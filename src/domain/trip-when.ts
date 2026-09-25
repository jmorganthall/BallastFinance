/**
 * When to go (PRD §16, D25-D26): the When section proposes dates, not only
 * compares the ones typed.
 *
 * Candidates are every window of the trip's length across a horizon, plus
 * every long weekend -- a school day off or a federal holiday touching a
 * weekend. Each is measured (how busy, what it costs, school days missed,
 * what it runs into) and scored; the top ten are shown with the reasons.
 *
 * School days off are the household's own facts (school_days_off): typed,
 * imported from an iCal feed, or read from the district's PDF by the reader
 * (D27). Federal holidays are computed here, with the observed-day rules.
 * DVC broker listings (D26) are reference data read from a public page by a
 * parser behind the same shape as the crowd sources; the parser is here so
 * a page that changes shape breaks one test, not a screen.
 *
 * Nothing here touches money math: a price on a candidate is the trip's
 * own parts re-dated (trip-plan.ts), and a broker listing is a dated fact
 * shown beside the lodging line, never the line itself.
 *
 * THE SCORE (D25). Lower is better. A candidate that runs into a blackout is
 * excluded before scoring. Over the candidates that remain:
 *
 *   busy   = (avg crowd - lowest avg) / (highest avg - lowest avg)   0..1
 *   price  = (price - cheapest) / (dearest - cheapest)               0..1
 *            over the candidates of the same length only
 *   school = school days missed / most missed by any candidate       0..1
 *   score  = w_busy × busy + w_price × price + w_school × school
 *
 * Each part is normalised to 0..1 across the candidates, so the weights say
 * what they mean: with the plain defaults (busy 3, price 2, school 1) the
 * quietest week wins over the cheapest, and both over the one that misses
 * no school. Price is normalised among candidates of the same number of
 * nights, because a three-night weekend is not "cheap" for costing less
 * than a week; it is cheap when it costs less than other three-night
 * weekends. A candidate with no crowd data at all takes the midpoint (0.5)
 * for busy, so it neither hides nor wins by silence, and its reasons say
 * so; one with data for only some of its days is averaged over those and
 * says how many. When every candidate is alike on a part (one price for
 * all), that part is 0 for all. Ties break on the earlier start.
 */

import { addDays, addMonths, compareDates, maxDate, minDate, type CivilDate } from './dates'
import { formatCents, type Cents } from './money'
import type { Id } from './types'
import type { Trip } from './trip'
import { crowdWord, priceWindowCents, resortLevel, TripPlanError, type BlackoutRange, type CrowdLevel, type TripDay, type WindowPricingInput } from './trip-plan'

// ---------------------------------------------------------------- facts

export type SchoolDayOffSource = 'typed' | 'ical' | `read:${string}`

export interface SchoolDayOff {
  id: Id
  householdId: Id
  date: CivilDate
  label: string
  schoolYear: string
  source: SchoolDayOffSource | string
  sourceUrl: string | null
  recordedOn: CivilDate
}

/** A day off as a calendar or a person states it, before it is a row. */
export interface DayOffInput {
  date: CivilDate
  label: string
}

export type SchoolCalendarSourceKind = 'ical' | 'pdf' | 'page'

export const SCHOOL_CALENDAR_SOURCE_KINDS: readonly SchoolCalendarSourceKind[] = ['ical', 'pdf', 'page']

export interface SchoolCalendarSource {
  label: string
  url: string
  kind: SchoolCalendarSourceKind
}

export interface Holiday {
  /** The day the holiday is observed: a Saturday holiday on the Friday before, a Sunday one on the Monday after. */
  date: CivilDate
  name: string
}

export interface WeekWeights {
  busy: number
  price: number
  school: number
}

export const DEFAULT_WEEK_WEIGHTS: WeekWeights = { busy: 3, price: 2, school: 1 }
export const DEFAULT_HORIZON_MONTHS = 12
export const BEST_WEEKS_SHOWN = 10

// ---------------------------------------------------------------- validation

export function validateDayOff(input: DayOffInput & { schoolYear: string }): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new TripPlanError('A day off is a date, like 2027-01-18.')
  if (!input.label.trim()) throw new TripPlanError('A day off needs a name, like "Presidents\' Day".')
  if (!input.schoolYear.trim()) throw new TripPlanError('Say which school year this is, like 2026-27.')
}

export function validateSchoolCalendarSources(sources: readonly SchoolCalendarSource[]): void {
  for (const s of sources) {
    if (!s.label.trim()) throw new TripPlanError('Every calendar source needs a name, like "District calendar".')
    if (!/^https?:\/\//.test(s.url)) throw new TripPlanError(`"${s.label}" needs a link that starts with http:// or https://.`)
    if (!SCHOOL_CALENDAR_SOURCE_KINDS.includes(s.kind)) throw new TripPlanError(`Say what kind of thing "${s.label}" links to: a calendar feed, a PDF, or a web page.`)
  }
}

export function validateWeekWeights(w: WeekWeights): void {
  for (const [key, value] of Object.entries(w)) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new TripPlanError(`The weight for "${key}" is a number from 0 to 100.`)
  }
  if (w.busy + w.price + w.school === 0) throw new TripPlanError('At least one weight has to be above zero, or nothing can be ranked.')
}

export function validateHorizonMonths(months: number): void {
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new TripPlanError('The horizon is a whole number of months, 1 to 24.')
}

/** "2026-27" for a date in the school year that starts in August 2026. */
export function schoolYearOf(date: CivilDate): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  const start = m >= 8 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

// ---------------------------------------------------------------- federal holidays

const civil = (y: number, m: number, d: number): CivilDate => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** 0 Sunday .. 6 Saturday. */
export function weekday(date: CivilDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The nth (1-based) given weekday of a month; n = -1 for the last. */
function nthWeekday(y: number, m: number, wd: number, n: number): CivilDate {
  if (n > 0) {
    const first = civil(y, m, 1)
    const shift = (wd - weekday(first) + 7) % 7
    return addDays(first, shift + 7 * (n - 1))
  }
  const last = addDays(m === 12 ? civil(y + 1, 1, 1) : civil(y, m + 1, 1), -1)
  const back = (weekday(last) - wd + 7) % 7
  return addDays(last, -back)
}

/** The federal rule: a Saturday holiday is observed the Friday before, a Sunday one the Monday after. */
export function observedDay(date: CivilDate): CivilDate {
  const wd = weekday(date)
  if (wd === 6) return addDays(date, -1)
  if (wd === 0) return addDays(date, 1)
  return date
}

/**
 * The eleven federal holidays as observed in a calendar year. New Year's Day
 * of the year after is included when its observed day falls on December 31st
 * of this year, and this year's is left out when it was observed the December
 * before -- the list is the days off in that year, which is what a window
 * needs.
 */
export function federalHolidays(year: number): Holiday[] {
  const fixed: [number, number, string][] = [
    [1, 1, "New Year's Day"],
    [6, 19, 'Juneteenth'],
    [7, 4, 'Independence Day'],
    [11, 11, 'Veterans Day'],
    [12, 25, 'Christmas Day'],
  ]
  const list: Holiday[] = []
  for (const [m, d, name] of fixed) list.push({ date: observedDay(civil(year, m, d)), name })
  list.push({ date: observedDay(civil(year + 1, 1, 1)), name: "New Year's Day" })
  list.push({ date: nthWeekday(year, 1, 1, 3), name: 'Martin Luther King Jr. Day' })
  list.push({ date: nthWeekday(year, 2, 1, 3), name: "Presidents' Day" })
  list.push({ date: nthWeekday(year, 5, 1, -1), name: 'Memorial Day' })
  list.push({ date: nthWeekday(year, 9, 1, 1), name: 'Labor Day' })
  list.push({ date: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' })
  list.push({ date: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day' })
  return list.filter((h) => h.date.startsWith(`${year}-`)).sort((a, b) => compareDates(a.date, b.date))
}

/** Every federal holiday observed between two dates, inclusive. */
export function federalHolidaysBetween(from: CivilDate, to: CivilDate): Holiday[] {
  const out: Holiday[] = []
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
    for (const h of federalHolidays(y)) if (compareDates(h.date, from) >= 0 && compareDates(h.date, to) <= 0) out.push(h)
  }
  return out
}

// ---------------------------------------------------------------- long weekends

export interface LongWeekend {
  startDate: CivilDate
  endDate: CivilDate
  nights: number
  /** What makes it long: "Presidents' Day", "Teacher work day". */
  anchor: string
}

/**
 * The windows a day off next to a weekend opens (D25). A Monday off gives
 * Friday to Monday (3 nights) and Thursday to Monday (4); a Friday off gives
 * Thursday to Sunday (3) and Friday to Monday (3); a Tuesday off, Friday to
 * Tuesday (4); a Thursday off, Thursday to Sunday (3) and Thursday to Monday
 * (4). Two days off that open the same window (Thanksgiving Thursday and
 * Friday) give it once, named for both. Days off on a weekend open nothing:
 * the observed-day rule has already moved a holiday off it.
 */
export function longWeekends(input: {
  daysOff: readonly DayOffInput[]
  holidays: readonly Holiday[]
  horizonFrom: CivilDate
  horizonTo: CivilDate
}): LongWeekend[] {
  const anchors: { date: CivilDate; label: string }[] = [
    ...input.holidays.map((h) => ({ date: h.date, label: h.name })),
    ...input.daysOff.map((d) => ({ date: d.date, label: d.label })),
  ]
  const found = new Map<string, LongWeekend & { anchors: Set<string> }>()
  const open = (start: CivilDate, nights: number, label: string) => {
    const end = addDays(start, nights)
    if (compareDates(start, input.horizonFrom) < 0 || compareDates(end, input.horizonTo) > 0) return
    const key = `${start}|${end}`
    const have = found.get(key)
    if (have) {
      have.anchors.add(label)
      return
    }
    found.set(key, { startDate: start, endDate: end, nights, anchor: label, anchors: new Set([label]) })
  }
  for (const a of anchors) {
    switch (weekday(a.date)) {
      case 1: // Monday
        open(addDays(a.date, -3), 3, a.label)
        open(addDays(a.date, -4), 4, a.label)
        break
      case 2: // Tuesday
        open(addDays(a.date, -4), 4, a.label)
        break
      case 4: // Thursday
        open(a.date, 3, a.label)
        open(a.date, 4, a.label)
        break
      case 5: // Friday
        open(addDays(a.date, -1), 3, a.label)
        open(a.date, 3, a.label)
        break
      default:
        break
    }
  }
  return [...found.values()]
    .map(({ anchors: set, ...w }) => ({ ...w, anchor: [...set].join(' and ') }))
    .sort((a, b) => compareDates(a.startDate, b.startDate) || a.nights - b.nights)
}

// ---------------------------------------------------------------- candidates

export type CandidateKind = 'week' | 'long_weekend'

export interface Candidate {
  startDate: CivilDate
  endDate: CivilDate
  nights: number
  kind: CandidateKind
  /** For a long weekend, what makes it one. */
  anchor: string | null
  /** The trip's own dates as they stand. */
  current: boolean
}

/**
 * Every window of the trip's length starting from tomorrow to the end of the
 * horizon, plus every long weekend in it, plus the trip's own dates so the
 * screen can say how they compare. The trip's own window is kept even when
 * it is past the horizon or already gone.
 */
export function candidateWindows(input: {
  trip: Pick<Trip, 'startDate' | 'endDate'>
  horizonMonths: number
  daysOff: readonly DayOffInput[]
  holidays: readonly Holiday[]
  today: CivilDate
}): Candidate[] {
  const nights = Math.max(0, compareDates(input.trip.endDate, input.trip.startDate))
  const from = addDays(input.today, 1)
  const to = addMonths(input.today, input.horizonMonths)
  const out = new Map<string, Candidate>()
  const put = (c: Candidate) => {
    const key = `${c.startDate}|${c.endDate}`
    const have = out.get(key)
    if (have) {
      // The trip's own dates may also be a long weekend; keep both facts on one row.
      out.set(key, { ...have, current: have.current || c.current, kind: have.anchor ? have.kind : c.kind, anchor: have.anchor ?? c.anchor })
      return
    }
    out.set(key, c)
  }
  put({ startDate: input.trip.startDate, endDate: input.trip.endDate, nights, kind: 'week', anchor: null, current: true })
  for (let start = from; compareDates(start, to) <= 0; start = addDays(start, 1)) {
    put({ startDate: start, endDate: addDays(start, nights), nights, kind: 'week', anchor: null, current: false })
  }
  for (const w of longWeekends({ daysOff: input.daysOff, holidays: input.holidays, horizonFrom: from, horizonTo: addDays(to, 4) })) {
    put({ startDate: w.startDate, endDate: w.endDate, nights: w.nights, kind: 'long_weekend', anchor: w.anchor, current: false })
  }
  return [...out.values()].sort((a, b) => compareDates(a.startDate, b.startDate) || a.nights - b.nights)
}

// ---------------------------------------------------------------- measuring and scoring

export interface MeasuredCandidate extends Candidate {
  /** Mean resort-wide level over the days that matter, to a tenth. Null with no data. */
  crowdAverage: number | null
  daysWithData: number
  /** The days that matter: the park days when they are known and the window is the trip's length, else every day. */
  daysCounted: number
  priceCents: Cents
  schoolDaysMissed: number
  blackouts: string[]
}

function rangesOverlap(aFrom: CivilDate, aTo: CivilDate, bFrom: CivilDate, bTo: CivilDate): boolean {
  return compareDates(aFrom, bTo) <= 0 && compareDates(bFrom, aTo) <= 0
}

/**
 * Whether a date is a school day: a weekday, not a day off, not a federal
 * holiday, and inside a school year the calendar knows. A school year runs
 * from its first listed day off to its last, so a summer with nothing listed
 * is not school. With no calendar at all, every weekday counts, and the
 * screen says the calendar is missing.
 */
export function isSchoolDay(date: CivilDate, daysOff: readonly (DayOffInput & { schoolYear?: string })[], holidays: readonly Holiday[]): boolean {
  const wd = weekday(date)
  if (wd === 0 || wd === 6) return false
  if (holidays.some((h) => h.date === date)) return false
  if (daysOff.some((d) => d.date === date)) return false
  if (daysOff.length === 0) return true
  const spans = new Map<string, { from: CivilDate; to: CivilDate }>()
  for (const d of daysOff) {
    const year = d.schoolYear ?? schoolYearOf(d.date)
    const have = spans.get(year)
    spans.set(year, have ? { from: minDate(have.from, d.date), to: maxDate(have.to, d.date) } : { from: d.date, to: d.date })
  }
  for (const s of spans.values()) if (compareDates(date, s.from) >= 0 && compareDates(date, s.to) <= 0) return true
  return false
}

export function schoolDaysMissed(
  window: { startDate: CivilDate; endDate: CivilDate },
  daysOff: readonly (DayOffInput & { schoolYear?: string })[],
  holidays: readonly Holiday[],
): number {
  let missed = 0
  for (let d = window.startDate; compareDates(d, window.endDate) <= 0; d = addDays(d, 1)) if (isSchoolDay(d, daysOff, holidays)) missed += 1
  return missed
}

/**
 * Each candidate measured: how busy on the days that matter (the trip's own
 * park days shifted with the window when it is the same length, else every
 * day), what it costs (the caller prices a window; the parts are the trip's
 * own, from trip-plan.ts), school days missed, and what it runs into.
 */
export function measureCandidates(input: {
  candidates: readonly Candidate[]
  trip: Pick<Trip, 'startDate' | 'endDate'>
  days?: readonly TripDay[]
  crowdLevels: readonly CrowdLevel[]
  priceOf: (window: { startDate: CivilDate; endDate: CivilDate }) => Cents
  daysOff: readonly (DayOffInput & { schoolYear?: string })[]
  holidays: readonly Holiday[]
  blackoutDates: readonly BlackoutRange[]
}): MeasuredCandidate[] {
  const tripNights = Math.max(0, compareDates(input.trip.endDate, input.trip.startDate))
  const planned = (input.days ?? []).filter((d) => d.park !== 'rest' && d.park !== 'travel')
  const parkOffsets = planned.length > 0 ? planned.map((d) => compareDates(d.date, input.trip.startDate)) : null
  return input.candidates.map((c) => {
    const offsets = parkOffsets && c.nights === tripNights ? parkOffsets : Array.from({ length: c.nights + 1 }, (_, i) => i)
    const levels = offsets.map((o) => resortLevel(input.crowdLevels, addDays(c.startDate, o))).filter((l): l is number => l !== null)
    const crowdAverage = levels.length > 0 ? Math.round((levels.reduce((s, l) => s + l, 0) / levels.length) * 10) / 10 : null
    return {
      ...c,
      crowdAverage,
      daysWithData: levels.length,
      daysCounted: offsets.length,
      priceCents: input.priceOf(c),
      schoolDaysMissed: schoolDaysMissed(c, input.daysOff, input.holidays),
      blackouts: input.blackoutDates.filter((b) => rangesOverlap(c.startDate, c.endDate, b.from, b.to)).map((b) => b.label),
    }
  })
}

export interface ScoredCandidate extends MeasuredCandidate {
  /** Lower is better; see the formula at the top of the file. To three places. */
  score: number
  reasons: string[]
}

function normalise(value: number, lowest: number, highest: number): number {
  if (highest <= lowest) return 0
  return (value - lowest) / (highest - lowest)
}

/**
 * The top ten (D25), with the reasons in words. A candidate that runs into
 * a blackout is out before scoring; the current dates are scored like any
 * other, so the list can say whether they are already the best. Price
 * reasons compare with the trip's current dates when they are among the
 * candidates.
 */
export function scoreCandidates(input: {
  candidates: readonly MeasuredCandidate[]
  weights?: WeekWeights
  limit?: number
}): ScoredCandidate[] {
  const weights = input.weights ?? DEFAULT_WEEK_WEIGHTS
  const limit = input.limit ?? BEST_WEEKS_SHOWN
  const eligible = input.candidates.filter((c) => c.blackouts.length === 0)
  if (eligible.length === 0) return []
  const known = eligible.map((c) => c.crowdAverage).filter((a): a is number => a !== null)
  const lowestBusy = known.length > 0 ? Math.min(...known) : 0
  const highestBusy = known.length > 0 ? Math.max(...known) : 0
  const priceRange = new Map<number, { cheapest: Cents; dearest: Cents }>()
  for (const c of eligible) {
    const have = priceRange.get(c.nights)
    priceRange.set(c.nights, have ? { cheapest: Math.min(have.cheapest, c.priceCents), dearest: Math.max(have.dearest, c.priceCents) } : { cheapest: c.priceCents, dearest: c.priceCents })
  }
  const mostMissed = Math.max(...eligible.map((c) => c.schoolDaysMissed))
  const current = input.candidates.find((c) => c.current) ?? null

  const scored: ScoredCandidate[] = eligible.map((c) => {
    const busy = c.crowdAverage === null ? 0.5 : normalise(c.crowdAverage, lowestBusy, highestBusy)
    const range = priceRange.get(c.nights)!
    const price = normalise(c.priceCents, range.cheapest, range.dearest)
    const school = mostMissed > 0 ? c.schoolDaysMissed / mostMissed : 0
    const score = Math.round((weights.busy * busy + weights.price * price + weights.school * school) * 1000) / 1000
    const reasons: string[] = []
    if (c.anchor) reasons.push(`long weekend: ${c.anchor}`)
    if (c.crowdAverage === null) reasons.push('no crowd data')
    else if (c.daysWithData < c.daysCounted) reasons.push(`${crowdWord(c.crowdAverage)} (${c.crowdAverage} avg, ${c.daysWithData} of ${c.daysCounted} days known)`)
    else reasons.push(`${crowdWord(c.crowdAverage)} (${c.crowdAverage} avg)`)
    if (current && !c.current) {
      const diff = c.priceCents - current.priceCents
      if (diff === 0) reasons.push('same price as your current dates')
      else reasons.push(`${formatCents(Math.abs(diff))} ${diff < 0 ? 'under' : 'over'} your current dates`)
    } else if (c.current) reasons.push('your current dates')
    reasons.push(c.schoolDaysMissed === 0 ? 'no school missed' : `${c.schoolDaysMissed} school ${c.schoolDaysMissed === 1 ? 'day' : 'days'} missed`)
    return { ...c, score, reasons }
  })
  return scored.sort((a, b) => a.score - b.score || compareDates(a.startDate, b.startDate) || a.nights - b.nights).slice(0, limit)
}

export interface BestWeeksInput extends WindowPricingInput {
  days?: readonly TripDay[]
  crowdLevels: readonly CrowdLevel[]
  daysOff: readonly (DayOffInput & { schoolYear?: string })[]
  blackoutDates: readonly BlackoutRange[]
  horizonMonths?: number
  weights?: WeekWeights
  limit?: number
}

export interface BestWeeks {
  top: ScoredCandidate[]
  /** How many windows were looked at, blackouts included. */
  considered: number
  excludedByBlackout: number
  /** False when the household has no school calendar, so every weekday counted as school. */
  daysOffKnown: boolean
  horizonFrom: CivilDate
  horizonTo: CivilDate
}

/**
 * The whole of D25 in one call: the candidates across the horizon, the
 * federal holidays over it, each candidate measured and scored, the top
 * ten. The engine gathers the facts; this decides.
 */
export function bestWeeks(input: BestWeeksInput): BestWeeks {
  const horizonMonths = input.horizonMonths ?? DEFAULT_HORIZON_MONTHS
  const horizonFrom = addDays(input.today, 1)
  const horizonTo = addMonths(input.today, horizonMonths)
  const holidays = federalHolidaysBetween(addDays(minDate(horizonFrom, input.trip.startDate), -7), addDays(maxDate(horizonTo, input.trip.endDate), 14))
  const candidates = candidateWindows({ trip: input.trip, horizonMonths, daysOff: input.daysOff, holidays, today: input.today })
  const measured = measureCandidates({
    candidates,
    trip: input.trip,
    days: input.days,
    crowdLevels: input.crowdLevels,
    priceOf: (w) => priceWindowCents(input, w),
    daysOff: input.daysOff,
    holidays,
    blackoutDates: input.blackoutDates,
  })
  return {
    top: scoreCandidates({ candidates: measured, weights: input.weights, limit: input.limit }),
    considered: measured.length,
    excludedByBlackout: measured.filter((c) => c.blackouts.length > 0).length,
    daysOffKnown: input.daysOff.length > 0,
    horizonFrom,
    horizonTo,
  }
}

// ---------------------------------------------------------------- iCal

/** Unfold RFC 5545 lines (a continuation starts with a space or tab) and split. */
function icalLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/** "20270118", "20270118T000000Z", "2027-01-18" -> a civil date, or nothing. */
export function icalDate(value: string): CivilDate | null {
  const m = value.trim().match(/^(\d{4})-?(\d{2})-?(\d{2})(?:T|$)/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = civil(y, mo, d)
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (y < 2000 || y > 2100 || check.toISOString().slice(0, 10) !== date) return null
  return date
}

function icalUnescape(s: string): string {
  return s.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').replace(/\s+/g, ' ').trim()
}

/**
 * Days off from an iCal feed: every VEVENT with a start date, one day per
 * date it covers (DTEND is exclusive; a timed event counts as its start
 * day), named by SUMMARY. Alarms are skipped, time zones ignored beyond the
 * date. Anything that is not a calendar is nothing.
 */
export function parseIcal(text: string): DayOffInput[] {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) return []
  const out: DayOffInput[] = []
  const seen = new Set<string>()
  let inEvent = false
  let skipDepth = 0
  let start: CivilDate | null = null
  let end: CivilDate | null = null
  let allDay = false
  let summary = ''
  for (const line of icalLines(text)) {
    const colon = line.indexOf(':')
    const head = (colon === -1 ? line : line.slice(0, colon)).toUpperCase()
    const value = colon === -1 ? '' : line.slice(colon + 1)
    const name = head.split(';')[0]!
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT' && !inEvent) {
        inEvent = true
        start = end = null
        allDay = false
        summary = ''
      } else if (inEvent) skipDepth += 1
      continue
    }
    if (name === 'END') {
      if (skipDepth > 0) {
        skipDepth -= 1
        continue
      }
      if (value.toUpperCase() === 'VEVENT' && inEvent) {
        inEvent = false
        if (start) {
          const label = summary || 'Day off'
          // An all-day DTEND is the day after the last day; a timed one is on the last day itself.
          const last = end ? (allDay ? addDays(end, -1) : end) : start
          const stop = compareDates(last, start) < 0 ? start : last
          for (let d = start; compareDates(d, stop) <= 0 && compareDates(d, start) < 366; d = addDays(d, 1)) {
            const key = `${d}|${label.toLowerCase()}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ date: d, label })
          }
        }
      }
      continue
    }
    if (!inEvent || skipDepth > 0) continue
    if (name === 'DTSTART') {
      start = icalDate(value)
      allDay = /VALUE=DATE(?![-T])/i.test(head) || /^\d{8}$/.test(value.trim())
    } else if (name === 'DTEND') end = icalDate(value)
    else if (name === 'SUMMARY') summary = icalUnescape(value)
  }
  return out.sort((a, b) => compareDates(a.date, b.date) || a.label.localeCompare(b.label))
}

/** What an import would do against what is already there: rows to add, rows the calendar no longer has. */
export function diffDaysOff(
  existing: readonly Pick<SchoolDayOff, 'date' | 'label'>[],
  incoming: readonly DayOffInput[],
): { add: DayOffInput[]; remove: Pick<SchoolDayOff, 'date' | 'label'>[] } {
  const key = (d: { date: CivilDate; label: string }) => `${d.date}|${d.label.trim().toLowerCase()}`
  const have = new Set(existing.map(key))
  const want = new Set(incoming.map(key))
  const add: DayOffInput[] = []
  const seen = new Set<string>()
  for (const d of incoming) {
    const k = key(d)
    if (have.has(k) || seen.has(k)) continue
    seen.add(k)
    add.push({ date: d.date, label: d.label.trim() })
  }
  return { add, remove: existing.filter((d) => !want.has(key(d))) }
}

// ---------------------------------------------------------------- DVC listings (D26)

export interface DvcListing {
  resort: string
  room: string
  checkIn: CivilDate
  nights: number
  points: number | null
  priceCents: Cents | null
  /** The source key, or 'read:<model>' when the reader read the page. */
  source: string
  sourceUrl: string
  seenOn: CivilDate
}

export interface ParsedListings {
  listings: Omit<DvcListing, 'source' | 'sourceUrl' | 'seenOn'>[]
  reason: string | null
}

export interface ListingSourceArgs {
  from: CivilDate
  to: CivilDate
}

/** A broker's public availability page the app can read, behind one shape (D26). */
export interface ListingSource {
  key: string
  label: string
  url(args: ListingSourceArgs): string
  parse(body: string): ParsedListings
}

export function validateDvcListing(l: Omit<DvcListing, 'source' | 'sourceUrl' | 'seenOn'>): void {
  if (!l.resort.trim()) throw new TripPlanError('A listing needs a resort.')
  if (!l.room.trim()) throw new TripPlanError('A listing needs a room type.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.checkIn)) throw new TripPlanError('A listing needs a check-in date.')
  if (!Number.isInteger(l.nights) || l.nights < 1 || l.nights > 60) throw new TripPlanError('A listing is a whole number of nights, 1 to 60.')
  if (l.points !== null && (!Number.isInteger(l.points) || l.points < 0)) throw new TripPlanError('Points are a whole number.')
  if (l.priceCents !== null && (!Number.isInteger(l.priceCents) || l.priceCents < 0)) throw new TripPlanError('A price is whole cents, zero or more.')
}

const RESORT_KEY = /resort|hotel|property/i
const ROOM_KEY = /room|villa|view|unit|accommodation/i
const CHECK_IN_KEY = /check[-_ ]?in|arriv|start|from/i
const CHECK_OUT_KEY = /check[-_ ]?out|depart|end|^to$/i
const NIGHTS_KEY = /night/i
const POINTS_KEY = /point/i
const PRICE_KEY = /price|cost|total|rate|amount/i
/** The labels a card writes before its values, so one value stops where the next label starts. */
const CARD_LABEL = /(?:resort|hotel|property|room|villa|view|unit|check[-_ ]?in|check[-_ ]?out|arriv|depart|nights?|points?|price|cost|total|rate|amount)/i

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A date as a listing might write it. */
export function listingDate(text: unknown): CivilDate | null {
  if (typeof text !== 'string' && typeof text !== 'number') return null
  const s = String(text).trim()
  let m: RegExpMatchArray | null
  if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return icalDate(`${m[1]}${m[2]}${m[3]}`)
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return icalDate(`${m[3]}${m[1]!.padStart(2, '0')}${m[2]!.padStart(2, '0')}`)
  if ((m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/))) {
    const mi = MONTH_NAMES.indexOf(m[1]!.toLowerCase().slice(0, 3))
    if (mi === -1) return null
    return icalDate(`${m[3]}${String(mi + 1).padStart(2, '0')}${m[2]!.padStart(2, '0')}`)
  }
  return null
}

/** "$1,234.50", "1234", 1234.5 -> whole cents; anything else nothing. */
export function listingPriceCents(value: unknown): Cents | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null
  if (typeof value !== 'string') return null
  const m = value.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function wholeNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number((value.match(/\d+/) ?? [NaN])[0]) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim()

type Draft = Partial<Omit<DvcListing, 'source' | 'sourceUrl' | 'seenOn'>> & { checkOut?: CivilDate | null }

function finish(d: Draft, out: ParsedListings['listings']): void {
  if (!d.resort || !d.room || !d.checkIn) return
  let nights = d.nights ?? null
  if (nights === null && d.checkOut) nights = compareDates(d.checkOut, d.checkIn)
  if (nights === null || nights < 1 || nights > 60) return
  out.push({ resort: d.resort, room: d.room, checkIn: d.checkIn, nights, points: d.points ?? null, priceCents: d.priceCents ?? null })
}

function fromJson(value: unknown, out: ParsedListings['listings'], depth = 0): void {
  if (depth > 12 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) fromJson(item, out, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  const d: Draft = {}
  for (const [key, v] of Object.entries(record)) {
    if (v === null || typeof v === 'object') continue
    if (!d.resort && RESORT_KEY.test(key) && typeof v === 'string') d.resort = v.trim()
    else if (!d.room && ROOM_KEY.test(key) && typeof v === 'string') d.room = v.trim()
    else if (!d.checkIn && CHECK_IN_KEY.test(key) && !CHECK_OUT_KEY.test(key)) d.checkIn = listingDate(v) ?? undefined
    else if (!d.checkOut && CHECK_OUT_KEY.test(key)) d.checkOut = listingDate(v)
    else if (d.nights === undefined && NIGHTS_KEY.test(key)) d.nights = wholeNumber(v) ?? undefined
    else if (d.points === undefined && POINTS_KEY.test(key)) d.points = wholeNumber(v) ?? null
    else if (d.priceCents === undefined && PRICE_KEY.test(key)) d.priceCents = listingPriceCents(v)
  }
  const before = out.length
  finish(d, out)
  if (out.length > before) return
  for (const v of Object.values(record)) if (v && typeof v === 'object') fromJson(v, out, depth + 1)
}

function jsonCandidates(text: string): unknown[] {
  const found: unknown[] = []
  const tryParse = (s: string) => {
    try {
      found.push(JSON.parse(s))
      return true
    } catch {
      return false
    }
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) tryParse(trimmed)
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = (m[1] ?? '').trim()
    if (!body || tryParse(body)) continue
    const first = body.search(/[[{]/)
    if (first === -1) continue
    const closer = body[first] === '[' ? ']' : '}'
    const last = body.lastIndexOf(closer)
    if (last > first) tryParse(body.slice(first, last + 1))
  }
  return found
}

function fromTables(html: string, out: ParsedListings['listings']): void {
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...(table[1] ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...(r[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1] ?? '')),
    )
    if (rows.length < 2) continue
    const header = rows[0]!.map((h) => h.toLowerCase())
    const col = (pattern: RegExp, not?: RegExp) => header.findIndex((h) => pattern.test(h) && !(not && not.test(h)))
    const iResort = col(RESORT_KEY)
    const iRoom = col(ROOM_KEY)
    const iIn = col(CHECK_IN_KEY, CHECK_OUT_KEY)
    const iOut = col(CHECK_OUT_KEY)
    const iNights = col(NIGHTS_KEY)
    const iPoints = col(POINTS_KEY)
    const iPrice = col(PRICE_KEY)
    if (iResort === -1 || iIn === -1) continue
    for (const cells of rows.slice(1)) {
      const d: Draft = {
        resort: cells[iResort],
        room: iRoom === -1 ? 'Room' : cells[iRoom],
        checkIn: listingDate(cells[iIn]) ?? undefined,
        checkOut: iOut === -1 ? null : listingDate(cells[iOut]),
        nights: iNights === -1 ? undefined : (wholeNumber(cells[iNights]) ?? undefined),
        points: iPoints === -1 ? null : wholeNumber(cells[iPoints]),
        priceCents: iPrice === -1 ? null : listingPriceCents(cells[iPrice]),
      }
      finish(d, out)
    }
  }
}

/**
 * Cards: any element whose class says "listing", "availability", "result" or
 * "reservation", read as labelled text ("Check-in: Jun 12, 2027", "5
 * nights", "120 points", "$1,850").
 */
function fromCards(html: string, out: ParsedListings['listings']): void {
  for (const m of html.matchAll(/<(div|li|article|section)\b[^>]*class="[^"]*(?:listing|availability|result|reservation)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(m[2] ?? '')
    const labelled = (pattern: RegExp) => {
      const hit = text.match(new RegExp(`(?:${pattern.source})[^:]*:\\s*([^|·\\n]+?)(?=\\s+${CARD_LABEL.source}s?\\s*:|\\s*[|·]|$)`, 'i'))
      return hit?.[1]?.trim() ?? null
    }
    const d: Draft = {
      resort: labelled(RESORT_KEY) ?? undefined,
      room: labelled(ROOM_KEY) ?? undefined,
      checkIn: listingDate(labelled(CHECK_IN_KEY) ?? '') ?? undefined,
      checkOut: listingDate(labelled(CHECK_OUT_KEY) ?? ''),
      nights: wholeNumber((text.match(/(\d+)\s*nights?/i) ?? [])[1]) ?? undefined,
      points: wholeNumber((text.match(/(\d+)\s*points?/i) ?? [])[1]),
      priceCents: listingPriceCents((text.match(/\$\s*[\d,]+(?:\.\d{2})?/) ?? [])[0]),
    }
    finish(d, out)
  }
}

/**
 * Read a broker's availability page however it carries its rows: JSON in a
 * script tag, a table, or cards. One row per resort, room, check-in and
 * nights; a page with nothing readable is nothing with a reason, never an
 * exception. Only listings inside the dates asked for are kept when dates
 * are given.
 */
export function parseListingPage(text: string, args?: ListingSourceArgs): ParsedListings {
  if (typeof text !== 'string' || !text.trim()) return { listings: [], reason: 'The page was empty.' }
  const found: ParsedListings['listings'] = []
  for (const json of jsonCandidates(text)) fromJson(json, found)
  if (found.length === 0) fromTables(text, found)
  if (found.length === 0) fromCards(text, found)
  const seen = new Set<string>()
  const listings = found.filter((l) => {
    if (args && (compareDates(l.checkIn, args.from) < 0 || compareDates(l.checkIn, args.to) > 0)) return false
    const key = `${l.resort.toLowerCase()}|${l.room.toLowerCase()}|${l.checkIn}|${l.nights}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (listings.length === 0) {
    return { listings, reason: found.length > 0 ? 'The page had listings, but none for those dates.' : 'Nothing on the page read as a list of DVC rooms.' }
  }
  return { listings, reason: null }
}

export const DVC_RENTAL_STORE_URL = 'https://dvcrentalstore.com/guests/check-dvc-availability/'
export const DVC_RENTAL_STORE_CONFIRMED_URL = 'https://dvcrentalstore.com/guests/confirmed-reservations/'

/** The sources in the order tried (D26). The DVC members' own tool needs a login and is not touched. */
export const DVC_LISTING_SOURCES: readonly ListingSource[] = [
  {
    key: 'dvc_rental_store',
    label: 'DVC Rental Store',
    url: (args) => `${DVC_RENTAL_STORE_URL}?check_in=${args.from}&check_out=${args.to}`,
    parse: (body) => parseListingPage(body),
  },
  {
    key: 'dvc_rental_store_confirmed',
    label: 'DVC Rental Store confirmed reservations',
    url: () => DVC_RENTAL_STORE_CONFIRMED_URL,
    parse: (body) => parseListingPage(body),
  },
]

/** The dates a "Check what DVC brokers have" press asks about: the trip's, two days either side. */
export const DVC_LISTING_SLACK_DAYS = 2

export function listingWindow(trip: Pick<Trip, 'startDate' | 'endDate'>): ListingSourceArgs {
  return { from: addDays(trip.startDate, -DVC_LISTING_SLACK_DAYS), to: addDays(trip.endDate, DVC_LISTING_SLACK_DAYS) }
}

/** Listings for a check-in near the trip's start, soonest first, then by price. */
export function listingsForTrip(listings: readonly DvcListing[], trip: Pick<Trip, 'startDate' | 'endDate'>): DvcListing[] {
  const w = listingWindow(trip)
  return listings
    .filter((l) => compareDates(l.checkIn, w.from) >= 0 && compareDates(l.checkIn, w.to) <= 0)
    .sort((a, b) => compareDates(a.checkIn, b.checkIn) || (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity) || a.resort.localeCompare(b.resort))
}
