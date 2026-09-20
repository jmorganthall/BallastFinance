/**
 * Civil dates and the household week.
 *
 * Due dates, commit dates and edit dates are calendar dates, not instants, so
 * they are handled as plain "YYYY-MM-DD" strings and compared as day numbers.
 * No timezone enters the arithmetic. The household timezone is consulted in
 * exactly one place -- todayIn() -- to answer "what is today?".
 *
 * The week boundary is Saturday (PRD §10), matching both the Capital One
 * recurring transfer and the Saturday digest. A "week" in the accrual math is
 * therefore one Saturday transfer, and the count of weeks between two dates is
 * the count of Saturdays strictly after the first and on or before the second.
 */

export type CivilDate = string // YYYY-MM-DD

export class DateError extends Error {}

/** PRD §10: weeks are computed in the household's timezone. */
export const HOUSEHOLD_TIMEZONE = 'America/Chicago'

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/

export function assertCivilDate(d: string): asserts d is CivilDate {
  if (!CIVIL_DATE.test(d)) throw new DateError(`Not a civil date: "${d}"`)
  const n = toDayNumber(d as CivilDate)
  if (!Number.isFinite(n)) throw new DateError(`Not a real date: "${d}"`)
  if (fromDayNumber(n) !== d) throw new DateError(`Not a real date: "${d}"`)
}

/** Days since 1970-01-01. The unit all date comparisons reduce to. */
export function toDayNumber(d: CivilDate): number {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, day) / 86_400_000
}

export function fromDayNumber(n: number): CivilDate {
  return new Date(n * 86_400_000).toISOString().slice(0, 10)
}

export function addDays(d: CivilDate, days: number): CivilDate {
  return fromDayNumber(toDayNumber(d) + days)
}

export function compareDates(a: CivilDate, b: CivilDate): number {
  return toDayNumber(a) - toDayNumber(b)
}

export const minDate = (a: CivilDate, b: CivilDate): CivilDate => (compareDates(a, b) <= 0 ? a : b)
export const maxDate = (a: CivilDate, b: CivilDate): CivilDate => (compareDates(a, b) >= 0 ? a : b)

/** Today's calendar date in the household timezone. The only timezone-aware function here. */
export function todayIn(timeZone: string = HOUSEHOLD_TIMEZONE, now: Date = new Date()): CivilDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

// 1970-01-01 (day 0) was a Thursday, so day 2 (1970-01-03) was the first Saturday.
const FIRST_SATURDAY_DAY_NUMBER = 2

/** How many Saturdays have occurred on or before this day number. */
function saturdaysUpTo(dayNumber: number): number {
  if (dayNumber < FIRST_SATURDAY_DAY_NUMBER) return 0
  return Math.floor((dayNumber - FIRST_SATURDAY_DAY_NUMBER) / 7) + 1
}

export function isSaturday(d: CivilDate): boolean {
  // 0 = Sunday. Day 0 was a Thursday (4).
  return (((toDayNumber(d) + 4) % 7) + 7) % 7 === 6
}

/**
 * Transfer weeks in the half-open interval (from, to]: the number of Saturdays
 * strictly after `from` and on or before `to`. This is literally "how many times
 * money moves between these two dates", which is what an accrual rate divides by.
 *
 * Returns 0 when `to` is on or before `from`.
 */
export function transferWeeksBetween(from: CivilDate, to: CivilDate): number {
  const a = toDayNumber(from)
  const b = toDayNumber(to)
  if (b <= a) return 0
  return saturdaysUpTo(b) - saturdaysUpTo(a)
}

/**
 * The divisor for an accrual rate. PRD §5: "minimum 1 week" -- an item due
 * before the next Saturday still needs its whole amount set aside in one move.
 */
export function accrualWeeksBetween(from: CivilDate, to: CivilDate): number {
  return Math.max(1, transferWeeksBetween(from, to))
}

/** Whole months from `from` to `to`, rounded down. Never negative. */
export function monthsBetween(from: CivilDate, to: CivilDate): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0)
  return Math.max(0, months)
}

/** The same day-of-month `months` later, clamped to the end of a short month. */
export function addMonths(d: CivilDate, months: number): CivilDate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}
