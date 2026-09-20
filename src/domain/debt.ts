/**
 * Debt Priorities (PRD §7).
 *
 * Replaces the spreadsheet's Debt Priorities tab, with two upgrades it could not
 * do: promo-rate awareness, and a lump-sum optimizer.
 *
 * Everything here is a pure function of the stored Debt facts plus today. No
 * score, ladder or projection is ever persisted (D9) -- they all move whenever a
 * balance changes, a promo approaches expiry, or the household moves the slider.
 *
 * Rates are basis points throughout (2499 = 24.99%). A percentage stored as a
 * float would drift, and these numbers drive which debt gets real money.
 */

import { addMonths, compareDates, monthsBetween, type CivilDate } from './dates'
import type { Cents } from './money'
import type { Id } from './types'

export type DebtCategory = 'consumer' | 'auto' | 'mortgage'
export type DebtState = 'open' | 'paid_off'

export type MinPaymentRule =
  | { type: 'fixed'; amountCents: Cents }
  | { type: 'percent'; basisPoints: number }
  | { type: 'percent_with_floor'; basisPoints: number; floorCents: Cents }

export interface PromoRule {
  rateBasisPoints: number
  /** 'full' = the whole balance; 'amount' = just this tranche of it. */
  appliesTo: 'full' | 'amount'
  amountCents?: Cents
  untilDate: CivilDate
}

export interface Debt {
  id: Id
  householdId: Id
  name: string
  category: DebtCategory
  balanceCents: Cents
  balanceAsOf: CivilDate
  aprBasisPoints: number
  promoRules: PromoRule[]
  minPaymentRule: MinPaymentRule
  creditLimitCents?: Cents | null
  fixedPayment: boolean
  state: DebtState
}

export class DebtDataError extends Error {}

/**
 * How long a balance may go unchecked before the screen says so. Every score
 * and projection here is only as good as the balance it starts from, and a
 * statement cycle is a month, so a balance older than one is a guess.
 */
export const BALANCE_STALE_AFTER_DAYS = 31

/** Days since the balance was last confirmed or read off a statement. */
export function balanceAgeDays(debt: Pick<Debt, 'balanceAsOf'>, today: CivilDate): number {
  return Math.max(0, compareDates(today, debt.balanceAsOf))
}

/**
 * A gentle nudge, not an error: the balance is old enough that the numbers
 * built on it deserve a fresh look. Never fires for a paid-off debt, whose
 * balance is a fact that does not age.
 */
export function balanceFreshness(
  debt: Pick<Debt, 'balanceAsOf' | 'state'>,
  today: CivilDate,
  staleAfterDays: number = BALANCE_STALE_AFTER_DAYS,
): { ageDays: number; stale: boolean } {
  const ageDays = balanceAgeDays(debt, today)
  return { ageDays, stale: debt.state === 'open' && ageDays > staleAfterDays }
}

/**
 * A promo rate that is not actually cheaper than the rate it reverts to is a
 * data-entry mistake, and a costly one: it silently disables the whole
 * promo-cliff mechanism, which exists precisely to raise this debt's priority
 * before interest lands. Caught at the point of entry rather than showing a
 * confident, wrong payoff order.
 */
/**
 * Reject a debt whose numbers cannot describe a real debt.
 *
 * The UI validates too, but a route handler is not the last line: a blank
 * minimum-payment box once reached a parser that throws and took the whole
 * page down with a 500. Anything that would produce a nonsense payoff order
 * fails here, where every caller passes.
 */
export function validateDebtInputs(input: {
  balanceCents: Cents
  aprBasisPoints: number
  minPaymentRule: MinPaymentRule
}): void {
  if (!Number.isFinite(input.balanceCents) || input.balanceCents < 0) {
    throw new DebtDataError('A debt balance must be zero or more.')
  }
  if (!Number.isFinite(input.aprBasisPoints) || input.aprBasisPoints < 0) {
    throw new DebtDataError('An interest rate cannot be negative.')
  }

  const rule = input.minPaymentRule
  switch (rule.type) {
    case 'fixed':
      if (!Number.isFinite(rule.amountCents) || rule.amountCents <= 0) {
        throw new DebtDataError('The minimum payment must be more than zero.')
      }
      break
    case 'percent':
    case 'percent_with_floor':
      if (!Number.isFinite(rule.basisPoints) || rule.basisPoints <= 0) {
        throw new DebtDataError('The minimum payment percentage must be more than zero.')
      }
      if (rule.type === 'percent_with_floor') {
        if (!Number.isFinite(rule.floorCents) || rule.floorCents < 0) {
          throw new DebtDataError('The minimum payment floor cannot be negative.')
        }
      }
      break
  }
}

export function validateDebtRates(input: {
  aprBasisPoints: number
  promoRules: readonly PromoRule[]
}): void {
  for (const rule of input.promoRules) {
    if (rule.rateBasisPoints >= input.aprBasisPoints) {
      throw new DebtDataError(
        `A promotional rate of ${(rule.rateBasisPoints / 100).toFixed(2)}% is not lower than the ` +
          `normal rate of ${(input.aprBasisPoints / 100).toFixed(2)}%. Put the rate the debt goes ` +
          `back to in the interest rate field, not the promotional one.`,
      )
    }
  }
}

export const DEFAULT_PRIORITY_WEIGHT = 0.7 // 70% long-term (PRD D5)
export const DEFAULT_PROMO_LEAD_WEEKS = 8

const BASIS_POINTS = 10_000
const WEEKS_PER_MONTH = 52 / 12

/** The monthly minimum this debt demands right now. */
export function minimumPaymentCents(debt: Debt): Cents {
  const rule = debt.minPaymentRule
  switch (rule.type) {
    case 'fixed':
      return Math.min(rule.amountCents, debt.balanceCents)
    case 'percent':
      return Math.min(Math.ceil((debt.balanceCents * rule.basisPoints) / BASIS_POINTS), debt.balanceCents)
    case 'percent_with_floor': {
      const percent = Math.ceil((debt.balanceCents * rule.basisPoints) / BASIS_POINTS)
      return Math.min(Math.max(percent, rule.floorCents), debt.balanceCents)
    }
  }
}

interface Tranche {
  amountCents: Cents
  rateBasisPoints: number
}

/**
 * Split a balance into promo tranches plus whatever sits at the standard rate,
 * applying the promo logic of PRD §7 to each.
 *
 * The rule that matters: a promo rate is only worth believing if the balance can
 * actually be cleared before it expires. If it cannot, the post-promo rate is
 * what this debt really costs, starting now -- which is exactly the cliff the
 * spreadsheet could not see, because a 0% APR scores zero long-term today.
 */
function tranchesFor(debt: Debt, today: CivilDate, leadWeeks: number): Tranche[] {
  const minimum = minimumPaymentCents(debt)
  const tranches: Tranche[] = []
  let unallocated = debt.balanceCents

  const live = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, today) > 0)
    .sort((a, b) => compareDates(a.untilDate, b.untilDate))

  for (const rule of live) {
    if (unallocated <= 0) break
    const amountCents =
      rule.appliesTo === 'full' ? unallocated : Math.min(rule.amountCents ?? 0, unallocated)
    if (amountCents <= 0) continue

    const monthsLeft = monthsBetween(today, rule.untilDate)
    const clearable = monthsLeft * minimum >= amountCents

    let rateBasisPoints: number
    if (!clearable) {
      // It will still be here when the promo ends, so price it at the real rate.
      rateBasisPoints = debt.aprBasisPoints
    } else {
      const weeksLeft = monthsLeft * WEEKS_PER_MONTH
      if (weeksLeft <= leadWeeks) {
        // Ramp toward the post-promo rate so this debt climbs the ladder in
        // time to be cleared, rather than jumping the day interest lands.
        const progress = leadWeeks === 0 ? 1 : Math.min(1, (leadWeeks - weeksLeft) / leadWeeks)
        rateBasisPoints = Math.round(
          rule.rateBasisPoints + (debt.aprBasisPoints - rule.rateBasisPoints) * progress,
        )
      } else {
        rateBasisPoints = rule.rateBasisPoints
      }
    }

    tranches.push({ amountCents, rateBasisPoints })
    unallocated -= amountCents
  }

  if (unallocated > 0) {
    tranches.push({ amountCents: unallocated, rateBasisPoints: debt.aprBasisPoints })
  }
  return tranches
}

/** Promo-aware effective APR, blended across tranches by balance (PRD §7). */
export function effectiveAprBasisPoints(
  debt: Debt,
  today: CivilDate,
  leadWeeks: number = DEFAULT_PROMO_LEAD_WEEKS,
): number {
  if (debt.balanceCents <= 0) return 0
  const tranches = tranchesFor(debt, today, leadWeeks)
  const weighted = tranches.reduce((s, t) => s + t.amountCents * t.rateBasisPoints, 0)
  const total = tranches.reduce((s, t) => s + t.amountCents, 0)
  return total > 0 ? Math.round(weighted / total) : debt.aprBasisPoints
}

/** Is this debt inside the window where a promo expiry should be shouted about? */
export function promoExpiryWarning(
  debt: Debt,
  today: CivilDate,
  leadWeeks: number = DEFAULT_PROMO_LEAD_WEEKS,
): { untilDate: CivilDate; monthlyToClearCents: Cents } | null {
  const live = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, today) > 0)
    .sort((a, b) => compareDates(a.untilDate, b.untilDate))
  const next = live[0]
  if (!next) return null

  const monthsLeft = monthsBetween(today, next.untilDate)
  if (monthsLeft * WEEKS_PER_MONTH > leadWeeks) return null

  const amountCents =
    next.appliesTo === 'full' ? debt.balanceCents : Math.min(next.amountCents ?? 0, debt.balanceCents)

  return {
    untilDate: next.untilDate,
    monthlyToClearCents: monthsLeft <= 0 ? amountCents : Math.ceil(amountCents / monthsLeft),
  }
}

export interface DebtScore {
  debt: Debt
  effectiveAprBasisPoints: number
  minimumPaymentCents: Cents
  /** Avoided-interest weight, normalised against the worst rate in the inventory. */
  longTerm: number
  /** Cash freed per dollar paid off, normalised against the best ratio. */
  shortTerm: number
  priority: number
}

/**
 * Score every open debt (PRD §7).
 *
 * The long-term denominator is the highest effective APR currently in the
 * inventory (D4), so scores shift when the worst debt is paid off. That is
 * intended, and the UI says so in a tooltip: the ladder is about relative
 * urgency, not an absolute scale.
 */
export function scoreDebts(args: {
  debts: readonly Debt[]
  today: CivilDate
  weight?: number
  promoLeadWeeks?: number
}): DebtScore[] {
  const weight = args.weight ?? DEFAULT_PRIORITY_WEIGHT
  const leadWeeks = args.promoLeadWeeks ?? DEFAULT_PROMO_LEAD_WEEKS
  const open = args.debts.filter((d) => d.state === 'open' && d.balanceCents > 0)
  if (open.length === 0) return []

  const rows = open.map((debt) => ({
    debt,
    effectiveAprBasisPoints: effectiveAprBasisPoints(debt, args.today, leadWeeks),
    minimumPaymentCents: minimumPaymentCents(debt),
  }))

  const maxApr = Math.max(...rows.map((r) => r.effectiveAprBasisPoints))
  const ratios = rows.map((r) => r.minimumPaymentCents / r.debt.balanceCents)
  const maxRatio = Math.max(...ratios)

  return rows
    .map((row, index) => {
      const longTerm = maxApr > 0 ? row.effectiveAprBasisPoints / maxApr : 0
      const shortTerm = maxRatio > 0 ? (ratios[index] ?? 0) / maxRatio : 0
      return {
        ...row,
        longTerm,
        shortTerm,
        priority: weight * longTerm + (1 - weight) * shortTerm,
      }
    })
    .sort((a, b) => b.priority - a.priority || a.debt.name.localeCompare(b.debt.name))
}

export interface LadderRung extends DebtScore {
  rank: number
  cumulativeCostCents: Cents
  cumulativeFreedPerMonthCents: Cents
  /** How many months of freed cash it takes to repay the cost of getting here. */
  breakEvenMonths: number | null
}

/** The snowball ladder: debts in priority order, with the running trade-off. */
export function snowballLadder(scores: readonly DebtScore[]): LadderRung[] {
  let cost = 0
  let freed = 0
  return scores.map((score, index) => {
    cost += score.debt.balanceCents
    freed += score.minimumPaymentCents
    return {
      ...score,
      rank: index + 1,
      cumulativeCostCents: cost,
      cumulativeFreedPerMonthCents: freed,
      breakEvenMonths: freed > 0 ? Math.ceil(cost / freed) : null,
    }
  })
}

export interface Projection {
  months: number | null
  payoffDate: CivilDate | null
  totalInterestCents: Cents
}

const MAX_MONTHS = 600 // 50 years; past that it is "never" for a household's purposes

/**
 * Months to clear one debt, simulated month by month rather than solved in
 * closed form. The amortisation formula assumes a constant payment, but a
 * percent-of-balance minimum shrinks every month -- which is exactly the case
 * that never pays off and most needs to be shown honestly.
 */
export function projectPayoff(args: {
  debt: Debt
  today: CivilDate
  extraPerMonthCents?: Cents
  leadWeeks?: number
}): Projection {
  const { debt } = args
  const extra = args.extraPerMonthCents ?? 0
  if (debt.balanceCents <= 0) {
    return { months: 0, payoffDate: args.today, totalInterestCents: 0 }
  }

  const monthlyRate =
    effectiveAprBasisPoints(debt, args.today, args.leadWeeks ?? DEFAULT_PROMO_LEAD_WEEKS) /
    BASIS_POINTS /
    12

  let balance = debt.balanceCents
  let interest = 0

  for (let month = 1; month <= MAX_MONTHS; month += 1) {
    const charged = Math.round(balance * monthlyRate)
    interest += charged
    balance += charged

    const working: Debt = { ...debt, balanceCents: balance }
    const payment = Math.min(balance, minimumPaymentCents(working) + extra)

    // A payment that does not cover the interest never clears the balance.
    if (payment <= charged && extra === 0) {
      return { months: null, payoffDate: null, totalInterestCents: interest }
    }

    balance -= payment
    if (balance <= 0) {
      return {
        months: month,
        payoffDate: addMonths(args.today, month),
        totalInterestCents: interest,
      }
    }
  }

  return { months: null, payoffDate: null, totalInterestCents: interest }
}

/** Interest this debt will accrue over the next 12 months if left at minimums. */
export function interestOverNextYearCents(debt: Debt, today: CivilDate, leadWeeks?: number): Cents {
  if (debt.balanceCents <= 0) return 0
  const monthlyRate =
    effectiveAprBasisPoints(debt, today, leadWeeks ?? DEFAULT_PROMO_LEAD_WEEKS) / BASIS_POINTS / 12

  let balance = debt.balanceCents
  let interest = 0
  for (let month = 0; month < 12 && balance > 0; month += 1) {
    const charged = Math.round(balance * monthlyRate)
    interest += charged
    balance += charged
    balance -= Math.min(balance, minimumPaymentCents({ ...debt, balanceCents: balance }))
  }
  return interest
}
