/**
 * Ballast's own park data (PRD §16, D28-D29).
 *
 * The calendar comes first: before a family picks a week it wants to see the
 * year -- how hot, how busy, how late the parks stay open, when school is
 * out. That page is drawn from reference data Ballast collects for itself
 * (park_weather, park_hours, wait_observations, and crowd_levels from the
 * outlook), household-independent, each row with a source and the day it
 * was fetched. This module reads what the adapters bring back, blends it,
 * and lays a month out as cells. Nothing here is money, and nothing here
 * is stored: busyness is derived on every read.
 *
 * HOW BUSY (D28). One function, busynessFor, answers for a date and a park,
 * and every screen and score reads through it. In order:
 *
 *   1. a level a person typed for that day (crowd_levels, source "typed"):
 *      the household's own word, kept over anything fetched (D23);
 *   2. the forward outlook (crowd_levels rows from the outlook source);
 *   3. the household's own wait history, scaled to 1-10 (below);
 *   4. a level a crowd-calendar parser read (crowd_levels, any other source);
 *   5. nothing.
 *
 * Each answer says which of these it is, so the screen can show its source
 * on tap. The resort as a whole on a date is the resort-wide figure a tier
 * gives (park "other"), else the mean of the theme parks that tier knows.
 *
 * WAIT HISTORY TO BUSYNESS. Queue-Times is polled every few minutes into
 * wait_observations. A day's figure for a park is the mean posted wait
 * across its open rides over the observations that day. The same month-day
 * across the years is averaged, so June 14th has one figure whatever the
 * year. Those month-day figures are then ranked across the whole year the
 * history covers: a day's level is its percentile among them, in tens --
 * the quietest tenth of days is 1, the busiest tenth is 10. Ranking rather
 * than scaling by minutes means a park whose waits are all long still
 * shows which of its days are the quiet ones, which is the question. With
 * fewer than WAIT_HISTORY_MIN_DAYS month-days of history, the ranks would
 * say little, so the history answers nothing and the next tier is asked.
 *
 * WEATHER. Three horizons from Open-Meteo: a forecast to 16 days, a
 * sub-seasonal outlook to about six weeks, and the typical figures for the
 * date from ten years of archive, averaged per month-day here. For a date
 * the closest horizon wins, and the cell is marked with which one it was.
 */

import { addDays, compareDates, todayIn, type CivilDate } from './dates'
import type { TripDestination } from './trip'
import { crowdLevelsFromJson, pickLevel, THEME_PARKS, TripPlanError, parkFromText, type BlackoutRange, type CrowdLevel, type TripPark } from './trip-plan'
import type { DayOffInput, Holiday } from './trip-when'

// ---------------------------------------------------------------- facts

export type WeatherHorizon = 'forecast' | 'subseasonal' | 'normal'

export const WEATHER_HORIZONS: readonly WeatherHorizon[] = ['forecast', 'subseasonal', 'normal']

export const WEATHER_HORIZON_WORDS: Record<WeatherHorizon, string> = {
  forecast: 'forecast',
  subseasonal: '6-week outlook',
  normal: 'typical for this date',
}

export interface ParkWeather {
  destination: TripDestination
  date: CivilDate
  /** Whole degrees Fahrenheit. */
  highF: number
  lowF: number
  /** 0-100, or nothing when the horizon does not say. */
  precipChance: number | null
  horizon: WeatherHorizon
  source: string
  fetchedOn: CivilDate
}

/** A day's weather as a parser reads it, before the destination, horizon and day of fetch are added. */
export interface ParsedWeatherDay {
  date: CivilDate
  highF: number
  lowF: number
  precipChance: number | null
}

export interface ParkHours {
  destination: TripDestination
  park: TripPark
  date: CivilDate
  /** "HH:MM", the park's own clock. */
  opens: string
  closes: string
  /** When early entry starts, "HH:MM", or nothing that day. */
  earlyEntry: string | null
  /** When extended evening hours end, "HH:MM", or nothing that day. */
  extendedEvening: string | null
  source: string
  fetchedOn: CivilDate
}

export type ParsedParkHours = Omit<ParkHours, 'destination' | 'park' | 'source' | 'fetchedOn'>

export interface WaitObservation {
  source: string
  parkId: string
  parkName: string
  rideId: string
  rideName: string
  isOpen: boolean
  /** Posted minutes while open; nothing while closed. */
  waitMinutes: number | null
  /** The payload's own timestamp, ISO 8601. */
  observedAt: string
}

/** A park's day of waits, summed up: the mean posted wait across its open rides over every observation that day. */
export interface WaitDaySummary {
  parkName: string
  date: CivilDate
  meanWaitMinutes: number
  observations: number
}

export type BusynessSource = 'typed' | 'outlook' | 'wait_history' | 'crowd_level'

export const BUSYNESS_SOURCE_WORDS: Record<BusynessSource, string> = {
  typed: 'typed by you',
  outlook: 'crowd outlook',
  wait_history: 'from our own wait history',
  crowd_level: 'crowd calendar',
}

export interface Busyness {
  /** 1 quiet to 10 packed. */
  level: number
  source: BusynessSource
  /** The source's own name, for the screen: "ropedrop", "thrill_data", "typed". */
  detail: string
  fetchedOn: CivilDate | null
}

/** The source key the outlook is stored under in crowd_levels. */
export const OUTLOOK_SOURCE = 'ropedrop'

export const WAIT_HISTORY_MIN_DAYS = 14

export const QUEUE_TIMES_SOURCE = 'queue_times'
export const QUEUE_TIMES_ATTRIBUTION = { text: 'Powered by Queue-Times.com', url: 'https://queue-times.com/en-US' }

export const OPEN_METEO_SOURCE = 'open_meteo'
export const THEMEPARKS_SOURCE = 'themeparks_wiki'

/** The park names Queue-Times uses, under its "Walt Disney World" group, laid over by a setting. */
export const DEFAULT_QUEUE_TIMES_PARKS: Record<Exclude<TripPark, 'water_park' | 'other' | 'rest' | 'travel'>, string> = {
  magic_kingdom: 'Magic Kingdom',
  epcot: 'Epcot',
  hollywood_studios: "Disney's Hollywood Studios",
  animal_kingdom: "Disney's Animal Kingdom",
}
export const DEFAULT_QUEUE_TIMES_GROUP = 'Walt Disney World'

/** ThemeParks.wiki's destination for Walt Disney World. */
export const THEMEPARKS_WDW_DESTINATION_ID = 'e957da41-3552-4cf6-b636-5babc5cbc4e5'

export const PARK_WEATHER_STALE_AFTER_DAYS = 3
export const PARK_HOURS_STALE_AFTER_DAYS = 7
export const OUTLOOK_STALE_AFTER_DAYS = 14

// ---------------------------------------------------------------- validation

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function validateParkWeather(w: Pick<ParkWeather, 'date' | 'highF' | 'lowF' | 'precipChance' | 'horizon' | 'source'>): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) throw new TripPlanError('A weather row needs a date.')
  if (!Number.isInteger(w.highF) || !Number.isInteger(w.lowF) || w.highF < -50 || w.highF > 130 || w.lowF < -50 || w.lowF > 130) throw new TripPlanError('Temperatures are whole degrees Fahrenheit that a person could stand in.')
  if (w.lowF > w.highF) throw new TripPlanError('The low cannot be above the high.')
  if (w.precipChance !== null && (!Number.isInteger(w.precipChance) || w.precipChance < 0 || w.precipChance > 100)) throw new TripPlanError('The chance of rain is a whole percent, 0 to 100.')
  if (!WEATHER_HORIZONS.includes(w.horizon)) throw new TripPlanError('A weather row is a forecast, a 6-week outlook, or typical for the date.')
  if (!w.source.trim()) throw new TripPlanError('A weather row needs to say where it came from.')
}

export function validateParkHours(h: Pick<ParkHours, 'date' | 'park' | 'opens' | 'closes' | 'earlyEntry' | 'extendedEvening' | 'source'>): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) throw new TripPlanError('Park hours need a date.')
  if (!THEME_PARKS.includes(h.park)) throw new TripPlanError('Park hours are for the four theme parks.')
  for (const t of [h.opens, h.closes, h.earlyEntry, h.extendedEvening]) {
    if (t !== null && !TIME.test(t)) throw new TripPlanError('A park time is hours and minutes, like 09:00.')
  }
  if (!h.source.trim()) throw new TripPlanError('Park hours need to say where they came from.')
}

export function validateWaitObservation(o: WaitObservation): void {
  if (!o.source.trim() || !o.parkId.trim() || !o.rideId.trim()) throw new TripPlanError('A wait observation needs a source, a park and a ride.')
  if (o.waitMinutes !== null && (!Number.isInteger(o.waitMinutes) || o.waitMinutes < 0 || o.waitMinutes > 1440)) throw new TripPlanError('A wait is whole minutes, zero or more.')
  if (Number.isNaN(Date.parse(o.observedAt))) throw new TripPlanError('A wait observation needs the time it was posted.')
}

// ---------------------------------------------------------------- weather

const MONTH_DAY = (date: CivilDate) => date.slice(5, 10)

/** A whole degree, halves away from zero. */
const wholeDegrees = (n: number) => Math.round(n)

/**
 * The typical high and low for each month-day from years of daily archive
 * rows: the mean over the years that have that day, to whole degrees. A
 * February 29th averages only the leap years. Keys are "MM-DD".
 */
export function normalsFromArchive(rows: readonly ParsedWeatherDay[]): Map<string, { highF: number; lowF: number; years: number }> {
  const sums = new Map<string, { high: number; low: number; years: number }>()
  for (const r of rows) {
    const key = MONTH_DAY(r.date)
    const have = sums.get(key) ?? { high: 0, low: 0, years: 0 }
    sums.set(key, { high: have.high + r.highF, low: have.low + r.lowF, years: have.years + 1 })
  }
  const out = new Map<string, { highF: number; lowF: number; years: number }>()
  for (const [key, s] of sums) out.set(key, { highF: wholeDegrees(s.high / s.years), lowF: wholeDegrees(s.low / s.years), years: s.years })
  return out
}

export interface BlendedWeather {
  highF: number
  lowF: number
  precipChance: number | null
  horizon: WeatherHorizon
  fetchedOn: CivilDate
  source: string
}

/**
 * The weather to show for a date: the forecast when there is one, else the
 * 6-week outlook, else what is typical for the date. Each is looked up by
 * the date itself; the horizon on the answer says which one it was.
 */
export function blendWeather(input: {
  forecast: readonly ParkWeather[]
  subseasonal: readonly ParkWeather[]
  normals: readonly ParkWeather[]
  date: CivilDate
}): BlendedWeather | null {
  const tiers: [readonly ParkWeather[], WeatherHorizon][] = [
    [input.forecast, 'forecast'],
    [input.subseasonal, 'subseasonal'],
    [input.normals, 'normal'],
  ]
  for (const [rows, horizon] of tiers) {
    let best: ParkWeather | null = null
    for (const r of rows) {
      if (r.date !== input.date || r.horizon !== horizon) continue
      if (!best || compareDates(r.fetchedOn, best.fetchedOn) > 0) best = r
    }
    if (best) return { highF: best.highF, lowF: best.lowF, precipChance: best.precipChance, horizon, fetchedOn: best.fetchedOn, source: best.source }
  }
  return null
}

/** Weather rows split by horizon, so a caller can hand blendWeather one read. */
export function splitWeather(rows: readonly ParkWeather[]): { forecast: ParkWeather[]; subseasonal: ParkWeather[]; normals: ParkWeather[] } {
  return {
    forecast: rows.filter((r) => r.horizon === 'forecast'),
    subseasonal: rows.filter((r) => r.horizon === 'subseasonal'),
    normals: rows.filter((r) => r.horizon === 'normal'),
  }
}

/**
 * The typical rows to store for a stretch of dates: each date takes its
 * month-day's figure. A date whose month-day the archive never had (a
 * February 29th in ten years without one) gets nothing.
 */
export function normalsForDates(normals: ReadonlyMap<string, { highF: number; lowF: number }>, from: CivilDate, to: CivilDate): ParsedWeatherDay[] {
  const out: ParsedWeatherDay[] = []
  for (let d = from; compareDates(d, to) <= 0; d = addDays(d, 1)) {
    const n = normals.get(MONTH_DAY(d))
    if (n) out.push({ date: d, highF: n.highF, lowF: n.lowF, precipChance: null })
  }
  return out
}

// ---------------------------------------------------------------- how busy

/** A park's month-day levels from its wait history, built once and looked up many times. */
export type WaitHistoryIndex = Map<string, Map<string, { level: number; meanWaitMinutes: number }>>

/** Per park and date on the park's own clock, the mean posted wait across open rides over every observation that day. */
export function summariseWaits(observations: readonly WaitObservation[], timezone: string = 'America/New_York'): WaitDaySummary[] {
  const sums = new Map<string, { parkName: string; date: CivilDate; total: number; count: number }>()
  for (const o of observations) {
    if (!o.isOpen || o.waitMinutes === null) continue
    const date = todayIn(timezone, new Date(o.observedAt))
    const key = `${o.parkName}|${date}`
    const have = sums.get(key) ?? { parkName: o.parkName, date, total: 0, count: 0 }
    sums.set(key, { ...have, total: have.total + o.waitMinutes, count: have.count + 1 })
  }
  return [...sums.values()]
    .map((s) => ({ parkName: s.parkName, date: s.date, meanWaitMinutes: s.total / s.count, observations: s.count }))
    .sort((a, b) => a.parkName.localeCompare(b.parkName) || compareDates(a.date, b.date))
}

/**
 * The index: each park's month-day mean across the years, ranked across the
 * days it has into tens (see the note at the top). A park with too few
 * month-days is left out.
 */
export function indexWaitHistory(summaries: readonly WaitDaySummary[], minDays: number = WAIT_HISTORY_MIN_DAYS): WaitHistoryIndex {
  const perPark = new Map<string, Map<string, { total: number; years: number }>>()
  for (const s of summaries) {
    const days = perPark.get(s.parkName) ?? new Map()
    const key = MONTH_DAY(s.date)
    const have = days.get(key) ?? { total: 0, years: 0 }
    days.set(key, { total: have.total + s.meanWaitMinutes, years: have.years + 1 })
    perPark.set(s.parkName, days)
  }
  const out: WaitHistoryIndex = new Map()
  for (const [parkName, days] of perPark) {
    if (days.size < minDays) continue
    const means = [...days].map(([key, d]) => ({ key, mean: d.total / d.years }))
    const sorted = means.map((m) => m.mean).sort((a, b) => a - b)
    const n = sorted.length
    const levels = new Map<string, { level: number; meanWaitMinutes: number }>()
    for (const m of means) {
      // Percentile rank: how many days are no busier than this one, out of all days, in tens.
      let atOrBelow = 0
      for (const v of sorted) if (v <= m.mean) atOrBelow += 1
      const level = Math.max(1, Math.min(10, Math.ceil((10 * atOrBelow) / n)))
      levels.set(m.key, { level, meanWaitMinutes: Math.round(m.mean * 10) / 10 })
    }
    out.set(parkName, levels)
  }
  return out
}

/** The park names the wait history is filed under, as the household set them; the default is Queue-Times' own names. */
export type WaitParkNames = Partial<Record<TripPark, string>>

/**
 * How busy a park is on a date from the household's own wait history alone
 * (D28), for a test or a screen that wants that tier by itself. Everything
 * the calendar reads goes through busynessFor instead.
 */
export function waitHistoryToBusyness(
  observations: readonly WaitObservation[],
  args: { date: CivilDate; park: TripPark; parkNames?: WaitParkNames },
): Busyness | null {
  return busynessFromWaits(indexWaitHistory(summariseWaits(observations)), args.date, args.park, args.parkNames ?? DEFAULT_QUEUE_TIMES_PARKS, null)
}

function busynessFromWaits(index: WaitHistoryIndex, date: CivilDate, park: TripPark, parkNames: WaitParkNames, fetchedOn: CivilDate | null): Busyness | null {
  const name = parkNames[park]
  if (!name) return null
  const hit = index.get(name)?.get(MONTH_DAY(date))
  if (!hit) return null
  return { level: hit.level, source: 'wait_history', detail: `${name}: ${hit.meanWaitMinutes} min average wait on this date`, fetchedOn }
}

/** Everything busynessFor can draw on, gathered once by the engine. */
export interface BusynessSources {
  /** Outlook rows (crowd_levels with the outlook source). */
  outlook?: readonly CrowdLevel[]
  /** The household's own wait history, indexed; or the raw summaries. */
  waitHistory?: WaitHistoryIndex | readonly WaitDaySummary[]
  waitParkNames?: WaitParkNames
  /** The newest observation's day, for the age shown. */
  waitHistoryAsOf?: CivilDate | null
  /** Crowd-calendar rows, typed ones included. */
  crowdLevels?: readonly CrowdLevel[]
  /** Typed rows, when kept apart from the fetched ones; otherwise found by source in crowdLevels. */
  typed?: readonly CrowdLevel[]
}

const fromCrowd = (l: CrowdLevel, source: BusynessSource): Busyness => ({ level: l.level, source, detail: l.source, fetchedOn: l.fetchedOn })

const TIER_ORDER: BusynessSource[] = ['typed', 'outlook', 'wait_history', 'crowd_level']

/** The mean of the theme parks that answered, labelled with the best tier among them and how many parks it covers. */
function meanOfParks(answers: readonly (Busyness | null)[]): Busyness | null {
  const found = answers.filter((b): b is Busyness => b !== null)
  if (found.length === 0) return null
  const mean = found.reduce((s, b) => s + b.level, 0) / found.length
  const best = found.reduce((a, b) => (TIER_ORDER.indexOf(b.source) < TIER_ORDER.indexOf(a.source) ? b : a))
  return { level: Math.round(mean * 10) / 10, source: best.source, detail: `${found.length} of 4 parks`, fetchedOn: best.fetchedOn }
}

/**
 * The one answer to "how busy" for a date and a park (D28): the tiers in
 * the order at the top of the file, the first that knows wins, and the
 * answer says which it was. Park "other" is the resort as a whole: a
 * resort-wide figure a person typed or the outlook gave, else the mean of
 * each theme park's own answer (each from its best tier, so a typed level
 * for one park and a calendar's for another are averaged together, as a
 * person would), else a crowd calendar's resort-wide figure.
 */
export function busynessFor(input: { date: CivilDate; park: TripPark } & BusynessSources): Busyness | null {
  const { date, park } = input
  const crowd = input.crowdLevels ?? []
  const typed = input.typed ?? crowd.filter((l) => l.source === 'typed')
  const fetched = crowd.filter((l) => l.source !== 'typed' && l.source !== OUTLOOK_SOURCE)
  const outlook = input.outlook ?? crowd.filter((l) => l.source === OUTLOOK_SOURCE)
  const index = input.waitHistory instanceof Map ? input.waitHistory : input.waitHistory ? indexWaitHistory(input.waitHistory) : null
  const parkNames = input.waitParkNames ?? DEFAULT_QUEUE_TIMES_PARKS

  const tiers: ((p: TripPark) => Busyness | null)[] = [
    (p) => {
      const l = pickLevel(typed, date, p)
      return l ? fromCrowd(l, 'typed') : null
    },
    (p) => {
      const l = pickLevel(outlook, date, p)
      return l ? fromCrowd(l, 'outlook') : null
    },
    (p) => (index ? busynessFromWaits(index, date, p, parkNames, input.waitHistoryAsOf ?? null) : null),
    (p) => {
      const l = pickLevel(fetched, date, p)
      return l ? fromCrowd(l, 'crowd_level') : null
    },
  ]
  const own = (p: TripPark): Busyness | null => {
    for (const tier of tiers) {
      const hit = tier(p)
      if (hit) return hit
    }
    return null
  }
  if (THEME_PARKS.includes(park)) return own(park)
  return tiers[0]!('other') ?? tiers[1]!('other') ?? meanOfParks(THEME_PARKS.map(own)) ?? tiers[3]!('other')
}

// ---------------------------------------------------------------- the calendar (D29)

export interface CalendarCell {
  date: CivilDate
  /** 1-31, for the grid. */
  day: number
  weekend: boolean
  past: boolean
  today: boolean
  weather: BlendedWeather | null
  busyness: Busyness | null
  /** The theme park that closes first that day, and when. */
  earliestClose: { park: TripPark; closes: string } | null
  daysOff: string[]
  holidays: string[]
  blackouts: string[]
}

export interface CalendarMonth {
  month: string
  /** "June 2027". */
  label: string
  /** Rows of seven, Sunday first, padded with nulls at the ends. */
  weeks: (CalendarCell | null)[][]
  previous: string
  next: string
  /** The month's park hours as stored, for the day a person taps. */
  hours: ParkHours[]
  /** The newest day each kind of data was fetched, for the age shown. */
  freshness: { weather: CivilDate | null; hours: CivilDate | null; busyness: CivilDate | null }
  /** Which weather horizons the month shows, for the legend. */
  horizonsShown: WeatherHorizon[]
  /** Which busyness sources the month shows, for the legend. */
  busynessSourcesShown: BusynessSource[]
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1]} ${y}`
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + by
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** The first and last date of a month. */
export function monthBounds(month: string): { from: CivilDate; to: CivilDate } {
  const from: CivilDate = `${month}-01`
  const to = addDays(`${shiftMonth(month, 1)}-01`, -1)
  return { from, to }
}

/** "2027-06" for any date. */
export const monthOf = (date: CivilDate): string => date.slice(0, 7)

/** The earliest closing time among the theme parks that have hours that day. Extended evening does not count: it is for resort guests. */
export function earliestClose(hours: readonly ParkHours[], date: CivilDate): { park: TripPark; closes: string } | null {
  let best: { park: TripPark; closes: string } | null = null
  for (const h of hours) {
    if (h.date !== date || !THEME_PARKS.includes(h.park)) continue
    if (!best || h.closes < best.closes) best = { park: h.park, closes: h.closes }
  }
  return best
}

function weekdayOf(date: CivilDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/**
 * A month as the calendar shows it (D29): a cell per day with the weather
 * and its horizon, how busy and its source, the earliest park close, the
 * days off school, the federal holidays and the blocked-out stretches. The
 * engine gathers the inputs for the month; this lays them out.
 */
export function calendarMonth(input: {
  month: string
  weather: readonly ParkWeather[]
  hours: readonly ParkHours[]
  busyness: BusynessSources
  daysOff: readonly DayOffInput[]
  holidays: readonly Holiday[]
  blackouts: readonly BlackoutRange[]
  today: CivilDate
}): CalendarMonth {
  const { from, to } = monthBounds(input.month)
  const split = splitWeather(input.weather)
  const cells: CalendarCell[] = []
  for (let d = from; compareDates(d, to) <= 0; d = addDays(d, 1)) {
    const wd = weekdayOf(d)
    cells.push({
      date: d,
      day: Number(d.slice(8, 10)),
      weekend: wd === 0 || wd === 6,
      past: compareDates(d, input.today) < 0,
      today: d === input.today,
      weather: blendWeather({ ...split, date: d }),
      busyness: busynessFor({ ...input.busyness, date: d, park: 'other' }),
      earliestClose: earliestClose(input.hours, d),
      daysOff: input.daysOff.filter((o) => o.date === d).map((o) => o.label),
      holidays: input.holidays.filter((h) => h.date === d).map((h) => h.name),
      blackouts: input.blackouts.filter((b) => compareDates(b.from, d) <= 0 && compareDates(d, b.to) <= 0).map((b) => b.label),
    })
  }
  const weeks: (CalendarCell | null)[][] = []
  let row: (CalendarCell | null)[] = Array.from({ length: weekdayOf(from) }, () => null)
  for (const cell of cells) {
    row.push(cell)
    if (row.length === 7) {
      weeks.push(row)
      row = []
    }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push(null)
    weeks.push(row)
  }
  const newest = (dates: (CivilDate | null | undefined)[]) => dates.reduce<CivilDate | null>((best, d) => (d && (!best || compareDates(d, best) > 0) ? d : best), null)
  return {
    month: input.month,
    label: monthLabel(input.month),
    weeks,
    previous: shiftMonth(input.month, -1),
    next: shiftMonth(input.month, 1),
    hours: input.hours.filter((h) => monthOf(h.date) === input.month).sort((a, b) => compareDates(a.date, b.date) || a.park.localeCompare(b.park)),
    freshness: {
      weather: newest(cells.map((c) => c.weather?.fetchedOn)),
      hours: newest(input.hours.filter((h) => monthOf(h.date) === input.month).map((h) => h.fetchedOn)),
      busyness: newest(cells.map((c) => c.busyness?.fetchedOn)),
    },
    horizonsShown: WEATHER_HORIZONS.filter((h) => cells.some((c) => c.weather?.horizon === h)),
    busynessSourcesShown: (['typed', 'outlook', 'wait_history', 'crowd_level'] as BusynessSource[]).filter((s) => cells.some((c) => c.busyness?.source === s)),
  }
}

/** The colour step for a level, 1 to 5: two levels a step, so the scale reads at a glance. */
export function busynessStep(level: number): 1 | 2 | 3 | 4 | 5 {
  return Math.max(1, Math.min(5, Math.ceil(Math.round(level) / 2))) as 1 | 2 | 3 | 4 | 5
}

export function dataAge(fetchedOn: CivilDate | null, today: CivilDate): string {
  if (!fetchedOn) return 'never fetched'
  const days = Math.max(0, compareDates(today, fetchedOn))
  if (days === 0) return 'fetched today'
  if (days === 1) return 'fetched yesterday'
  return `fetched ${days} days ago`
}

// ---------------------------------------------------------------- what came back from a fetch

export interface Parsed<T> {
  rows: T[]
  /** Why there is nothing, in words for the screen. Null when something was read. */
  reason: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const civil = (v: unknown): CivilDate | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

/**
 * Open-Meteo's daily block, forecast or archive alike:
 * {daily: {time: [...], temperature_2m_max: [...], temperature_2m_min: [...], precipitation_probability_max?: [...]}}.
 * Temperatures are read as the unit that was asked for (Fahrenheit) and
 * rounded to whole degrees; a day with a null in either temperature is
 * skipped. Anything else is nothing with a reason.
 */
export function parseOpenMeteoDaily(json: unknown): Parsed<ParsedWeatherDay> {
  if (!isRecord(json)) return { rows: [], reason: 'The weather service did not answer with JSON.' }
  if (typeof json.error !== 'undefined' && json.error) return { rows: [], reason: `The weather service refused: ${typeof json.reason === 'string' ? json.reason : 'no reason given'}.` }
  const daily = json.daily
  if (!isRecord(daily) || !Array.isArray(daily.time)) return { rows: [], reason: 'The answer had no daily block.' }
  const highs = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : []
  const lows = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : []
  const rain = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : null
  const rows: ParsedWeatherDay[] = []
  daily.time.forEach((t, i) => {
    const date = civil(t)
    const high = finite(highs[i])
    const low = finite(lows[i])
    if (!date || high === null || low === null) return
    if (high < -50 || high > 130 || low < -50 || low > 130) return
    const chance = rain ? finite(rain[i]) : null
    rows.push({ date, highF: wholeDegrees(high), lowF: wholeDegrees(Math.min(low, high)), precipChance: chance === null ? null : Math.max(0, Math.min(100, Math.round(chance))) })
  })
  return rows.length > 0 ? { rows, reason: null } : { rows, reason: 'The daily block had no readable days.' }
}

/**
 * Open-Meteo's seasonal endpoint. Its daily block carries one series per
 * ensemble member (temperature_2m_max_member01, ...) or, on some builds, a
 * plain series; both are read, and the members are averaged per day. The
 * unit is taken as the one asked for. This shape is from the public docs
 * and was not checked live; a changed shape is nothing with a reason.
 */
export function parseOpenMeteoSeasonal(json: unknown): Parsed<ParsedWeatherDay> {
  if (!isRecord(json)) return { rows: [], reason: 'The seasonal service did not answer with JSON.' }
  if (typeof json.error !== 'undefined' && json.error) return { rows: [], reason: `The seasonal service refused: ${typeof json.reason === 'string' ? json.reason : 'no reason given'}.` }
  const daily = json.daily
  if (!isRecord(daily) || !Array.isArray(daily.time)) return { rows: [], reason: 'The answer had no daily block.' }
  const seriesFor = (prefix: string): unknown[][] =>
    Object.entries(daily)
      .filter(([k, v]) => (k === prefix || k.startsWith(`${prefix}_member`)) && Array.isArray(v))
      .map(([, v]) => v as unknown[])
  const highSeries = seriesFor('temperature_2m_max')
  const lowSeries = seriesFor('temperature_2m_min')
  if (highSeries.length === 0 || lowSeries.length === 0) return { rows: [], reason: 'The daily block had no temperature series.' }
  const meanAt = (series: unknown[][], i: number): number | null => {
    const values = series.map((s) => finite(s[i])).filter((v): v is number => v !== null && v >= -50 && v <= 130)
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
  }
  const rows: ParsedWeatherDay[] = []
  daily.time.forEach((t, i) => {
    const date = civil(t)
    const high = meanAt(highSeries, i)
    const low = meanAt(lowSeries, i)
    if (!date || high === null || low === null) return
    rows.push({ date, highF: wholeDegrees(high), lowF: wholeDegrees(Math.min(low, high)), precipChance: null })
  })
  return rows.length > 0 ? { rows, reason: null } : { rows, reason: 'The daily block had no readable days.' }
}

export interface ResolvedPark {
  park: TripPark
  id: string
  name: string
}

/**
 * ThemeParks.wiki's children of a destination: {children: [{id, name,
 * entityType}]}. The four theme parks are found by name; a water park or a
 * hotel is left out. The ids are what the schedule endpoint takes.
 */
export function parseThemeParksChildren(json: unknown): Parsed<ResolvedPark> & { missing: TripPark[] } {
  const list = isRecord(json) && Array.isArray(json.children) ? json.children : Array.isArray(json) ? json : null
  if (!list) return { rows: [], reason: 'The park service did not answer with a list of parks.', missing: [...THEME_PARKS] }
  const rows: ResolvedPark[] = []
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue
    if (typeof item.entityType === 'string' && item.entityType.toUpperCase() !== 'PARK') continue
    const park = parkFromText(item.name)
    if (!park || !THEME_PARKS.includes(park) || rows.some((r) => r.park === park)) continue
    rows.push({ park, id: item.id, name: item.name })
  }
  const missing = THEME_PARKS.filter((p) => !rows.some((r) => r.park === p))
  return { rows, reason: rows.length === 0 ? 'None of the four parks was in the list.' : null, missing }
}

/** "2027-06-12T09:00:00-04:00" -> "09:00": the clock on the wall at the park, no arithmetic. */
export function clockOf(iso: unknown): string | null {
  if (typeof iso !== 'string') return null
  const m = iso.match(/T(\d{2}):(\d{2})/)
  if (!m) return null
  const t = `${m[1]}:${m[2]}`
  return TIME.test(t) ? t : null
}

/**
 * ThemeParks.wiki's schedule for a park: {schedule: [{date, type,
 * openingTime, closingTime, description?}]}. OPERATING gives the day's
 * open and close; an EXTRA_HOURS entry whose description says early entry
 * gives when that starts, one that says extended evening gives when that
 * ends. Ticketed events are left out. Times are the strings' own clock.
 */
export function parseThemeParksSchedule(json: unknown): Parsed<ParsedParkHours> {
  const list = isRecord(json) && Array.isArray(json.schedule) ? json.schedule : null
  if (!list) return { rows: [], reason: 'The park service did not answer with a schedule.' }
  const byDate = new Map<CivilDate, ParsedParkHours>()
  const extras: { date: CivilDate; early: string | null; evening: string | null }[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const date = civil(item.date) ?? civil(item.openingTime)
    if (!date) continue
    const type = typeof item.type === 'string' ? item.type.toUpperCase() : ''
    const opens = clockOf(item.openingTime)
    const closes = clockOf(item.closingTime)
    if (type === 'OPERATING' && opens && closes) {
      byDate.set(date, { date, opens, closes, earlyEntry: null, extendedEvening: null })
    } else if (type === 'EXTRA_HOURS' || type === 'INFO') {
      const words = typeof item.description === 'string' ? item.description.toLowerCase() : ''
      if (/early/.test(words) && opens) extras.push({ date, early: opens, evening: null })
      else if (/extended|evening/.test(words) && closes) extras.push({ date, early: null, evening: closes })
    }
  }
  for (const e of extras) {
    const day = byDate.get(e.date)
    if (!day) continue
    if (e.early) day.earlyEntry = e.early
    if (e.evening) day.extendedEvening = e.evening
  }
  const rows = [...byDate.values()].sort((a, b) => compareDates(a.date, b.date))
  return rows.length > 0 ? { rows, reason: null } : { rows, reason: 'The schedule had no operating days.' }
}

export interface ParsedOutlookLevel {
  date: CivilDate
  park: TripPark
  level: number
}

/**
 * RopeDrop Planner's outlook. The shape is not pinned down by its public
 * page, so the reader is defensive: any JSON carrying per-date, per-park
 * crowd levels or wait predictions is walked for {date, level | crowd |
 * index | wait, park?}, a percent is scaled to tens, and a predicted wait
 * in minutes is scaled to tens over ten-minute steps (a 60-minute average
 * wait is a 6). The caller adds the source. Nothing readable is nothing
 * with a reason.
 */
export function parseRopeDropOutlook(json: unknown): Parsed<ParsedOutlookLevel> {
  if (json === null || typeof json !== 'object') return { rows: [], reason: 'The outlook did not answer with JSON.' }
  const found = crowdLevelsFromJson(json)
  const seen = new Set<string>()
  const rows = found.filter((l) => {
    const key = `${l.date}|${l.park}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return rows.length > 0 ? { rows, reason: null } : { rows, reason: 'Nothing in the outlook read as a crowd level by date.' }
}

/**
 * Queue-Times' list of parks: [{id, name, parks: [{id, name}]}] grouped by
 * company. The four parks are found by the names the household set (the
 * defaults are Queue-Times' own) under the named group; a name not found
 * is reported so the log can say so.
 */
export function parseQueueTimesParks(
  json: unknown,
  wanted: WaitParkNames = DEFAULT_QUEUE_TIMES_PARKS,
  group: string = DEFAULT_QUEUE_TIMES_GROUP,
): Parsed<ResolvedPark> & { missing: string[] } {
  const groups = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.companies) ? json.companies : null
  const names = Object.entries(wanted).filter((e): e is [TripPark, string] => typeof e[1] === 'string' && e[1].trim() !== '')
  if (!groups) return { rows: [], reason: 'The wait service did not answer with a list of parks.', missing: names.map(([, n]) => n) }
  const norm = (s: string) => s.trim().toLowerCase()
  const candidates: { id: string; name: string }[] = []
  for (const g of groups) {
    if (!isRecord(g)) continue
    const groupName = typeof g.name === 'string' ? g.name : ''
    if (group && norm(groupName) !== norm(group)) continue
    const parks = Array.isArray(g.parks) ? g.parks : []
    for (const p of parks) {
      if (!isRecord(p) || typeof p.name !== 'string' || (typeof p.id !== 'number' && typeof p.id !== 'string')) continue
      candidates.push({ id: String(p.id), name: p.name })
    }
  }
  const rows: ResolvedPark[] = []
  const missing: string[] = []
  for (const [park, name] of names) {
    const hit = candidates.find((c) => norm(c.name) === norm(name))
    if (hit) rows.push({ park, id: hit.id, name: hit.name })
    else missing.push(name)
  }
  return { rows, reason: rows.length === 0 ? `No park under "${group}" matched the names set.` : null, missing }
}

/**
 * Queue-Times' waits for a park: {lands: [{rides: [...]}], rides: [...]},
 * each ride {id, name, is_open, wait_time, last_updated}. A ride's posted
 * wait counts while it is open; closed is a wait of nothing. The time is
 * the payload's own last_updated, never the clock here.
 */
export function parseQueueTimesWaits(json: unknown, park: { parkId: string; parkName: string }, source: string = QUEUE_TIMES_SOURCE): Parsed<WaitObservation> {
  if (!isRecord(json)) return { rows: [], reason: 'The wait service did not answer with JSON.' }
  const rides: unknown[] = []
  if (Array.isArray(json.rides)) rides.push(...json.rides)
  if (Array.isArray(json.lands)) for (const land of json.lands) if (isRecord(land) && Array.isArray(land.rides)) rides.push(...land.rides)
  const rows: WaitObservation[] = []
  for (const r of rides) {
    if (!isRecord(r) || typeof r.name !== 'string' || (typeof r.id !== 'number' && typeof r.id !== 'string')) continue
    if (typeof r.last_updated !== 'string' || Number.isNaN(Date.parse(r.last_updated))) continue
    const isOpen = r.is_open === true
    const wait = finite(r.wait_time)
    rows.push({
      source,
      parkId: park.parkId,
      parkName: park.parkName,
      rideId: String(r.id),
      rideName: r.name,
      isOpen,
      waitMinutes: isOpen && wait !== null && wait >= 0 ? Math.round(wait) : null,
      observedAt: new Date(r.last_updated).toISOString(),
    })
  }
  return rows.length > 0 ? { rows, reason: null } : { rows, reason: 'The answer had no rides with a posted time.' }
}
