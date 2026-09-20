/**
 * Recurrence (PRD D8, superseded).
 *
 * Almost everything this app plans for happens again: insurance, property tax,
 * Christmas, an annual subscription. Re-creating each cycle by hand was exactly
 * the manual work the product exists to remove.
 *
 * A recurring line item rolls forward IN PLACE. One row per series, not one per
 * cycle: confirming it spent moves its due date to the next occurrence and
 * starts a fresh accrual cycle from the spend date. Ending a series is setting
 * its recurrence back to 'none'.
 */

import { addMonths, compareDates, type CivilDate } from './dates'

export type Recurrence = 'none' | 'monthly' | 'quarterly' | 'semiannual' | 'annual'

export const RECURRENCES: Recurrence[] = ['none', 'monthly', 'quarterly', 'semiannual', 'annual']

const MONTHS: Record<Recurrence, number> = {
  none: 0,
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
}

/** Plain words for the UI. The internal vocabulary stays out of the screens. */
export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: 'Just once',
  monthly: 'Every month',
  quarterly: 'Every 3 months',
  semiannual: 'Every 6 months',
  annual: 'Every year',
}

export function isRecurring(recurrence: Recurrence): boolean {
  return recurrence !== 'none'
}

/**
 * The next occurrence after `date`, or null for a one-off.
 *
 * Month arithmetic, not 365 days: an annual bill due 29 February lands on
 * 28 February in a common year, and a quarterly one keeps its day of month
 * rather than drifting earlier every cycle.
 */
export function nextOccurrence(date: CivilDate, recurrence: Recurrence): CivilDate | null {
  if (!isRecurring(recurrence)) return null
  return addMonths(date, MONTHS[recurrence])
}

/**
 * Advance a date until it is strictly after `today`.
 *
 * This is what makes entering a real recurring bill bearable. Someone typing in
 * last September's insurance renewal means "this happens every year, and the
 * last one was then" -- rejecting it as a past date is technically correct and
 * completely unhelpful. A one-off is returned untouched, so the past-date rule
 * still bites where it should.
 */
export function rollToFuture(
  date: CivilDate,
  recurrence: Recurrence,
  today: CivilDate,
): CivilDate {
  if (!isRecurring(recurrence)) return date

  let candidate = date
  // An annual item entered a century late is a typo, not a plan; the bound
  // stops a bad input becoming a hang.
  for (let guard = 0; guard < 1200 && compareDates(candidate, today) <= 0; guard += 1) {
    const next = nextOccurrence(candidate, recurrence)
    if (!next) break
    candidate = next
  }
  return candidate
}

/** How many occurrences fall in (from, to]. Used to describe a series. */
export function occurrencesBetween(
  from: CivilDate,
  to: CivilDate,
  recurrence: Recurrence,
): number {
  if (!isRecurring(recurrence)) return compareDates(to, from) >= 0 ? 1 : 0
  let count = 0
  let cursor = from
  for (let guard = 0; guard < 1200; guard += 1) {
    const next = nextOccurrence(cursor, recurrence)
    if (!next || compareDates(next, to) > 0) break
    cursor = next
    count += 1
  }
  return count
}
