/**
 * The accrual engine (PRD §5). Pure functions over facts -- no I/O, no clock.
 *
 * Model (D2): a line item's savings plan is a set of rate COMPONENTS, each
 * running over its own window. At commit one `base` component spreads the whole
 * amount from the commit date to the due date. Every later edit leaves existing
 * components untouched and adds one `catch_up` component covering only the delta,
 * spread from the edit date to the due date. That is what keeps the ongoing
 * transfer stable and makes every adjustment visible and dated, rather than
 * silently re-blending one number.
 *
 * A component carries its exact TOTAL in cents plus its week count, and the
 * weekly rate is derived from those. Storing a rounded weekly rate instead would
 * lose cents -- $600 over 7 weeks at a rounded $85.71/wk arrives $0.03 short --
 * and the shortfall would compound across edits. Holding the exact total makes
 * the central invariant exact:
 *
 *     components always deliver exactly the line item's total by its due date
 *
 * Displayed rates then round UP (see money.ts), so an instruction handed to a
 * human is never a cent short of the plan.
 */

import {
  accrualWeeksBetween,
  compareDates,
  maxDate,
  minDate,
  transferWeeksBetween,
  type CivilDate,
} from './dates'
import { ceilDiv, proratedCeil, roundUpToStep, type Cents } from './money'
import { previousOccurrence, type Recurrence } from './recurrence'
import {
  lineItemTotalCents,
  type DriftAdjustment,
  type Id,
  type LineItem,
  type LineItemChange,
  type LineItemSnapshot,
} from './types'

/**
 * 'opening' is money the household already had when the cycle began. It is a
 * component so that every other calculation — delivery, the edit delta, the
 * curve, the invariant — works on it unchanged, with no special case. It has a
 * zero-length window, so it counts as delivered immediately and never appears
 * in a weekly transfer figure.
 */
export type ComponentKind = 'base' | 'catch_up' | 'opening'

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
 * week count, because a window can contain no Saturday at all -- an item due
 * before the next transfer date -- and such a component still has to be fully
 * funded by its due date. It reads as a single immediate move, which is what
 * `accrualWeeksBetween`'s one-week floor already prices it as.
 */
export function componentDeliveredBy(c: RateComponent, asOf: CivilDate): Cents {
  if (compareDates(asOf, c.endDate) >= 0) return c.amountCents
  return proratedCeil(c.amountCents, transferWeeksBetween(c.startDate, asOf), c.weeks)
}

/** What a component will still deliver in (from, to]. Used to price an edit's delta. */
export function componentDeliveredBetween(
  c: RateComponent,
  from: CivilDate,
  to: CivilDate,
): Cents {
  const start = maxDate(from, c.startDate)
  const end = minDate(to, c.endDate)
  if (compareDates(end, start) <= 0) return 0
  return componentDeliveredBy(c, end) - componentDeliveredBy(c, start)
}

/** Is this component still asking for transfers after `asOf`? */
export function isComponentActive(c: RateComponent, asOf: CivilDate): boolean {
  return transferWeeksBetween(maxDate(asOf, c.startDate), c.endDate) > 0
}

function buildComponent(args: {
  kind: ComponentKind
  lineItemId: Id | null
  reserveAccountId: Id
  startDate: CivilDate
  endDate: CivilDate
  amountCents: Cents
}): RateComponent {
  return { ...args, weeks: accrualWeeksBetween(args.startDate, args.endDate) }
}

function snapshotTotal(s: LineItemSnapshot): Cents {
  return s.unitAmountCents * s.quantity
}

/**
 * Derive a line item's components from its commit date and its edit history.
 *
 * `commitDate` is the package's committed_at for a live package, or today for a
 * simulated one (the what-if overlay prices a package as if committed now).
 *
 * The delta at each edit is measured against what the existing components will
 * actually have delivered by the NEW due date -- not against the old total. That
 * single rule handles every case with one formula:
 *
 *   - amount or quantity rises  -> positive catch-up for the increase
 *   - amount or quantity falls  -> negative catch-up, shown as a reduction
 *   - due date pulled EARLIER   -> positive catch-up, because the base component
 *                                  can no longer deliver its full amount in time
 *   - due date pushed LATER     -> zero delta; the existing plan still funds it,
 *                                  and it simply finishes early
 */
export function componentsForLineItem(args: {
  lineItem: LineItem
  commitDate: CivilDate
  changes?: readonly LineItemChange[]
  /**
   * When the current cycle began: the date this item was last confirmed spent.
   * A recurring item that has just been paid starts again at zero, so anything
   * before this date belongs to a settled cycle and must not affect the new
   * one's math.
   */
  cycleStartDate?: CivilDate
  /** Money already set aside for this item when the cycle began. */
  openingCents?: Cents
}): RateComponent[] {
  const { lineItem } = args
  const commitDate = args.cycleStartDate
    ? maxDate(args.commitDate, args.cycleStartDate)
    : args.commitDate

  const changes = [...(args.changes ?? [])]
    .filter((c) => c.lineItemId === lineItem.id)
    // Edits made during a settled cycle are history, not part of this plan.
    .filter((c) => compareDates(c.occurredAt, commitDate) >= 0)
    .sort((a, b) => compareDates(a.occurredAt, b.occurredAt))

  // State at commit is the state before the first edit, or the current state if none.
  const first = changes[0]
  const atCommit: LineItemSnapshot = first
    ? first.before
    : {
        unitAmountCents: lineItem.unitAmountCents,
        quantity: lineItem.quantity,
        dueDate: lineItem.dueDate,
        reserveAccountId: lineItem.reserveAccountId,
      }

  // An opening balance cannot exceed what the item costs; the surplus is the
  // account's business, not this line item's.
  const openingCents = Math.max(0, Math.min(args.openingCents ?? 0, snapshotTotal(atCommit)))

  const components: RateComponent[] = []

  if (openingCents > 0) {
    components.push({
      kind: 'opening',
      lineItemId: lineItem.id,
      reserveAccountId: atCommit.reserveAccountId,
      startDate: commitDate,
      endDate: commitDate,
      amountCents: openingCents,
      weeks: 1,
    })
  }

  components.push(
    buildComponent({
      kind: 'base',
      lineItemId: lineItem.id,
      reserveAccountId: atCommit.reserveAccountId,
      startDate: commitDate,
      endDate: maxDate(atCommit.dueDate, commitDate),
      amountCents: snapshotTotal(atCommit) - openingCents,
    }),
  )

  for (const change of changes) {
    // An edit before the package was committed just moves the starting plan.
    const editDate = maxDate(change.occurredAt, commitDate)
    const newTotal = snapshotTotal(change.after)
    const newDue = maxDate(change.after.dueDate, editDate)

    const delivered = components.reduce((sum, c) => sum + componentDeliveredBy(c, editDate), 0)
    const scheduled = components.reduce(
      (sum, c) => sum + componentDeliveredBetween(c, editDate, newDue),
      0,
    )
    const delta = newTotal - delivered - scheduled

    if (delta !== 0) {
      components.push(
        buildComponent({
          kind: 'catch_up',
          lineItemId: lineItem.id,
          reserveAccountId: change.after.reserveAccountId,
          startDate: editDate,
          endDate: newDue,
          amountCents: delta,
        }),
      )
    }
  }

  return components
}

export function driftAdjustmentComponent(a: DriftAdjustment): RateComponent {
  return buildComponent({
    kind: 'catch_up',
    lineItemId: null,
    reserveAccountId: a.reserveAccountId,
    startDate: a.startDate,
    endDate: a.endDate,
    amountCents: a.amountCents,
  })
}

/**
 * Should-have-saved at `asOf` for one line item (PRD §5), capped at its total so
 * a plan can never claim more is owed than the item costs.
 */
export function shouldHaveSavedForItem(
  components: readonly RateComponent[],
  asOf: CivilDate,
  capCents: Cents,
): Cents {
  const raw = components.reduce((sum, c) => sum + componentDeliveredBy(c, asOf), 0)
  return Math.max(0, Math.min(raw, capCents))
}

/** Should-have-saved across a set of components with no single cap (account rollup). */
export function shouldHaveSaved(components: readonly RateComponent[], asOf: CivilDate): Cents {
  return components.reduce((sum, c) => sum + componentDeliveredBy(c, asOf), 0)
}

export interface CatchUpGroup {
  endDate: CivilDate
  perWeekCents: Cents
}

export interface WeeklyBreakdown {
  /** The exact weekly figure: the sum of the parts below. */
  totalPerWeekCents: Cents
  /**
   * The number to put into the bank: the total, rounded up to the household's
   * step (nearest $10 by default) so small plan changes do not mean editing
   * the recurring transfer. Equals the total when no step applies.
   */
  transferPerWeekCents: Cents
  /** Base components: the stable, ongoing set-aside. */
  ongoingPerWeekCents: Cents
  /**
   * Catch-up components grouped by the date they stop, soonest first. A
   * negative group is an accepted cut: the account was ahead and is easing
   * off until the extra is used up.
   */
  catchUp: CatchUpGroup[]
}

/**
 * The display decomposition required everywhere a weekly number appears (PRD §5):
 * "Move $W/week: $X ongoing + $Y catch-up until {date}."
 *
 * Each part is rounded up independently and the total is the sum of the rounded
 * parts, so the parts a reader adds up always equal the headline number.
 */
export function weeklyBreakdown(
  components: readonly RateComponent[],
  asOf: CivilDate,
  /** Round the bank figure up to this step; 0 or absent means exact. */
  roundUpToCents: Cents = 0,
): WeeklyBreakdown {
  const active = components.filter((c) => isComponentActive(c, asOf))

  const ongoingPerWeekCents = active
    .filter((c) => c.kind === 'base')
    .reduce((sum, c) => sum + componentRatePerWeekCents(c), 0)

  const byEndDate = new Map<CivilDate, Cents>()
  for (const c of active.filter((x) => x.kind === 'catch_up')) {
    byEndDate.set(c.endDate, (byEndDate.get(c.endDate) ?? 0) + componentRatePerWeekCents(c))
  }

  const catchUp = [...byEndDate.entries()]
    .map(([endDate, perWeekCents]) => ({ endDate, perWeekCents }))
    .filter((g) => g.perWeekCents !== 0)
    .sort((a, b) => compareDates(a.endDate, b.endDate))

  const totalPerWeekCents = ongoingPerWeekCents + catchUp.reduce((s, g) => s + g.perWeekCents, 0)
  return {
    ongoingPerWeekCents,
    catchUp,
    totalPerWeekCents,
    transferPerWeekCents: roundUpToStep(totalPerWeekCents, roundUpToCents),
  }
}

/**
 * The single blended number a pure re-spread would give: remaining / weeks left.
 * Shown in a tooltip for anyone who wants it (PRD §5), never used to drive a
 * transfer -- the committed plan is the component set, not this.
 */
export function respreadEquivalentPerWeekCents(args: {
  remainingCents: Cents
  asOf: CivilDate
  dueDate: CivilDate
}): Cents {
  if (args.remainingCents <= 0) return 0
  return ceilDiv(args.remainingCents, accrualWeeksBetween(args.asOf, args.dueDate))
}

export interface CurvePoint {
  date: CivilDate
  cents: Cents
}

/**
 * The should-have-saved curve, sampled at the dates money actually moves.
 *
 * Sampled per transfer week rather than per day: the curve is a step function --
 * nothing changes between Saturdays -- so daily sampling would invent smoothness
 * the plan does not have and make the chart lie about when money appears.
 */
export function accrualCurve(args: {
  components: readonly RateComponent[]
  from: CivilDate
  to: CivilDate
  capCents?: Cents
  /** Keep the point count sane over long horizons. */
  maxPoints?: number
}): CurvePoint[] {
  const { components, from, to } = args
  const totalWeeks = transferWeeksBetween(from, to)
  if (totalWeeks <= 0) {
    return [{ date: from, cents: 0 }]
  }

  const maxPoints = args.maxPoints ?? 60
  const stride = Math.max(1, Math.ceil(totalWeeks / maxPoints))

  const points: CurvePoint[] = []
  const value = (at: CivilDate) =>
    args.capCents !== undefined
      ? shouldHaveSavedForItem(components, at, args.capCents)
      : shouldHaveSaved(components, at)

  points.push({ date: from, cents: value(from) })

  for (let week = stride; week <= totalWeeks; week += stride) {
    const date = advanceWeeks(from, week)
    points.push({ date, cents: value(date) })
  }

  // Always land exactly on the end date, whatever the stride did.
  const last = points.at(-1)
  if (!last || last.date !== to) points.push({ date: to, cents: value(to) })

  return points
}

/** The date `weeks` transfer-weeks after `from`. */
function advanceWeeks(from: CivilDate, weeks: number): CivilDate {
  const base = new Date(`${from}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + weeks * 7)
  return base.toISOString().slice(0, 10)
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
}): Cents {
  if (args.totalCents <= 0) return 0
  if (compareDates(args.dueDate, args.today) <= 0) return args.totalCents
  if (compareDates(args.fromDate, args.today) >= 0) return 0
  const component: RateComponent = {
    kind: 'base',
    lineItemId: null,
    reserveAccountId: '',
    startDate: args.fromDate,
    endDate: args.dueDate,
    amountCents: args.totalCents,
    weeks: accrualWeeksBetween(args.fromDate, args.dueDate),
  }
  return Math.max(0, Math.min(componentDeliveredBy(component, args.today), args.totalCents))
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
 * there is nothing to suggest -- a one-off, or a cycle that has not started.
 */
export function openingSinceLastOccurrence(args: {
  totalCents: Cents
  dueDate: CivilDate
  recurrence: Recurrence | null
  today: CivilDate
}): { lastOccurrence: CivilDate; cents: Cents } | null {
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
  })
  return cents > 0 ? { lastOccurrence: last, cents } : null
}
