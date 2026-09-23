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
  /**
   * What the household actually pays each month, when that is more than the
   * lender's minimum. Null or absent means the minimum. This is the number
   * that says whether a deal-rate balance is on track: a card the family
   * clears at $400 a month is not a cliff just because its minimum is $30.
   */
  plannedPaymentCents?: Cents | null
  /**
   * Listed in the PRD's data model, read by nothing. The form no longer asks
   * for it: a set-amount minimum already says the payment never changes, and
   * asking twice looked like two different questions. Stays false.
   */
  fixedPayment: boolean
  state: DebtState
  /**
   * The home or vehicle this debt is secured on (PRD §15), or none. Read only
   * by the equity figures: what is owed on an asset comes off what selling it
   * would leave.
   */
  assetId?: Id | null
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
  plannedPaymentCents?: Cents | null
}): void {
  if (!Number.isFinite(input.balanceCents) || input.balanceCents < 0) {
    throw new DebtDataError('A debt balance must be zero or more.')
  }
  if (!Number.isFinite(input.aprBasisPoints) || input.aprBasisPoints < 0) {
    throw new DebtDataError('An interest rate cannot be negative.')
  }
  if (
    input.plannedPaymentCents != null &&
    (!Number.isFinite(input.plannedPaymentCents) || input.plannedPaymentCents < 0)
  ) {
    throw new DebtDataError('What you pay each month cannot be negative.')
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

/**
 * What actually goes at this debt each month: the household's planned
 * payment when it has one, else the lender's minimum, never more than the
 * balance. Every projection and every "is it on track" test uses this, so a
 * family paying well above the minimum is judged on what it does, not on
 * what the card would let it get away with.
 */
export function monthlyPaymentCents(debt: Debt): Cents {
  const planned = Math.max(0, debt.plannedPaymentCents ?? 0)
  return Math.min(debt.balanceCents, Math.max(minimumPaymentCents(debt), planned))
}

interface Tranche {
  amountCents: Cents
  rateBasisPoints: number
}

/**
 * The one definition of a promotional cliff, used by the ranking, the
 * share-out's shortfall step and the lump-sum optimizer alike, so they can
 * never disagree about whether a deal is on track.
 *
 * `shortCents` is what the household's monthly payments (what they actually
 * pay, else the minimum) will NOT have cleared of the deal-rate balance by
 * the day the deal ends: the money that will meet the full rate. Zero means
 * on track. Only the soonest live deal is considered; it is the one whose
 * deadline is real.
 */
export interface PromoCliff {
  untilDate: CivilDate
  promoRateBasisPoints: number
  /** The balance on the deal. */
  amountCents: Cents
  monthsLeft: number
  /** What the payments leave at the full rate when the deal ends. 0 = on track. */
  shortCents: Cents
}

export function promoCliff(debt: Debt, today: CivilDate): PromoCliff | null {
  if (debt.state !== 'open' || debt.balanceCents <= 0) return null
  const next = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, today) > 0)
    .sort((a, b) => compareDates(a.untilDate, b.untilDate))[0]
  if (!next) return null
  const amountCents =
    next.appliesTo === 'full' ? debt.balanceCents : Math.min(next.amountCents ?? 0, debt.balanceCents)
  if (amountCents <= 0) return null
  const monthsLeft = monthsBetween(today, next.untilDate)
  return {
    untilDate: next.untilDate,
    promoRateBasisPoints: next.rateBasisPoints,
    amountCents,
    monthsLeft,
    shortCents: Math.max(0, amountCents - monthsLeft * monthlyPaymentCents(debt)),
  }
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
  const payment = monthlyPaymentCents(debt)
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
    const clearable = monthsLeft * payment >= amountCents

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
  /** What goes at it each month: the planned payment, else the minimum. */
  paymentPerMonthCents: Cents
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
    paymentPerMonthCents: monthlyPaymentCents(debt),
  }))

  const maxApr = Math.max(...rows.map((r) => r.effectiveAprBasisPoints))
  const ratios = rows.map((r) => r.paymentPerMonthCents / r.debt.balanceCents)
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
    freed += score.paymentPerMonthCents
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

/**
 * How far a projection is willing to look. A percent-of-balance minimum shrinks
 * with the balance, so a card can take centuries to clear at its minimum and
 * still, truthfully, have an end -- and the interest over that life is a
 * finite figure worth knowing. The cap is for the balance that never shrinks
 * at all, which the loop also catches early; past it, "never" is the honest
 * word.
 */
const MAX_MONTHS = 12_000

/**
 * A card asks for the whole balance once it is under its floor, about $25.
 * Below that, a projection that stalls (a percent-of-balance minimum rounding
 * to the same cent as the interest) is rounding, not a debt.
 */
const POCKET_CHANGE_CENTS = 2500

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
  if (debt.balanceCents <= 0) {
    return { months: 0, payoffDate: args.today, totalInterestCents: 0 }
  }
  const run = simulateMonths({ debt, today: args.today, extraPerMonthCents: args.extraPerMonthCents ?? 0 })
  return {
    months: run.paidOffAfterMonths,
    payoffDate: run.paidOffAfterMonths === null ? null : addMonths(args.today, run.paidOffAfterMonths),
    totalInterestCents: run.interestCents,
  }
}

/**
 * Month by month, at the rate actually in force each month.
 *
 * A deal-rate balance is charged its deal rate until the deal ends and the
 * full rate after -- not a blended rate from today. The blend (the "effective
 * APR") is the right thing to RANK by, because it is how urgent a cliff is;
 * it is the wrong thing to PROJECT with, because it charges a 0% card 30%
 * from day one and reports a year of interest that will never be billed.
 * Everything that states a fact about a debt's future -- when it is paid
 * off, what it will cost, what a payment today saves -- comes from here.
 *
 * Payments go to the deal-rate balance first, which is how a card issuer
 * applies the minimum, and is exactly what makes a cliff a cliff.
 */
function simulateMonths(args: {
  debt: Debt
  today: CivilDate
  extraPerMonthCents: Cents
  /** Stop after this many months, still open. Absent: run to payoff or the cap. */
  horizonMonths?: number
}): { paidOffAfterMonths: number | null; interestCents: Cents } {
  const { debt, extraPerMonthCents: extra } = args
  const limit = args.horizonMonths ?? MAX_MONTHS

  // Each live deal as its own running balance, soonest deadline first, with
  // whatever is not on a deal at the full rate.
  const deals = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, args.today) > 0)
    .sort((a, b) => compareDates(a.untilDate, b.untilDate))
  let standard = debt.balanceCents
  const tranches: { balance: Cents; rateBasisPoints: number; untilDate: CivilDate }[] = []
  for (const rule of deals) {
    if (standard <= 0) break
    const amount = rule.appliesTo === 'full' ? standard : Math.min(rule.amountCents ?? 0, standard)
    if (amount <= 0) continue
    tranches.push({ balance: amount, rateBasisPoints: rule.rateBasisPoints, untilDate: rule.untilDate })
    standard -= amount
  }

  let interest = 0
  for (let month = 1; month <= limit; month += 1) {
    // The month being charged runs from this date; a deal that has ended by
    // then has rolled into the full-rate balance.
    const monthStart = addMonths(args.today, month - 1)
    for (let i = tranches.length - 1; i >= 0; i -= 1) {
      if (compareDates(tranches[i]!.untilDate, monthStart) <= 0) {
        standard += tranches[i]!.balance
        tranches.splice(i, 1)
      }
    }

    let charged = 0
    for (const t of tranches) {
      const c = Math.round((t.balance * t.rateBasisPoints) / BASIS_POINTS / 12)
      t.balance += c
      charged += c
    }
    const cs = Math.round((standard * debt.aprBasisPoints) / BASIS_POINTS / 12)
    standard += cs
    charged += cs
    interest += charged

    const total = standard + tranches.reduce((sum, t) => sum + t.balance, 0)
    const payment = Math.min(total, monthlyPaymentCents({ ...debt, balanceCents: total }) + extra)

    // A payment that does not cover the interest never clears the balance.
    // Except at pocket change, where the last payment takes the lot: a debt
    // that got there shrank from real money, so it is paid off.
    if (payment <= charged && extra === 0) {
      if (total <= POCKET_CHANGE_CENTS) return { paidOffAfterMonths: month, interestCents: interest }
      return { paidOffAfterMonths: null, interestCents: interest }
    }

    // Deal balances first, then the full-rate balance.
    let left = payment
    for (const t of tranches) {
      const take = Math.min(t.balance, left)
      t.balance -= take
      left -= take
    }
    standard -= Math.min(standard, left)

    if (standard + tranches.reduce((sum, t) => sum + t.balance, 0) <= 0) {
      return { paidOffAfterMonths: month, interestCents: interest }
    }
  }

  return { paidOffAfterMonths: null, interestCents: interest }
}

/** Interest this debt will accrue over the next 12 months if left at minimums. */
export function interestOverNextYearCents(debt: Debt, today: CivilDate, _leadWeeks?: number): Cents {
  if (debt.balanceCents <= 0) return 0
  return simulateMonths({ debt, today, extraPerMonthCents: 0, horizonMonths: 12 }).interestCents
}
