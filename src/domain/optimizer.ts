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
 *
 * Every step looks at the debts AS THEY WILL BE after the payments already
 * decided, never at the balances it started with. That is what keeps a deal-
 * rate card honest: its effective rate is the full rate only for the part the
 * payments would leave when the deal ends (the cliff, PRD §7), so once that
 * part is covered the rest of the card is a deal again, and the next dollar
 * goes to whatever actually costs something. A deal the household is on track
 * to clear attracts nothing: paying it early saves nothing, and saying so is
 * better than pretending.
 */

import { compareDates, monthsBetween, type CivilDate } from './dates'
import { formatCents, type Cents } from './money'
import {
  DEFAULT_PRIORITY_WEIGHT,
  DEFAULT_PROMO_LEAD_WEEKS,
  effectiveAprBasisPoints,
  interestOverNextYearCents,
  monthlyPaymentCents,
  projectPayoff,
  promoCliff,
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
  /**
   * The monthly obligation this payment removes. Clearing a debt frees its
   * whole minimum. A partial payment frees whatever a percent-of-balance
   * minimum falls by, because a smaller balance means a smaller minimum next
   * month; a set payment stays what it is until the debt is gone, so a partial
   * payment at one frees nothing.
   */
  monthlyFreedCents: Cents
  /** The minimum this month, and what it becomes after the payment (zero when cleared). */
  minimumBeforeCents: Cents
  minimumAfterCents: Cents
  /**
   * Interest this payment stops from ever being charged, over the rest of the
   * debt's life at its payments. Null when the debt would never be paid off,
   * because then "the rest of its life" has no end.
   */
  lifetimeInterestAvoidedCents: Cents | null
  /** How many months sooner the debt is gone. Null when it never would be. */
  monthsSooner: number | null
  reason: string
}

export interface OptimizerResult {
  amountCents: Cents
  /**
   * How many open debts were looked at. Zero is "no debts recorded"; a
   * positive count with no allocations is "every debt is a deal it is on
   * track to clear" -- two different things to tell a household.
   */
  consideredDebts: number
  allocations: OptimizerAllocation[]
  unallocatedCents: Cents
  /** Headline one: monthly obligation removed. */
  monthlyFreedCents: Cents
  /** Headline two: interest this avoids over the next twelve months. Always known. */
  interestAvoidedCents: Cents
  /**
   * Headline two, the long view: interest never paid over the life of every
   * debt touched. Null when any of them would never be paid off, in which
   * case the twelve-month figure is the honest one.
   */
  lifetimeInterestAvoidedCents: Cents | null
  why: string
}

const percent = (basisPoints: number) => (basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')

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
    consideredDebts: open.length,
    allocations: [],
    unallocatedCents: args.amountCents,
    monthlyFreedCents: 0,
    interestAvoidedCents: 0,
    lifetimeInterestAvoidedCents: 0,
    why: 'There is nothing to pay off.',
  }
  if (open.length === 0 || args.amountCents <= 0) return empty

  // The debts as they will be after each decision so far.
  const balance = new Map<Id, Cents>(open.map((d) => [d.id, d.balanceCents]))
  const asNow = (d: Debt): Debt => ({ ...d, balanceCents: balance.get(d.id) ?? 0 })
  const paid = new Map<Id, Cents>()
  const reasons = new Map<Id, string[]>()
  const touched: Debt[] = []
  const pay = (d: Debt, cents: Cents, reason: string) => {
    if (cents <= 0) return
    balance.set(d.id, (balance.get(d.id) ?? 0) - cents)
    if (!paid.has(d.id)) touched.push(d)
    paid.set(d.id, (paid.get(d.id) ?? 0) + cents)
    reasons.set(d.id, [...(reasons.get(d.id) ?? []), reason])
    remaining -= cents
  }
  let remaining = args.amountCents

  // 1. Promo cliffs this amount can actually clear, soonest deadline first.
  const urgentClearable = open
    .filter((d) => promoUrgent(d, args.today, leadWeeks) && (balance.get(d.id) ?? 0) <= remaining)
    .sort((a, b) => (balance.get(a.id) ?? 0) - (balance.get(b.id) ?? 0))
  for (const d of urgentClearable) {
    const owed = balance.get(d.id) ?? 0
    if (owed <= 0 || owed > remaining) continue
    pay(d, owed, 'Its promotional rate is about to end — clearing it now beats paying interest on it later.')
  }

  // 2. Knockouts: anything this amount can eliminate outright, best value first.
  const scored = open.map((d) => {
    const now = asNow(d)
    return {
      debt: d,
      apr: effectiveAprBasisPoints(now, args.today, leadWeeks),
      freedRatio: now.balanceCents > 0 ? monthlyPaymentCents(now) / now.balanceCents : 0,
    }
  })
  const normalisedApr = normalise(scored.map((r) => r.apr))
  const normalisedFreed = normalise(scored.map((r) => r.freedRatio))
  const score = new Map(
    scored.map((r, i) => [r.debt.id, (1 - weight) * (normalisedFreed[i] ?? 0) + weight * (normalisedApr[i] ?? 0)]),
  )
  const knockouts = open
    .filter((d) => !paid.has(d.id) && (balance.get(d.id) ?? 0) > 0 && (balance.get(d.id) ?? 0) <= remaining)
    .sort(
      (a, b) =>
        (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || (balance.get(a.id) ?? 0) - (balance.get(b.id) ?? 0),
    )
  for (const d of knockouts) {
    const owed = balance.get(d.id) ?? 0
    if (owed <= 0 || owed > remaining) continue
    pay(d, owed, `Paying it off completely frees ${formatCents(monthlyPaymentCents(asNow(d)))} a month.`)
  }

  // 3. Whatever is left goes at the most expensive debt still open -- judged
  //    on what it will cost after the payments above. A deal-rate card is
  //    expensive only for the part its payments would leave at the full rate,
  //    so it takes that much and no more; once covered it is a deal again and
  //    the next dollar moves on. A debt that costs nothing is not a target.
  let unallocatedWhy: string | null = null
  while (remaining > 0) {
    const candidates = open
      .map((d) => ({ debt: d, now: asNow(d) }))
      .filter(({ now }) => now.balanceCents > 0)
      .map((c) => ({ ...c, apr: effectiveAprBasisPoints(c.now, args.today, leadWeeks), cliff: promoCliff(c.now, args.today) }))
      .filter((c) => c.apr > 0)
      .sort((a, b) => b.apr - a.apr || (score.get(b.debt.id) ?? 0) - (score.get(a.debt.id) ?? 0))
    const target = candidates[0]
    if (!target) {
      unallocatedWhy =
        touched.length > 0
          ? 'Every debt still open is on a deal it is on track to clear, so paying more now saves nothing.'
          : 'Every debt is on a deal it is on track to clear, so paying it early saves nothing.'
      break
    }
    const { debt, now, cliff } = target
    if (cliff && cliff.shortCents > 0) {
      const cents = Math.min(remaining, cliff.shortCents)
      pay(
        debt,
        cents,
        `Its ${percent(cliff.promoRateBasisPoints)}% deal ends ${cliff.untilDate}, and at ${formatCents(monthlyPaymentCents(now))} a month ${formatCents(cliff.shortCents)} would still be there at ${percent(debt.aprBasisPoints)}% after that. This ${cents >= cliff.shortCents ? 'covers it' : 'covers part of it'}.`,
      )
      continue
    }
    const cents = Math.min(remaining, now.balanceCents)
    pay(
      debt,
      cents,
      `It is the most expensive debt left at ${percent(target.apr)}%, so every dollar here avoids the most interest.`,
    )
  }

  // What each payment does, judged once per debt on its whole amount.
  const allocations: OptimizerAllocation[] = touched.map((debt) => {
    const amountCents = paid.get(debt.id) ?? 0
    const after: Debt = { ...debt, balanceCents: debt.balanceCents - amountCents }
    const clearsIt = amountCents >= debt.balanceCents
    const minimumBeforeCents = monthlyPaymentCents(debt)
    const minimumAfterCents = clearsIt ? 0 : monthlyPaymentCents(after)
    const before = projectPayoff({ debt, today: args.today, leadWeeks })
    const then = clearsIt ? null : projectPayoff({ debt: after, today: args.today, leadWeeks })
    const lifetime =
      before.months === null
        ? { interest: null, months: null }
        : clearsIt
          ? { interest: before.totalInterestCents, months: before.months }
          : then!.months === null
            ? { interest: null, months: null }
            : {
                interest: before.totalInterestCents - then!.totalInterestCents,
                months: before.months - then!.months,
              }
    const drops =
      !clearsIt && minimumBeforeCents - minimumAfterCents > 0
        ? ` Its minimum drops from ${formatCents(minimumBeforeCents)} to ${formatCents(minimumAfterCents)} a month.`
        : ''
    const sooner =
      !clearsIt && lifetime.months !== null && lifetime.months > 0
        ? ` Gone ${lifetime.months === 1 ? 'a month' : `${lifetime.months} months`} sooner.`
        : ''
    return {
      debtId: debt.id,
      debtName: debt.name,
      amountCents,
      clearsIt,
      monthlyFreedCents: minimumBeforeCents - minimumAfterCents,
      minimumBeforeCents,
      minimumAfterCents,
      lifetimeInterestAvoidedCents: lifetime.interest,
      monthsSooner: lifetime.months,
      reason: `${(reasons.get(debt.id) ?? []).join(' ')}${drops}${sooner}`,
    }
  })

  const monthlyFreedCents = allocations.reduce((s, a) => s + a.monthlyFreedCents, 0)

  // The long view is only honest when every debt touched has an end.
  const lifetimeInterestAvoidedCents = allocations.every((a) => a.lifetimeInterestAvoidedCents !== null)
    ? allocations.reduce((s, a) => s + (a.lifetimeInterestAvoidedCents ?? 0), 0)
    : null

  // The next twelve months, before and after, at the rates actually in force.
  const interestAvoidedCents = touched.reduce((sum, debt) => {
    const amountCents = paid.get(debt.id) ?? 0
    const after: Debt = { ...debt, balanceCents: debt.balanceCents - amountCents }
    return sum + interestOverNextYearCents(debt, args.today) - interestOverNextYearCents(after, args.today)
  }, 0)

  return {
    amountCents: args.amountCents,
    consideredDebts: open.length,
    allocations,
    unallocatedCents: remaining,
    monthlyFreedCents,
    interestAvoidedCents,
    lifetimeInterestAvoidedCents,
    why: buildWhy(allocations, remaining, unallocatedWhy),
  }
}

/**
 * The story, without the numbers: what gets cleared and where the rest goes.
 * The headline figures (cash back each month, interest never paid) are shown
 * as figures beside it, so repeating them here would be reading the same
 * sentence twice.
 */
function buildWhy(
  allocations: readonly OptimizerAllocation[],
  unallocatedCents: Cents,
  unallocatedWhy: string | null,
): string {
  if (allocations.length === 0) {
    return unallocatedWhy
      ? `${unallocatedWhy} ${formatCents(unallocatedCents)} is left over to put somewhere else.`
      : 'There is nothing to pay off.'
  }

  const cleared = allocations.filter((a) => a.clearsIt)
  const parts: string[] = []

  if (cleared.length === 1) {
    parts.push(`This clears ${cleared[0]!.debtName} outright.`)
  } else if (cleared.length > 1) {
    parts.push(
      `This clears ${cleared.slice(0, -1).map((a) => a.debtName).join(', ')} and ${cleared.at(-1)!.debtName} outright.`,
    )
  }

  const partial = allocations.filter((a) => !a.clearsIt)
  if (partial.length === 1) {
    parts.push(
      cleared.length > 0
        ? `The rest goes at ${partial[0]!.debtName}, the most expensive one left.`
        : `It goes at ${partial[0]!.debtName}, the most expensive one.`,
    )
  } else if (partial.length > 1) {
    parts.push(
      `${cleared.length > 0 ? 'The rest goes' : 'It goes'} at ${partial.slice(0, -1).map((a) => a.debtName).join(', ')} and ${partial.at(-1)!.debtName}, in the order they cost the most.`,
    )
  }

  if (unallocatedCents > 0) {
    // Money remains. Saying nothing would leave the household believing it
    // was all spent.
    parts.push(
      unallocatedWhy
        ? `${unallocatedWhy} ${formatCents(unallocatedCents)} is left over to put somewhere else.`
        : `That clears everything, and ${formatCents(unallocatedCents)} is left over to put somewhere else.`,
    )
  }

  return parts.join(' ')
}
