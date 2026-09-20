/**
 * The lump-sum optimizer (PRD §7).
 *
 * The ladder answers "which debt to eliminate next". This answers a different
 * question: given THIS specific amount -- usually the Allocation Engine's debt
 * share -- where should it actually go, including when splitting it across
 * debts beats concentrating it on one.
 *
 * Interpretation note on the weighting. The PRD specifies knockouts "ranked by
 * (minimum freed ÷ payoff cost), weighted by (1 − w)" and the remainder going
 * to the highest effective APR "weighted by w". That is read here as one blended
 * objective over both terms, matching the abstract's "using the same short-term
 * + long-term objective": a knockout's value is its normalised cash-freed ratio
 * carrying weight (1 − w) plus its normalised rate carrying weight w. With the
 * slider hard over to "free up cash flow now" the ranking becomes pure cash
 * freed per dollar; hard over to "avoid the most interest" it becomes pure rate.
 */

import { compareDates, monthsBetween, type CivilDate } from './dates'
import { formatCents, type Cents } from './money'
import {
  DEFAULT_PRIORITY_WEIGHT,
  DEFAULT_PROMO_LEAD_WEEKS,
  effectiveAprBasisPoints,
  interestOverNextYearCents,
  minimumPaymentCents,
  type Debt,
} from './debt'
import type { Id } from './types'

const WEEKS_PER_MONTH = 52 / 12

export interface OptimizerAllocation {
  debtId: Id
  debtName: string
  amountCents: Cents
  /** True when this payment clears the debt outright. */
  clearsIt: boolean
  monthlyFreedCents: Cents
  reason: string
}

export interface OptimizerResult {
  amountCents: Cents
  allocations: OptimizerAllocation[]
  unallocatedCents: Cents
  /** Headline one: monthly obligation removed. */
  monthlyFreedCents: Cents
  /** Headline two: interest this avoids over the next twelve months. */
  interestAvoidedCents: Cents
  why: string
}

function normalise(values: number[]): number[] {
  const max = Math.max(...values, 0)
  return max > 0 ? values.map((v) => v / max) : values.map(() => 0)
}

/**
 * A promo balance inside its lead window that this amount could clear jumps the
 * queue (PRD §7). Clearing it before the rate resets is worth more than any
 * ranking, because after the deadline the saving is simply gone.
 */
function promoUrgent(debt: Debt, today: CivilDate, leadWeeks: number): boolean {
  const next = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, today) > 0)
    .sort((a, b) => compareDates(a.untilDate, b.untilDate))[0]
  if (!next) return false
  return monthsBetween(today, next.untilDate) * WEEKS_PER_MONTH <= leadWeeks
}

export function optimiseLumpSum(args: {
  debts: readonly Debt[]
  amountCents: Cents
  today: CivilDate
  weight?: number
  promoLeadWeeks?: number
}): OptimizerResult {
  const weight = args.weight ?? DEFAULT_PRIORITY_WEIGHT
  const leadWeeks = args.promoLeadWeeks ?? DEFAULT_PROMO_LEAD_WEEKS
  const open = args.debts.filter((d) => d.state === 'open' && d.balanceCents > 0)

  const empty: OptimizerResult = {
    amountCents: args.amountCents,
    allocations: [],
    unallocatedCents: args.amountCents,
    monthlyFreedCents: 0,
    interestAvoidedCents: 0,
    why: 'There is nothing to pay off.',
  }
  if (open.length === 0 || args.amountCents <= 0) return empty

  const rows = open.map((debt) => ({
    debt,
    apr: effectiveAprBasisPoints(debt, args.today, leadWeeks),
    minimum: minimumPaymentCents(debt),
    yearInterest: interestOverNextYearCents(debt, args.today, leadWeeks),
    urgent: promoUrgent(debt, args.today, leadWeeks),
  }))

  const normalisedApr = normalise(rows.map((r) => r.apr))
  const normalisedFreed = normalise(rows.map((r) => r.minimum / r.debt.balanceCents))

  const candidates = rows.map((row, index) => ({
    ...row,
    score: (1 - weight) * (normalisedFreed[index] ?? 0) + weight * (normalisedApr[index] ?? 0),
  }))

  let remaining = args.amountCents
  const allocations: OptimizerAllocation[] = []
  const used = new Set<Id>()

  // 1. Promo cliffs this amount can actually clear, soonest deadline first.
  const urgentClearable = candidates
    .filter((c) => c.urgent && c.debt.balanceCents <= remaining)
    .sort((a, b) => a.debt.balanceCents - b.debt.balanceCents)

  for (const candidate of urgentClearable) {
    if (candidate.debt.balanceCents > remaining) continue
    remaining -= candidate.debt.balanceCents
    used.add(candidate.debt.id)
    allocations.push({
      debtId: candidate.debt.id,
      debtName: candidate.debt.name,
      amountCents: candidate.debt.balanceCents,
      clearsIt: true,
      monthlyFreedCents: candidate.minimum,
      reason: 'Its promotional rate is about to end — clearing it now beats paying interest on it later.',
    })
  }

  // 2. Knockouts: anything this amount can eliminate outright, best value first.
  const knockouts = candidates
    .filter((c) => !used.has(c.debt.id) && c.debt.balanceCents <= remaining)
    .sort((a, b) => b.score - a.score || a.debt.balanceCents - b.debt.balanceCents)

  for (const candidate of knockouts) {
    if (candidate.debt.balanceCents > remaining) continue
    remaining -= candidate.debt.balanceCents
    used.add(candidate.debt.id)
    allocations.push({
      debtId: candidate.debt.id,
      debtName: candidate.debt.name,
      amountCents: candidate.debt.balanceCents,
      clearsIt: true,
      monthlyFreedCents: candidate.minimum,
      reason: `Paying it off completely frees ${formatCents(candidate.minimum)} a month.`,
    })
  }

  // 3. Whatever is left goes at the most expensive remaining debt.
  if (remaining > 0) {
    const target = candidates
      .filter((c) => !used.has(c.debt.id))
      .sort((a, b) => b.apr - a.apr || b.score - a.score)[0]

    if (target) {
      allocations.push({
        debtId: target.debt.id,
        debtName: target.debt.name,
        amountCents: remaining,
        clearsIt: false,
        monthlyFreedCents: 0,
        reason: `It is the most expensive debt left at ${(target.apr / 100).toFixed(2)}%, so every dollar here avoids the most interest.`,
      })
      remaining = 0
    }
  }

  const monthlyFreedCents = allocations.reduce((s, a) => s + a.monthlyFreedCents, 0)

  // Interest avoided: the full next-twelve-months interest of anything cleared,
  // plus a proportional share for a partial payment.
  const interestAvoidedCents = allocations.reduce((sum, allocation) => {
    const row = rows.find((r) => r.debt.id === allocation.debtId)
    if (!row) return sum
    if (allocation.clearsIt) return sum + row.yearInterest
    const share = allocation.amountCents / row.debt.balanceCents
    return sum + Math.round(row.yearInterest * share)
  }, 0)

  return {
    amountCents: args.amountCents,
    allocations,
    unallocatedCents: remaining,
    monthlyFreedCents,
    interestAvoidedCents,
    why: buildWhy(allocations, monthlyFreedCents, interestAvoidedCents, remaining),
  }
}

function buildWhy(
  allocations: readonly OptimizerAllocation[],
  monthlyFreedCents: Cents,
  interestAvoidedCents: Cents,
  unallocatedCents: Cents,
): string {
  if (allocations.length === 0) return 'There is nothing to pay off.'

  const cleared = allocations.filter((a) => a.clearsIt)
  const parts: string[] = []

  if (cleared.length === 1) {
    parts.push(`This clears ${cleared[0]!.debtName} outright.`)
  } else if (cleared.length > 1) {
    parts.push(
      `This clears ${cleared.slice(0, -1).map((a) => a.debtName).join(', ')} and ${cleared.at(-1)!.debtName} outright.`,
    )
  }

  const partial = allocations.find((a) => !a.clearsIt)
  if (partial) {
    parts.push(`The rest goes at ${partial.debtName}, the most expensive one left.`)
  }

  if (monthlyFreedCents > 0) {
    parts.push(`You get ${formatCents(monthlyFreedCents)} a month back.`)
  }
  if (interestAvoidedCents > 0) {
    parts.push(`It saves about ${formatCents(interestAvoidedCents)} of interest over the next year.`)
  }
  if (unallocatedCents > 0) {
    // Everything is cleared and money remains. Saying nothing would leave the
    // household believing it was all spent.
    parts.push(
      `That clears everything, and ${formatCents(unallocatedCents)} is left over to put somewhere else.`,
    )
  }

  return parts.join(' ')
}
