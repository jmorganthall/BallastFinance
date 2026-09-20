/**
 * Recurrence (PRD D8, superseded).
 *
 * Almost everything this app plans for happens again: insurance, property tax,
 * Christmas, an annual subscription. Re-creating each cycle by hand was exactly
 * the manual work the product exists to remove.
 *
 * A recurring line item rolls forward IN PLACE. One row per series, not one per
 * cycle: confirming it spent moves its due date to the next occurrence and
 * starts a fresh accrual cycle from the spend date. Ending a series is clearing
 * its recurrence.
 *
 * An interval, not a menu. The first version offered monthly, quarterly,
 * semiannual and annual, which covers a spreadsheet's common rows and nothing
 * else: a bill every 3 weeks, a filter every 45 days, an inspection every 2
 * years all had to be rounded or refused. A recurrence is now "every N of a
 * unit", and the old four are just the intervals they always were.
 *
 * Days and weeks are day arithmetic; months and years are month arithmetic, so
 * an annual bill due 29 February lands on 28 February in a common year and a
 * quarterly one keeps its day of month rather than drifting earlier each cycle.
 */

import { addDays, addMonths, compareDates, type CivilDate } from './dates'

export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year'

/** How often a line item comes round. `null` anywhere this appears is a one-off. */
export interface Recurrence {
  every: number
  unit: RecurrenceUnit
}

export const RECURRENCE_UNITS: RecurrenceUnit[] = ['day', 'week', 'month', 'year']

/** The four the old fixed menu offered, kept for anything that still names them. */
export const LEGACY_RECURRENCES: Record<string, Recurrence | null> = {
  none: null,
  monthly: { every: 1, unit: 'month' },
  quarterly: { every: 3, unit: 'month' },
  semiannual: { every: 6, unit: 'month' },
  annual: { every: 1, unit: 'year' },
}

const MAX_EVERY = 999

/**
 * Build a recurrence from whatever a form or a sheet produced, or null for a
 * one-off. Everything that accepts a recurrence goes through here, so an
 * unusable interval can never reach the accrual math.
 */
export function recurrenceOf(every: unknown, unit: unknown): Recurrence | null {
  if (typeof unit !== 'string') return null
  if (unit === 'none' || unit === '') return null
  if (!RECURRENCE_UNITS.includes(unit as RecurrenceUnit)) {
    const legacy = LEGACY_RECURRENCES[unit]
    return legacy ? { ...legacy } : null
  }
  const n = typeof every === 'number' ? every : Number(String(every ?? '').trim())
  if (!Number.isInteger(n) || n < 1 || n > MAX_EVERY) return null
  return { every: n, unit: unit as RecurrenceUnit }
}

export function isRecurring(recurrence: Recurrence | null | undefined): recurrence is Recurrence {
  return Boolean(recurrence) && (recurrence as Recurrence).every >= 1
}

export function sameRecurrence(a: Recurrence | null, b: Recurrence | null): boolean {
  if (!a || !b) return a === b || (!a && !b)
  return a.every === b.every && a.unit === b.unit
}

/**
 * Plain words for a screen (PRD §9). "Every 3 months", not "quarterly": the
 * word a family uses for the interval they typed.
 */
export function describeRecurrence(recurrence: Recurrence | null | undefined): string {
  if (!isRecurring(recurrence)) return 'Just once'
  const { every, unit } = recurrence
  if (every === 1) return `Every ${unit}`
  return `Every ${every} ${unit}s`
}

/** The unit names a select offers, in plain words. */
export const UNIT_LABELS: Record<RecurrenceUnit, string> = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
}

function step(date: CivilDate, recurrence: Recurrence, direction: 1 | -1): CivilDate {
  const n = recurrence.every * direction
  switch (recurrence.unit) {
    case 'day':
      return addDays(date, n)
    case 'week':
      return addDays(date, n * 7)
    case 'month':
      return addMonths(date, n)
    case 'year':
      return addMonths(date, n * 12)
  }
}

/** The next occurrence after `date`, or null for a one-off. */
export function nextOccurrence(date: CivilDate, recurrence: Recurrence | null): CivilDate | null {
  if (!isRecurring(recurrence)) return null
  return step(date, recurrence, 1)
}

/**
 * The occurrence before `date`, or null for a one-off.
 *
 * This is what makes "you should already have some of this saved" answerable:
 * a bill due next February that comes round every year was last due last
 * February, and that is when saving for it should have started.
 */
export function previousOccurrence(
  date: CivilDate,
  recurrence: Recurrence | null,
): CivilDate | null {
  if (!isRecurring(recurrence)) return null
  return step(date, recurrence, -1)
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
  recurrence: Recurrence | null,
  today: CivilDate,
): CivilDate {
  if (!isRecurring(recurrence)) return date

  let candidate = date
  // A daily item entered years late would otherwise spin; the bound stops a bad
  // input becoming a hang, and anything that hits it is a typo, not a plan.
  for (let guard = 0; guard < 5000 && compareDates(candidate, today) <= 0; guard += 1) {
    const next = nextOccurrence(candidate, recurrence)
    if (!next || compareDates(next, candidate) <= 0) break
    candidate = next
  }
  return candidate
}

/** How many occurrences fall in (from, to]. Used to describe a series. */
export function occurrencesBetween(
  from: CivilDate,
  to: CivilDate,
  recurrence: Recurrence | null,
): number {
  if (!isRecurring(recurrence)) return compareDates(to, from) >= 0 ? 1 : 0
  let count = 0
  let cursor = from
  for (let guard = 0; guard < 5000; guard += 1) {
    const next = nextOccurrence(cursor, recurrence)
    if (!next || compareDates(next, to) > 0) break
    cursor = next
    count += 1
  }
  return count
}
