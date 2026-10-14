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
  /**
   * Interest is charged back to the deal's start if the deal balance is not
   * paid in full by `untilDate` (PRD D49 (9)). Absent means nobody has said
   * yet: taken as yes, and the debt asks once to be checked against the
   * card's terms.
   */
  chargedBack?: boolean
  /** When the deal started, for interest charged back. Absent: the day the debt was entered. */
  startDate?: CivilDate
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
   * The day of the month the regular payment goes out (PRD D49 (3)), 1-31,
   * a day past a short month's end meaning its last day. Null or absent: no
   * payment is assumed between stated balances.
   */
  paymentDay?: number | null
  /** The day the debt was entered in Ballast: where interest charged back starts when a deal has no start date. */
  enteredOn?: CivilDate
  /**
   * The last balance a person stated, as of `balanceAsOf`, when the engine
   * read it. `balanceCents` is the likely balance today worked out from it
   * (D49 (2)-(3)); the two differ once a payment has been made or assumed.
   * Never stored: the engine fills it on every read.
   */
  statedBalanceCents?: Cents
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
 * statement cycle is a month, so a balance older than one is a guess. PRD
 * D49 (4): more than 30 days asks, on This week, to be checked.
 */
export const BALANCE_STALE_AFTER_DAYS = 30

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
 * A debt's balance today (PRD D49 (2)): the last balance a person stated, less
 * every payment marked done since, never below zero. Payments made before
 * that statement are already in it, so only the later ones are passed here.
 * The same shape as an account's money today, its last count plus the moves
 * since (D34): the stated figure is the fact, the rest is worked out.
 */
export function balanceAfterPayments(statedCents: Cents, paymentsSinceCents: readonly Cents[]): Cents {
  const paid = paymentsSinceCents.reduce((sum, cents) => sum + cents, 0)
  return Math.max(0, statedCents - paid)
}

/** A payment marked done on a debt since its stated balance (D49 (1)). */
export interface DebtPaymentMade {
  on: CivilDate
  amountCents: Cents
  /**
   * The regular monthly payment, recorded on the payment form. It stands in
   * for the payment assumed that month. A payment asked for on a to-do is
   * the money a share-out sends on top of the regular one (PRD §6), so it
   * never replaces it.
   */
  regular: boolean
}

/** The day `paymentDay` falls on in the month of `d`, or that month's last day if it is shorter. */
function paymentDateIn(d: CivilDate, paymentDay: number): CivilDate {
  const [y, m] = d.split('-').map(Number) as [number, number]
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${d.slice(0, 7)}-${String(Math.min(paymentDay, lastDay)).padStart(2, '0')}` as CivilDate
}

/**
 * A debt's likely balance today (PRD D49 (2)-(3)), from the balance a person
 * last stated (`debt.balanceCents` as of `debt.balanceAsOf`).
 *
 * Without a payment day, it is the stated balance less the payments marked
 * done since: nothing is assumed. With one, each payment day after the
 * statement and up to today charges a month's interest at the rate in force
 * that month (a deal balance at its deal rate until the deal ends, the rest
 * at the full rate -- the same month as `projectPayoff`'s) and then takes the
 * regular payment, the planned one or else the minimum, the way an account
 * assumes its confirmed transfer runs (D35). A regular payment marked done in
 * a month replaces that month's assumed one; a payment asked for on a to-do
 * comes off on top. Payments go to the deal balance first. Never below zero.
 */
export function likelyDebtBalance(args: {
  debt: Debt
  payments: readonly DebtPaymentMade[]
  today: CivilDate
}): Cents {
  const { debt, payments, today } = args
  const paymentDay = debt.paymentDay ?? null
  if (paymentDay === null) {
    return balanceAfterPayments(
      debt.balanceCents,
      payments.map((p) => p.amountCents),
    )
  }

  const deals = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, debt.balanceAsOf) > 0)
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
  const total = () => standard + tranches.reduce((sum, t) => sum + t.balance, 0)
  const pay = (cents: Cents) => {
    let left = cents
    for (const t of tranches) {
      const take = Math.min(t.balance, left)
      t.balance -= take
      left -= take
    }
    standard -= Math.min(standard, left)
  }

  const monthOf = (d: CivilDate) => d.slice(0, 7)
  const paidRegularly = new Set(payments.filter((p) => p.regular).map((p) => monthOf(p.on)))

  type Step = { on: CivilDate; payment?: DebtPaymentMade }
  const steps: Step[] = payments.map((payment) => ({ on: payment.on, payment }))
  for (let month = 0; ; month += 1) {
    const due = paymentDateIn(addMonths(`${debt.balanceAsOf.slice(0, 7)}-01` as CivilDate, month), paymentDay)
    if (compareDates(due, today) > 0) break
    if (compareDates(due, debt.balanceAsOf) > 0) steps.push({ on: due })
  }
  // In date order; on the same day a payment marked done comes before the
  // assumed one, so the month's interest is charged on what is left.
  steps.sort((a, b) => compareDates(a.on, b.on) || (a.payment ? 0 : 1) - (b.payment ? 0 : 1))

  for (const step of steps) {
    if (step.payment) {
      pay(step.payment.amountCents)
      continue
    }
    for (let i = tranches.length - 1; i >= 0; i -= 1) {
      if (compareDates(tranches[i]!.untilDate, step.on) <= 0) {
        standard += tranches[i]!.balance
        tranches.splice(i, 1)
      }
    }
    if (total() <= 0) continue
    for (const t of tranches) t.balance += Math.round((t.balance * t.rateBasisPoints) / BASIS_POINTS / 12)
    standard += Math.round((standard * debt.aprBasisPoints) / BASIS_POINTS / 12)
    if (!paidRegularly.has(monthOf(step.on))) {
      pay(Math.min(total(), monthlyPaymentCents({ ...debt, balanceCents: total() })))
    }
  }
  return Math.max(0, total())
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
  paymentDay?: number | null
}): void {
  if (input.paymentDay != null && !(Number.isInteger(input.paymentDay) && input.paymentDay >= 1 && input.paymentDay <= 31)) {
    throw new DebtDataError('The payment day is a day of the month, 1 to 31.')
  }
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
  /** Told each month as it is worked out, for the debt's own page (D49 (11)). */
  onMonth?: (month: PayoffMonth) => void
}): {
  paidOffAfterMonths: number | null
  interestCents: Cents
  /** Each deal that ended unpaid and charged its interest back, and how much. */
  chargedBack: { untilDate: CivilDate; cents: Cents }[]
} {
  const { debt, extraPerMonthCents: extra } = args
  const limit = args.horizonMonths ?? MAX_MONTHS

  // Each live deal as its own running balance, soonest deadline first, with
  // whatever is not on a deal at the full rate.
  const deals = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, args.today) > 0)
    .sort((a, b) => compareDates(a.untilDate, b.untilDate))
  let standard = debt.balanceCents
  const tranches: {
    balance: Cents
    rateBasisPoints: number
    untilDate: CivilDate
    chargedBack: boolean
    /** Interest at the full rate on the deal balance, month by month since the deal started (D49 (9)). */
    backInterest: Cents
  }[] = []
  const fullMonth = (cents: Cents) => Math.round((cents * debt.aprBasisPoints) / BASIS_POINTS / 12)
  for (const rule of deals) {
    if (standard <= 0) break
    const amount = rule.appliesTo === 'full' ? standard : Math.min(rule.amountCents ?? 0, standard)
    if (amount <= 0) continue
    // The months before today, at the balance known now: Ballast has no
    // earlier one, so the figure is "about".
    const started = rule.startDate ?? debt.enteredOn ?? args.today
    tranches.push({
      balance: amount,
      rateBasisPoints: rule.rateBasisPoints,
      untilDate: rule.untilDate,
      chargedBack: rule.chargedBack !== false,
      backInterest: monthsBetween(started, args.today) * fullMonth(amount),
    })
    standard -= amount
  }

  let interest = 0
  const chargedBack: { untilDate: CivilDate; cents: Cents }[] = []
  for (let month = 1; month <= limit; month += 1) {
    // This month's payment lands on this date. A deal that ends before it
    // has rolled into the full-rate balance -- with the interest charged
    // back to its start, when it was not paid in full and its terms say so.
    // The same count of payments as the cliff's (months left x payment,
    // PRD §6), so the two never disagree about whether a deal is cleared.
    const paymentOn = addMonths(args.today, month)
    let backCharged = 0
    for (let i = tranches.length - 1; i >= 0; i -= 1) {
      const t = tranches[i]!
      if (compareDates(t.untilDate, paymentOn) < 0) {
        if (t.chargedBack && t.balance > 0) {
          standard += t.backInterest
          backCharged += t.backInterest
          chargedBack.push({ untilDate: t.untilDate, cents: t.backInterest })
        }
        standard += t.balance
        tranches.splice(i, 1)
      }
    }

    let charged = backCharged
    for (const t of tranches) {
      const c = Math.round((t.balance * t.rateBasisPoints) / BASIS_POINTS / 12)
      t.balance += c
      charged += c
      t.backInterest += fullMonth(t.balance)
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
    // Interest charged back is a one-off, not a month's cost, so it is no
    // sign the payment cannot keep up.
    if (payment <= charged - backCharged && extra === 0) {
      if (total <= POCKET_CHANGE_CENTS) return { paidOffAfterMonths: month, interestCents: interest, chargedBack }
      return { paidOffAfterMonths: null, interestCents: interest, chargedBack }
    }

    // Deal balances first, then the full-rate balance.
    let left = payment
    for (const t of tranches) {
      const take = Math.min(t.balance, left)
      t.balance -= take
      left -= take
    }
    standard -= Math.min(standard, left)
    args.onMonth?.({
      on: paymentOn,
      interestCents: charged,
      chargedBackCents: backCharged,
      paidCents: payment,
      balanceAfterCents: standard + tranches.reduce((sum, t) => sum + t.balance, 0),
    })

    if (standard + tranches.reduce((sum, t) => sum + t.balance, 0) <= 0) {
      return { paidOffAfterMonths: month, interestCents: interest, chargedBack }
    }
  }

  return { paidOffAfterMonths: null, interestCents: interest, chargedBack }
}

/**
 * The interest a deal will charge back when it ends unpaid (PRD D49 (9)), on
 * the payments set up now: the full rate on the deal balance month by month
 * from the deal's start (or the day the debt was entered) to its end. About,
 * because months before today are taken at the balance known now. Null when
 * the soonest deal will be cleared in time, or its terms charge nothing back.
 */
export function chargedBackInterestCents(debt: Debt, today: CivilDate): Cents | null {
  if (debt.balanceCents <= 0) return null
  const run = simulateMonths({ debt, today, extraPerMonthCents: 0 })
  const soonest = debt.promoRules
    .filter((rule) => compareDates(rule.untilDate, today) > 0)
    .sort((a, b) => compareDates(a.untilDate, b.untilDate))[0]
  if (!soonest) return null
  return run.chargedBack.find((c) => c.untilDate === soonest.untilDate)?.cents ?? null
}

/** Interest this debt will accrue over the next 12 months if left at minimums. */
export function interestOverNextYearCents(debt: Debt, today: CivilDate, _leadWeeks?: number): Cents {
  if (debt.balanceCents <= 0) return 0
  return simulateMonths({ debt, today, extraPerMonthCents: 0, horizonMonths: 12 }).interestCents
}

/**
 * Each figure as a share of the largest, 0-1, for a bar drawn beside it on
 * Debts ("Interest left to pay", D49 (10)): which debt costs the most is read
 * at a glance. Null stays null (a debt never paid off at its payment has no
 * figure to compare).
 */
export function shareOfLargest(values: readonly (Cents | null)[]): (number | null)[] {
  const largest = Math.max(0, ...values.filter((v): v is Cents => v !== null))
  return values.map((v) => (v === null ? null : largest === 0 ? 0 : v / largest))
}

/** One month of a debt's payoff, as `projectPayoff` works it out. */
export interface PayoffMonth {
  /** The day this month's payment lands. */
  on: CivilDate
  /** Interest charged this month, any charged back included. */
  interestCents: Cents
  /** Interest a deal that ended unpaid charged back this month (D49 (9)). */
  chargedBackCents: Cents
  paidCents: Cents
  balanceAfterCents: Cents
}

/**
 * The payoff month by month, on the payment set up now plus any extra: the
 * very months `projectPayoff` counts (D49 (11)), for the balance line and
 * the interest-against-paydown bars on a debt's page. Stops at payoff; a
 * debt its payment never pays off has no months, and its page says so.
 */
export function payoffSchedule(args: {
  debt: Debt
  today: CivilDate
  extraPerMonthCents?: Cents
}): PayoffMonth[] {
  const months: PayoffMonth[] = []
  if (args.debt.balanceCents <= 0) return months
  simulateMonths({
    debt: args.debt,
    today: args.today,
    extraPerMonthCents: args.extraPerMonthCents ?? 0,
    onMonth: (month) => months.push(month),
  })
  return months
}

/**
 * What paying more would do (D49 (11)): `extraPerMonthCents` on top of the
 * payment every month, or `onceCents` off the balance today. Each against
 * the payoff on the payment set up now.
 */
export function debtWhatIf(args: {
  debt: Debt
  today: CivilDate
  extraPerMonthCents?: Cents
  onceCents?: Cents
}): {
  now: Projection
  then: Projection
  /** The months after paying more, for the what-if line. */
  thenMonths: PayoffMonth[]
  monthsSooner: number | null
  interestSavedCents: Cents | null
} {
  const now = projectPayoff({ debt: args.debt, today: args.today })
  const once = Math.min(args.onceCents ?? 0, args.debt.balanceCents)
  const after = { ...args.debt, balanceCents: args.debt.balanceCents - once }
  const extra = args.extraPerMonthCents ?? 0
  const then = projectPayoff({ debt: after, today: args.today, extraPerMonthCents: extra })
  const bothPaid = now.months !== null && then.months !== null
  return {
    now,
    then,
    thenMonths: payoffSchedule({ debt: after, today: args.today, extraPerMonthCents: extra }),
    monthsSooner: bothPaid ? now.months! - then.months! : null,
    interestSavedCents: bothPaid ? now.totalInterestCents - then.totalInterestCents : null,
  }
}

/** One thing that happened to a debt, for its page's history (D49 (11)). */
export type DebtHistoryEntry =
  | { on: CivilDate; kind: 'stated'; amountCents: Cents }
  | { on: CivilDate; kind: 'paid' | 'paid_todo'; amountCents: Cents }
  | { on: CivilDate; kind: 'terms'; changed: string[] }

const TERM_WORDS: Record<string, string> = {
  name: 'name',
  category: 'kind',
  apr_basis_points: 'interest rate',
  min_payment_rule: 'minimum payment',
  promo_rules: 'deal',
  credit_limit_cents: 'credit limit',
  payment_day: 'payment day',
  planned_payment_cents: 'monthly payment',
  asset_id: 'home or vehicle it is secured on',
}

/** Which terms a `debt_updated` event changed, in plain words. */
export function debtTermsChanged(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(TERM_WORDS).filter(
    (key) => key in after && JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  ).map((key) => TERM_WORDS[key]!)
}

/** A bar on a debt's page: one month's payment, or one year's, split in two (D49 (11)). */
export interface PaymentSplit {
  /** "2027-03" for a month, "2031" for a year. */
  period: string
  paidCents: Cents
  /** What came off the balance: the payment less its interest, never below zero. */
  paydownCents: Cents
  interestCents: Cents
  chargedBackCents: Cents
}

/**
 * Each payment split into what paid the balance down and what was interest.
 * Months up to three years of them; past that, years, so a mortgage's bars
 * stay readable.
 */
export function paymentSplits(months: readonly PayoffMonth[]): PaymentSplit[] {
  const byYear = months.length > 36
  const groups = new Map<string, PaymentSplit>()
  for (const m of months) {
    const period = byYear ? m.on.slice(0, 4) : m.on.slice(0, 7)
    const g = groups.get(period) ?? { period, paidCents: 0, paydownCents: 0, interestCents: 0, chargedBackCents: 0 }
    g.paidCents += m.paidCents
    g.interestCents += m.interestCents
    g.chargedBackCents += m.chargedBackCents
    g.paydownCents = Math.max(0, g.paidCents - g.interestCents)
    groups.set(period, g)
  }
  return [...groups.values()]
}
