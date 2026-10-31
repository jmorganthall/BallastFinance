/**
 * The family's trip shape (PRD D55): how many park days, a travel day each
 * side, and when a drive is split into an evening leg and a morning.
 *
 * Length is park days, never nights. Around them, each window is laid out
 * by these rules, S being the easy stretch and D the drive one way:
 *
 *   way down
 *     needed     the full travel day would be a school day or a day we
 *                cannot go, and the morning leg (D - S) is no longer than
 *                S: leave the evening before, a night on the road, and the
 *                arrival day is a quick park day (it counts as a park day)
 *     ceiling    D > 2S: always split; the arrival day stays a travel day
 *     preferred  D > S, the family splits when it is free, and the evening
 *                before the travel day is not a day we cannot go: leave
 *                that evening, a night on the road, arrive on the travel day
 *     otherwise  a full travel day
 *   a drive no longer than S is done the evening before, after school, and
 *   the night is at the resort
 *
 *   way home (never needed: the morning drive still uses the day)
 *     ceiling    D > 2S: the last park day ends in the evening (it is
 *                quick), a night on the road, home the next morning
 *     preferred  the same, when D > S, the family splits when it is free,
 *                and the trip has HOME_SPLIT_MIN_PARK_DAYS or more, because
 *                on a short trip a quick last day costs a real park day
 *     otherwise  a full travel day
 *
 * Leaving after school costs no school day, so the evening a split leaves
 * on is never counted as school. With no drive looked up, every travel day
 * is a full one and the window says so.
 *
 * Nothing here is stored: the shape is a setting, the layout is derived.
 */

import { addDays, compareDates, type CivilDate } from './dates'
import { TripPlanError } from './trip-plan'

/** Where the family usually stays, for the night-by-night cost (D55 (5)). */
export type StayChoice = { kind: 'all' } | { kind: 'tier'; tier: StayTier } | { kind: 'resort'; name: string }

export type StayTier = 'value' | 'moderate' | 'deluxe'

export const STAY_TIERS: readonly StayTier[] = ['value', 'moderate', 'deluxe']

export interface TripShape {
  parkDaysMin: number
  parkDaysMax: number
  adultDrivers: number
  /** Typed; null means two hours a driver. */
  easyStretchMinutes: number | null
  /** Split a drive longer than an easy stretch whenever it costs nothing. */
  splitWhenFree: boolean
  stay: StayChoice
}

export const DEFAULT_TRIP_SHAPE: TripShape = {
  parkDaysMin: 3,
  parkDaysMax: 4,
  adultDrivers: 2,
  easyStretchMinutes: null,
  splitWhenFree: true,
  stay: { kind: 'all' },
}

export const MINUTES_PER_DRIVER = 120
export const MAX_PARK_DAYS = 14
export const HOME_SPLIT_MIN_PARK_DAYS = 5

/** The easy stretch: the typed figure, else two hours for each adult driver. */
export function easyStretchMinutes(shape: Pick<TripShape, 'adultDrivers' | 'easyStretchMinutes'>): number {
  return shape.easyStretchMinutes ?? shape.adultDrivers * MINUTES_PER_DRIVER
}

export function validateParkDays(min: number, max: number): void {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > MAX_PARK_DAYS) throw new TripPlanError(`Park days are whole numbers, 1 to ${MAX_PARK_DAYS}.`)
  if (min > max) throw new TripPlanError('The fewest park days cannot be more than the most.')
}

export function validateTripShape(shape: TripShape): void {
  validateParkDays(shape.parkDaysMin, shape.parkDaysMax)
  if (!Number.isInteger(shape.adultDrivers) || shape.adultDrivers < 1 || shape.adultDrivers > 6) throw new TripPlanError('Adult drivers is a whole number, 1 to 6.')
  if (shape.easyStretchMinutes !== null && (!Number.isInteger(shape.easyStretchMinutes) || shape.easyStretchMinutes < 60 || shape.easyStretchMinutes > 12 * 60))
    throw new TripPlanError('An easy stretch of driving is 1 to 12 hours.')
  if (shape.stay.kind === 'tier' && !STAY_TIERS.includes(shape.stay.tier)) throw new TripPlanError('Where we usually stay is value, moderate or deluxe, or one resort.')
  if (shape.stay.kind === 'resort' && !shape.stay.name.trim()) throw new TripPlanError('Name the resort we usually stay at.')
}

/**
 * "3-4", "5" or "2-6" from the address (a one-off search, never saved).
 * Anything else is nothing, and the family's own shape is used.
 */
export function parseParkDays(text: string | null | undefined): { min: number; max: number } | null {
  const m = (text ?? '').trim().match(/^(\d{1,2})(?:-(\d{1,2}))?$/)
  if (!m) return null
  const min = Number(m[1])
  const max = m[2] === undefined ? min : Number(m[2])
  try {
    validateParkDays(min, max)
  } catch {
    return null
  }
  return { min, max }
}

// ---------------------------------------------------------------- laying out a window

export type ShapeDayRole = 'leave_evening' | 'travel' | 'park' | 'quick_park'

export interface ShapedDay {
  date: CivilDate
  role: ShapeDayRole
}

export type DownLeg = 'full' | 'evening' | 'split_quick' | 'split'
export type HomeLeg = 'full' | 'split'

export interface ShapedWindow {
  /** The first day: the evening we leave, or the travel day. */
  startDate: CivilDate
  /** The day we get home. */
  endDate: CivilDate
  firstParkDate: CivilDate
  /** Quick days included (D55 (3)). */
  parkDays: number
  days: ShapedDay[]
  /** The nights at the resort, by the date each night starts. */
  resortNights: CivilDate[]
  roadNights: number
  down: DownLeg
  home: HomeLeg
  /** Why the way down is split, when it is. */
  downReason: 'needed' | 'ceiling' | 'preferred' | null
  driveKnown: boolean
}

export interface ShapeDayFacts {
  isSchoolDay: (date: CivilDate) => boolean
  isCantGo: (date: CivilDate) => boolean
}

/**
 * One window of the family's shape, its park days starting on
 * firstParkDate, laid out by the rules at the top of this file.
 */
export function shapeWindow(
  input: {
    firstParkDate: CivilDate
    parkDays: number
    /** One way, in minutes; null when no drive has been looked up. */
    driveMinutes: number | null
    stretchMinutes: number
    splitWhenFree: boolean
  } & ShapeDayFacts,
): ShapedWindow {
  const { firstParkDate: p1, parkDays: n, driveMinutes: drive, stretchMinutes: s } = input
  if (!Number.isInteger(n) || n < 1) throw new TripPlanError('A window has at least one park day.')
  const lastPark = addDays(p1, n - 1)
  const travelDown = addDays(p1, -1)

  let down: DownLeg = 'full'
  let downReason: ShapedWindow['downReason'] = null
  if (drive !== null && s > 0 && drive <= s) {
    if (!input.isCantGo(travelDown)) down = 'evening'
  } else if (drive !== null && s > 0) {
    const fullCosts = input.isSchoolDay(travelDown) || input.isCantGo(travelDown)
    if (fullCosts && drive - s <= s && !input.isCantGo(travelDown)) {
      down = 'split_quick'
      downReason = 'needed'
    } else if (drive > 2 * s) {
      down = 'split'
      downReason = 'ceiling'
    } else if (drive > s && input.splitWhenFree && !input.isCantGo(addDays(p1, -2))) {
      down = 'split'
      downReason = 'preferred'
    }
  }

  let home: HomeLeg = 'full'
  if (drive !== null && s > 0) {
    if (drive > 2 * s) home = 'split'
    else if (drive > s && input.splitWhenFree && n >= HOME_SPLIT_MIN_PARK_DAYS) home = 'split'
  }

  const days: ShapedDay[] = []
  if (down === 'split_quick' || down === 'evening') days.push({ date: travelDown, role: 'leave_evening' })
  if (down === 'split') days.push({ date: addDays(p1, -2), role: 'leave_evening' }, { date: travelDown, role: 'travel' })
  if (down === 'full') days.push({ date: travelDown, role: 'travel' })
  for (let i = 0; i < n; i++) {
    const date = addDays(p1, i)
    const quick = (i === 0 && down === 'split_quick') || (i === n - 1 && home === 'split')
    days.push({ date, role: quick ? 'quick_park' : 'park' })
  }
  const homeDay = addDays(lastPark, 1)
  days.push({ date: homeDay, role: 'travel' })

  // The nights at the resort run from the day we arrive to the night before we leave it.
  const arrive = down === 'split_quick' ? p1 : travelDown
  const lastNight = home === 'split' ? addDays(lastPark, -1) : lastPark
  const resortNights: CivilDate[] = []
  for (let d = arrive; compareDates(d, lastNight) <= 0; d = addDays(d, 1)) resortNights.push(d)

  return {
    startDate: days[0]!.date,
    endDate: homeDay,
    firstParkDate: p1,
    parkDays: n,
    days,
    resortNights,
    roadNights: (down === 'split' || down === 'split_quick' ? 1 : 0) + (home === 'split' ? 1 : 0),
    down,
    home,
    downReason,
    driveKnown: drive !== null,
  }
}

/** School days a window costs: travel and park days; the evening we leave on is after school. */
export function shapeSchoolDaysMissed(window: Pick<ShapedWindow, 'days'>, isSchoolDay: (date: CivilDate) => boolean): number {
  return window.days.filter((d) => d.role !== 'leave_evening' && isSchoolDay(d.date)).length
}

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dayName(date: CivilDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return SHORT_DAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!
}

/**
 * The window in words: "Thu evening → quick park day Fri · 3 park days ·
 * home Mon". Plain enough for the list; the dates themselves are said by
 * the screen.
 */
export function shapeWords(window: ShapedWindow): string {
  const parts: string[] = []
  const quickFirst = window.down === 'split_quick'
  if (window.down === 'split_quick') parts.push(`leave ${dayName(window.startDate)} evening → quick park day ${dayName(window.firstParkDate)}`)
  else if (window.down === 'split') parts.push(`leave ${dayName(window.startDate)} evening, arrive ${dayName(addDays(window.firstParkDate, -1))}`)
  else if (window.down === 'evening') parts.push(`drive ${dayName(window.startDate)} evening`)
  else parts.push(`drive ${dayName(window.startDate)}`)
  parts.push(`${window.parkDays} park ${window.parkDays === 1 ? 'day' : 'days'}${quickFirst || window.home === 'split' ? ` (${quickFirst && window.home === 'split' ? 'first and last quick' : quickFirst ? 'first quick' : 'last quick'})` : ''}`)
  parts.push(window.home === 'split' ? `leave ${dayName(addDays(window.endDate, -1))} evening, home ${dayName(window.endDate)}` : `home ${dayName(window.endDate)}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------- "Plan this" (D55 (7))

const ROLE_CODE: Record<ShapeDayRole, string> = { leave_evening: 'E', travel: 'T', park: 'P', quick_park: 'Q' }
const CODE_ROLE: Record<string, ShapeDayRole> = { E: 'leave_evening', T: 'travel', P: 'park', Q: 'quick_park' }

/** The window's days as one letter each, from its first day: what "Plan this" carries in the address. */
export function shapeCode(window: Pick<ShapedWindow, 'days'>): string {
  return window.days.map((d) => ROLE_CODE[d.role]).join('')
}

export interface LaidOutDay {
  date: CivilDate
  park: 'travel' | 'rest'
  notes: string
}

const ROLE_NOTE: Record<ShapeDayRole, string> = {
  leave_evening: 'Leave this evening, after school: an easy stretch, then a night on the way.',
  travel: '',
  park: '',
  quick_park: 'Quick park day.',
}

/**
 * The trip's days from a code, or nothing when the code does not fit the
 * dates. Travel days and the evening we leave are travel; park days, quick
 * ones too, are left for "Use this plan" to choose the park (D32), and a
 * quick day says so in its notes.
 */
export function layoutFromCode(startDate: CivilDate, endDate: CivilDate, code: string | null | undefined): LaidOutDay[] | null {
  const letters = (code ?? '').trim().toUpperCase()
  if (!/^[ETPQ]+$/.test(letters)) return null
  if (compareDates(addDays(startDate, letters.length - 1), endDate) !== 0) return null
  return [...letters].map((letter, i) => {
    const role = CODE_ROLE[letter]!
    return { date: addDays(startDate, i), park: role === 'park' || role === 'quick_park' ? 'rest' : 'travel', notes: ROLE_NOTE[role] }
  })
}

/** "4 hours", "7.5 hours": a drive or a stretch in words, to the half hour. */
export function hoursWords(minutes: number): string {
  const halves = Math.round(minutes / 30)
  const hours = halves / 2
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/** What a trip from Explore is called until someone names it: "Disney, Nov 2026". */
export function exploreTripName(window: Pick<ShapedWindow, 'firstParkDate'>): string {
  const [y, m] = window.firstParkDate.split('-').map(Number) as [number, number]
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `Disney, ${names[m - 1]} ${y}`
}

/** The easy-stretch field on the form: the typed hours, if any, and the usual two hours a driver as its placeholder. */
export function easyStretchField(shape: Pick<TripShape, 'adultDrivers' | 'easyStretchMinutes'>): { typed: string; usual: string } {
  return {
    typed: shape.easyStretchMinutes === null ? '' : String(shape.easyStretchMinutes / 60),
    usual: `${hoursWords(easyStretchMinutes({ adultDrivers: shape.adultDrivers, easyStretchMinutes: null }))}, 2 a driver`,
  }
}
