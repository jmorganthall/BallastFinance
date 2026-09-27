/**
 * Which park, which day (PRD §16, D32).
 *
 * Given a trip's days, the planner proposes a park for each day it is free
 * to plan, from what Ballast already knows per park and per day: how busy
 * (busynessFor, D28), the weather for the date (park_weather, blended by
 * horizon) and the park hours (park_hours). Nothing is fetched for this and
 * nothing is stored: the proposal is a derivation, shown beside the current
 * choice, and only "Use this plan" writes trip_days.park -- the ordinary
 * fact it already is.
 *
 * WHICH DAYS ARE PLANNED. A day a person set by hand (plan.parkChosen, set
 * when they pick a park, a rest day or a travel day on the form) is kept as
 * it is and the rest are planned around it; "Let the plan choose" clears
 * the flag. A day already gone is left alone. Of the days nobody chose, a
 * theme-park day and a rest day from the day cut (rest is what a new day
 * starts as until a park is picked) are open to the plan; a travel day, a
 * water-park day and "somewhere else" are never given a park, whoever set
 * them.
 *
 * THE SCORE, lower is better, one function (scoreParkDay):
 *
 *   busyness level that day, 1 quiet to 10 packed (MISSING_BUSYNESS, the
 *     middle of the scale, when nothing is known -- said in the reasons)
 *   + (1 - PARK_COVER[park]) × RAIN_WEIGHT   when the chance of rain is at
 *     or above RAIN_THRESHOLD_PERCENT: a wet day sends the plan to the
 *     parks with the most under cover
 *   - HEAT_EARLY_BONUS                       when the high is at or above
 *     HEAT_THRESHOLD_F and this park opens earliest that day: a hot day
 *     sends the earliest start to the park that opens first
 *   - LATE_CLOSE_BONUS                       when the park closes at or
 *     after LATE_CLOSE_HOUR: a late close claims the evening
 *
 * A park whose hours say it is closed that day is unavailable. A park with
 * no hours row is not closed, only unknown: no bonus either way.
 *
 * THE ASSIGNMENT (planParkDays) is the set of parks with the lowest total
 * fit across the trip, under one constraint: each of the four parks is used
 * once before any repeats -- day by day, a park may be taken only while no
 * other park has been used less, counting the days a person chose too.
 * (A greedy pass, best pair first, was tried and rejected: it hands the dry
 * days out first and leaves a wet day whatever park is left.) A tie goes to
 * the earlier date, so the first day gets the quieter park. Every choice
 * carries its reasons in words.
 */

import { compareDates, type CivilDate } from './dates'
import { blendWeather, busynessFor, splitWeather, type BusynessSources, type ParkHours, type ParkWeather } from './park-data'
import { PARK_LABELS, THEME_PARKS, type TripDay, type TripPark } from './trip-plan'
import type { Id } from './types'

// ---------------------------------------------------------------- constants

export type ThemePark = Exclude<TripPark, 'water_park' | 'other' | 'rest' | 'travel'>

export const isThemePark = (park: TripPark): park is ThemePark => THEME_PARKS.includes(park)

/** The share of a park a family can do under cover or indoors, 0 to 1. */
export const PARK_COVER: Record<ThemePark, number> = {
  epcot: 0.6,
  hollywood_studios: 0.6,
  magic_kingdom: 0.4,
  animal_kingdom: 0.2,
}

/** A chance of rain at or above this counts as a wet day. */
export const RAIN_THRESHOLD_PERCENT = 50
/** What a wet day adds to a park with nothing under cover; a park fully under cover adds nothing. */
export const RAIN_WEIGHT = 3
/** A high at or above this counts as a hot day. */
export const HEAT_THRESHOLD_F = 92
/** What a hot day takes off the park that opens earliest. */
export const HEAT_EARLY_BONUS = 1
/** A close at or after this hour (24h) claims the evening. */
export const LATE_CLOSE_HOUR = 21
/** What a late close takes off. */
export const LATE_CLOSE_BONUS = 0.5
/** The level assumed when nothing is known: the middle of the 1-10 scale. */
export const MISSING_BUSYNESS = 5.5

// ---------------------------------------------------------------- one park, one day

export interface ParkDayWeather {
  highF: number
  precipChance: number | null
}

export interface ParkDayScore {
  date: CivilDate
  park: ThemePark
  /** Closed that day, by its hours. */
  available: boolean
  /** Lower is better. */
  score: number
  reasons: string[]
  /** The level the score started from, or nothing when it was assumed. */
  busyness: number | null
}

/** "9 pm", "8:30 am", from "HH:MM". */
export function hourWords(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number]
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`
}

const hourOf = (time: string): number => Number(time.slice(0, 2))

function coverWords(cover: number): string {
  if (cover >= 0.5) return 'mostly under cover'
  if (cover >= 0.35) return 'some cover'
  return 'little cover'
}

/**
 * How well one park fits one day, by the formula at the top of the file.
 * `hours` is every park's hours that day, so the function can tell whether
 * this park opens earliest.
 */
export function scoreParkDay(input: { date: CivilDate; park: ThemePark; busyness: number | null; weather: ParkDayWeather | null; hours: readonly ParkHours[] }): ParkDayScore {
  const { date, park, busyness, weather } = input
  const today = input.hours.filter((h) => h.date === date && isThemePark(h.park))
  const own = today.find((h) => h.park === park) ?? null
  const reasons: string[] = []

  if (own && own.closes <= own.opens) {
    return { date, park, available: false, score: Number.POSITIVE_INFINITY, reasons: ['closed that day'], busyness }
  }

  let score: number
  if (busyness === null) {
    score = MISSING_BUSYNESS
    reasons.push('no busyness data')
  } else {
    score = busyness
    reasons.push(`how busy ${busyness}`)
  }

  if (weather && weather.precipChance !== null && weather.precipChance >= RAIN_THRESHOLD_PERCENT) {
    const cover = PARK_COVER[park]
    score += (1 - cover) * RAIN_WEIGHT
    reasons.push(`${weather.precipChance}% rain, ${coverWords(cover)}`)
  }

  if (weather && weather.highF >= HEAT_THRESHOLD_F && own) {
    const earliest = today.reduce((best, h) => (h.opens < best ? h.opens : best), own.opens)
    if (own.opens <= earliest) {
      score -= HEAT_EARLY_BONUS
      reasons.push(`${weather.highF}°, opens earliest (${hourWords(own.opens)})`)
    }
  }

  if (own && hourOf(own.closes) >= LATE_CLOSE_HOUR) {
    score -= LATE_CLOSE_BONUS
    reasons.push(`open till ${hourWords(own.closes)}`)
  }

  return { date, park, available: true, score: Math.round(score * 100) / 100, reasons, busyness }
}

// ---------------------------------------------------------------- the whole trip

export interface ParkDayPlanInput {
  days: readonly TripDay[]
  busyness: BusynessSources
  weather: readonly ParkWeather[]
  hours: readonly ParkHours[]
  today: CivilDate
}

export interface ParkDayAssignment {
  dayId: Id
  date: CivilDate
  park: ThemePark
  /** What the day is now, before the plan is used. */
  current: TripPark
  /** Lower is better; "fit" on screen, never "score". */
  score: number
  reasons: string[]
  /** How busy that park is that day, or nothing known. */
  busyness: number | null
}

export interface ParkDayPlan {
  /** One per day the plan chose, in date order. */
  assignments: ParkDayAssignment[]
  /** Days a person chose by hand, kept as they are and planned around. */
  unchanged: { dayId: Id; date: CivilDate; park: TripPark }[]
  /** Days open to the plan that no park could take (every park closed). */
  unplanned: { dayId: Id; date: CivilDate; reason: string }[]
  /** Dates the plan had to do without. */
  missing: { busyness: CivilDate[]; weather: CivilDate[]; hours: CivilDate[] }
  summary: string
}

/** Whether the plan may set this day's park. */
export function dayIsOpenToPlan(day: Pick<TripDay, 'date' | 'park' | 'plan'>, today: CivilDate): boolean {
  if (day.plan.parkChosen) return false
  if (compareDates(day.date, today) < 0) return false
  return isThemePark(day.park) || day.park === 'rest'
}

export function planParkDays(input: ParkDayPlanInput): ParkDayPlan {
  const days = [...input.days].sort((a, b) => compareDates(a.date, b.date))
  const split = splitWeather(input.weather)
  const uses = new Map<ThemePark, number>(THEME_PARKS.map((p) => [p as ThemePark, 0]))
  const unchanged: ParkDayPlan['unchanged'] = []
  const open: TripDay[] = []
  for (const day of days) {
    if (dayIsOpenToPlan(day, input.today)) open.push(day)
    else {
      if (day.plan.parkChosen) unchanged.push({ dayId: day.id, date: day.date, park: day.park })
      if (isThemePark(day.park)) uses.set(day.park, (uses.get(day.park) ?? 0) + 1)
    }
  }

  const missing: ParkDayPlan['missing'] = { busyness: [], weather: [], hours: [] }
  const scores = new Map<Id, Map<ThemePark, ParkDayScore>>()
  const quietest = new Map<Id, number | null>()
  for (const day of open) {
    const blended = blendWeather({ ...split, date: day.date })
    const weather = blended ? { highF: blended.highF, precipChance: blended.precipChance } : null
    const hours = input.hours.filter((h) => h.date === day.date)
    if (!weather) missing.weather.push(day.date)
    if (hours.length === 0) missing.hours.push(day.date)
    const byPark = new Map<ThemePark, ParkDayScore>()
    let anyLevel = false
    let least: number | null = null
    for (const park of THEME_PARKS as readonly ThemePark[]) {
      const level = busynessFor({ ...input.busyness, date: day.date, park })?.level ?? null
      if (level !== null) {
        anyLevel = true
        least = least === null ? level : Math.min(least, level)
      }
      byPark.set(park, scoreParkDay({ date: day.date, park, busyness: level, weather, hours }))
    }
    if (!anyLevel) missing.busyness.push(day.date)
    scores.set(day.id, byPark)
    quietest.set(day.id, least)
  }

  // A day no park can take is set aside before the choosing.
  const unplanned: ParkDayPlan['unplanned'] = []
  const plannable = open.filter((day) => {
    const any = [...scores.get(day.id)!.values()].some((s) => s.available)
    if (!any) unplanned.push({ dayId: day.id, date: day.date, reason: 'every park is closed that day' })
    return any
  })

  const chosen = chooseParks(plannable, scores, uses)
  const assignments: ParkDayAssignment[] = plannable.map((day, i) => {
    const best = scores.get(day.id)!.get(chosen[i]!)!
    const least = quietest.get(day.id) ?? null
    const reasons = best.reasons.map((r) => (best.busyness !== null && least !== null && best.busyness === least && r === `how busy ${best.busyness}` ? `quietest that day (${best.busyness})` : r))
    return { dayId: day.id, date: day.date, park: best.park, current: day.park, score: best.score, reasons, busyness: best.busyness }
  })
  assignments.sort((a, b) => compareDates(a.date, b.date))

  const n = assignments.length
  const parts: string[] = []
  parts.push(n === 0 ? 'No days for the plan to choose' : `${n} ${n === 1 ? 'day' : 'days'} planned: ${assignments.map((a) => PARK_LABELS[a.park]).join(', ')}`)
  if (unchanged.length > 0) parts.push(`${unchanged.length} ${unchanged.length === 1 ? 'day is' : 'days are'} your pick`)
  if (unplanned.length > 0) parts.push(`${unplanned.length} ${unplanned.length === 1 ? 'day has' : 'days have'} no park open`)
  return { assignments, unchanged, unplanned, missing, summary: parts.join(' · ') }
}

// ---------------------------------------------------------------- the choosing

const PARK_LIST = THEME_PARKS as readonly ThemePark[]

/** Lexicographic order on two sequences of busyness levels: the earlier day's quieter park wins. */
function quieterFirst(a: readonly (number | null)[], b: readonly (number | null)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? MISSING_BUSYNESS
    const y = b[i] ?? MISSING_BUSYNESS
    if (x !== y) return x - y
  }
  return a.length - b.length
}

/**
 * The parks for the days open to the plan, in the days' order: the lowest
 * total fit across the trip, under the rule that each park is used once
 * before any repeats -- on each day, in date order, only a park used no
 * more often than every other (the hand-chosen days counted) may be taken;
 * when every such park is closed that day, any open park may. Among equal
 * totals the plan whose earlier days are quieter wins.
 *
 * A dynamic programme over the days with the use counts as the state: at
 * most (days/4 + 2)^4 states, so a fortnight is a few thousand steps.
 */
function chooseParks(days: readonly TripDay[], scores: ReadonlyMap<Id, ReadonlyMap<ThemePark, ParkDayScore>>, fixedUses: ReadonlyMap<ThemePark, number>): ThemePark[] {
  if (days.length === 0) return []
  type Best = { cost: number; levels: (number | null)[]; parks: ThemePark[] } | null
  const memo = new Map<string, Best>()
  const solve = (i: number, counts: readonly number[]): Best => {
    if (i === days.length) return { cost: 0, levels: [], parks: [] }
    const key = `${i}:${counts.join(',')}`
    if (memo.has(key)) return memo.get(key)!
    const byPark = scores.get(days[i]!.id)!
    const open = PARK_LIST.map((park, k) => ({ park, k, s: byPark.get(park)! })).filter(({ s }) => s.available)
    const fewest = Math.min(...counts)
    const leastUsed = open.filter(({ k }) => counts[k] === fewest)
    let best: Best = null
    for (const { park, k, s } of leastUsed.length > 0 ? leastUsed : open) {
      const next = counts.slice()
      next[k] = (next[k] ?? 0) + 1
      const rest = solve(i + 1, next)
      if (!rest) continue
      const cand = { cost: s.score + rest.cost, levels: [s.busyness, ...rest.levels], parks: [park, ...rest.parks] }
      if (!best || cand.cost < best.cost - 1e-9 || (Math.abs(cand.cost - best.cost) < 1e-9 && quieterFirst(cand.levels, best.levels) < 0)) best = cand
    }
    memo.set(key, best)
    return best
  }
  return solve(0, PARK_LIST.map((p) => fixedUses.get(p) ?? 0))?.parks ?? []
}

// ---------------------------------------------------------------- what "Use this plan" changes

export interface ParkDayChange {
  dayId: Id
  date: CivilDate
  from: TripPark
  to: ThemePark
}

/** The days "Use this plan" would set: each proposed park that differs from the day's park now. */
export function parkDayPlanDiff(current: readonly TripDay[], proposed: readonly Pick<ParkDayAssignment, 'dayId' | 'park'>[]): ParkDayChange[] {
  const byId = new Map(current.map((d) => [d.id, d]))
  const out: ParkDayChange[] = []
  for (const p of proposed) {
    const day = byId.get(p.dayId)
    if (!day || day.park === p.park) continue
    out.push({ dayId: day.id, date: day.date, from: day.park, to: p.park })
  }
  return out.sort((a, b) => compareDates(a.date, b.date))
}

/** True when two proposals set the same park on the same days: the check that nothing stale is applied. */
export function sameParkDayPlan(a: readonly Pick<ParkDayAssignment, 'dayId' | 'park'>[], b: readonly Pick<ParkDayAssignment, 'dayId' | 'park'>[]): boolean {
  if (a.length !== b.length) return false
  const key = (x: Pick<ParkDayAssignment, 'dayId' | 'park'>) => `${x.dayId}:${x.park}`
  const setB = new Set(b.map(key))
  return a.every((x) => setB.has(key(x)))
}
