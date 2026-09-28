/**
 * Rate components (PRD §5): a sum of money delivered evenly over the
 * transfer days in a window. Pure functions over facts -- no I/O, no clock.
 *
 * Since D35 no component sets a figure on screen: the weekly amount, what an
 * account holds, and how every part stands are the one position's
 * (`position.ts`). What remains here is the arithmetic the position builds
 * on -- how much a window has delivered by a date, the steady line
 * (`evenPaceCents`), and the bumps and cuts a person confirmed before D35,
 * which still change what the bank moves until they end.
 *
 * A component carries its exact TOTAL in cents plus its week count, and the
 * weekly rate is derived from those. Storing a rounded weekly rate instead
 * would lose cents -- $600 over 7 weeks at a rounded $85.71/wk arrives $0.03
 * short -- so holding the exact total keeps "delivers exactly its total by
 * its end date" exact. Displayed rates round UP (see money.ts), so an
 * instruction handed to a human is never a cent short.
 *
 * A week is one transfer, and the day the transfer runs is the household's
 * (PRD D31). Every function here that counts weeks takes it as
 * `transferWeekday`; it defaults to Saturday so pure tests can leave it out.
 */

import {
  accrualWeeksBetween,
  compareDates,
  DEFAULT_TRANSFER_WEEKDAY,
  maxDate,
  minDate,
  transferWeeksBetween,
  type CivilDate,
  type Weekday,
} from './dates'
import { ceilDiv, proratedCeil, type Cents } from './money'
import { previousOccurrence, type Recurrence } from './recurrence'
import type { DriftAdjustment, Id, TimelineStart } from './types'

/**
 * 'base' is a steady line (the pace, `evenPaceCents`); 'catch_up' is a bump
 * or cut confirmed before D35.
 */
export type ComponentKind = 'base' | 'catch_up'

export interface RateComponent {
  kind: ComponentKind
  lineItemId: Id | null // null for an account-level drift adjustment
  reserveAccountId: Id
  startDate: CivilDate
  endDate: CivilDate
  /** Exact total this component delivers over its window. Negative = a reduction. */
  amountCents: Cents
  /** Transfer weeks in (startDate, endDate], minimum 1. */
  weeks: number
}

/** The weekly figure for one component, rounded up so it never under-funds. */
export function componentRatePerWeekCents(c: RateComponent): Cents {
  return ceilDiv(c.amountCents, c.weeks)
}

/**
 * What a component has delivered by `asOf`. Exact at both endpoints.
 *
 * On or after the end date a component has delivered everything, by definition:
 * the money is due. That is stated explicitly rather than falling out of the
 * week count, because a window can contain no transfer day at all -- an item
 * due before the next transfer -- and such a component still has to be fully
 * funded by its due date. It reads as a single immediate move, which is what
 * `accrualWeeksBetween`'s one-week floor already prices it as.
 */
export function componentDeliveredBy(
  c: RateComponent,
  asOf: CivilDate,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): Cents {
  if (compareDates(asOf, c.endDate) >= 0) return c.amountCents
  return proratedCeil(
    c.amountCents,
    transferWeeksBetween(c.startDate, asOf, transferWeekday),
    c.weeks,
  )
}

/** What a component will still deliver in (from, to]. Used to price an edit's delta. */
export function componentDeliveredBetween(
  c: RateComponent,
  from: CivilDate,
  to: CivilDate,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): Cents {
  const start = maxDate(from, c.startDate)
  const end = minDate(to, c.endDate)
  if (compareDates(end, start) <= 0) return 0
  return (
    componentDeliveredBy(c, end, transferWeekday) - componentDeliveredBy(c, start, transferWeekday)
  )
}

/** Is this component still asking for transfers after `asOf`? */
export function isComponentActive(
  c: RateComponent,
  asOf: CivilDate,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): boolean {
  return transferWeeksBetween(maxDate(asOf, c.startDate), c.endDate, transferWeekday) > 0
}

function buildComponent(args: {
  kind: ComponentKind
  lineItemId: Id | null
  reserveAccountId: Id
  startDate: CivilDate
  endDate: CivilDate
  amountCents: Cents
  transferWeekday: Weekday
}): RateComponent {
  const { transferWeekday, ...component } = args
  return {
    ...component,
    weeks: accrualWeeksBetween(args.startDate, args.endDate, transferWeekday),
  }
}

export function driftAdjustmentComponent(
  a: DriftAdjustment,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): RateComponent {
  return buildComponent({
    kind: 'catch_up',
    lineItemId: null,
    reserveAccountId: a.reserveAccountId,
    startDate: a.startDate,
    endDate: a.endDate,
    amountCents: a.amountCents,
    transferWeekday,
  })
}

/**
 * Where the money would be today had it been saved evenly over a window,
 * from `fromDate` to the due date: the pace. Priced with the same base
 * component a committed item gets, so "should be here by now" and "is here"
 * are one arithmetic. Nothing before the window opens; all of it once the
 * due date is here; never more than the total.
 *
 * This is the one definition of the pace (PRD §6). The opening suggested
 * for a recurring part, the progress bar's tick, and the reshuffle's first
 * pass all read it; none re-derives it.
 */
export function evenPaceCents(args: {
  totalCents: Cents
  fromDate: CivilDate
  dueDate: CivilDate
  today: CivilDate
  transferWeekday?: Weekday
}): Cents {
  if (args.totalCents <= 0) return 0
  if (compareDates(args.dueDate, args.today) <= 0) return args.totalCents
  if (compareDates(args.fromDate, args.today) >= 0) return 0
  const transferWeekday = args.transferWeekday ?? DEFAULT_TRANSFER_WEEKDAY
  const component: RateComponent = {
    kind: 'base',
    lineItemId: null,
    reserveAccountId: '',
    startDate: args.fromDate,
    endDate: args.dueDate,
    amountCents: args.totalCents,
    weeks: accrualWeeksBetween(args.fromDate, args.dueDate, transferWeekday),
  }
  return Math.max(
    0,
    Math.min(componentDeliveredBy(component, args.today, transferWeekday), args.totalCents),
  )
}

/**
 * What a recurring item would already have set aside, had the household been
 * saving for it since the last time it came round.
 *
 * A plan entered as "every year, next due 15 February" carries its own history:
 * the previous one was a year before that, and a household saving steadily
 * since then would be part-way there by now. Offering that figure turns a plan
 * that starts at $0 -- and therefore demands a year's saving in the months that
 * remain -- into one that starts where the money actually is.
 *
 * It is a suggestion, never an assertion: the money is only there if the
 * household says it is, so nothing here writes anything. Returns null when
 * there is nothing to suggest -- a one-off, a cycle that has not started, or
 * a part whose timeline already starts at its last occurrence (D30) or at a
 * day a person gave (D33): its
 * should-hold carries the elapsed share by itself, and an opening on such a
 * part is only money genuinely set aside, which nobody should be told.
 */
export function openingSinceLastOccurrence(args: {
  totalCents: Cents
  dueDate: CivilDate
  recurrence: Recurrence | null
  today: CivilDate
  /** Absent reads as 'commit', the setting under which the offer makes sense. */
  timelineStart?: TimelineStart
  transferWeekday?: Weekday
}): { lastOccurrence: CivilDate; cents: Cents } | null {
  // Under 'last_occurrence' or 'typed' (D30, D33) should-hold already carries
  // the elapsed share; only a part starting at the commit is offered one.
  if (args.timelineStart && args.timelineStart !== 'commit') return null
  const last = previousOccurrence(args.dueDate, args.recurrence)
  if (!last) return null
  // The cycle has not begun: there is no elapsed time to have saved over.
  if (compareDates(last, args.today) >= 0) return null
  if (args.totalCents <= 0) return null

  const cents = evenPaceCents({
    totalCents: args.totalCents,
    fromDate: last,
    dueDate: args.dueDate,
    today: args.today,
    transferWeekday: args.transferWeekday,
  })
  return cents > 0 ? { lastOccurrence: last, cents } : null
}
