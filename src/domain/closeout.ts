/**
 * Deadline close-out (PRD §5, capability 4).
 *
 * When a due date passes, the item does not quietly disappear. It enters Due and
 * keeps asking whether the money was actually spent, and it stays in the
 * expected-balance totals until a human confirms. An item that fell out of the
 * math on a date alone would make every account total a guess: the money might
 * still be sitting there, or it might be gone.
 */

import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import type { Id, LineItem, LineItemState } from './types'

export interface CloseOutPrompt {
  lineItemId: Id
  label: string
  reserveAccountId: Id
  dueDate: CivilDate
  plannedCents: Cents
  daysOverdue: number
}

/**
 * The state a line item should be in today, given its stored state and the
 * calendar. Only a human confirmation moves an item to retired.
 */
export function dueState(item: LineItem, today: CivilDate): LineItemState {
  if (item.state === 'retired' || item.state === 'planned') return item.state
  return compareDates(today, item.dueDate) >= 0 ? 'due' : 'accruing'
}

export function closeOutPrompts(args: {
  lineItems: readonly LineItem[]
  today: CivilDate
  /** Only items in committed packages are prompted about. */
  isLive: (item: LineItem) => boolean
}): CloseOutPrompt[] {
  return args.lineItems
    .filter((item) => args.isLive(item) && dueState(item, args.today) === 'due')
    .map((item) => ({
      lineItemId: item.id,
      label: item.label,
      reserveAccountId: item.reserveAccountId,
      dueDate: item.dueDate,
      plannedCents: item.unitAmountCents * item.quantity,
      daysOverdue: Math.max(0, Math.round(compareDates(args.today, item.dueDate))),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
}

/**
 * Closing out at a different amount than planned is normal, and the difference
 * is real: it is money still sitting in the account, or money that had to come
 * from somewhere else. Either way it surfaces as drift rather than vanishing.
 */
export function closeOutDrift(args: { plannedCents: Cents; actualCents: Cents }): Cents {
  return args.plannedCents - args.actualCents
}
