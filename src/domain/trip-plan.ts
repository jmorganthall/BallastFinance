/**
 * Planning a trip, not only pricing it (PRD §16, D22-D24).
 *
 * The money side lives in trip.ts and does not change. This module owns the
 * planning derivations: which day rows a trip's dates need, what to book and
 * when, how one candidate week compares with the next, what each day looks
 * like, and what a reservation costs. It also reads the three things the
 * server layer fetches for planning -- two crowd calendars and a geocoded
 * address -- so their formats are tested without a network, and a page that
 * changes shape breaks one parser here, not a screen.
 *
 * Every fact here is the module's own (trip_days, trip_reservations,
 * trip_tasks, crowd_levels). The core never reads them, and none of this
 * touches the weekly math.
 */

import { addDays, compareDates, minDate, type CivilDate } from './dates'
import type { Cents } from './money'
import type { Id } from './types'
import {
  contingencyBasisPoints,
  defaultLines,
  isAddedLine,
  keepTypedLines,
  lineTotalCents,
  variantPrice,
  type DefaultLine,
  type DriveEstimate,
  type GasPrice,
  type ReferencePrice,
  type Trip,
  type TripDestination,
  type TripLine,
  type TripLineCategory,
  type TripVariant,
  type VariantPrice,
} from './trip'

// ---------------------------------------------------------------- facts

export type TripPark = 'magic_kingdom' | 'epcot' | 'hollywood_studios' | 'animal_kingdom' | 'water_park' | 'other' | 'rest' | 'travel'

export const TRIP_PARKS: readonly TripPark[] = ['magic_kingdom', 'epcot', 'hollywood_studios', 'animal_kingdom', 'water_park', 'other', 'rest', 'travel']

/** The four parks a crowd calendar rates day by day. */
export const THEME_PARKS: readonly TripPark[] = ['magic_kingdom', 'epcot', 'hollywood_studios', 'animal_kingdom']

export const PARK_LABELS: Record<TripPark, string> = {
  magic_kingdom: 'Magic Kingdom',
  epcot: 'EPCOT',
  hollywood_studios: 'Hollywood Studios',
  animal_kingdom: 'Animal Kingdom',
  water_park: 'Water park',
  other: 'Somewhere else',
  rest: 'Rest day',
  travel: 'Travel day',
}

export interface DayPlanNotes {
  notes: string
  ropeDrop: boolean
}

export interface TripDay {
  id: Id
  tripId: Id
  date: CivilDate
  park: TripPark
  plan: DayPlanNotes
  sort: number
}

export type ReservationKind = 'dining' | 'lightning_lane' | 'experience' | 'flight' | 'lodging' | 'transport' | 'other'

export const RESERVATION_KINDS: readonly ReservationKind[] = ['dining', 'lightning_lane', 'experience', 'flight', 'lodging', 'transport', 'other']

export const RESERVATION_KIND_LABELS: Record<ReservationKind, string> = {
  dining: 'Table',
  lightning_lane: 'Lightning Lane',
  experience: 'Experience',
  flight: 'Flight',
  lodging: 'Where we stay',
  transport: 'Ride',
  other: 'Other',
}

export interface TripReservation {
  id: Id
  tripId: Id
  date: CivilDate
  /** "HH:MM", or nothing for an all-day booking. */
  time: string | null
  kind: ReservationKind
  name: string
  park: TripPark | null
  confirmation: string | null
  party: number
  perPersonCents: Cents | null
  /** The part of the trip this cost is already counted in, so it is never added twice. */
  lineId: Id | null
  note: string | null
}

export type TaskKind = 'book' | 'pay' | 'buy' | 'pack' | 'do'

export const TASK_KINDS: readonly TaskKind[] = ['book', 'pay', 'buy', 'pack', 'do']

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  book: 'Book',
  pay: 'Pay',
  buy: 'Buy',
  pack: 'Pack',
  do: 'Do',
}

export interface TripTask {
  id: Id
  tripId: Id
  kind: TaskKind
  label: string
  dueOn: CivilDate
  doneOn: CivilDate | null
  link: string | null
  lineId: Id | null
  sort: number
  /** True while the timeline still owns it; false once a person has edited it. */
  generated: boolean
  /** A stable name for a timeline task, so rebuilding it finds the same row. */
  key: string | null
}

export type CrowdSourceKey = 'thrill_data' | 'undercover_tourist' | 'typed'

export interface CrowdLevel {
  destination: TripDestination
  date: CivilDate
  park: TripPark
  /** 1 quiet to 10 packed. */
  level: number
  source: CrowdSourceKey | string
  fetchedOn: CivilDate
}

/** A crowd level as a parser reads it, before the destination and date of fetch are added. */
export interface ParsedCrowdLevel {
  date: CivilDate
  park: TripPark
  level: number
}

export interface BlackoutRange {
  from: CivilDate
  to: CivilDate
  label: string
}

// ---------------------------------------------------------------- validation

export class TripPlanError extends Error {}

export const CROWD_STALE_AFTER_DAYS = 30

export function validateCrowdLevel(level: Pick<CrowdLevel, 'level' | 'park' | 'date' | 'source'>): void {
  if (!Number.isInteger(level.level) || level.level < 1 || level.level > 10) throw new TripPlanError('How busy is a whole number from 1 (quiet) to 10 (packed).')
  if (!TRIP_PARKS.includes(level.park)) throw new TripPlanError('That is not a park this planner knows.')
  if (!level.source.trim()) throw new TripPlanError('A crowd level needs to say where it came from.')
}

export function validateDayInputs(day: Pick<TripDay, 'park' | 'plan'>): void {
  if (!TRIP_PARKS.includes(day.park)) throw new TripPlanError('Pick a park, a rest day or a travel day.')
  if (typeof day.plan.notes !== 'string' || typeof day.plan.ropeDrop !== 'boolean') throw new TripPlanError('The day plan is notes and a rope-drop choice.')
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function validateReservationInputs(r: Omit<TripReservation, 'id' | 'tripId'>): void {
  if (!r.name.trim()) throw new TripPlanError('A reservation needs a name, like "Chef Mickey\'s".')
  if (!RESERVATION_KINDS.includes(r.kind)) throw new TripPlanError('Say what kind of reservation this is.')
  if (r.time !== null && !TIME.test(r.time)) throw new TripPlanError('The time is hours and minutes, like 18:30.')
  if (r.park !== null && !TRIP_PARKS.includes(r.park)) throw new TripPlanError('That is not a park this planner knows.')
  if (!Number.isInteger(r.party) || r.party < 0) throw new TripPlanError('The party is a whole number of people.')
  if (r.perPersonCents !== null && (!Number.isInteger(r.perPersonCents) || r.perPersonCents < 0)) throw new TripPlanError('The cost per person is whole cents, zero or more.')
}

export function validateTaskInputs(t: Pick<TripTask, 'kind' | 'label' | 'dueOn' | 'link'>): void {
  if (!t.label.trim()) throw new TripPlanError('A to-do needs words.')
  if (!TASK_KINDS.includes(t.kind)) throw new TripPlanError('Say what kind of to-do this is.')
  if (t.link !== null && t.link !== '' && !/^https?:\/\//.test(t.link)) throw new TripPlanError('A link starts with http:// or https://.')
}

export function validateBlackoutDates(ranges: readonly BlackoutRange[]): void {
  for (const r of ranges) {
    if (!r.label.trim()) throw new TripPlanError('Every blocked-out stretch needs a name, like "School term".')
    if (compareDates(r.to, r.from) < 0) throw new TripPlanError(`"${r.label}" ends before it starts.`)
  }
}

export function validatePackTemplate(labels: readonly string[]): void {
  if (labels.some((l) => typeof l !== 'string' || !l.trim())) throw new TripPlanError('Every packing item needs words.')
}

// ---------------------------------------------------------------- the days

/** What a new day row starts as: the ends of the trip are travel days, the rest are rest days until a park is picked. */
export function defaultPark(trip: Pick<Trip, 'startDate' | 'endDate'>, date: CivilDate): TripPark {
  if (compareDates(trip.endDate, trip.startDate) === 0) return 'rest'
  return date === trip.startDate || date === trip.endDate ? 'travel' : 'rest'
}

export interface DayCut {
  /** Dates with no row yet, in order. */
  add: { date: CivilDate; park: TripPark; sort: number }[]
  /** Rows for dates the trip no longer covers. */
  remove: TripDay[]
  /** Rows kept, with the sort they should have now. */
  keep: { day: TripDay; sort: number }[]
}

/**
 * One row per date from the first day to the last. When the dates change,
 * the rows for dates that remain are kept -- a park picked for June 14th
 * is still picked -- and only the missing ones are added or the stray ones
 * removed.
 */
export function cutDays(trip: Pick<Trip, 'startDate' | 'endDate'>, existing: readonly TripDay[]): DayCut {
  const byDate = new Map(existing.map((d) => [d.date, d]))
  const add: DayCut['add'] = []
  const keep: DayCut['keep'] = []
  const wanted = new Set<CivilDate>()
  const count = Math.max(0, compareDates(trip.endDate, trip.startDate))
  for (let i = 0; i <= count; i += 1) {
    const date = addDays(trip.startDate, i)
    wanted.add(date)
    const have = byDate.get(date)
    if (have) keep.push({ day: have, sort: i })
    else add.push({ date, park: defaultPark(trip, date), sort: i })
  }
  const remove = existing.filter((d) => !wanted.has(d.date))
  return { add, remove, keep }
}

// ---------------------------------------------------------------- what to book, and when

export interface GeneratedTask {
  key: string
  kind: TaskKind
  label: string
  dueOn: CivilDate
  /** The part of the trip the task pays for or books, so the engine can point it at a line. */
  category: TripLineCategory | null
}

/** A short packing list to start from; the household lays its own over it (setting trip_pack_template). */
export const DEFAULT_PACK_TEMPLATE: readonly string[] = [
  'Park tickets or MagicBands',
  'Phone chargers and a battery pack',
  'Ponchos',
  'Sunscreen',
  'Medications',
  'Snacks',
  'Stroller',
  'Documents: IDs, confirmations, insurance cards',
]

/** A stable key from a packing label, so the same item is found again on a rebuild. */
export function packKey(label: string): string {
  return `pack:${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
}

export const DINING_WINDOW_DAYS = 60
export const LIGHTNING_LANE_RESORT_DAYS = 7
export const LIGHTNING_LANE_OTHER_DAYS = 3
export const RESORT_BALANCE_DAYS = 30
export const RENTAL_BALANCE_DAYS = 60
export const FLIGHTS_DAYS = 120
export const TICKETS_DAYS = 60
export const MEMORY_MAKER_DAYS = 3

/**
 * The booking timeline (D22): what Disney and the rest open or ask for, and
 * when, for the way of doing it that is chosen. A date already gone is kept
 * as it is -- it shows as overdue, which is the truth -- never moved to
 * today. Without a way chosen yet, only what every trip needs is listed.
 */
export function bookingTimeline(
  trip: Pick<Trip, 'startDate' | 'endDate'>,
  variant: Pick<TripVariant, 'choices'> | null,
  today: CivilDate,
  options: { packTemplate?: readonly string[] | null } = {},
): GeneratedTask[] {
  const start = trip.startDate
  const before = (days: number) => addDays(start, -days)
  const tasks: GeneratedTask[] = []
  const push = (key: string, kind: TaskKind, label: string, dueOn: CivilDate, category: TripLineCategory | null) =>
    tasks.push({ key, kind, label, dueOn, category })
  const c = variant?.choices ?? null
  const resort = c?.lodging === 'disney_resort'

  if (c?.travel === 'fly') push('flights', 'book', 'Book the flights', before(FLIGHTS_DAYS), 'travel')
  if (c?.lodging === 'dvc_rental') {
    // A DVC rental is paid in full when it is booked, and it is booked early: soon, but no later than a month out.
    push('dvc_pay', 'pay', 'Pay the DVC rental in full when it is booked', minDate(addDays(today, 14), before(RESORT_BALANCE_DAYS)), 'lodging')
  }
  push(
    'dining',
    'book',
    resort ? 'Book the restaurants. Disney resort guests: the whole stay opens on that day' : 'Book the restaurants',
    before(DINING_WINDOW_DAYS),
    'dining',
  )
  if (!c || c.parkDays > 0) push('tickets', 'buy', 'Buy the park tickets', before(TICKETS_DAYS), 'tickets')
  if (c?.lodging === 'rental') push('rental_balance', 'pay', 'Pay the other half of the rental', before(RENTAL_BALANCE_DAYS), 'lodging')
  if (resort) push('resort_balance', 'pay', 'Pay the rest of the Disney resort room', before(RESORT_BALANCE_DAYS), 'lodging')
  if (c && c.lightningLane !== 'none') {
    const name = c.lightningLane === 'premier' ? 'Lightning Lane Premier Pass' : 'Lightning Lane Multi Pass'
    push('lightning_lane', 'buy', `Buy ${name}`, before(resort ? LIGHTNING_LANE_RESORT_DAYS : LIGHTNING_LANE_OTHER_DAYS), 'lightning_lane')
  }
  push('memory_maker', 'buy', 'Buy Memory Maker', before(MEMORY_MAKER_DAYS), 'photos')

  const template = options.packTemplate ?? DEFAULT_PACK_TEMPLATE
  const seen = new Set<string>()
  for (const label of template) {
    const key = packKey(label)
    if (!label.trim() || seen.has(key)) continue
    seen.add(key)
    push(key, 'pack', label.trim(), before(1), null)
  }
  return tasks
}

export interface TimelineMerge {
  add: GeneratedTask[]
  /** Generated rows still owned by the timeline, brought up to date. */
  update: { task: TripTask; patch: Pick<GeneratedTask, 'kind' | 'label' | 'dueOn'> }[]
  /** Generated rows whose key no longer applies and nobody has ticked. */
  remove: TripTask[]
}

/**
 * Rebuilding the timeline never touches a to-do a person has edited (it is
 * theirs now) or ticked (it is done, whatever the timeline thinks). A
 * generated to-do whose key still applies is brought up to date; one whose
 * key no longer applies goes.
 */
export function mergeTimeline(generated: readonly GeneratedTask[], existing: readonly TripTask[]): TimelineMerge {
  const wanted = new Map(generated.map((g) => [g.key, g]))
  const have = new Map<string, TripTask>()
  for (const t of existing) if (t.key && t.generated) have.set(t.key, t)
  const owned = new Set(existing.filter((t) => t.key).map((t) => t.key as string))

  const add = generated.filter((g) => !owned.has(g.key))
  const update: TimelineMerge['update'] = []
  const remove: TripTask[] = []
  for (const [key, task] of have) {
    if (task.doneOn) continue
    const fresh = wanted.get(key)
    if (!fresh) {
      remove.push(task)
      continue
    }
    if (fresh.kind !== task.kind || fresh.label !== task.label || fresh.dueOn !== task.dueOn) {
      update.push({ task, patch: { kind: fresh.kind, label: fresh.label, dueOn: fresh.dueOn } })
    }
  }
  return { add, update, remove }
}

export type TaskBucket = 'overdue' | 'this_month' | 'later' | 'done'

/** Where a to-do sits on the checklist: overdue, due this month, later, or done. */
export function taskBucket(task: Pick<TripTask, 'dueOn' | 'doneOn'>, today: CivilDate): TaskBucket {
  if (task.doneOn) return 'done'
  if (compareDates(task.dueOn, today) < 0) return 'overdue'
  return task.dueOn.slice(0, 7) === today.slice(0, 7) ? 'this_month' : 'later'
}

/** Undone to-dos soonest first, ties by sort then label. */
export function sortTasks(tasks: readonly TripTask[]): TripTask[] {
  return [...tasks].sort((a, b) => compareDates(a.dueOn, b.dueOn) || a.sort - b.sort || a.label.localeCompare(b.label))
}

/** The next few undone to-dos across trips, for the home screen. */
export function comingUpTasks(tasks: readonly TripTask[], limit: number): TripTask[] {
  return sortTasks(tasks.filter((t) => !t.doneOn)).slice(0, limit)
}

// ---------------------------------------------------------------- how busy

/**
 * The one level to trust for a date and park: a typed level over a fetched
 * one, then the most recently fetched. Two sources that disagree are both
 * facts; this is only which one the screen shows.
 */
export function pickLevel(levels: readonly CrowdLevel[], date: CivilDate, park: TripPark): CrowdLevel | null {
  let best: CrowdLevel | null = null
  for (const l of levels) {
    if (l.date !== date || l.park !== park) continue
    if (!best) {
      best = l
      continue
    }
    const typed = l.source === 'typed'
    const bestTyped = best.source === 'typed'
    if (typed !== bestTyped) {
      if (typed) best = l
      continue
    }
    if (compareDates(l.fetchedOn, best.fetchedOn) > 0) best = l
  }
  return best
}

/**
 * How busy the whole resort is on a date: the resort-wide figure when a
 * source gives one (park "other"), else the mean of the four parks that have
 * one. Nothing at all is null, never a guess.
 */
export function resortLevel(levels: readonly CrowdLevel[], date: CivilDate): number | null {
  const whole = pickLevel(levels, date, 'other')
  if (whole) return whole.level
  const parks = THEME_PARKS.map((p) => pickLevel(levels, date, p)).filter((l): l is CrowdLevel => l !== null)
  if (parks.length === 0) return null
  return parks.reduce((sum, l) => sum + l.level, 0) / parks.length
}

export interface CrowdPullSummary {
  park: TripPark
  days: number
  from: CivilDate
  to: CivilDate
  lowest: number
  highest: number
}

/** What a pull found, park by park, for the person to look at before keeping it. */
export function crowdPullSummary(levels: readonly ParsedCrowdLevel[]): CrowdPullSummary[] {
  const out: CrowdPullSummary[] = []
  for (const park of TRIP_PARKS) {
    const mine = levels.filter((l) => l.park === park)
    if (mine.length === 0) continue
    const dates = mine.map((l) => l.date).sort()
    out.push({
      park,
      days: mine.length,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      lowest: Math.min(...mine.map((l) => l.level)),
      highest: Math.max(...mine.map((l) => l.level)),
    })
  }
  return out
}

export function crowdFreshness(level: Pick<CrowdLevel, 'fetchedOn'>, today: CivilDate, staleAfterDays: number = CROWD_STALE_AFTER_DAYS): { ageDays: number; stale: boolean } {
  const ageDays = Math.max(0, compareDates(today, level.fetchedOn))
  return { ageDays, stale: ageDays > staleAfterDays }
}

/** "quiet", "busy", "packed": a word for a level, for a person who does not think in tens. */
export function crowdWord(level: number): string {
  if (level <= 3) return 'quiet'
  if (level <= 6) return 'moderate'
  if (level <= 8) return 'busy'
  return 'packed'
}

// ---------------------------------------------------------------- which week

export interface WeekCandidate {
  startDate: CivilDate
  endDate: CivilDate
  offsetWeeks: number
}

export const DEFAULT_WEEK_SPREAD = 3

/** The trip's own week and the same weekday a few weeks either side, each the same length. */
export function candidateWeeks(trip: Pick<Trip, 'startDate' | 'endDate'>, spread: number = DEFAULT_WEEK_SPREAD): WeekCandidate[] {
  const nights = Math.max(0, compareDates(trip.endDate, trip.startDate))
  const out: WeekCandidate[] = []
  for (let k = -spread; k <= spread; k += 1) {
    const startDate = addDays(trip.startDate, 7 * k)
    out.push({ startDate, endDate: addDays(startDate, nights), offsetWeeks: k })
  }
  return out
}

export interface WeekComparisonRow extends WeekCandidate {
  current: boolean
  crowd: {
    /** Mean resort-wide level over the park days, to a tenth. Null with no data. */
    average: number | null
    /** The busiest park day, rounded up to a whole level. */
    worst: number | null
    daysWithData: number
    parkDays: number
  }
  price: VariantPrice
  /** Getting-there parts only, so a week's cost to travel stands on its own. */
  travelCents: Cents
  /** A blocked-out stretch this week runs into, by name. */
  blackouts: string[]
  /** Any day this week that has already gone. */
  past: boolean
}

export interface WeekComparisonInput {
  trip: Trip
  variant: TripVariant | null
  /** The variant's parts as they stand, so a typed figure carries over to each candidate week. */
  lines?: readonly TripLine[]
  /** The trip's day rows, to know which days are park days. With none planned, every day counts. */
  days?: readonly TripDay[]
  candidateWeeks?: readonly WeekCandidate[]
  crowdLevels: readonly CrowdLevel[]
  referencePrices: readonly ReferencePrice[]
  drive?: DriveEstimate | null
  gasPrice?: GasPrice | null
  maxDriveMinutes?: number
  blackoutDates: readonly BlackoutRange[]
  today: CivilDate
}

function rangesOverlap(aFrom: CivilDate, aTo: CivilDate, bFrom: CivilDate, bTo: CivilDate): boolean {
  return compareDates(aFrom, bTo) <= 0 && compareDates(bFrom, aTo) <= 0
}

/**
 * One row per candidate week (D22): how busy, what it costs, what getting
 * there costs, and what it runs into. The park days are the trip's own,
 * shifted with the week; the price is the same parts re-dated, with every
 * typed figure carried over.
 */
export function weekComparison(input: WeekComparisonInput): WeekComparisonRow[] {
  const { trip, variant, today } = input
  const weeks = input.candidateWeeks ?? candidateWeeks(trip)
  const percent = contingencyBasisPoints(input.referencePrices)
  const planned = (input.days ?? []).filter((d) => d.park !== 'rest' && d.park !== 'travel')
  const parkOffsets =
    planned.length > 0 ? planned.map((d) => compareDates(d.date, trip.startDate)) : null

  return weeks.map((week) => {
    const shifted: Trip = { ...trip, startDate: week.startDate, endDate: week.endDate }
    const nights = compareDates(week.endDate, week.startDate)
    const offsets = parkOffsets ?? Array.from({ length: nights + 1 }, (_, i) => i)
    const levels = offsets
      .map((o) => resortLevel(input.crowdLevels, addDays(week.startDate, o)))
      .filter((l): l is number => l !== null)
    const average = levels.length > 0 ? Math.round((levels.reduce((s, l) => s + l, 0) / levels.length) * 10) / 10 : null
    const worst = levels.length > 0 ? Math.ceil(Math.max(...levels)) : null

    let priced: DefaultLine[] = []
    if (variant) {
      const fresh = defaultLines(shifted, variant, {
        referencePrices: input.referencePrices,
        drive: input.drive ?? null,
        gasPrice: input.gasPrice ?? null,
        maxDriveMinutes: input.maxDriveMinutes,
        today,
      })
      // Default parts carry their typed figures over by name; parts a person added are theirs whatever the week.
      const lines = input.lines ?? []
      priced = [...keepTypedLines(lines.filter((l) => !isAddedLine(l)), fresh), ...lines.filter(isAddedLine)]
    }
    const price = variantPrice(priced, percent)
    const travelCents = priced.filter((l) => l.category === 'travel').reduce((s, l) => s + Math.max(0, lineTotalCents(l)), 0)
    const blackouts = input.blackoutDates.filter((b) => rangesOverlap(week.startDate, week.endDate, b.from, b.to)).map((b) => b.label)

    return {
      ...week,
      current: week.offsetWeeks === 0,
      crowd: { average, worst, daysWithData: levels.length, parkDays: offsets.length },
      price,
      travelCents,
      blackouts,
      past: compareDates(week.startDate, today) < 0,
    }
  })
}

// ---------------------------------------------------------------- the days, planned

export interface DayView {
  date: CivilDate
  day: TripDay | null
  park: TripPark
  /** How busy the day's park is, or the resort as a whole on a day with no park. */
  level: CrowdLevel | null
  /** The resort as a whole, to the nearest whole level, for a day whose own park has no figure. */
  resortLevel: number | null
  quietest: { park: TripPark; level: number } | null
  reservations: TripReservation[]
}

/** Reservations in the order of the day: timed ones by time, untimed ones after. */
export function sortReservations(reservations: readonly TripReservation[]): TripReservation[] {
  return [...reservations].sort(
    (a, b) =>
      compareDates(a.date, b.date) ||
      (a.time === null ? 1 : 0) - (b.time === null ? 1 : 0) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.name.localeCompare(b.name),
  )
}

/**
 * Each date of the trip as the screen shows it: the park picked, how busy it
 * is, the quietest park that day, and what is booked. A day with no row yet
 * (a trip made before days existed) still appears, empty.
 */
export function dayPlan(
  trip: Pick<Trip, 'startDate' | 'endDate'>,
  days: readonly TripDay[],
  reservations: readonly TripReservation[],
  crowdLevels: readonly CrowdLevel[],
): DayView[] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const count = Math.max(0, compareDates(trip.endDate, trip.startDate))
  const out: DayView[] = []
  for (let i = 0; i <= count; i += 1) {
    const date = addDays(trip.startDate, i)
    const day = byDate.get(date) ?? null
    const park = day?.park ?? defaultPark(trip, date)
    const own = THEME_PARKS.includes(park) ? pickLevel(crowdLevels, date, park) : pickLevel(crowdLevels, date, 'other')
    let quietest: DayView['quietest'] = null
    for (const p of THEME_PARKS) {
      const l = pickLevel(crowdLevels, date, p)
      if (l && (!quietest || l.level < quietest.level)) quietest = { park: p, level: l.level }
    }
    const whole = resortLevel(crowdLevels, date)
    out.push({
      date,
      day,
      park,
      level: own,
      resortLevel: whole === null ? null : Math.round(whole),
      quietest,
      reservations: sortReservations(reservations.filter((r) => r.date === date)),
    })
  }
  return out
}

// ---------------------------------------------------------------- reservations and money

/** What a reservation comes to: the party times the figure per person. Nothing typed is nothing. */
export function reservationCostCents(r: Pick<TripReservation, 'party' | 'perPersonCents'>): Cents {
  if (r.perPersonCents === null) return 0
  return r.party * r.perPersonCents
}

export interface ReservationMoney {
  /** Reservations whose cost is already counted in a part of the trip, by that part. */
  countedIn: { lineId: Id; cents: Cents }[]
  /** Reservations with a cost that no part of the trip counts: money the plan does not know about. */
  uncountedCents: Cents
}

/**
 * A reservation with a cost is counted in the part it points at (the dining
 * figure already covers the restaurants), and never added on top. One that
 * points at nothing is money the price tag is missing, and the screen says so.
 */
export function reservationMoney(reservations: readonly TripReservation[]): ReservationMoney {
  const byLine = new Map<Id, Cents>()
  let uncounted = 0
  for (const r of reservations) {
    const cents = reservationCostCents(r)
    if (cents === 0) continue
    if (r.lineId) byLine.set(r.lineId, (byLine.get(r.lineId) ?? 0) + cents)
    else uncounted += cents
  }
  return { countedIn: [...byLine].map(([lineId, cents]) => ({ lineId, cents })), uncountedCents: uncounted }
}

// ---------------------------------------------------------------- what came back from a fetch

/** A crowd calendar the app can read, behind one shape (D23). */
export interface CrowdSource {
  key: CrowdSourceKey
  label: string
  /** The page to fetch for a destination and a month ("YYYY-MM"). */
  url(destination: TripDestination, month: string): string
  parse(text: string, month: string): ParsedCrowd
}

export interface ParsedCrowd {
  levels: ParsedCrowdLevel[]
  /** Why there is nothing, in words for the screen. Null when something was read. */
  reason: string | null
}

const MONTH = /^\d{4}-\d{2}$/

export function validateMonth(month: string): void {
  if (!MONTH.test(month)) throw new TripPlanError('A month is written like 2027-06.')
  const m = Number(month.slice(5, 7))
  if (m < 1 || m > 12) throw new TripPlanError('A month is written like 2027-06.')
}

/** The months a trip touches, "YYYY-MM" each, first to last. */
export function monthsOf(trip: Pick<Trip, 'startDate' | 'endDate'>): string[] {
  const months: string[] = []
  let cursor = trip.startDate.slice(0, 7)
  const last = trip.endDate.slice(0, 7)
  while (cursor <= last && months.length < 12) {
    months.push(cursor)
    const [y, m] = cursor.split('-').map(Number) as [number, number]
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }
  return months
}

const PARK_WORDS: [RegExp, TripPark][] = [
  [/magic[\s_-]*kingdom|\bmk\b/i, 'magic_kingdom'],
  [/epcot|\bep\b/i, 'epcot'],
  [/hollywood|\bdhs\b|\bhs\b|studios/i, 'hollywood_studios'],
  [/animal[\s_-]*kingdom|\bdak\b|\bak\b/i, 'animal_kingdom'],
  [/typhoon|blizzard|water[\s_-]*park/i, 'water_park'],
  [/\bwdw\b|walt[\s_-]*disney[\s_-]*world|disney[\s_-]*world|resort[\s_-]*wide|overall|\ball\b|\bresort\b|orlando/i, 'other'],
]

/** "Magic Kingdom", "mk", "hollywood_studios" -> a park; anything else is nothing. */
export function parkFromText(text: string | null | undefined): TripPark | null {
  if (!text) return null
  for (const [pattern, park] of PARK_WORDS) if (pattern.test(text)) return park
  return null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function realDate(y: number, m: number, d: number): CivilDate | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.toISOString().slice(0, 10) === date ? date : null
}

/**
 * A date as a page might write it: ISO, US numeric, "June 12, 2027", "Jun 12"
 * (year from the month asked for), or a bare day number when the page is a
 * calendar for that month.
 */
export function dateFromText(text: string | number | null | undefined, month: string | null): CivilDate | null {
  if (text === null || text === undefined) return null
  const s = String(text).trim()
  let m: RegExpMatchArray | null
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return realDate(Number(m[1]), Number(m[2]), Number(m[3]))
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return realDate(Number(m[3]), Number(m[1]), Number(m[2]))
  if ((m = s.match(/^(?:[a-z]+,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/i))) {
    const mi = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3))
    if (mi === -1) return null
    const year = m[3] ? Number(m[3]) : month ? Number(month.slice(0, 4)) : NaN
    return realDate(year, mi + 1, Number(m[2]))
  }
  if (month && /^\d{1,2}$/.test(s)) return realDate(Number(month.slice(0, 4)), Number(month.slice(5, 7)), Number(s))
  return null
}

/** A level as a page might write it: 1-10 as is, a percent scaled to tens, anything else nothing. */
export function levelFromValue(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*%?\s*$/.test(value) ? Number(value.replace('%', '')) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  if (n <= 10) return Math.max(1, Math.round(n))
  if (n <= 100) return Math.max(1, Math.min(10, Math.ceil(n / 10)))
  return null
}

const DATE_KEY = /date|day|^d$|^when$|^x$/i
const LEVEL_KEY = /crowd|level|index|score|rating|busy|value|^v$|^y$/i
const PARK_KEY = /park|location|venue|place|name|title|label/i

/** Walk a parsed JSON value for objects that read as {date, level[, park]}. A parent key names the park when the row does not. */
function fromJson(value: unknown, month: string | null, parkHint: TripPark | null, out: ParsedCrowdLevel[], depth = 0): void {
  if (depth > 12 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) fromJson(item, month, parkHint, out, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  let date: CivilDate | null = null
  let level: number | null = null
  let park: TripPark | null = null
  for (const [key, v] of Object.entries(record)) {
    if (date === null && DATE_KEY.test(key) && (typeof v === 'string' || typeof v === 'number')) date = dateFromText(v, month)
    else if (level === null && LEVEL_KEY.test(key) && !DATE_KEY.test(key)) level = levelFromValue(v)
    else if (park === null && PARK_KEY.test(key) && typeof v === 'string') park = parkFromText(v)
  }
  if (date && level !== null) {
    out.push({ date, park: park ?? parkHint ?? 'other', level })
    return
  }
  // A park named on this object ({name: "Magic Kingdom", data: [...]}) or by a key ({magic_kingdom: [...]}) names its children.
  for (const [key, v] of Object.entries(record)) {
    if (v && typeof v === 'object') fromJson(v, month, parkFromText(key) ?? park ?? parkHint, out, depth + 1)
  }
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
  const scripts = text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)
  for (const m of scripts) {
    const body = (m[1] ?? '').trim()
    if (!body) continue
    if (tryParse(body)) continue
    // window.__DATA__ = {...}; or var calendar = [...];
    const first = body.search(/[[{]/)
    if (first === -1) continue
    const opener = body[first]
    const closer = opener === '[' ? ']' : '}'
    const last = body.lastIndexOf(closer)
    if (last > first) tryParse(body.slice(first, last + 1))
  }
  return found
}

function fromDataAttributes(html: string, month: string | null, out: ParsedCrowdLevel[]): void {
  for (const tag of html.matchAll(/<[a-z][a-z0-9-]*\b([^>]*\bdata-[^>]*)>/gi)) {
    const attrs = new Map<string, string>()
    for (const a of (tag[1] ?? '').matchAll(/data-([a-z0-9-]+)\s*=\s*"([^"]*)"/gi)) attrs.set(a[1]!.toLowerCase(), a[2]!)
    const dateText = attrs.get('date') ?? attrs.get('day') ?? attrs.get('when')
    const levelText = attrs.get('level') ?? attrs.get('crowd') ?? attrs.get('crowd-level') ?? attrs.get('index') ?? attrs.get('value') ?? attrs.get('score')
    if (!dateText || levelText === undefined) continue
    const date = dateFromText(dateText, month)
    const level = levelFromValue(levelText)
    if (!date || level === null) continue
    out.push({ date, park: parkFromText(attrs.get('park') ?? attrs.get('location') ?? attrs.get('venue')) ?? 'other', level })
  }
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

function fromTables(html: string, month: string | null, out: ParsedCrowdLevel[]): void {
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...(table[1] ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...(r[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1] ?? '')),
    )
    if (rows.length === 0) continue
    // A header row naming parks makes each level cell's column its park.
    const header = rows[0]!
    const columnParks = header.map((h) => parkFromText(h))
    const hasParkColumns = columnParks.filter((p) => p !== null && p !== 'other').length >= 2
    const tablePark = hasParkColumns ? null : parkFromText(stripTags(table[0]!.slice(0, 400)))
    for (const cells of rows) {
      const dateIndex = cells.findIndex((c) => dateFromText(c, month) !== null)
      if (dateIndex === -1) continue
      const date = dateFromText(cells[dateIndex], month)!
      if (hasParkColumns) {
        cells.forEach((cell, i) => {
          const park = columnParks[i]
          if (i === dateIndex || !park) return
          const level = levelFromValue(cell)
          if (level !== null) out.push({ date, park, level })
        })
      } else {
        const park = cells.map((c) => parkFromText(c)).find((p) => p !== null) ?? tablePark ?? 'other'
        const level = cells.map((c, i) => (i === dateIndex ? null : levelFromValue(c))).find((l) => l !== null)
        if (level !== undefined && level !== null) out.push({ date, park, level })
      }
    }
  }
}

/**
 * Read a crowd-calendar page however it carries its numbers: JSON in a
 * script tag, data attributes, or a table. Only the month asked for is kept,
 * one level per date and park, and a page with nothing readable is nothing
 * with a reason, never an exception.
 */
export function parseCrowdPage(text: string, month: string | null): ParsedCrowd {
  if (typeof text !== 'string' || !text.trim()) return { levels: [], reason: 'The page was empty.' }
  const found: ParsedCrowdLevel[] = []
  for (const json of jsonCandidates(text)) fromJson(json, month, null, found)
  if (found.length === 0) fromDataAttributes(text, month, found)
  if (found.length === 0) fromTables(text, month, found)
  const seen = new Set<string>()
  const levels = found.filter((l) => {
    if (month && l.date.slice(0, 7) !== month) return false
    const key = `${l.date}|${l.park}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (levels.length === 0) {
    return {
      levels,
      reason: found.length > 0 ? `The page had crowd levels, but none for ${month}.` : 'Nothing on the page read as a crowd calendar.',
    }
  }
  return { levels, reason: null }
}

export const THRILL_DATA_URL = 'https://www.thrill-data.com/trip-planning/crowd-calendar/resort/wdw'
export const UNDERCOVER_TOURIST_URL = 'https://www.undercovertourist.com/orlando/crowd-calendar/'

/** Thrill Data's public WDW calendar: the resort page carries every park's levels as data. */
export function parseThrillDataCrowd(text: string, month: string): ParsedCrowd {
  return parseCrowdPage(text, month)
}

/** Undercover Tourist's Orlando calendar: one level per park per day, as a table or data attributes. */
export function parseUndercoverTouristCrowd(text: string, month: string): ParsedCrowd {
  return parseCrowdPage(text, month)
}

/** The sources in the order tried (D23). TouringPlans is subscriber-only and not fetched. */
export const CROWD_SOURCES: readonly CrowdSource[] = [
  {
    key: 'thrill_data',
    label: 'Thrill Data',
    url: (destination, month) => `${THRILL_DATA_URL}?month=${month}&destination=${destination}`,
    parse: parseThrillDataCrowd,
  },
  {
    key: 'undercover_tourist',
    label: 'Undercover Tourist',
    url: (_destination, month) => `${UNDERCOVER_TOURIST_URL}?month=${month}`,
    parse: parseUndercoverTouristCrowd,
  },
]

export interface GeocodeResult {
  latitude: number
  longitude: number
  resolvedName: string
}

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search'

export function nominatimUrl(address: string): string {
  return `${NOMINATIM_SEARCH_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(address.trim())}`
}

/**
 * The first place Nominatim answered with: [{lat, lon, display_name}]. A
 * point off the globe, or a shape that is not a search result, is nothing
 * rather than a home the drive is measured from.
 */
export function parseNominatim(json: unknown): GeocodeResult | null {
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { results?: unknown }).results) ? (json as { results: unknown[] }).results : null
  if (!list || list.length === 0) return null
  const first = list[0] as { lat?: unknown; lon?: unknown; display_name?: unknown }
  if (!first || typeof first !== 'object') return null
  const isNumberish = (v: unknown) => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number'
  if (!isNumberish(first.lat) || !isNumberish(first.lon)) return null
  const latitude = Number(first.lat)
  const longitude = Number(first.lon)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null
  const resolvedName = typeof first.display_name === 'string' ? first.display_name.trim() : ''
  return { latitude, longitude, resolvedName }
}

// ---------------------------------------------------------------- words on screen

/** "Jun 12" for a date, in a day card's header. */
export function shortDate(date: CivilDate): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number]
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[m - 1]} ${d}`
}

/** The weekday of a civil date, "Saturday". */
export function weekdayName(date: CivilDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!
}
