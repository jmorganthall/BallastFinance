/**
 * Civil dates and the household week.
 *
 * Due dates, commit dates and edit dates are calendar dates, not instants, so
 * they are handled as plain "YYYY-MM-DD" strings and compared as day numbers.
 * No timezone enters the arithmetic. The household timezone is consulted in
 * exactly one place -- todayIn() -- to answer "what is today?".
 *
 * The week boundary is the household's transfer day (PRD §10 as amended by
 * D31): the weekday the Capital One recurring transfer runs, a household
 * setting that defaults to Saturday until a person picks a day. A "week" in
 * the accrual math is one such transfer, and the count of weeks between two
 * dates is the count of transfer days strictly after the first and on or
 * before the second. This module holds the one definition of that count;
 * every function elsewhere that counts weeks takes the day as a parameter
 * (`transferWeekday`, beside `today`) and never assumes Saturday.
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

/** A day of the week, 0 Sunday to 6 Saturday, as `Date.getUTCDay()` numbers it. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const WEEKDAY_NAMES: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/**
 * The day the transfer runs until a household says otherwise (PRD D31). The
 * domain defaults to it so pure callers and tests can leave it out; the
 * engine always passes the household's own setting.
 */
export const DEFAULT_TRANSFER_WEEKDAY: Weekday = 6

export function isWeekday(n: unknown): n is Weekday {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6
}

// 1970-01-01 (day 0) was a Thursday (4).
const EPOCH_WEEKDAY = 4

/** The weekday of a civil date, 0 Sunday to 6 Saturday. */
export function weekdayOf(d: CivilDate): Weekday {
  return ((((toDayNumber(d) + EPOCH_WEEKDAY) % 7) + 7) % 7) as Weekday
}

/** Is this the day money moves? */
export function isTransferDay(d: CivilDate, transferWeekday: Weekday): boolean {
  return weekdayOf(d) === transferWeekday
}

/** The day number of the first transfer day on or after day 0. */
function firstTransferDayNumber(transferWeekday: Weekday): number {
  return (((transferWeekday - EPOCH_WEEKDAY) % 7) + 7) % 7
}

/**
 * How many transfer days have occurred on or before this day number, counted
 * from the epoch's first. Negative before it, which is fine: only differences
 * are ever read, so a window before 1970 still counts right.
 */
function transfersUpTo(dayNumber: number, transferWeekday: Weekday): number {
  return Math.floor((dayNumber - firstTransferDayNumber(transferWeekday)) / 7) + 1
}

/**
 * Transfer weeks in the half-open interval (from, to]: the number of transfer
 * days strictly after `from` and on or before `to`. This is literally "how
 * many times money moves between these two dates", which is what an accrual
 * rate divides by.
 *
 * Returns 0 when `to` is on or before `from`.
 */
export function transferWeeksBetween(
  from: CivilDate,
  to: CivilDate,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): number {
  const a = toDayNumber(from)
  const b = toDayNumber(to)
  if (b <= a) return 0
  return transfersUpTo(b, transferWeekday) - transfersUpTo(a, transferWeekday)
}

/**
 * The divisor for an accrual rate. PRD §5: "minimum 1 week" -- an item due
 * before the next transfer still needs its whole amount set aside in one move.
 */
export function accrualWeeksBetween(
  from: CivilDate,
  to: CivilDate,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): number {
  return Math.max(1, transferWeeksBetween(from, to, transferWeekday))
}

/**
 * The `n`-th transfer day strictly after `d`, so that (d, result] holds
 * exactly `n` transfers. A catch-up "over eight weeks" ends on the eighth
 * transfer day, whatever day of the week the check-in happened.
 */
export function nthTransferDayAfter(d: CivilDate, n: number, transferWeekday: Weekday): CivilDate {
  const gap = (((transferWeekday - weekdayOf(d)) % 7) + 7) % 7 || 7
  return addDays(d, gap + (Math.max(1, n) - 1) * 7)
}

/** The first transfer day strictly after `d`. */
export function nextTransferDay(d: CivilDate, transferWeekday: Weekday): CivilDate {
  return nthTransferDayAfter(d, 1, transferWeekday)
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
