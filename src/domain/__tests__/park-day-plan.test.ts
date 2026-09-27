/**
 * Which park, which day (PRD §16, D32): the score is one documented formula
 * with plain constants, the assignment is greedy under "each park once
 * before any repeats", a day a person chose is kept and counted, a rest or
 * travel day is never given a park, and what the plan lacks is said in words.
 */

import { describe, expect, it } from 'vitest'
import {
  dayIsOpenToPlan,
  HEAT_EARLY_BONUS,
  HEAT_THRESHOLD_F,
  hourWords,
  LATE_CLOSE_BONUS,
  LATE_CLOSE_HOUR,
  MISSING_BUSYNESS,
  PARK_COVER,
  parkDayPlanDiff,
  planParkDays,
  RAIN_THRESHOLD_PERCENT,
  RAIN_WEIGHT,
  sameParkDayPlan,
  scoreParkDay,
  type ThemePark,
} from '../park-day-plan'
import type { CrowdLevel, TripDay, TripPark } from '../trip-plan'
import type { ParkHours, ParkWeather } from '../park-data'

const TODAY = '2026-09-26'
const PARKS: ThemePark[] = ['magic_kingdom', 'epcot', 'hollywood_studios', 'animal_kingdom']

const day = (date: string, park: TripPark = 'rest', parkChosen = false): TripDay => ({
  id: `day-${date}`,
  tripId: 'trip',
  date,
  park,
  plan: { notes: '', ropeDrop: false, parkChosen },
  sort: 0,
})

const level = (date: string, park: TripPark, value: number, source = 'typed'): CrowdLevel => ({ destination: 'wdw', date, park, level: value, source, fetchedOn: TODAY })

const weather = (date: string, highF: number, precipChance: number | null, horizon: ParkWeather['horizon'] = 'forecast'): ParkWeather => ({
  destination: 'wdw',
  date,
  highF,
  lowF: highF - 18,
  precipChance,
  horizon,
  source: 'open_meteo',
  fetchedOn: TODAY,
})

const hours = (date: string, park: TripPark, opens: string, closes: string): ParkHours => ({
  destination: 'wdw',
  park,
  date,
  opens,
  closes,
  earlyEntry: null,
  extendedEvening: null,
  source: 'themeparks_wiki',
  fetchedOn: TODAY,
})

/** Five park days of a week, every park at the same level unless a row for that date and park says otherwise. */
const week = ['2027-06-14', '2027-06-15', '2027-06-16', '2027-06-17', '2027-06-18']
const flat = (value: number, over: CrowdLevel[] = []) =>
  week.flatMap((d) => PARKS.map((p) => over.find((o) => o.date === d && o.park === p) ?? level(d, p, value)))

describe('the score for one park on one day', () => {
  const date = '2027-06-15'
  const plain = (park: ThemePark, busyness: number | null, extra: Partial<Parameters<typeof scoreParkDay>[0]> = {}) =>
    scoreParkDay({ date, park, busyness, weather: null, hours: [], ...extra })

  it('is the busyness level, lower better, and says so', () => {
    expect(plain('epcot', 3)).toMatchObject({ score: 3, available: true, reasons: ['how busy 3'], busyness: 3 })
    expect(plain('epcot', 7).score).toBeGreaterThan(plain('epcot', 3).score)
    for (let l = 1; l < 10; l += 1) expect(plain('epcot', l + 1).score).toBeGreaterThan(plain('epcot', l).score)
  })

  it('takes the middle of the scale when nothing is known, and says that too', () => {
    expect(plain('magic_kingdom', null)).toMatchObject({ score: MISSING_BUSYNESS, reasons: ['no busyness data'], busyness: null })
  })

  it('a wet day adds more to the parks with the least under cover', () => {
    const wet = { highF: 80, precipChance: RAIN_THRESHOLD_PERCENT }
    const ak = plain('animal_kingdom', 4, { weather: wet })
    const ep = plain('epcot', 4, { weather: wet })
    expect(ak.score).toBe(4 + (1 - PARK_COVER.animal_kingdom) * RAIN_WEIGHT)
    expect(ep.score).toBe(4 + (1 - PARK_COVER.epcot) * RAIN_WEIGHT)
    expect(ak.score).toBeGreaterThan(ep.score)
    expect(ak.reasons).toContain('50% rain, little cover')
    expect(ep.reasons).toContain('50% rain, mostly under cover')
    // Below the threshold, or no chance known, rain does not count.
    expect(plain('animal_kingdom', 4, { weather: { highF: 80, precipChance: RAIN_THRESHOLD_PERCENT - 1 } }).score).toBe(4)
    expect(plain('animal_kingdom', 4, { weather: { highF: 80, precipChance: null } }).score).toBe(4)
  })

  it('a hot day takes a little off the park that opens earliest, by the hours that day', () => {
    const hot = { highF: HEAT_THRESHOLD_F, precipChance: 10 }
    const open = [hours(date, 'animal_kingdom', '08:00', '19:00'), hours(date, 'magic_kingdom', '09:00', '20:00'), hours(date, 'epcot', '09:00', '20:00')]
    expect(plain('animal_kingdom', 5, { weather: hot, hours: open })).toMatchObject({ score: 5 - HEAT_EARLY_BONUS, reasons: ['how busy 5', '92°, opens earliest (8 am)'] })
    expect(plain('magic_kingdom', 5, { weather: hot, hours: open }).score).toBe(5)
    // A park with no hours row that day cannot claim the early start.
    expect(plain('hollywood_studios', 5, { weather: hot, hours: open }).score).toBe(5)
    // Not hot: nothing.
    expect(plain('animal_kingdom', 5, { weather: { highF: HEAT_THRESHOLD_F - 1, precipChance: 10 }, hours: open }).score).toBe(5)
  })

  it('a late close takes a little off', () => {
    const late = [hours(date, 'magic_kingdom', '09:00', `${LATE_CLOSE_HOUR}:00`), hours(date, 'epcot', '09:00', `${LATE_CLOSE_HOUR - 1}:30`)]
    expect(plain('magic_kingdom', 5, { hours: late })).toMatchObject({ score: 5 - LATE_CLOSE_BONUS, reasons: ['how busy 5', 'open till 9 pm'] })
    expect(plain('epcot', 5, { hours: late }).score).toBe(5)
  })

  it('a park whose hours say it is closed is unavailable', () => {
    const closed = plain('epcot', 2, { hours: [hours(date, 'epcot', '00:00', '00:00')] })
    expect(closed.available).toBe(false)
    expect(closed.reasons).toEqual(['closed that day'])
    expect(closed.score).toBe(Number.POSITIVE_INFINITY)
  })

  it('says the clock plainly', () => {
    expect(['21:00', '08:30', '00:00', '12:15'].map(hourWords)).toEqual(['9 pm', '8:30 am', '12 am', '12:15 pm'])
  })
})

describe('which days the plan may set', () => {
  it('a rest day or a park day nobody chose; never a travel day, a water park, somewhere else, a hand pick, or a day gone', () => {
    expect(dayIsOpenToPlan(day('2027-06-14', 'rest'), TODAY)).toBe(true)
    expect(dayIsOpenToPlan(day('2027-06-14', 'epcot'), TODAY)).toBe(true)
    expect(dayIsOpenToPlan(day('2027-06-14', 'travel'), TODAY)).toBe(false)
    expect(dayIsOpenToPlan(day('2027-06-14', 'water_park'), TODAY)).toBe(false)
    expect(dayIsOpenToPlan(day('2027-06-14', 'other'), TODAY)).toBe(false)
    expect(dayIsOpenToPlan(day('2027-06-14', 'rest', true), TODAY)).toBe(false)
    expect(dayIsOpenToPlan(day('2027-06-14', 'epcot', true), TODAY)).toBe(false)
    expect(dayIsOpenToPlan(day('2026-09-25', 'epcot'), TODAY)).toBe(false)
  })
})

describe('the plan for the trip', () => {
  const base = { weather: [] as ParkWeather[], hours: [] as ParkHours[], today: TODAY }

  it('gives each of the four parks once before any repeats, the quietest park to the earlier day on a tie', () => {
    const days = [day('2027-06-13', 'travel'), ...week.map((d) => day(d)), day('2027-06-19', 'travel')]
    const plan = planParkDays({ ...base, days, busyness: { crowdLevels: flat(5) } })
    expect(plan.assignments.map((a) => a.date)).toEqual(week)
    const parks = plan.assignments.map((a) => a.park)
    expect(new Set(parks.slice(0, 4)).size).toBe(4)
    expect(PARKS).toContain(parks[4])
    expect(plan.assignments.every((a) => a.current === 'rest')).toBe(true)
    expect(plan.unchanged).toEqual([])
    expect(plan.summary).toMatch(/^5 days planned: /)
    // Every level was 5, so every park is the quietest that day.
    expect(plan.assignments[0]!.reasons).toEqual(['quietest that day (5)'])
  })

  it('sends the quietest park to each day, and the earlier day gets the quieter of two equal fits', () => {
    const levels = flat(6, [level('2027-06-14', 'epcot', 2), level('2027-06-15', 'epcot', 2), level('2027-06-16', 'animal_kingdom', 3)])
    const plan = planParkDays({ ...base, days: week.map((d) => day(d)), busyness: { crowdLevels: levels } })
    const byDate = Object.fromEntries(plan.assignments.map((a) => [a.date, a.park]))
    // EPCOT is a 2 on both the 14th and the 15th; it goes to the 14th, and the 15th takes the next best.
    expect(byDate['2027-06-14']).toBe('epcot')
    expect(byDate['2027-06-15']).not.toBe('epcot')
    expect(byDate['2027-06-16']).toBe('animal_kingdom')
    expect(plan.assignments.find((a) => a.date === '2027-06-14')!.reasons).toEqual(['quietest that day (2)'])
  })

  it('a wet day moves the plan to the parks with the most under cover', () => {
    const levels = flat(5)
    const dry = planParkDays({ ...base, days: week.slice(0, 4).map((d) => day(d)), busyness: { crowdLevels: levels } })
    const wet = planParkDays({
      ...base,
      days: week.slice(0, 4).map((d) => day(d)),
      busyness: { crowdLevels: levels },
      weather: [weather('2027-06-14', 85, 80), weather('2027-06-15', 85, 0), weather('2027-06-16', 85, 0), weather('2027-06-17', 85, 0)],
    })
    const first = (p: ReturnType<typeof planParkDays>) => p.assignments.find((a) => a.date === '2027-06-14')!
    expect(['epcot', 'hollywood_studios']).toContain(first(wet).park)
    expect(first(wet).reasons).toContain('80% rain, mostly under cover')
    // Animal Kingdom, with the least cover, is pushed off the wet day and lands on a dry one.
    expect(wet.assignments.find((a) => a.park === 'animal_kingdom')!.date).not.toBe('2027-06-14')
    expect(dry.assignments.find((a) => a.date === '2027-06-14')!.reasons).toEqual(['quietest that day (5)'])
  })

  it('a hot day sends the earliest start to the park that opens earliest', () => {
    const open = week.flatMap((d) => [
      hours(d, 'magic_kingdom', '09:00', '22:00'),
      hours(d, 'epcot', '09:00', '21:00'),
      hours(d, 'hollywood_studios', '09:00', '20:00'),
      hours(d, 'animal_kingdom', '08:00', '19:00'),
    ])
    const plan = planParkDays({
      ...base,
      days: week.slice(0, 4).map((d) => day(d)),
      busyness: { crowdLevels: flat(5) },
      hours: open,
      weather: [weather('2027-06-16', 96, 10), ...['2027-06-14', '2027-06-15', '2027-06-17'].map((d) => weather(d, 85, 10))],
    })
    const hot = plan.assignments.find((a) => a.date === '2027-06-16')!
    expect(hot.park).toBe('animal_kingdom')
    expect(hot.reasons).toContain('96°, opens earliest (8 am)')
  })

  it('a late close claims the evening', () => {
    const open = [hours('2027-06-14', 'magic_kingdom', '09:00', '23:00'), hours('2027-06-14', 'epcot', '09:00', '21:00'), hours('2027-06-14', 'hollywood_studios', '09:00', '20:00'), hours('2027-06-14', 'animal_kingdom', '09:00', '19:00')]
    const plan = planParkDays({ ...base, days: [day('2027-06-14')], busyness: { crowdLevels: flat(5) }, hours: open })
    expect(plan.assignments[0]).toMatchObject({ park: 'magic_kingdom', score: 5 - LATE_CLOSE_BONUS })
    expect(plan.assignments[0]!.reasons).toEqual(['quietest that day (5)', 'open till 11 pm'])
    // The bonus is the same for every late park; the busier one still loses.
    const busyMk = planParkDays({ ...base, days: [day('2027-06-14')], busyness: { crowdLevels: flat(5, [level('2027-06-14', 'magic_kingdom', 7)]) }, hours: open })
    expect(busyMk.assignments[0]!.park).toBe('epcot')
  })

  it('keeps a day a person chose, counts it toward each-park-once, and plans around it', () => {
    const days = [day('2027-06-14', 'epcot', true), day('2027-06-15'), day('2027-06-16'), day('2027-06-17'), day('2027-06-18', 'rest', true)]
    const levels = flat(5, [level('2027-06-15', 'epcot', 1), level('2027-06-16', 'epcot', 1), level('2027-06-17', 'epcot', 1)])
    const plan = planParkDays({ ...base, days, busyness: { crowdLevels: levels } })
    expect(plan.unchanged).toEqual([
      { dayId: 'day-2027-06-14', date: '2027-06-14', park: 'epcot' },
      { dayId: 'day-2027-06-18', date: '2027-06-18', park: 'rest' },
    ])
    expect(plan.assignments.map((a) => a.date)).toEqual(['2027-06-15', '2027-06-16', '2027-06-17'])
    // EPCOT is the quietest every remaining day, but the hand-picked EPCOT day has used it; the other three parks come first.
    expect(new Set(plan.assignments.map((a) => a.park))).toEqual(new Set(['magic_kingdom', 'hollywood_studios', 'animal_kingdom']))
    expect(plan.summary).toBe('3 days planned: Magic Kingdom, Hollywood Studios, Animal Kingdom · 2 days are your pick')
  })

  it('never gives a travel day, a water-park day, "somewhere else", or a day gone a park', () => {
    const days = [day('2026-09-20', 'rest'), day('2027-06-13', 'travel'), day('2027-06-14', 'water_park'), day('2027-06-15', 'other'), day('2027-06-16', 'rest')]
    const plan = planParkDays({ ...base, days, busyness: { crowdLevels: flat(5) } })
    expect(plan.assignments.map((a) => a.date)).toEqual(['2027-06-16'])
    expect(plan.unchanged).toEqual([])
  })

  it('a park day nobody chose may be moved, and a day already right is listed with no change', () => {
    const days = [day('2027-06-14', 'animal_kingdom'), day('2027-06-15', 'epcot')]
    const levels = flat(5, [level('2027-06-14', 'epcot', 1), level('2027-06-15', 'animal_kingdom', 1)])
    const plan = planParkDays({ ...base, days, busyness: { crowdLevels: levels } })
    expect(plan.assignments.map((a) => [a.date, a.current, a.park])).toEqual([
      ['2027-06-14', 'animal_kingdom', 'epcot'],
      ['2027-06-15', 'epcot', 'animal_kingdom'],
    ])
    expect(parkDayPlanDiff(days, plan.assignments)).toEqual([
      { dayId: 'day-2027-06-14', date: '2027-06-14', from: 'animal_kingdom', to: 'epcot' },
      { dayId: 'day-2027-06-15', date: '2027-06-15', from: 'epcot', to: 'animal_kingdom' },
    ])
    expect(parkDayPlanDiff(days, [{ dayId: 'day-2027-06-14', park: 'animal_kingdom' }, { dayId: 'nobody', park: 'epcot' }])).toEqual([])
  })

  it('says what it had to do without, and uses the middle of the scale', () => {
    const plan = planParkDays({ ...base, days: [day('2027-06-14'), day('2027-06-15')], busyness: { crowdLevels: [level('2027-06-15', 'epcot', 3)] } })
    expect(plan.missing).toEqual({ busyness: ['2027-06-14'], weather: ['2027-06-14', '2027-06-15'], hours: ['2027-06-14', '2027-06-15'] })
    const blind = plan.assignments.find((a) => a.date === '2027-06-14')!
    expect(blind).toMatchObject({ score: MISSING_BUSYNESS, busyness: null, reasons: ['no busyness data'] })
    // The one park with a level that day is the quietest by the only figure there is.
    expect(plan.assignments.find((a) => a.date === '2027-06-15')).toMatchObject({ park: 'epcot', reasons: ['quietest that day (3)'] })
  })

  it('a day with every park closed is left unplanned and said', () => {
    const closed = PARKS.map((p) => hours('2027-06-14', p, '00:00', '00:00'))
    const plan = planParkDays({ ...base, days: [day('2027-06-14'), day('2027-06-15')], busyness: { crowdLevels: flat(5) }, hours: closed })
    expect(plan.assignments.map((a) => a.date)).toEqual(['2027-06-15'])
    expect(plan.unplanned).toEqual([{ dayId: 'day-2027-06-14', date: '2027-06-14', reason: 'every park is closed that day' }])
    expect(plan.summary).toContain('1 day has no park open')
  })

  it('the once-rule gives way when only an already-used park is open that day', () => {
    // Two days; on the 15th only EPCOT is open, and EPCOT is the quietest on the 14th too.
    const open = [hours('2027-06-15', 'epcot', '09:00', '21:00'), ...(['magic_kingdom', 'hollywood_studios', 'animal_kingdom'] as ThemePark[]).map((p) => hours('2027-06-15', p, '00:00', '00:00'))]
    const plan = planParkDays({ ...base, days: [day('2027-06-14'), day('2027-06-15')], busyness: { crowdLevels: flat(5, [level('2027-06-14', 'epcot', 1)]) }, hours: open })
    expect(plan.assignments.map((a) => [a.date, a.park])).toEqual([
      ['2027-06-14', 'epcot'],
      ['2027-06-15', 'epcot'],
    ])
  })

  it('the weather for a date is blended by horizon, the forecast first', () => {
    const rows = [weather('2027-06-14', 85, 90, 'normal'), weather('2027-06-14', 85, 0, 'forecast')]
    const plan = planParkDays({ ...base, days: [day('2027-06-14')], busyness: { crowdLevels: flat(5) }, weather: rows })
    expect(plan.assignments[0]!.reasons).toEqual(['quietest that day (5)'])
    expect(plan.missing.weather).toEqual([])
  })

  it('a fortnight of park days balances the four parks, no park a second time before every park once', () => {
    const dates = Array.from({ length: 14 }, (_, i) => `2027-06-${String(14 + i).padStart(2, '0')}`)
    const levels = dates.flatMap((d, i) => PARKS.map((p, k) => level(d, p, 1 + ((i * 3 + k * 2) % 9))))
    const started = Date.now()
    const plan = planParkDays({ ...base, days: dates.map((d) => day(d)), busyness: { crowdLevels: levels } })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(plan.assignments).toHaveLength(14)
    const counts = new Map<ThemePark, number>()
    for (const a of plan.assignments) {
      // Before this day, no park may have been used less than the one taken now.
      const fewest = Math.min(...PARKS.map((p) => counts.get(p) ?? 0))
      expect(counts.get(a.park) ?? 0).toBe(fewest)
      counts.set(a.park, (counts.get(a.park) ?? 0) + 1)
    }
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1)
  })

  it('two proposals are the same when they set the same park on the same days, whatever the order', () => {
    const a = [{ dayId: 'x', park: 'epcot' as const }, { dayId: 'y', park: 'magic_kingdom' as const }]
    expect(sameParkDayPlan(a, [a[1]!, a[0]!])).toBe(true)
    expect(sameParkDayPlan(a, [a[0]!])).toBe(false)
    expect(sameParkDayPlan(a, [a[0]!, { dayId: 'y', park: 'epcot' }])).toBe(false)
  })
})
