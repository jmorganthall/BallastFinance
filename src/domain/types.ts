/**
 * Domain facts.
 *
 * These mirror the six stored objects of PRD §3 as plain data. The derivation
 * layer takes facts and returns derived views; it never reads a database, a
 * clock or an environment variable (PRD §10: "zero I/O"). "Today" is always a
 * parameter, which is what makes every curve and rate reproducible in a test.
 */

import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import type { Recurrence } from './recurrence'

export type Id = string

export type PackageState = 'simulated' | 'active' | 'retired'
export type LineItemState = 'planned' | 'accruing' | 'due' | 'retired'

export type AccountScope = 'household' | 'individual'

export interface ReserveAccount {
  id: Id
  householdId: Id
  name: string
  institutionLabel: string
  /** 'individual' restricts WRITES to the owner. Reads are never restricted. */
  scope: AccountScope
  ownerUserId: Id | null
  active: boolean
}

/**
 * May this user write to this account (PRD §2)?
 *
 * Reads are deliberately absent from this question. Both spouses see every
 * account and every balance, so a household total is never a partial picture
 * and a check-in never silently omits money. What an individual scope buys is
 * that only its owner can rename it, fund a new line item from it, or confirm
 * its balance.
 */
export function canWriteAccount(
  account: Pick<ReserveAccount, 'scope' | 'ownerUserId'>,
  userId: Id | null,
): boolean {
  if (account.scope === 'household') return true
  return userId !== null && account.ownerUserId === userId
}

export interface Package {
  id: Id
  householdId: Id
  name: string
  state: PackageState
  module: string
  detail: unknown // module-owned; the core never reads it (PRD §3, abstract principle 4)
  createdAt: CivilDate
  committedAt: CivilDate | null
}

/**
 * Where a part's money timeline begins (PRD D30). A part that comes round
 * again did not begin the day it was typed in: by default its base component
 * runs from the last time it came round, so "should hold today" is already
 * the elapsed share of the cycle and the weekly figure is the steady rate.
 * 'commit' is the older reading -- the plan starts the day it is committed
 * and the elapsed share is offered as an opening instead (D8). 'typed' (D33)
 * is another day a person gives, held in `timelineStartDate`, for a
 * household that has been setting money aside for a bill since some other
 * day than either of those. A one-off (D36) is 'commit' or 'typed': it has
 * no last time it came round, so it starts the day the plan started (or the
 * day it was added) unless a person gives an earlier day.
 */
export type TimelineStart = 'last_occurrence' | 'commit' | 'typed'

/**
 * A choice of where a timeline starts, as a form or a caller states it: the
 * kind, and the day when the kind is 'typed'. The two D30 kinds may be given
 * as a bare string, which is how every caller from before D33 gives them.
 */
export interface TimelineStartChoice {
  kind: TimelineStart
  date?: CivilDate | null
}

/** One reading of a choice, however it was given. */
export function timelineChoiceOf(
  choice: TimelineStart | TimelineStartChoice,
): { timelineStart: TimelineStart; timelineStartDate: CivilDate | null } {
  const kind = typeof choice === 'string' ? choice : choice.kind
  const date = typeof choice === 'string' ? null : (choice.date ?? null)
  return { timelineStart: kind, timelineStartDate: kind === 'typed' ? date : null }
}

/**
 * How a `line_item_changed` event records where a timeline starts, in its
 * `timeline_start: { before, after }`: the D30 kinds as the bare string they
 * were always written as, and a typed start as `{ kind: 'typed', date }`,
 * so a log written before D33 reads exactly as it did.
 */
export type TimelineStartRecord = TimelineStart | { kind: 'typed'; date: CivilDate }

/**
 * Whether a choice of where a timeline starts can be kept on a part (D33,
 * D36), and the plain words when it cannot. A one-off has no last time it
 * came round: asked for one, it starts where the plan does, which is a
 * definition and not refused. A day given, on any part, must be on or
 * before today and before the day the part is needed; any other kind
 * carries no day.
 */
export function resolveTimelineStart(args: {
  recurrence: Recurrence | null
  choice: TimelineStart | TimelineStartChoice
  dueDate: CivilDate
  today: CivilDate
}):
  | { ok: true; timelineStart: TimelineStart; timelineStartDate: CivilDate | null }
  | { ok: false; problem: string } {
  const { timelineStart, timelineStartDate } = timelineChoiceOf(args.choice)
  if (!args.recurrence && timelineStart === 'last_occurrence') {
    return { ok: true, timelineStart: 'commit', timelineStartDate: null }
  }
  if (timelineStart !== 'typed') return { ok: true, timelineStart, timelineStartDate: null }
  if (!timelineStartDate) {
    return { ok: false, problem: 'Pick the day you have been saving for this since.' }
  }
  if (compareDates(timelineStartDate, args.today) > 0) {
    return { ok: false, problem: 'The day you have been saving since cannot be after today.' }
  }
  if (compareDates(timelineStartDate, args.dueDate) >= 0) {
    return {
      ok: false,
      problem: 'The day you have been saving since has to be before the day it is needed.',
    }
  }
  return { ok: true, timelineStart, timelineStartDate }
}

/**
 * Where a part's timeline starts after a change to it (D30, D33, D36): the
 * one decision for every caller that changes a part, whether a person
 * changed this part on its own or a change to the whole plan asks the same
 * of each of its parts. What was not said keeps what the part has; a part
 * that starts repeating with nothing said about it gets the default for a
 * repeating part, unless it already had a day given, which it keeps; a
 * part that stops repeating while "the last time it came round" starts
 * where the plan does. The result is judged against the part as it will
 * be after the change, and says whether it moved, so a caller asking this
 * of many parts can list which would change and which cannot take it, in
 * the same plain words.
 */
export function nextTimelineStart(args: {
  current: {
    recurrence: Recurrence | null
    timelineStart: TimelineStart
    timelineStartDate: CivilDate | null
  }
  /** What a person said. A field left out was not said. */
  asked?: { kind?: TimelineStart; date?: CivilDate | null }
  /** The part's recurrence and due date as they will be after the change. */
  recurrence: Recurrence | null
  dueDate: CivilDate
  today: CivilDate
}):
  | { ok: true; timelineStart: TimelineStart; timelineStartDate: CivilDate | null; changed: boolean }
  | { ok: false; problem: string } {
  const { current, asked } = args
  const startsRepeating = current.recurrence === null && args.recurrence !== null
  const kind =
    asked?.kind ??
    (startsRepeating && current.timelineStart !== 'typed'
      ? defaultTimelineStart(args.recurrence)
      : current.timelineStart)
  const date = asked && 'date' in asked ? (asked.date ?? null) : current.timelineStartDate
  const resolved = resolveTimelineStart({
    recurrence: args.recurrence,
    choice: { kind, date },
    dueDate: args.dueDate,
    today: args.today,
  })
  if (!resolved.ok) return resolved
  return {
    ...resolved,
    changed:
      resolved.timelineStart !== current.timelineStart ||
      resolved.timelineStartDate !== current.timelineStartDate,
  }
}

export function timelineStartRecord(
  timelineStart: TimelineStart,
  timelineStartDate: CivilDate | null,
): TimelineStartRecord {
  return timelineStart === 'typed' && timelineStartDate
    ? { kind: 'typed', date: timelineStartDate }
    : timelineStart
}

/** The default for a part: from its last occurrence when it has one. */
export function defaultTimelineStart(recurrence: Recurrence | null | undefined): TimelineStart {
  return recurrence ? 'last_occurrence' : 'commit'
}

export interface LineItem {
  id: Id
  packageId: Id
  label: string
  unitAmountCents: Cents
  quantity: number
  dueDate: CivilDate
  reserveAccountId: Id
  state: LineItemState
  /** null is a one-off. An interval rolls forward when confirmed spent. */
  recurrence: Recurrence | null
  /**
   * A fact on the part, like its recurrence, and like the recurrence NOT in
   * `LineItemSnapshot`: the accrual math reads the part's current setting over
   * the whole cycle. Toggling it is a statement about where the timeline as a
   * whole begins, not a dated delta, so it is not replayed as a catch-up; the
   * engine records the toggle beside the snapshots on the `line_item_changed`
   * event so the log still explains why the weekly number moved.
   */
  timelineStart: TimelineStart
  /**
   * The day a person gave (D33): present exactly when `timelineStart` is
   * 'typed', on or before the day it was given and before the due date. Like
   * the kind, a fact on the part and not in `LineItemSnapshot`.
   */
  timelineStartDate: CivilDate | null
}

/** Total obligation of a line item. The one place unit x quantity is computed. */
export function lineItemTotalCents(item: Pick<LineItem, 'unitAmountCents' | 'quantity'>): Cents {
  return item.unitAmountCents * item.quantity
}

/**
 * The shape a line_item_changed event records. Only the fields that move money
 * matter to the accrual math; a label edit produces a zero delta and no component.
 */
export interface LineItemSnapshot {
  unitAmountCents: Cents
  quantity: number
  dueDate: CivilDate
  reserveAccountId: Id
}

export interface LineItemChange {
  lineItemId: Id
  occurredAt: CivilDate
  before: LineItemSnapshot
  after: LineItemSnapshot
}

/**
 * When a line item's current accrual cycle began, and what was already set
 * aside for it at that moment (PRD §5). Three things start a cycle: the
 * package commit (with the opening balance declared then, split across its
 * parts by cost), a part added to a plan that is already live, and a
 * recurring item being confirmed spent, which starts the next cycle at $0.
 * Anything before the latest start is a settled cycle and does not touch the
 * current one's math.
 */
/**
 * What began a cycle: the plan's commit, a part added to a live plan, a
 * recurring part confirmed spent and rolled forward, or a check-in that
 * counted money toward the part (a reshuffle is the same kind of restatement).
 */
export type CycleOrigin = 'commit' | 'added' | 'rolled' | 'counted'

export interface LineItemCycle {
  lineItemId: Id
  startDate: CivilDate
  openingCents: Cents
  /**
   * Where this sits among everything recorded, oldest first. Two starts on
   * the same day are ordinary -- a plan committed with an opening and then
   * counted toward at a check-in that afternoon -- and the later record is
   * the truth, so the tie is broken by this, never by query order.
   */
  recordedOrder?: number
  /**
   * The pace a part is measured against runs from a real beginning -- a
   * commit, an add, a roll -- never from a count, which only restates what
   * was already there. Absent means unknown, which only the pace reads.
   */
  origin?: CycleOrigin
}

/**
 * A catch-up accepted at a check-in (PRD §5: "Drift adjustments accepted at a
 * check-in also become catch-up components"). Account-level, because a check-in
 * confirms an account balance rather than a single item.
 */
export interface DriftAdjustment {
  id: Id
  reserveAccountId: Id
  amountCents: Cents
  startDate: CivilDate
  endDate: CivilDate
}
