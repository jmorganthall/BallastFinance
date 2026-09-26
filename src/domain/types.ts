/**
 * Domain facts.
 *
 * These mirror the six stored objects of PRD §3 as plain data. The derivation
 * layer takes facts and returns derived views; it never reads a database, a
 * clock or an environment variable (PRD §10: "zero I/O"). "Today" is always a
 * parameter, which is what makes every curve and rate reproducible in a test.
 */

import type { CivilDate } from './dates'
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
 * and the elapsed share is offered as an opening instead (D8). A one-off is
 * always 'commit'; it has no last time.
 */
export type TimelineStart = 'last_occurrence' | 'commit'

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
