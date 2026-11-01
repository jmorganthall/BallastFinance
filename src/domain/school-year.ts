/**
 * Where a school year starts and ends (PRD D25, D59). A school year runs from
 * its first day of school to its last, both school days; a day a person or a
 * school calendar's feed stated wins, and an end nobody stated is the year's
 * first or last listed day off, the rule from before D59. The calendar's
 * tint, the best-weeks list, Explore and school days missed all read these.
 * Nothing here is stored. Kept apart from trip-when.ts so the calendar
 * (park-data.ts) can read it without a circular import.
 */

import { addDays, compareDates, maxDate, minDate, weekdayOf, type CivilDate } from './dates'
import type { DayOffInput, SchoolDayOffSource } from './trip-when'

/** The first or the last day of a school year (D59). */
export type SchoolYearBound = 'first' | 'last'

/**
 * A school year's first or last day of school, a household fact with where
 * it came from: typed, or found in a school calendar's feed (D59). Both are
 * school days.
 */
export interface SchoolYearDay {
  schoolYear: string
  which: SchoolYearBound
  date: CivilDate
  source: SchoolDayOffSource | string
  sourceUrl?: string | null
}

/** "2026-27" for a date in the school year that starts in August 2026. */
export function schoolYearOf(date: CivilDate): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  const start = m >= 8 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/**
 * The school year a first or last day belongs to, by its own calendar year:
 * a first day starts the year that begins that year (a July 28 start is
 * still 2026-27), a last day ends the year that ends that year. Days off
 * keep `schoolYearOf`, which only has to place days inside the year.
 */
export function schoolYearOfBound(which: SchoolYearBound, date: CivilDate): string {
  const y = Number(date.slice(0, 4))
  const start = which === 'first' ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/**
 * Where each school year runs, first day to last, both school days (D59):
 * a day a person or a feed stated wins; an end nobody stated is the year's
 * first or last listed day off, as before D59. A year with neither end known
 * is not here.
 */
export function schoolYearSpans(
  daysOff: readonly (DayOffInput & { schoolYear?: string })[],
  yearDays: readonly Pick<SchoolYearDay, 'schoolYear' | 'which' | 'date'>[] = [],
): Map<string, { from: CivilDate; to: CivilDate }> {
  const guessed = new Map<string, { from: CivilDate; to: CivilDate }>()
  for (const d of daysOff) {
    const year = d.schoolYear ?? schoolYearOf(d.date)
    const have = guessed.get(year)
    guessed.set(year, have ? { from: minDate(have.from, d.date), to: maxDate(have.to, d.date) } : { from: d.date, to: d.date })
  }
  const spans = new Map<string, { from: CivilDate; to: CivilDate }>()
  const years = new Set([...guessed.keys(), ...yearDays.map((y) => y.schoolYear)])
  for (const year of years) {
    const from = yearDays.find((y) => y.schoolYear === year && y.which === 'first')?.date ?? guessed.get(year)?.from
    const to = yearDays.find((y) => y.schoolYear === year && y.which === 'last')?.date ?? guessed.get(year)?.to
    if (from && to && compareDates(from, to) <= 0) spans.set(year, { from, to })
  }
  return spans
}

/**
 * Whether a date is out of school, as the calendar tints it (D48 (2), D59):
 * a weekend, a day off, or a day outside every school year the calendar
 * knows. With no calendar at all, only weekends are; a federal holiday alone
 * is not (it is still not a school day: see `isSchoolDay`).
 */
export function outOfSchool(
  date: CivilDate,
  daysOff: readonly (DayOffInput & { schoolYear?: string })[],
  yearDays: readonly Pick<SchoolYearDay, 'schoolYear' | 'which' | 'date'>[] = [],
  spans: Map<string, { from: CivilDate; to: CivilDate }> = schoolYearSpans(daysOff, yearDays),
): boolean {
  const wd = weekdayOf(date)
  if (wd === 0 || wd === 6) return true
  if (daysOff.some((d) => d.date === date)) return true
  if (daysOff.length === 0 && yearDays.length === 0) return false
  for (const s of spans.values()) if (compareDates(date, s.from) >= 0 && compareDates(date, s.to) <= 0) return false
  return true
}

/** A first day falls July to October, a last day April to July (D59). */
export function fitsSchoolYearBound(which: SchoolYearBound, date: CivilDate): boolean {
  const month = Number(date.slice(5, 7))
  return which === 'first' ? month >= 7 && month <= 10 : month >= 4 && month <= 7
}

const FIRST_DAY = /\bfirst day (?:of (?:the )?school(?: year)?|for students|of classes)\b/i
const LAST_DAY = /\blast day (?:of (?:the )?school(?: year)?|for students|of classes)\b/i
const NOT_STUDENTS = /\b(?:teachers?|staff|employees?|faculty)\b/i

/** Whether an event's title says it is the first or last day of school for students (D59 (4)); else nothing. */
export function schoolYearBoundOf(title: string): SchoolYearBound | null {
  if (NOT_STUDENTS.test(title)) return null
  if (FIRST_DAY.test(title)) return 'first'
  if (LAST_DAY.test(title)) return 'last'
  return null
}

/**
 * A feed's events split in two (D59 (4)): the first and last days of school,
 * which set a year's ends and are not days off, and the days off. Where a
 * year has two first days (a staggered start) the earliest is kept, and the
 * latest of two last days; the titles go with them so a person sees why.
 */
export function splitSchoolYearDays(items: readonly DayOffInput[]): {
  daysOff: DayOffInput[]
  yearDays: (Pick<SchoolYearDay, 'schoolYear' | 'which' | 'date'> & { label: string })[]
} {
  const daysOff: DayOffInput[] = []
  const found = new Map<string, Pick<SchoolYearDay, 'schoolYear' | 'which' | 'date'> & { label: string }>()
  for (const item of items) {
    // A matching title in a month no first or last day can be (a January start at a year-round
    // school) is left as the feed gave it, as before D59, so one odd event never stops the rest.
    const which = schoolYearBoundOf(item.label)
    if (!which || !fitsSchoolYearBound(which, item.date)) {
      daysOff.push(item)
      continue
    }
    const schoolYear = schoolYearOfBound(which, item.date)
    const key = `${schoolYear}|${which}`
    const have = found.get(key)
    const better = !have || (which === 'first' ? compareDates(item.date, have.date) < 0 : compareDates(item.date, have.date) > 0)
    if (better) found.set(key, { schoolYear, which, date: item.date, label: item.label })
  }
  const yearDays = [...found.values()].sort((a, b) => compareDates(a.date, b.date))
  return { daysOff, yearDays }
}

/**
 * What a read found besides days off, said after the count: ", and the first
 * and last day of school for 2026-27"; nothing when it found none.
 */
export function schoolYearDaysNote(yearDays: readonly Pick<SchoolYearDay, 'schoolYear' | 'which'>[]): string {
  const years = [...new Set(yearDays.map((d) => d.schoolYear))].sort()
  if (years.length === 0) return ''
  const parts = years.map((year) => {
    const ends = yearDays.filter((d) => d.schoolYear === year).map((d) => d.which)
    const which = ends.includes('first') && ends.includes('last') ? 'first and last day' : ends.includes('first') ? 'first day' : 'last day'
    return `the ${which} of school for ${year}`
  })
  return `, and ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}`
}

/** One school year as the screen lists it (D59 (1)): each end as stated, or the day it is counted from meanwhile. */
export interface SchoolYearRow {
  schoolYear: string
  first: { date: CivilDate; source: string } | null
  last: { date: CivilDate; source: string } | null
  /** While an end is not stated: the first or last listed day off it is counted from, or nothing. */
  guessFirst: CivilDate | null
  guessLast: CivilDate | null
}

/** The school years that touch today to a year from today (D59 (1)), soonest first: usually this one and the next. */
export function schoolYearRows(
  today: CivilDate,
  daysOff: readonly (DayOffInput & { schoolYear?: string })[],
  yearDays: readonly SchoolYearDay[],
): SchoolYearRow[] {
  const end = addDays(today, 365)
  const labels: string[] = []
  for (let d = today; compareDates(d, end) <= 0; d = addDays(d, 28)) {
    const label = schoolYearOf(d)
    if (!labels.includes(label)) labels.push(label)
  }
  if (!labels.includes(schoolYearOf(end))) labels.push(schoolYearOf(end))
  // A first day in July belongs to the year it starts, which schoolYearOf would still call the one before.
  for (const y of yearDays) if (!labels.includes(y.schoolYear) && compareDates(y.date, today) >= 0 && compareDates(y.date, end) <= 0) labels.push(y.schoolYear)
  const guessed = schoolYearSpans(daysOff)
  return labels.sort().map((schoolYear) => {
    const first = yearDays.find((y) => y.schoolYear === schoolYear && y.which === 'first')
    const last = yearDays.find((y) => y.schoolYear === schoolYear && y.which === 'last')
    return {
      schoolYear,
      first: first ? { date: first.date, source: first.source } : null,
      last: last ? { date: last.date, source: last.source } : null,
      guessFirst: first ? null : (guessed.get(schoolYear)?.from ?? null),
      guessLast: last ? null : (guessed.get(schoolYear)?.to ?? null),
    }
  })
}

