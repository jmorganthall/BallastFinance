/**
 * Explore (PRD D42, D55): the best times to go, before there is a trip.
 *
 * Every candidate is the family's own shape (trip-shape.ts): for each first
 * park day across the horizon and each number of park days asked for, one
 * window laid out with its travel days and any split drive. Each is
 * measured and scored by the same formula as the best weeks inside a trip
 * (trip-when.ts), with three differences that follow from the shape:
 *
 *   busy    over the park days only (a quick park day counts): nobody is
 *           in a queue on a travel day
 *   school  over the travel and park days; the evening a split leaves on
 *           is after school and costs none
 *   price   compared only between windows with the same number of park
 *           days; a window with no price yet takes the midpoint
 *
 * A window that touches a day we cannot go is left out before scoring.
 * The reasons name what makes it: how busy, a holiday or day off it uses,
 * school missed, and how the drive is done.
 *
 * The year strip is shaded from the same scores (D48 (3)): each day by the
 * best window that leaves on it, in five steps by rank, so the greenest
 * fifth of the days are the best fifth of the starts. A day no window
 * leaves on, or one every window from is left out, has no step.
 *
 * Nothing here is stored.
 */

import { addDays, addMonths, compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import { busynessFor, type BusynessSources } from './park-data'
import type { BlackoutRange } from './trip-plan'
import { shapeSchoolDaysMissed, shapeWindow, shapeWords, type ShapedWindow } from './trip-shape'
import {
  BEST_WEEKS_SHOWN,
  crowdReason,
  DEFAULT_HORIZON_MONTHS,
  federalHolidaysBetween,
  isSchoolDay,
  schoolReason,
  scoresOf,
  type DayOffInput,
  type WeekWeights,
} from './trip-when'

export interface ExploreInput {
  today: CivilDate
  horizonMonths?: number
  parkDays: { min: number; max: number }
  stretchMinutes: number
  splitWhenFree: boolean
  /** One way, in minutes; null when no drive has been looked up. */
  driveMinutes: number | null
  busyness: BusynessSources
  daysOff: readonly (DayOffInput & { schoolYear?: string })[]
  blackoutDates: readonly BlackoutRange[]
  weights?: WeekWeights
  limit?: number
  /** What a window costs, when anything is known (D55 (5)); absent or null is no price yet. */
  priceOf?: (window: ShapedWindow) => Cents | null
}

export interface ExploreWindow extends ShapedWindow {
  /** Mean resort-wide level over the park days, to a tenth. Null with no data. */
  crowdAverage: number | null
  daysWithData: number
  daysCounted: number
  schoolDaysMissed: number
  /** Holidays and days off school the window uses. */
  uses: string[]
  priceCents: Cents | null
  /** Lower is better. To three places. */
  score: number
  reasons: string[]
  /** The shape in words: "leave Thu evening → quick park day Fri · 3 park days · home Mon". */
  words: string
}

export interface Explore {
  top: ExploreWindow[]
  considered: number
  excludedByBlackout: number
  daysOffKnown: boolean
  driveKnown: boolean
  horizonFrom: CivilDate
  horizonTo: CivilDate
  parkDays: { min: number; max: number }
  stretchMinutes: number
  /** Each start date's step on the green-to-red scale, 1 the best fifth; dates with no window are absent. */
  startSteps: Record<CivilDate, number>
}

/**
 * The whole of Explore's ranking in one call: the candidates in the
 * family's shape, each measured and scored, the top ten, and the strip's
 * shading. The engine gathers the facts; this decides.
 */
export function explore(input: ExploreInput): Explore {
  const horizonMonths = input.horizonMonths ?? DEFAULT_HORIZON_MONTHS
  const horizonFrom = addDays(input.today, 1)
  const horizonTo = addMonths(input.today, horizonMonths)
  const lastDay = addDays(horizonTo, input.parkDays.max + 3)
  const holidays = federalHolidaysBetween(addDays(horizonFrom, -7), addDays(lastDay, 7))

  // One look per date, not per window: a year of windows reads the same days many times.
  const level = new Map<CivilDate, number | null>()
  const school = new Map<CivilDate, boolean>()
  const offName = new Map<CivilDate, string>()
  for (const h of holidays) offName.set(h.date, h.name)
  for (const d of input.daysOff) if (!offName.has(d.date)) offName.set(d.date, d.label)
  for (let d = addDays(horizonFrom, -2); compareDates(d, lastDay) <= 0; d = addDays(d, 1)) {
    level.set(d, busynessFor({ ...input.busyness, date: d, park: 'other' })?.level ?? null)
    school.set(d, isSchoolDay(d, input.daysOff, holidays))
  }
  const isSchool = (d: CivilDate) => school.get(d) ?? isSchoolDay(d, input.daysOff, holidays)
  const blackoutsOn = (d: CivilDate) => input.blackoutDates.filter((b) => compareDates(b.from, d) <= 0 && compareDates(d, b.to) <= 0)
  const isCantGo = (d: CivilDate) => blackoutsOn(d).length > 0

  interface Measured extends ShapedWindow {
    crowdAverage: number | null
    daysWithData: number
    daysCounted: number
    schoolDaysMissed: number
    uses: string[]
    priceCents: Cents | null
    blackedOut: boolean
  }
  const measured: Measured[] = []
  for (let p1 = addDays(horizonFrom, 1); compareDates(p1, addDays(horizonTo, 2)) <= 0; p1 = addDays(p1, 1)) {
    for (let n = input.parkDays.min; n <= input.parkDays.max; n++) {
      const w = shapeWindow({
        firstParkDate: p1,
        parkDays: n,
        driveMinutes: input.driveMinutes,
        stretchMinutes: input.stretchMinutes,
        splitWhenFree: input.splitWhenFree,
        isSchoolDay: isSchool,
        isCantGo,
      })
      if (compareDates(w.startDate, horizonFrom) < 0 || compareDates(w.startDate, horizonTo) > 0) continue
      const parkLevels = w.days
        .filter((d) => d.role === 'park' || d.role === 'quick_park')
        .map((d) => level.get(d.date) ?? null)
        .filter((l): l is number => l !== null)
      const crowdAverage = parkLevels.length > 0 ? Math.round((parkLevels.reduce((s, l) => s + l, 0) / parkLevels.length) * 10) / 10 : null
      const uses = [...new Set(w.days.filter((d) => d.role !== 'leave_evening' && offName.has(d.date)).map((d) => offName.get(d.date)!))]
      measured.push({
        ...w,
        crowdAverage,
        daysWithData: parkLevels.length,
        daysCounted: n,
        schoolDaysMissed: shapeSchoolDaysMissed(w, isSchool),
        uses,
        priceCents: input.priceOf ? input.priceOf(w) : null,
        blackedOut: w.days.some((d) => isCantGo(d.date)),
      })
    }
  }

  const eligible = measured.filter((m) => !m.blackedOut)
  const scores = scoresOf(
    eligible.map((m) => ({ ...m, priceGroup: m.parkDays })),
    input.weights,
  )
  const scored: ExploreWindow[] = eligible.map((m, i) => {
    const { blackedOut: _, ...rest } = m
    const reasons = [crowdReason(m)]
    if (m.uses.length > 0) reasons.push(`uses ${m.uses.slice(0, 2).join(' and ')}${m.uses.length > 2 ? ` and ${m.uses.length - 2} more` : ''}`)
    if (m.priceCents === null) reasons.push('no price yet')
    reasons.push(schoolReason(m.schoolDaysMissed))
    if (m.downReason === 'needed') reasons.push('the evening drive saves a school day')
    if (!m.driveKnown) reasons.push('drive not looked up yet')
    return { ...rest, score: scores[i]!, reasons, words: shapeWords(m) }
  })
  scored.sort((a, b) => a.score - b.score || compareDates(a.startDate, b.startDate) || a.parkDays - b.parkDays)

  return {
    top: pickTop(scored, input.limit ?? BEST_WEEKS_SHOWN),
    considered: measured.length,
    excludedByBlackout: measured.length - eligible.length,
    daysOffKnown: input.daysOff.length > 0,
    driveKnown: input.driveMinutes !== null,
    horizonFrom,
    horizonTo,
    parkDays: input.parkDays,
    stretchMinutes: input.stretchMinutes,
    startSteps: startSteps(scored),
  }
}

/**
 * The top of the list, one window per stretch of dates: a window that
 * overlaps one already picked is the same trip moved a day, and ten of
 * those would hide every other week of the year.
 */
function pickTop(sorted: readonly ExploreWindow[], limit: number): ExploreWindow[] {
  const picked: ExploreWindow[] = []
  for (const w of sorted) {
    if (picked.length >= limit) break
    if (picked.some((p) => compareDates(w.startDate, p.endDate) <= 0 && compareDates(p.startDate, w.endDate) <= 0)) continue
    picked.push(w)
  }
  return picked
}

/** Each start date's best score, ranked into five steps (1 the best fifth). */
function startSteps(scored: readonly ExploreWindow[]): Record<CivilDate, number> {
  const best = new Map<CivilDate, number>()
  for (const w of scored) {
    const have = best.get(w.startDate)
    if (have === undefined || w.score < have) best.set(w.startDate, w.score)
  }
  const ranked = [...best.entries()].sort((a, b) => a[1] - b[1] || compareDates(a[0], b[0]))
  const out: Record<CivilDate, number> = {}
  let firstOfScore = 0
  ranked.forEach(([date, score], i) => {
    // Equal scores share a step, so a tie never reads as one day better than the other.
    if (i > 0 && score !== ranked[i - 1]![1]) firstOfScore = i
    out[date] = 1 + Math.floor((5 * firstOfScore) / ranked.length)
  })
  return out
}
