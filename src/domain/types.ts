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
export interface LineItemCycle {
  lineItemId: Id
  startDate: CivilDate
  openingCents: Cents
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
