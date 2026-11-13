/**
 * Is a transfer worth it? (PRD D61)
 *
 * A card can carry a standing offer -- "0% on transfers for 18 months, 3%
 * fee" -- and a line of credit a lower rate than the cards. Asked about one
 * (a stored debt's offer, or a card typed on "Try a card"), this works out
 * how much to move, from which debts, what it saves after the fee, and how
 * much sooner the debts are paid off. Nothing here is stored and nothing
 * here is suggested on its own: it runs only when a person asks.
 *
 * The rules, each from the design (docs/superpowers/specs/
 * 2026-11-12-transfer-offers-design.md):
 *
 * - Current course and speed. Both sides run on the payment Ballast already
 *   uses for each debt (`monthlyPaymentCents`: planned, else the minimum).
 *   The payment the sources stop making goes to the target, as a fixed
 *   extra every month (`freedPerMonthCents`), so the same money goes out
 *   each month and only the interest and the fee differ.
 * - A 0% card holds only 0% money. A transfer lands as a deal on the
 *   target's whole balance, so the target must hold nothing when its offer
 *   ends; an offer that never ends is the debt's own rate, one rate on
 *   everything.
 * - Never moved: a balance on a live deal, an auto loan or a mortgage, or a
 *   debt that charges no more than the offer.
 * - Sources fill highest rate first. The amount recommended is the one that
 *   saves the most after the fee, tried in steps of at least $100; ties go
 *   to the smaller amount; when none saves money, none is recommended.
 * - The fee rounds up to the cent, so a saving is never overstated.
 * - Interest is to payoff on both sides; when any debt in any amount tried
 *   is never paid off on its payment, every amount is compared over the
 *   next ten years instead.
 *
 * Every month comes from the debts' own projection (`projectPayoff`,
 * `payoffSchedule`, `projectWithin`), so this screen and Debts can never
 * disagree about how a balance pays down.
 */

import { addMonths, compareDates, type CivilDate } from './dates'
import {
  currentDeal,
  isPaidOff,
  monthlyPaymentCents,
  offerEnds,
  payoffSchedule,
  projectPayoff,
  projectWithin,
  type Debt,
  type PromoRule,
  type TransferOffer,
} from './debt'
import type { Cents } from './money'

/** The window every amount is compared over when something is never paid off (D61). */
export const TRANSFER_HORIZON_MONTHS = 120
/** The finest step between amounts tried: $100. */
export const TRANSFER_STEP_CENTS = 10_000
/** At most this many amounts are tried; the step widens past it. */
const MAX_AMOUNTS_TRIED = 100

const BASIS_POINTS = 10_000

/** Why a debt cannot take a transfer. */
export type TransferRefusal =
  | { kind: 'no_offer' }
  | { kind: 'not_consumer' }
  /** It is on a deal already; a second would put two end dates on one card. */
  | { kind: 'on_deal'; until: CivilDate }
  /** It holds money at its full rate, and the offer would put a second rate beside it. */
  | { kind: 'mixes_rates'; balanceCents: Cents; aprBasisPoints: number }
  /** No credit limit is known, so there is no room to reason about. */
  | { kind: 'needs_limit' }
  | { kind: 'no_room'; limitCents: Cents; balanceCents: Cents }
  /** The offer's end date has passed. */
  | { kind: 'offer_over'; until: CivilDate }

/** Why a debt gives no money. */
export type LeftOutReason =
  | { kind: 'on_deal'; until: CivilDate; rateBasisPoints: number }
  | { kind: 'not_consumer' }
  | { kind: 'cheaper'; aprBasisPoints: number }

export interface TransferMove {
  debt: Debt
  amountCents: Cents
  /** Its payment a month today, before and after the move. */
  paymentBeforeCents: Cents
  paymentAfterCents: Cents
}

export interface TransferResult {
  amountCents: Cents
  feeCents: Cents
  /** What the moved debts stop paying a month, which goes to the target. */
  freedPerMonthCents: Cents
  moves: TransferMove[]
  interestWithoutCents: Cents
  interestWithCents: Cents
  /** Interest saved less the fee: interest without − (interest with + fee). */
  netSavingsCents: Cents
  /** Null: interest to payoff. A number: interest over that many months. */
  horizonMonths: number | null
  /** Months until the last debt involved is paid off; null when one never is. */
  monthsWithout: number | null
  monthsWith: number | null
  monthsSooner: number | null
  perDebt: { name: string; monthsWithout: number | null; monthsWith: number | null }[]
  /** The target as it would stand the day after the move. */
  targetAfter: Debt
  /** The deal the transfer lands on, when the offer ends. */
  deal: {
    endsOn: CivilDate
    rateBasisPoints: number
    /** What is still on it the day the rate ends, on the payments above. 0: it clears. */
    leftAtEndCents: Cents
    /** The monthly payment that clears it in time, rounded up to the dollar; null with no payment before the end. */
    clearsAtPerMonthCents: Cents | null
  } | null
}

export interface TransferCheck {
  refused: TransferRefusal | null
  leftOut: { debt: Debt; reason: LeftOutReason }[]
  /** The debts that can give money, in the order they fill. */
  sources: Debt[]
  /** Credit limit less the target's balance today. */
  roomCents: Cents | null
  /** The most that fits, with its fee, in the room and the sources. */
  mostCents: Cents
  /** The amount that saves the most; null when none saves money. */
  recommendedCents: Cents | null
  /** What was typed, and why it was not used as typed. */
  typed: { cents: Cents; problem: 'over_most' | 'not_positive' | null } | null
  /** The figures for the typed amount, else the recommended one, else the most. Null when nothing fits. */
  result: TransferResult | null
}

/** The fee on moving `amountCents`: the offer's share rounded up to the cent, never below its minimum. */
export function transferFeeCents(offer: Pick<TransferOffer, 'feeBasisPoints' | 'feeMinCents'>, amountCents: Cents): Cents {
  if (amountCents <= 0) return 0
  const share = Math.ceil((amountCents * offer.feeBasisPoints) / BASIS_POINTS)
  return Math.max(offer.feeMinCents ?? 0, share)
}

/** The day the offer's rate ends, counted from `today` for an offer of months; null for one that never ends. */
export function offerEndsOn(offer: TransferOffer, today: CivilDate): CivilDate | null {
  if (offer.untilDate !== undefined) return offer.untilDate
  if (offer.months !== undefined) return addMonths(today, offer.months)
  return null
}

/** The rate on what is moved: the offer's while it lasts, or the debt's own for one that never ends. */
export function offerRateBasisPoints(offer: TransferOffer, target: Pick<Debt, 'aprBasisPoints'>): number {
  return offerEnds(offer) ? (offer.rateBasisPoints ?? 0) : target.aprBasisPoints
}

const empty = (refused: TransferRefusal, roomCents: Cents | null = null): TransferCheck => ({
  refused,
  leftOut: [],
  sources: [],
  roomCents,
  mostCents: 0,
  recommendedCents: null,
  typed: null,
  result: null,
})

/**
 * Work the transfer out. `target` is a stored debt with an offer, or an
 * imagined card (Try a card) with the same shape; `debts` is every debt the
 * household has, the target included or not. `limitCents` stands in for a
 * stored target's missing credit limit, for this one calculation.
 */
export function transferCheck(args: {
  debts: readonly Debt[]
  target: Debt
  today: CivilDate
  amountCents?: Cents | null
  limitCents?: Cents | null
}): TransferCheck {
  const { target, today } = args
  const offer = target.transferOffer
  if (!offer) return empty({ kind: 'no_offer' })
  if (target.category !== 'consumer') return empty({ kind: 'not_consumer' })
  const live = currentDeal(target, today)
  if (live && target.balanceCents > 0) return empty({ kind: 'on_deal', until: live.untilDate })
  const endsOn = offerEndsOn(offer, today)
  if (endsOn !== null && compareDates(endsOn, today) <= 0) return empty({ kind: 'offer_over', until: endsOn })
  if (offerEnds(offer) && target.balanceCents > 0) {
    return empty({ kind: 'mixes_rates', balanceCents: target.balanceCents, aprBasisPoints: target.aprBasisPoints })
  }
  const limit = target.creditLimitCents || args.limitCents || null
  if (!limit) return empty({ kind: 'needs_limit' })
  const roomCents = limit - Math.max(0, target.balanceCents)
  if (roomCents <= 0) return empty({ kind: 'no_room', limitCents: limit, balanceCents: target.balanceCents }, Math.max(0, roomCents))

  const rate = offerRateBasisPoints(offer, target)
  const leftOut: { debt: Debt; reason: LeftOutReason }[] = []
  const sources: Debt[] = []
  for (const debt of args.debts) {
    if (debt.id === target.id || isPaidOff(debt)) continue
    const deal = currentDeal(debt, today)
    if (debt.category !== 'consumer') leftOut.push({ debt, reason: { kind: 'not_consumer' } })
    else if (deal) leftOut.push({ debt, reason: { kind: 'on_deal', until: deal.untilDate, rateBasisPoints: deal.rateBasisPoints } })
    else if (debt.aprBasisPoints <= rate) leftOut.push({ debt, reason: { kind: 'cheaper', aprBasisPoints: debt.aprBasisPoints } })
    else sources.push(debt)
  }
  sources.sort(
    (a, b) => b.aprBasisPoints - a.aprBasisPoints || b.balanceCents - a.balanceCents || a.name.localeCompare(b.name),
  )

  const mostCents = mostThatFits(offer, roomCents, sources.reduce((sum, d) => sum + d.balanceCents, 0))
  const base = { refused: null, leftOut, sources, roomCents }
  if (mostCents <= 0) return { ...base, mostCents: 0, recommendedCents: null, typed: null, result: null }

  const typedCents = args.amountCents ?? null
  const typed =
    typedCents === null
      ? null
      : { cents: typedCents, problem: typedCents <= 0 ? ('not_positive' as const) : typedCents > mostCents ? ('over_most' as const) : null }

  const tried = amountsToTry(mostCents)
  const context: Context = { sources, target, offer, today, endsOn, rate, without: new Map() }
  // To payoff first. An amount that leaves a debt never paid off on its
  // payment is not recommended while another clears everything; when none
  // does, every amount is compared over the same ten years instead.
  let horizon: number | null = null
  let results = tried.map((amount) => evaluate(context, amount, null))
  let eligible = results.filter(paysOff)
  if (eligible.length === 0) {
    horizon = TRANSFER_HORIZON_MONTHS
    results = tried.map((amount) => evaluate(context, amount, horizon))
    eligible = results
  }
  let best: TransferResult | null = null
  for (const r of eligible) if (best === null || r.netSavingsCents > best.netSavingsCents) best = r
  const recommendedCents = best && best.netSavingsCents > 0 ? best.amountCents : null

  const chosen =
    typed && typed.problem === null ? typed.cents : typed?.problem === 'over_most' ? mostCents : (recommendedCents ?? mostCents)
  let result = evaluate(context, chosen, horizon)
  if (horizon === null && !paysOff(result)) result = evaluate(context, chosen, TRANSFER_HORIZON_MONTHS)
  result.deal = endsOn === null ? null : dealAtEnd(context, result)
  return { ...base, mostCents, recommendedCents, typed, result }
}

const paysOff = (r: TransferResult) => r.monthsWithout !== null && r.monthsWith !== null

/**
 * The most that can move: every source's whole balance when it fits with
 * its fee, else the largest whole dollar whose amount and fee fit the room.
 */
function mostThatFits(offer: TransferOffer, roomCents: Cents, availableCents: Cents): Cents {
  if (availableCents <= 0) return 0
  if (availableCents + transferFeeCents(offer, availableCents) <= roomCents) return availableCents
  const dollar = 100
  let amount = Math.floor((roomCents * BASIS_POINTS) / (BASIS_POINTS + offer.feeBasisPoints) / dollar) * dollar
  amount = Math.min(amount, Math.floor(availableCents / dollar) * dollar)
  while (amount > 0 && amount + transferFeeCents(offer, amount) > roomCents) {
    // A fee minimum can be most of a small room: step down to what fits.
    const over = amount + transferFeeCents(offer, amount) - roomCents
    amount -= Math.max(dollar, Math.ceil(over / dollar) * dollar)
  }
  return Math.max(0, amount)
}

/** The amounts tried: one step and its multiples below the most, and the most. */
function amountsToTry(mostCents: Cents): Cents[] {
  const step = Math.max(TRANSFER_STEP_CENTS, Math.ceil(mostCents / MAX_AMOUNTS_TRIED / TRANSFER_STEP_CENTS) * TRANSFER_STEP_CENTS)
  const amounts: Cents[] = []
  for (let amount = step; amount < mostCents; amount += step) amounts.push(amount)
  amounts.push(mostCents)
  return amounts
}

interface Context {
  sources: readonly Debt[]
  target: Debt
  offer: TransferOffer
  today: CivilDate
  endsOn: CivilDate | null
  rate: number
  /** Each debt's own projection without the move, worked out once. */
  without: Map<string, { months: number | null; interestCents: Cents }>
}

/** The figures for moving `amountCents`, to payoff (`horizon` null) or over `horizon` months. */
function evaluate(context: Context, amountCents: Cents, horizon: number | null): TransferResult {
  const { target, offer, today, endsOn } = context
  const feeCents = transferFeeCents(offer, amountCents)

  const moves: TransferMove[] = []
  let left = amountCents
  for (const debt of context.sources) {
    if (left <= 0) break
    const take = Math.min(debt.balanceCents, left)
    left -= take
    const after = { ...debt, balanceCents: debt.balanceCents - take }
    moves.push({
      debt,
      amountCents: take,
      paymentBeforeCents: monthlyPaymentCents(debt, today),
      paymentAfterCents: after.balanceCents > 0 ? monthlyPaymentCents(after, today) : 0,
    })
  }
  const freedPerMonthCents = moves.reduce((sum, m) => sum + Math.max(0, m.paymentBeforeCents - m.paymentAfterCents), 0)

  const deal: PromoRule[] =
    endsOn === null
      ? []
      : [{ rateBasisPoints: context.rate, appliesTo: 'full', untilDate: endsOn, chargedBack: offer.chargedBack ?? false, startDate: today }]
  const targetAfter: Debt = {
    ...target,
    balanceCents: Math.max(0, target.balanceCents) + amountCents + feeCents,
    balanceAsOf: today,
    promoRules: deal,
  }

  // One projection per debt: its months, and its interest to payoff or
  // over the horizon.
  const project = (debt: Debt, extra = 0): { months: number | null; interestCents: Cents } => {
    if (debt.balanceCents <= 0) return { months: 0, interestCents: 0 }
    const run = projectPayoff({ debt, today, extraPerMonthCents: extra })
    return {
      months: run.months,
      interestCents:
        horizon === null
          ? run.totalInterestCents
          : projectWithin({ debt, today, extraPerMonthCents: extra, horizonMonths: horizon }).interestCents,
    }
  }
  const without = (debt: Debt) => {
    const key = `${debt.id}|${horizon}`
    let known = context.without.get(key)
    if (!known) context.without.set(key, (known = project(debt)))
    return known
  }

  const t0 = without(target)
  const t1 = project(targetAfter, freedPerMonthCents)
  const perDebt: TransferResult['perDebt'] = [{ name: target.name, monthsWithout: t0.months, monthsWith: t1.months }]
  let interestWithoutCents = t0.interestCents
  let interestWithCents = t1.interestCents
  for (const move of moves) {
    const s0 = without(move.debt)
    const s1 = project({ ...move.debt, balanceCents: move.debt.balanceCents - move.amountCents })
    interestWithoutCents += s0.interestCents
    interestWithCents += s1.interestCents
    perDebt.push({ name: move.debt.name, monthsWithout: s0.months, monthsWith: s1.months })
  }
  const latest = (pick: (d: (typeof perDebt)[number]) => number | null) =>
    perDebt.some((d) => pick(d) === null) ? null : Math.max(...perDebt.map((d) => pick(d)!))
  const monthsWithout = latest((d) => d.monthsWithout)
  const monthsWith = latest((d) => d.monthsWith)

  return {
    amountCents,
    feeCents,
    freedPerMonthCents,
    moves,
    interestWithoutCents,
    interestWithCents,
    netSavingsCents: interestWithoutCents - (interestWithCents + feeCents),
    horizonMonths: horizon,
    monthsWithout,
    monthsWith,
    monthsSooner: monthsWithout !== null && monthsWith !== null ? monthsWithout - monthsWith : null,
    perDebt,
    targetAfter,
    deal: null,
  }
}

/** What is left on the deal the day it ends, and the monthly payment that would clear it in time. */
function dealAtEnd(context: Context, result: TransferResult): NonNullable<TransferResult['deal']> {
  const { today } = context
  const endsOn = context.endsOn!
  const targetAfter = result.targetAfter
  // The payments that land on or before the end are the deal's: the same
  // count as the projection's, which rolls a deal off before the first
  // payment after its end.
  let payments = 0
  while (compareDates(addMonths(today, payments + 1), endsOn) <= 0) payments += 1
  let leftAtEndCents = targetAfter.balanceCents
  if (payments > 0) {
    const schedule = payoffSchedule({ debt: targetAfter, today, extraPerMonthCents: result.freedPerMonthCents })
    leftAtEndCents = schedule.length < payments ? 0 : schedule[payments - 1]!.balanceAfterCents
  }
  const dollar = 100
  return {
    endsOn,
    rateBasisPoints: context.rate,
    leftAtEndCents,
    clearsAtPerMonthCents: payments > 0 ? Math.ceil(targetAfter.balanceCents / payments / dollar) * dollar : null,
  }
}

/** "2 years 3 months", "5 months", "1 month": a count of months in words. */
export function monthsInWords(months: number): string {
  const years = Math.floor(months / 12)
  const rest = months % 12
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (years === 0) return part(rest, 'month')
  return rest === 0 ? part(years, 'year') : `${part(years, 'year')} ${part(rest, 'month')}`
}
