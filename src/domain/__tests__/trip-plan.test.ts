/**
 * Planning a trip (PRD §16 D22-D24): every derivation the planning sections
 * show, pinned without a database or a network. The crowd-calendar and
 * geocoder parsers are tested on small hand-written pages in each shape
 * they accept, and on garbage, because neither site is reachable from here
 * and a page that changes shape must fail as nothing, not as a crash.
 */

import { describe, expect, it } from 'vitest'
import {
  bookingTimeline,
  candidateWeeks,
  comingUpTasks,
  crowdFreshness,
  crowdPullSummary,
  crowdWord,
  CROWD_SOURCES,
  cutDays,
  dateFromText,
  dayPlan,
  DEFAULT_PACK_TEMPLATE,
  defaultPark,
  levelFromValue,
  mergeTimeline,
  monthsOf,
  nominatimUrl,
  packKey,
  parkFromText,
  parseCrowdPage,
  parseNominatim,
  parseThrillDataCrowd,
  parseUndercoverTouristCrowd,
  pickLevel,
  reservationCostCents,
  reservationMoney,
  resortLevel,
  sortReservations,
  taskBucket,
  TripPlanError,
  validateCrowdLevel,
  validateReservationInputs,
  validateTaskInputs,
  validateBlackoutDates,
  weekComparison,
  type CrowdLevel,
  type GeneratedTask,
  type TripDay,
  type TripReservation,
  type TripTask,
} from '../trip-plan'
import { DEFAULT_REFERENCE_PRICES, defaultLines, variantPrice, type Trip, type TripLine, type TripVariant, type VariantChoices } from '../trip'

const TODAY = '2026-09-25'

const trip: Trip = {
  id: 'trip-1',
  householdId: 'hh',
  name: 'Disney 2027',
  destination: 'wdw',
  startDate: '2027-06-12', // a Saturday
  endDate: '2027-06-18', // 6 nights, 7 days
  travelers: [
    { name: 'Josh', band: 'adult' },
    { name: 'Sam', band: 'adult' },
    { name: 'Ada', band: 'child' },
  ],
  home: { label: 'Home', latitude: 41.8781, longitude: -87.6298 },
  car: { mpg: 25, seats: 7 },
  chosenVariantId: null,
  packageId: null,
  sentOn: null,
  createdAt: TODAY,
  retiredAt: null,
}

const variant = (over: Partial<VariantChoices> = {}): TripVariant => ({
  id: 'var-1',
  tripId: trip.id,
  name: 'Drive, stay at Pop',
  choices: { travel: 'drive', lodging: 'disney_resort', lightningLane: 'multi_pass', dining: 'out_of_pocket', parkDays: 4, ...over },
  createdAt: TODAY,
})

const day = (date: string, park: TripDay['park'] = 'rest', over: Partial<TripDay> = {}): TripDay => ({
  id: `day-${date}`,
  tripId: trip.id,
  date,
  park,
  plan: { notes: '', ropeDrop: false },
  sort: 0,
  ...over,
})

const task = (over: Partial<TripTask> & { key?: string | null }): TripTask => ({
  id: over.id ?? `task-${over.key ?? over.label ?? 'x'}`,
  tripId: trip.id,
  kind: 'do',
  label: 'Something',
  dueOn: '2027-01-01',
  doneOn: null,
  link: null,
  lineId: null,
  sort: 0,
  generated: true,
  key: null,
  ...over,
})

const level = (date: string, park: CrowdLevel['park'], value: number, over: Partial<CrowdLevel> = {}): CrowdLevel => ({
  destination: 'wdw',
  date,
  park,
  level: value,
  source: 'thrill_data',
  fetchedOn: TODAY,
  ...over,
})

const byKey = (tasks: readonly GeneratedTask[], key: string) => {
  const t = tasks.find((g) => g.key === key)
  if (!t) throw new Error(`no task "${key}" in ${tasks.map((g) => g.key).join(', ')}`)
  return t
}

describe('cutting the days', () => {
  it('one row per date, travel days at the ends and rest days between, in order', () => {
    const cut = cutDays(trip, [])
    expect(cut.add.map((a) => a.date)).toEqual(['2027-06-12', '2027-06-13', '2027-06-14', '2027-06-15', '2027-06-16', '2027-06-17', '2027-06-18'])
    expect(cut.add.map((a) => a.park)).toEqual(['travel', 'rest', 'rest', 'rest', 'rest', 'rest', 'travel'])
    expect(cut.add.map((a) => a.sort)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(cut.remove).toEqual([])
    expect(defaultPark({ startDate: '2027-01-01', endDate: '2027-01-01' }, '2027-01-01')).toBe('rest')
  })

  it('a change of dates keeps the rows that remain, adds the missing and removes the stray', () => {
    const existing = ['2027-06-12', '2027-06-13', '2027-06-14'].map((d, i) => day(d, i === 1 ? 'epcot' : 'rest', { sort: i }))
    const cut = cutDays({ startDate: '2027-06-13', endDate: '2027-06-15' }, existing)
    expect(cut.remove.map((d) => d.date)).toEqual(['2027-06-12'])
    expect(cut.add.map((a) => a.date)).toEqual(['2027-06-15'])
    expect(cut.keep.map((k) => [k.day.date, k.day.park, k.sort])).toEqual([
      ['2027-06-13', 'epcot', 0],
      ['2027-06-14', 'rest', 1],
    ])
  })

  it('nothing to do when the rows already match', () => {
    const existing = cutDays(trip, []).add.map((a, i) => day(a.date, a.park, { sort: i }))
    const cut = cutDays(trip, existing)
    expect(cut.add).toEqual([])
    expect(cut.remove).toEqual([])
    expect(cut.keep.every((k) => k.day.sort === k.sort)).toBe(true)
  })
})

describe('what to book, and when', () => {
  it('a Disney resort, Multi Pass, driving: dining at 60 days with the resort note, LL at 7, balance at 30, tickets at 60, Memory Maker at 3', () => {
    const tasks = bookingTimeline(trip, variant(), TODAY)
    expect(byKey(tasks, 'dining')).toMatchObject({ kind: 'book', dueOn: '2027-04-13', category: 'dining' })
    expect(byKey(tasks, 'dining').label).toContain('Disney resort guests: the whole stay opens on that day')
    expect(byKey(tasks, 'lightning_lane')).toMatchObject({ kind: 'buy', dueOn: '2027-06-05', label: 'Buy Lightning Lane Multi Pass' })
    expect(byKey(tasks, 'resort_balance')).toMatchObject({ kind: 'pay', dueOn: '2027-05-13', category: 'lodging' })
    expect(byKey(tasks, 'tickets')).toMatchObject({ kind: 'buy', dueOn: '2027-04-13', category: 'tickets' })
    expect(byKey(tasks, 'memory_maker')).toMatchObject({ kind: 'buy', dueOn: '2027-06-09' })
    expect(tasks.find((t) => t.key === 'flights')).toBeUndefined()
    expect(tasks.find((t) => t.key === 'rental_balance')).toBeUndefined()
    expect(tasks.find((t) => t.key === 'dvc_pay')).toBeUndefined()
  })

  it('a rental, no Lightning Lane, flying: flights at 120, the other half at 60, LL not listed, no resort note', () => {
    const tasks = bookingTimeline(trip, variant({ travel: 'fly', lodging: 'rental', lightningLane: 'none' }), TODAY)
    expect(byKey(tasks, 'flights')).toMatchObject({ kind: 'book', dueOn: '2027-02-12', category: 'travel' })
    expect(byKey(tasks, 'rental_balance')).toMatchObject({ kind: 'pay', dueOn: '2027-04-13' })
    expect(byKey(tasks, 'dining').label).toBe('Book the restaurants')
    expect(tasks.find((t) => t.key === 'lightning_lane')).toBeUndefined()
    expect(tasks.find((t) => t.key === 'resort_balance')).toBeUndefined()
  })

  it('off site with Premier Pass: Lightning Lane at 3 days; a DVC rental is paid in full at booking', () => {
    const premier = bookingTimeline(trip, variant({ lodging: 'rental', lightningLane: 'premier' }), TODAY)
    expect(byKey(premier, 'lightning_lane')).toMatchObject({ dueOn: '2027-06-09', label: 'Buy Lightning Lane Premier Pass' })
    const dvc = bookingTimeline(trip, variant({ lodging: 'dvc_rental' }), TODAY)
    expect(byKey(dvc, 'dvc_pay')).toMatchObject({ kind: 'pay', dueOn: '2026-10-09' })
    expect(dvc.find((t) => t.key === 'resort_balance')).toBeUndefined()
  })

  it('no park days: no tickets; no way chosen yet: only what every trip needs', () => {
    expect(bookingTimeline(trip, variant({ parkDays: 0 }), TODAY).find((t) => t.key === 'tickets')).toBeUndefined()
    const bare = bookingTimeline(trip, null, TODAY)
    expect(bare.map((t) => t.key).filter((k) => !k.startsWith('pack:'))).toEqual(['dining', 'tickets', 'memory_maker'])
  })

  it('the packing list comes from the template, due the day before, with stable keys and no doubles', () => {
    const tasks = bookingTimeline(trip, variant(), TODAY)
    const pack = tasks.filter((t) => t.kind === 'pack')
    expect(pack).toHaveLength(DEFAULT_PACK_TEMPLATE.length)
    expect(pack.every((t) => t.dueOn === '2027-06-11')).toBe(true)
    expect(packKey('Park tickets or MagicBands')).toBe('pack:park_tickets_or_magicbands')
    const custom = bookingTimeline(trip, variant(), TODAY, { packTemplate: ['Ponchos', ' ponchos ', '', 'Bear'] }).filter((t) => t.kind === 'pack')
    expect(custom.map((t) => t.key)).toEqual(['pack:ponchos', 'pack:bear'])
  })

  it('a date already gone is kept as it is, never moved to today', () => {
    const soon = bookingTimeline({ startDate: '2026-10-10', endDate: '2026-10-14' }, variant({ travel: 'fly' }), TODAY)
    expect(byKey(soon, 'flights').dueOn).toBe('2026-06-12')
    expect(byKey(soon, 'dining').dueOn).toBe('2026-08-11')
  })
})

describe('rebuilding the timeline', () => {
  const generated: GeneratedTask[] = [
    { key: 'dining', kind: 'book', label: 'Book the restaurants', dueOn: '2027-04-13', category: 'dining' },
    { key: 'tickets', kind: 'buy', label: 'Buy the park tickets', dueOn: '2027-04-13', category: 'tickets' },
    { key: 'pack:ponchos', kind: 'pack', label: 'Ponchos', dueOn: '2027-06-11', category: null },
  ]

  it('adds what is missing, brings a generated row up to date, and removes one whose key no longer applies', () => {
    const existing = [
      task({ key: 'dining', kind: 'book', label: 'Book the restaurants', dueOn: '2027-04-20' }),
      task({ key: 'flights', kind: 'book', label: 'Book the flights', dueOn: '2027-02-12' }),
    ]
    const merge = mergeTimeline(generated, existing)
    expect(merge.add.map((g) => g.key)).toEqual(['tickets', 'pack:ponchos'])
    expect(merge.update).toHaveLength(1)
    expect(merge.update[0]!.task.key).toBe('dining')
    expect(merge.update[0]!.patch).toEqual({ kind: 'book', label: 'Book the restaurants', dueOn: '2027-04-13' })
    expect(merge.remove.map((t) => t.key)).toEqual(['flights'])
  })

  it('never touches a to-do a person edited, or one they ticked, even when its key is gone', () => {
    const existing = [
      task({ key: 'dining', label: 'Book Ohana!', dueOn: '2027-01-01', generated: false }),
      task({ key: 'flights', label: 'Book the flights', dueOn: '2027-02-12', doneOn: '2026-09-01' }),
      task({ key: 'tickets', label: 'Buy the park tickets', dueOn: '2027-01-01', doneOn: '2026-09-02' }),
      task({ key: null, label: 'Buy Ada a lanyard', dueOn: '2027-06-01', generated: false }),
    ]
    const merge = mergeTimeline(generated, existing)
    expect(merge.update).toEqual([])
    expect(merge.remove).toEqual([])
    // The edited dining row keeps its key, so no second dining row is added.
    expect(merge.add.map((g) => g.key)).toEqual(['pack:ponchos'])
  })

  it('nothing to do when everything matches', () => {
    const existing = generated.map((g) => task({ key: g.key, kind: g.kind, label: g.label, dueOn: g.dueOn }))
    expect(mergeTimeline(generated, existing)).toEqual({ add: [], update: [], remove: [] })
  })
})

describe('the checklist', () => {
  it('buckets: overdue, this month, later, done', () => {
    expect(taskBucket({ dueOn: '2026-09-24', doneOn: null }, TODAY)).toBe('overdue')
    expect(taskBucket({ dueOn: '2026-09-25', doneOn: null }, TODAY)).toBe('this_month')
    expect(taskBucket({ dueOn: '2026-09-30', doneOn: null }, TODAY)).toBe('this_month')
    expect(taskBucket({ dueOn: '2026-10-01', doneOn: null }, TODAY)).toBe('later')
    expect(taskBucket({ dueOn: '2026-01-01', doneOn: TODAY }, TODAY)).toBe('done')
  })

  it('coming up: the next few undone, soonest first', () => {
    const tasks = [
      task({ id: 'a', label: 'a', dueOn: '2027-03-01' }),
      task({ id: 'b', label: 'b', dueOn: '2026-10-01', doneOn: TODAY }),
      task({ id: 'c', label: 'c', dueOn: '2026-11-01' }),
      task({ id: 'd', label: 'd', dueOn: '2026-10-15' }),
      task({ id: 'e', label: 'e', dueOn: '2027-01-01' }),
    ]
    expect(comingUpTasks(tasks, 3).map((t) => t.id)).toEqual(['d', 'c', 'e'])
  })
})

describe('how busy', () => {
  const levels = [
    level('2027-06-13', 'magic_kingdom', 8),
    level('2027-06-13', 'magic_kingdom', 6, { source: 'typed', fetchedOn: '2026-08-01' }),
    level('2027-06-13', 'epcot', 4),
    level('2027-06-13', 'epcot', 5, { fetchedOn: '2026-09-01' }),
    level('2027-06-13', 'hollywood_studios', 7),
    level('2027-06-14', 'other', 9),
    level('2027-06-14', 'magic_kingdom', 2),
  ]

  it('a typed level wins over a fetched one, and the freshest fetch wins otherwise', () => {
    expect(pickLevel(levels, '2027-06-13', 'magic_kingdom')?.level).toBe(6)
    expect(pickLevel(levels, '2027-06-13', 'epcot')?.level).toBe(4)
    expect(pickLevel(levels, '2027-06-13', 'animal_kingdom')).toBeNull()
  })

  it('the resort as a whole: the resort-wide figure when there is one, else the mean of the parks', () => {
    expect(resortLevel(levels, '2027-06-14')).toBe(9)
    expect(resortLevel(levels, '2027-06-13')).toBeCloseTo((6 + 4 + 7) / 3)
    expect(resortLevel(levels, '2027-06-15')).toBeNull()
  })

  it('a level older than 30 days is stale; words for the numbers', () => {
    expect(crowdFreshness({ fetchedOn: '2026-08-26' }, TODAY)).toEqual({ ageDays: 30, stale: false })
    expect(crowdFreshness({ fetchedOn: '2026-08-25' }, TODAY)).toEqual({ ageDays: 31, stale: true })
    expect([1, 3, 4, 6, 7, 8, 9, 10].map(crowdWord)).toEqual(['quiet', 'quiet', 'moderate', 'moderate', 'busy', 'busy', 'packed', 'packed'])
  })

  it('a pull is summarised park by park', () => {
    const summary = crowdPullSummary([
      { date: '2027-06-13', park: 'epcot', level: 4 },
      { date: '2027-06-12', park: 'epcot', level: 7 },
      { date: '2027-06-12', park: 'magic_kingdom', level: 8 },
    ])
    expect(summary).toEqual([
      { park: 'magic_kingdom', days: 1, from: '2027-06-12', to: '2027-06-12', lowest: 8, highest: 8 },
      { park: 'epcot', days: 2, from: '2027-06-12', to: '2027-06-13', lowest: 4, highest: 7 },
    ])
  })

  it('refuses a level off the scale', () => {
    expect(() => validateCrowdLevel({ date: TODAY, park: 'epcot', level: 11, source: 'typed' })).toThrow(TripPlanError)
    expect(() => validateCrowdLevel({ date: TODAY, park: 'epcot', level: 0, source: 'typed' })).toThrow(TripPlanError)
    expect(() => validateCrowdLevel({ date: TODAY, park: 'epcot', level: 5, source: 'typed' })).not.toThrow()
  })
})

describe('which week', () => {
  const days = [day('2027-06-12', 'travel'), day('2027-06-13', 'magic_kingdom'), day('2027-06-14', 'epcot'), day('2027-06-15', 'rest'), day('2027-06-18', 'travel')]
  // Park days are the 2nd and 3rd of the trip. Levels for this week and the next.
  const crowd = [
    level('2027-06-13', 'other', 8),
    level('2027-06-14', 'other', 6),
    level('2027-06-20', 'other', 3),
    level('2027-06-21', 'magic_kingdom', 2),
    level('2027-06-21', 'epcot', 4),
  ]
  const base = {
    trip,
    variant: variant(),
    days,
    crowdLevels: crowd,
    referencePrices: DEFAULT_REFERENCE_PRICES,
    blackoutDates: [{ from: '2027-05-31', to: '2027-06-06', label: 'School term' }],
    today: TODAY,
  }

  it('seven candidate weeks, the same weekday and length, the trip in the middle', () => {
    const weeks = candidateWeeks(trip)
    expect(weeks).toHaveLength(7)
    expect(weeks[3]).toEqual({ startDate: '2027-06-12', endDate: '2027-06-18', offsetWeeks: 0 })
    expect(weeks[0]).toEqual({ startDate: '2027-05-22', endDate: '2027-05-28', offsetWeeks: -3 })
    expect(weeks[6]!.startDate).toBe('2027-07-03')
  })

  it('averages the resort-wide level over the park days, shifted with the week, and flags missing data', () => {
    const rows = weekComparison(base)
    const current = rows.find((r) => r.current)!
    expect(current.crowd).toEqual({ average: 7, worst: 8, daysWithData: 2, parkDays: 2 })
    const next = rows.find((r) => r.offsetWeeks === 1)!
    // The 20th has a resort-wide 3; the 21st is the mean of MK 2 and EPCOT 4 = 3.
    expect(next.crowd).toEqual({ average: 3, worst: 3, daysWithData: 2, parkDays: 2 })
    const empty = rows.find((r) => r.offsetWeeks === -1)!
    expect(empty.crowd).toEqual({ average: null, worst: null, daysWithData: 0, parkDays: 2 })
    expect(rows.every((r) => !r.past)).toBe(true)
  })

  it('with no park picked yet, every day counts', () => {
    const rows = weekComparison({ ...base, days: [] })
    expect(rows.find((r) => r.current)!.crowd).toEqual({ average: 7, worst: 8, daysWithData: 2, parkDays: 7 })
  })

  it('a blocked-out stretch is named on the weeks it touches', () => {
    const rows = weekComparison(base)
    // May 31 to Jun 6 runs into the weeks of May 29 and Jun 5, not the trip's own.
    expect(rows.map((r) => r.blackouts)).toEqual([[], ['School term'], ['School term'], [], [], [], []])
  })

  it('prices each week with the same parts re-dated, a typed figure carried over, and the travel parts on their own', () => {
    const fresh = defaultLines(trip, variant(), { referencePrices: DEFAULT_REFERENCE_PRICES, today: TODAY })
    const lines: TripLine[] = fresh.map((l, i) => ({ ...l, id: `line-${i}`, variantId: 'var-1' }))
    const room = lines.find((l) => l.label === 'Disney resort room, per night')!
    room.unitAmountCents = 28_000
    room.source = 'typed'
    const tolls = lines.find((l) => l.label === 'Tolls, each way')!
    tolls.unitAmountCents = 1_500
    tolls.source = 'typed'
    // A part a person added, even one with a default's name, comes along as it is.
    lines.push({ ...lines.find((l) => l.label === 'Souvenirs')!, id: 'line-added', unitAmountCents: 5_000, quantity: 1, sort: 1000 })
    const rows = weekComparison({ ...base, lines })
    for (const row of rows) {
      expect(row.price).toEqual(variantPrice(lines, 1000))
      expect(row.travelCents).toBe(2 * 1_500)
      expect(row.price.partsCents).toBeGreaterThan(0)
    }
    // A week with no way chosen has no price.
    expect(weekComparison({ ...base, variant: null }).every((r) => r.price.totalCents === 0)).toBe(true)
  })

  it('a week already gone is marked', () => {
    const rows = weekComparison({ ...base, trip: { ...trip, startDate: '2026-10-03', endDate: '2026-10-09' }, days: [] })
    // Sep 12 and Sep 19 have gone; Sep 26 starts tomorrow.
    expect(rows.map((r) => r.past)).toEqual([true, true, false, false, false, false, false])
  })
})

describe('the days, planned', () => {
  const reservations: TripReservation[] = [
    { id: 'r1', tripId: trip.id, date: '2027-06-13', time: '18:30', kind: 'dining', name: 'Ohana', park: 'other', confirmation: 'ABC123', party: 3, perPersonCents: 6_500, lineId: 'line-food', note: null },
    { id: 'r2', tripId: trip.id, date: '2027-06-13', time: null, kind: 'lightning_lane', name: 'Tron', park: 'magic_kingdom', confirmation: null, party: 3, perPersonCents: null, lineId: null, note: null },
    { id: 'r3', tripId: trip.id, date: '2027-06-13', time: '08:00', kind: 'dining', name: 'Breakfast', park: 'magic_kingdom', confirmation: null, party: 3, perPersonCents: 4_000, lineId: null, note: null },
  ]
  const crowd = [level('2027-06-13', 'magic_kingdom', 8), level('2027-06-13', 'epcot', 4), level('2027-06-13', 'animal_kingdom', 3), level('2027-06-14', 'other', 5)]

  it("each date: the park, that park's level, the quietest park, and the day's reservations in time order", () => {
    const views = dayPlan(trip, [day('2027-06-13', 'magic_kingdom'), day('2027-06-14', 'rest')], reservations, crowd)
    expect(views).toHaveLength(7)
    const sunday = views[1]!
    expect(sunday.park).toBe('magic_kingdom')
    expect(sunday.level?.level).toBe(8)
    expect(sunday.quietest).toEqual({ park: 'animal_kingdom', level: 3 })
    expect(sunday.reservations.map((r) => r.id)).toEqual(['r3', 'r1', 'r2'])
    expect(sunday.resortLevel).toBe(5) // (8 + 4 + 3) / 3 = 5
    // A rest day shows the resort as a whole.
    expect(views[2]!.level?.level).toBe(5)
    expect(views[2]!.quietest).toBeNull()
    // A day with no row yet still appears, with its default.
    expect(views[0]!.day).toBeNull()
    expect(views[0]!.park).toBe('travel')
    expect(views[0]!.level).toBeNull()
  })

  it('reservations sort by date, then timed before untimed', () => {
    expect(sortReservations([reservations[1]!, reservations[0]!, { ...reservations[2]!, date: '2027-06-12' }]).map((r) => r.id)).toEqual(['r3', 'r1', 'r2'])
  })

  it('a reservation costs the party times the figure; counted in its part, or flagged as counted nowhere', () => {
    expect(reservationCostCents(reservations[0]!)).toBe(19_500)
    expect(reservationCostCents(reservations[1]!)).toBe(0)
    expect(reservationMoney(reservations)).toEqual({ countedIn: [{ lineId: 'line-food', cents: 19_500 }], uncountedCents: 12_000 })
  })

  it('refuses what a reservation or a to-do cannot be', () => {
    const ok = { ...reservations[0]! }
    expect(() => validateReservationInputs(ok)).not.toThrow()
    expect(() => validateReservationInputs({ ...ok, time: '25:00' })).toThrow(TripPlanError)
    expect(() => validateReservationInputs({ ...ok, name: ' ' })).toThrow(TripPlanError)
    expect(() => validateReservationInputs({ ...ok, party: -1 })).toThrow(TripPlanError)
    expect(() => validateReservationInputs({ ...ok, perPersonCents: 1.5 })).toThrow(TripPlanError)
    expect(() => validateTaskInputs({ kind: 'do', label: 'x', dueOn: TODAY, link: 'ftp://nope' })).toThrow(TripPlanError)
    expect(() => validateTaskInputs({ kind: 'do', label: 'x', dueOn: TODAY, link: 'https://ok' })).not.toThrow()
    expect(() => validateBlackoutDates([{ from: '2027-02-02', to: '2027-02-01', label: 'Backwards' }])).toThrow(TripPlanError)
  })
})

describe('reading a crowd calendar', () => {
  const thrillDataJson = `<html><head><script>window.__CROWD__ = {"resort":"wdw","parks":{"magic_kingdom":[{"date":"2027-06-12","crowd_level":7},{"date":"2027-06-13","crowd_level":9}],"epcot":[{"date":"2027-06-12","crowd_level":4}],"hollywood_studios":[{"date":"2027-06-12","crowd_level":6}],"animal_kingdom":[{"date":"2027-06-12","crowd_level":3},{"date":"2027-07-01","crowd_level":2}]}};</script></head><body>calendar</body></html>`
  const applicationJson = `<html><body><script type="application/json" id="calendar">[{"day":"2027-06-13","index":85,"park":"EPCOT"},{"day":"June 14, 2027","index":22,"park":"Animal Kingdom"},{"day":"2027-06-15","index":"55%","park":"Disney World"}]</script></body></html>`
  const table = `<html><body><h2>Walt Disney World crowd calendar</h2><table class="calendar"><thead><tr><th>Date</th><th>Magic Kingdom</th><th>EPCOT</th><th>Hollywood Studios</th><th>Animal Kingdom</th></tr></thead><tbody><tr><td>Jun 12, 2027</td><td>7</td><td>5</td><td>6</td><td>4</td></tr><tr><td>Jun 13, 2027</td><td>8</td><td>—</td><td>6</td><td>4</td></tr></tbody></table></body></html>`
  const singleParkTable = `<table><tr><th>Day</th><th>Crowd level</th></tr><tr><td>2027-06-12</td><td>7</td></tr><tr><td>2027-06-13</td><td>8</td></tr></table>`
  const dataAttributes = `<div class="month"><div class="day" data-date="2027-06-12" data-park="Magic Kingdom" data-level="7"><span>12</span></div><div class="day" data-date="2027-06-12" data-park="mk" data-level="9"></div><div class="day" data-date="12" data-park="Epcot" data-crowd="40%"></div><div class="day" data-date="2027-06-12" data-park="Typhoon Lagoon" data-index="3"></div><div class="day" data-date="2027-06-12" data-level="6"></div></div>`

  it('Thrill Data: JSON in a script tag, the park named by the parent key, only the month asked for', () => {
    const got = parseThrillDataCrowd(thrillDataJson, '2027-06')
    expect(got.reason).toBeNull()
    expect(got.levels).toEqual([
      { date: '2027-06-12', park: 'magic_kingdom', level: 7 },
      { date: '2027-06-13', park: 'magic_kingdom', level: 9 },
      { date: '2027-06-12', park: 'epcot', level: 4 },
      { date: '2027-06-12', park: 'hollywood_studios', level: 6 },
      { date: '2027-06-12', park: 'animal_kingdom', level: 3 },
    ])
    expect(parseThrillDataCrowd(thrillDataJson, '2027-07').levels).toEqual([{ date: '2027-07-01', park: 'animal_kingdom', level: 2 }])
  })

  it('a chart series: {name, data: [{x, y}]} reads as a park and its days', () => {
    const chart = `<script>var series = [{"name":"Magic Kingdom","data":[{"x":"2027-06-12","y":7},{"x":"2027-06-13","y":8}]},{"name":"Universal","data":[{"x":"2027-06-12","y":5}]}];</script>`
    expect(parseCrowdPage(chart, '2027-06').levels).toEqual([
      { date: '2027-06-12', park: 'magic_kingdom', level: 7 },
      { date: '2027-06-13', park: 'magic_kingdom', level: 8 },
      { date: '2027-06-12', park: 'other', level: 5 },
    ])
  })

  it('application/json: a percent index scales to tens, a long date reads, the resort as a whole is "other"', () => {
    const got = parseCrowdPage(applicationJson, '2027-06')
    expect(got.levels).toEqual([
      { date: '2027-06-13', park: 'epcot', level: 9 },
      { date: '2027-06-14', park: 'animal_kingdom', level: 3 },
      { date: '2027-06-15', park: 'other', level: 6 },
    ])
  })

  it('Undercover Tourist: a table with a park per column; a dash is not a level', () => {
    const got = parseUndercoverTouristCrowd(table, '2027-06')
    expect(got.reason).toBeNull()
    expect(got.levels).toEqual([
      { date: '2027-06-12', park: 'magic_kingdom', level: 7 },
      { date: '2027-06-12', park: 'epcot', level: 5 },
      { date: '2027-06-12', park: 'hollywood_studios', level: 6 },
      { date: '2027-06-12', park: 'animal_kingdom', level: 4 },
      { date: '2027-06-13', park: 'magic_kingdom', level: 8 },
      { date: '2027-06-13', park: 'hollywood_studios', level: 6 },
      { date: '2027-06-13', park: 'animal_kingdom', level: 4 },
    ])
  })

  it('a two-column table with no park is the resort as a whole', () => {
    expect(parseCrowdPage(singleParkTable, '2027-06').levels).toEqual([
      { date: '2027-06-12', park: 'other', level: 7 },
      { date: '2027-06-13', park: 'other', level: 8 },
    ])
  })

  it('data attributes: first row per date and park wins, a bare day number reads for the month, a water park and no park are kept', () => {
    const got = parseCrowdPage(dataAttributes, '2027-06')
    expect(got.levels).toEqual([
      { date: '2027-06-12', park: 'magic_kingdom', level: 7 },
      { date: '2027-06-12', park: 'epcot', level: 4 },
      { date: '2027-06-12', park: 'water_park', level: 3 },
      { date: '2027-06-12', park: 'other', level: 6 },
    ])
  })

  it('garbage is nothing with a reason, never a throw', () => {
    for (const junk of ['', '   ', '<html><body>captive portal</body></html>', '{"nope":true}', '[1,2,3]', '<script>var x = function(){ return {a:1} }</script>', 'null']) {
      const got = parseThrillDataCrowd(junk, '2027-06')
      expect(got.levels).toEqual([])
      expect(got.reason).toBeTruthy()
    }
    expect(parseCrowdPage('<html>x</html>', '2027-06').reason).toBe('Nothing on the page read as a crowd calendar.')
    expect(parseCrowdPage(thrillDataJson, '2028-01').reason).toContain('none for 2028-01')
    expect(parseUndercoverTouristCrowd(`<script>[{"date":"2027-06-12","crowd_level":0},{"date":"2027-06-12","crowd_level":500}]</script>`, '2027-06').levels).toEqual([])
  })

  it('the pieces: dates as pages write them, levels as pages write them, park names', () => {
    expect(dateFromText('2027-06-12', null)).toBe('2027-06-12')
    expect(dateFromText('2027-06-12T00:00:00Z', null)).toBe('2027-06-12')
    expect(dateFromText('6/12/2027', null)).toBe('2027-06-12')
    expect(dateFromText('June 12, 2027', null)).toBe('2027-06-12')
    expect(dateFromText('Sat, Jun 12', '2027-06')).toBe('2027-06-12')
    expect(dateFromText('12', '2027-06')).toBe('2027-06-12')
    expect(dateFromText('12', null)).toBeNull()
    expect(dateFromText('2027-02-30', null)).toBeNull()
    expect(dateFromText('tomorrow', null)).toBeNull()
    expect([7, '7', 7.4, '70%', 85, 0, 101, 'x', null].map(levelFromValue)).toEqual([7, 7, 7, 7, 9, null, null, null, null])
    expect(['Magic Kingdom', 'EPCOT', "Disney's Hollywood Studios", 'DAK', 'Blizzard Beach', 'Walt Disney World', 'Universal'].map(parkFromText)).toEqual([
      'magic_kingdom',
      'epcot',
      'hollywood_studios',
      'animal_kingdom',
      'water_park',
      'other',
      null,
    ])
  })

  it('the sources, in order, each with its own page', () => {
    expect(CROWD_SOURCES.map((s) => s.key)).toEqual(['thrill_data', 'undercover_tourist'])
    expect(CROWD_SOURCES[0]!.url('wdw', '2027-06')).toBe('https://www.thrill-data.com/trip-planning/crowd-calendar/resort/wdw?month=2027-06&destination=wdw')
    expect(CROWD_SOURCES[1]!.url('wdw', '2027-06')).toBe('https://www.undercovertourist.com/orlando/crowd-calendar/?month=2027-06')
    expect(monthsOf(trip)).toEqual(['2027-06'])
    expect(monthsOf({ startDate: '2027-11-28', endDate: '2028-01-02' })).toEqual(['2027-11', '2027-12', '2028-01'])
  })
})

describe('reading the geocoder', () => {
  it('the first place, with its point and name; strings become numbers', () => {
    expect(parseNominatim([{ lat: '41.8781136', lon: '-87.6297982', display_name: 'Chicago, Cook County, Illinois, United States' }, { lat: '0', lon: '0' }])).toEqual({
      latitude: 41.8781136,
      longitude: -87.6297982,
      resolvedName: 'Chicago, Cook County, Illinois, United States',
    })
    expect(parseNominatim({ results: [{ lat: 41.9, lon: -87.6 }] })).toEqual({ latitude: 41.9, longitude: -87.6, resolvedName: '' })
  })

  it('nothing found, a point off the globe, or not a search result is nothing', () => {
    expect(parseNominatim([])).toBeNull()
    expect(parseNominatim([{ lat: '91', lon: '0' }])).toBeNull()
    expect(parseNominatim([{ lat: 'north', lon: 'west' }])).toBeNull()
    expect(parseNominatim([{ display_name: 'no point' }])).toBeNull()
    expect(parseNominatim('<html>blocked</html>')).toBeNull()
    expect(parseNominatim(null)).toBeNull()
  })

  it('asks for one result in jsonv2, with the address encoded', () => {
    expect(nominatimUrl(' 123 Main St, Springfield, IL ')).toBe('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=123%20Main%20St%2C%20Springfield%2C%20IL')
  })
})
