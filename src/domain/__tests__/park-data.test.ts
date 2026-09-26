/**
 * Ballast's own park data (PRD §16, D28-D29): the parsers on fixtures
 * written from each service's documented shape (none is reachable from the
 * sandbox), the weather blend by horizon, the normals averaging, the wait
 * history ranked to 1-10 against a known distribution, busynessFor's tiers,
 * and a month laid out as cells with a day that has nothing at all.
 */

import { describe, expect, it } from 'vitest'
import {
  blendWeather,
  busynessFor,
  busynessStep,
  calendarMonth,
  clockOf,
  dataAge,
  earliestClose,
  indexWaitHistory,
  monthBounds,
  normalsForDates,
  normalsFromArchive,
  parseOpenMeteoDaily,
  parseOpenMeteoSeasonal,
  parseQueueTimesParks,
  parseQueueTimesWaits,
  parseRopeDropOutlook,
  parseThemeParksChildren,
  parseThemeParksSchedule,
  shiftMonth,
  summariseWaits,
  waitHistoryToBusyness,
  type CrowdLevel,
  type ParkHours,
  type ParkWeather,
  type WaitDaySummary,
  type WaitObservation,
} from '@/domain'

const TODAY = '2026-09-26'

const weather = (date: string, horizon: ParkWeather['horizon'], highF: number, lowF: number, fetchedOn = TODAY, precipChance: number | null = null): ParkWeather => ({
  destination: 'wdw',
  date,
  highF,
  lowF,
  precipChance,
  horizon,
  source: 'open_meteo',
  fetchedOn,
})

const crowd = (date: string, park: CrowdLevel['park'], level: number, source = 'thrill_data', fetchedOn = TODAY): CrowdLevel => ({ destination: 'wdw', date, park, level, source, fetchedOn })

describe('the weather', () => {
  it('reads the Open-Meteo daily block to whole degrees and a whole percent, skipping a day with a null', () => {
    const json = {
      latitude: 28.375,
      daily_units: { temperature_2m_max: '°F' },
      daily: {
        time: ['2026-09-27', '2026-09-28', '2026-09-29'],
        temperature_2m_max: [91.4, null, 88.6],
        temperature_2m_min: [74.5, 73, 90.2],
        precipitation_probability_max: [45, 60, null],
        weather_code: [80, 95, 3],
      },
    }
    expect(parseOpenMeteoDaily(json)).toEqual({
      rows: [
        { date: '2026-09-27', highF: 91, lowF: 75, precipChance: 45 },
        // A low above the high is clamped to the high, not refused.
        { date: '2026-09-29', highF: 89, lowF: 89, precipChance: null },
      ],
      reason: null,
    })
    expect(parseOpenMeteoDaily({ error: true, reason: 'Latitude must be in range' }).reason).toContain('refused')
    expect(parseOpenMeteoDaily('<html>captive portal</html>').rows).toEqual([])
    expect(parseOpenMeteoDaily({ daily: { time: ['2026-09-27'], temperature_2m_max: [999], temperature_2m_min: [70] } })).toEqual({ rows: [], reason: 'The daily block had no readable days.' })
  })

  it('reads the seasonal endpoint by averaging the ensemble members, and a plain series when that is what came', () => {
    const members = {
      daily: {
        time: ['2026-10-10', '2026-10-11'],
        temperature_2m_max_member01: [84, 86],
        temperature_2m_max_member02: [88, null],
        temperature_2m_max_member03: [86, 90],
        temperature_2m_min_member01: [66, 70],
        temperature_2m_min_member02: [70, 68],
        temperature_2m_min_member03: [68, 72],
      },
    }
    expect(parseOpenMeteoSeasonal(members)).toEqual({
      rows: [
        { date: '2026-10-10', highF: 86, lowF: 68, precipChance: null },
        { date: '2026-10-11', highF: 88, lowF: 70, precipChance: null },
      ],
      reason: null,
    })
    const plain = { daily: { time: ['2026-10-10'], temperature_2m_max: [84.4], temperature_2m_min: [66.6] } }
    expect(parseOpenMeteoSeasonal(plain).rows).toEqual([{ date: '2026-10-10', highF: 84, lowF: 67, precipChance: null }])
    expect(parseOpenMeteoSeasonal({ daily: { time: ['2026-10-10'], humidity: [1] } }).reason).toContain('no temperature series')
    expect(parseOpenMeteoSeasonal([]).rows).toEqual([])
  })

  it('averages the archive per month-day and lays the typical figures over a stretch of dates', () => {
    const rows = [
      { date: '2016-06-14', highF: 90, lowF: 72, precipChance: null },
      { date: '2017-06-14', highF: 92, lowF: 74, precipChance: null },
      { date: '2018-06-14', highF: 95, lowF: 75, precipChance: null },
      { date: '2016-02-29', highF: 70, lowF: 50, precipChance: null },
    ]
    const normals = normalsFromArchive(rows)
    expect(normals.get('06-14')).toEqual({ highF: 92, lowF: 74, years: 3 }) // 92.33 -> 92, 73.67 -> 74
    expect(normals.get('02-29')).toEqual({ highF: 70, lowF: 50, years: 1 })
    expect(normalsForDates(normals, '2027-06-13', '2027-06-15')).toEqual([{ date: '2027-06-14', highF: 92, lowF: 74, precipChance: null }])
    // A non-leap year has no February 29th to ask for; a leap year's is answered.
    expect(normalsForDates(normals, '2028-02-28', '2028-03-01').map((r) => r.date)).toEqual(['2028-02-29'])
  })

  it('blends by horizon: the forecast first, then the seasonal outlook, then typical, each marked', () => {
    const forecast = [weather('2026-10-01', 'forecast', 90, 74, TODAY, 40)]
    const subseasonal = [weather('2026-10-01', 'subseasonal', 87, 70), weather('2026-10-20', 'subseasonal', 84, 66, '2026-09-20'), weather('2026-10-20', 'subseasonal', 85, 67, '2026-09-25')]
    const normals = [weather('2026-10-01', 'normal', 88, 71), weather('2026-10-20', 'normal', 85, 68), weather('2026-12-01', 'normal', 74, 55)]
    expect(blendWeather({ forecast, subseasonal, normals, date: '2026-10-01' })).toMatchObject({ highF: 90, lowF: 74, precipChance: 40, horizon: 'forecast' })
    // The newer of two rows on the same horizon wins.
    expect(blendWeather({ forecast, subseasonal, normals, date: '2026-10-20' })).toMatchObject({ highF: 85, lowF: 67, horizon: 'subseasonal', fetchedOn: '2026-09-25' })
    expect(blendWeather({ forecast, subseasonal, normals, date: '2026-12-01' })).toMatchObject({ highF: 74, horizon: 'normal' })
    expect(blendWeather({ forecast, subseasonal, normals, date: '2027-03-01' })).toBeNull()
    // A row filed under the wrong horizon list is not believed.
    expect(blendWeather({ forecast: normals, subseasonal: [], normals: [], date: '2026-12-01' })).toBeNull()
  })
})

describe('park hours', () => {
  const children = {
    id: 'e957da41-3552-4cf6-b636-5babc5cbc4e5',
    children: [
      { id: '75ea578a-adc8-4116-a54d-dccb60765ef9', name: 'Magic Kingdom Park', entityType: 'PARK' },
      { id: '47f90d2c-e191-4239-a466-5892ef59a88b', name: 'EPCOT', entityType: 'PARK' },
      { id: '288747d1-8b4f-4a64-867e-ea7c9b27bad8', name: "Disney's Hollywood Studios", entityType: 'PARK' },
      { id: '1c84a229-8862-4648-9c71-378ddd2c7693', name: "Disney's Animal Kingdom Theme Park", entityType: 'PARK' },
      { id: 'b070cbc5-feaa-4b87-a8c1-f94cca037a18', name: "Disney's Typhoon Lagoon Water Park", entityType: 'PARK' },
      { id: 'ride-1', name: 'Space Mountain', entityType: 'ATTRACTION' },
      { id: 'hotel-1', name: "Disney's Contemporary Resort", entityType: 'HOTEL' },
    ],
  }

  it('finds the four parks among the destination children by name, and says which are missing', () => {
    const got = parseThemeParksChildren(children)
    expect(got.rows).toEqual([
      { park: 'magic_kingdom', id: '75ea578a-adc8-4116-a54d-dccb60765ef9', name: 'Magic Kingdom Park' },
      { park: 'epcot', id: '47f90d2c-e191-4239-a466-5892ef59a88b', name: 'EPCOT' },
      { park: 'hollywood_studios', id: '288747d1-8b4f-4a64-867e-ea7c9b27bad8', name: "Disney's Hollywood Studios" },
      { park: 'animal_kingdom', id: '1c84a229-8862-4648-9c71-378ddd2c7693', name: "Disney's Animal Kingdom Theme Park" },
    ])
    expect(got.missing).toEqual([])
    const partial = parseThemeParksChildren({ children: children.children.slice(0, 2) })
    expect(partial.rows).toHaveLength(2)
    expect(partial.missing).toEqual(['hollywood_studios', 'animal_kingdom'])
    expect(parseThemeParksChildren({ message: 'not found' })).toMatchObject({ rows: [], missing: ['magic_kingdom', 'epcot', 'hollywood_studios', 'animal_kingdom'] })
    expect(parseThemeParksChildren(null).reason).toBeTruthy()
  })

  it("reads a park's schedule on the park's own clock, with early entry and extended evening", () => {
    const json = {
      id: '75ea578a-adc8-4116-a54d-dccb60765ef9',
      schedule: [
        { date: '2026-10-01', type: 'OPERATING', openingTime: '2026-10-01T09:00:00-04:00', closingTime: '2026-10-01T22:00:00-04:00' },
        { date: '2026-10-01', type: 'EXTRA_HOURS', description: 'Early Entry', openingTime: '2026-10-01T08:30:00-04:00', closingTime: '2026-10-01T09:00:00-04:00' },
        { date: '2026-10-01', type: 'EXTRA_HOURS', description: 'Extended Evening Hours', openingTime: '2026-10-01T22:00:00-04:00', closingTime: '2026-10-02T00:00:00-04:00' },
        { date: '2026-10-01', type: 'TICKETED_EVENT', description: "Mickey's Not-So-Scary Halloween Party", openingTime: '2026-10-01T19:00:00-04:00', closingTime: '2026-10-02T00:00:00-04:00' },
        { date: '2026-10-02', type: 'OPERATING', openingTime: '2026-10-02T09:00:00-04:00', closingTime: '2026-10-02T18:00:00-04:00' },
        { date: '2026-10-03', type: 'INFO', description: 'Fireworks at 9' },
      ],
    }
    expect(parseThemeParksSchedule(json)).toEqual({
      rows: [
        { date: '2026-10-01', opens: '09:00', closes: '22:00', earlyEntry: '08:30', extendedEvening: '00:00' },
        { date: '2026-10-02', opens: '09:00', closes: '18:00', earlyEntry: null, extendedEvening: null },
      ],
      reason: null,
    })
    expect(parseThemeParksSchedule({ schedule: [] }).reason).toContain('no operating days')
    expect(parseThemeParksSchedule('nope').rows).toEqual([])
    expect(clockOf('2026-10-01T09:05:00-04:00')).toBe('09:05')
    expect(clockOf('9am')).toBeNull()
  })

  it('finds the earliest close among the theme parks that day', () => {
    const hours: ParkHours[] = [
      { destination: 'wdw', park: 'magic_kingdom', date: '2026-10-01', opens: '09:00', closes: '22:00', earlyEntry: null, extendedEvening: '00:00', source: 't', fetchedOn: TODAY },
      { destination: 'wdw', park: 'animal_kingdom', date: '2026-10-01', opens: '08:00', closes: '19:00', earlyEntry: null, extendedEvening: null, source: 't', fetchedOn: TODAY },
      { destination: 'wdw', park: 'epcot', date: '2026-10-02', opens: '09:00', closes: '21:00', earlyEntry: null, extendedEvening: null, source: 't', fetchedOn: TODAY },
    ]
    expect(earliestClose(hours, '2026-10-01')).toEqual({ park: 'animal_kingdom', closes: '19:00' })
    expect(earliestClose(hours, '2026-10-03')).toBeNull()
  })
})

describe('the crowd outlook', () => {
  it('reads any JSON carrying per-date, per-park levels, scaling percents and predicted waits to tens', () => {
    const json = {
      resort: 'Walt Disney World',
      parks: [
        { name: 'Magic Kingdom', days: [{ date: '2027-06-12', crowd_level: 7 }, { date: '2027-06-13', crowd_level: 4 }] },
        { name: 'EPCOT', days: [{ date: '2027-06-12', crowd_level: 55 }] },
      ],
      overall: [{ date: '2027-06-12', predicted_wait: 62 }],
    }
    const got = parseRopeDropOutlook(json)
    expect(got.reason).toBeNull()
    expect(got.rows).toEqual([
      { date: '2027-06-12', park: 'magic_kingdom', level: 7 },
      { date: '2027-06-13', park: 'magic_kingdom', level: 4 },
      { date: '2027-06-12', park: 'epcot', level: 6 },
      { date: '2027-06-12', park: 'other', level: 7 },
    ])
    expect(parseRopeDropOutlook({ status: 'ok', items: [] })).toEqual({ rows: [], reason: 'Nothing in the outlook read as a crowd level by date.' })
    expect(parseRopeDropOutlook('<html>').rows).toEqual([])
  })
})

describe('live waits', () => {
  const parks = [
    { id: 1, name: 'Six Flags Group', parks: [{ id: 5, name: 'Six Flags Magic Mountain' }] },
    {
      id: 16,
      name: 'Walt Disney World',
      parks: [
        { id: 6, name: 'Magic Kingdom', country: 'United States', latitude: '28.417663' },
        { id: 5, name: 'Epcot' },
        { id: 7, name: "Disney's Hollywood Studios" },
        { id: 8, name: "Disney's Animal Kingdom" },
      ],
    },
  ]

  it('finds the four parks by the names set under the named group, and names what is missing', () => {
    const got = parseQueueTimesParks(parks)
    expect(got.rows).toEqual([
      { park: 'magic_kingdom', id: '6', name: 'Magic Kingdom' },
      { park: 'epcot', id: '5', name: 'Epcot' },
      { park: 'hollywood_studios', id: '7', name: "Disney's Hollywood Studios" },
      { park: 'animal_kingdom', id: '8', name: "Disney's Animal Kingdom" },
    ])
    expect(got.missing).toEqual([])
    const renamed = parseQueueTimesParks(parks, { magic_kingdom: 'Magic Kingdom', epcot: 'EPCOT Center' })
    expect(renamed.rows.map((r) => r.park)).toEqual(['magic_kingdom'])
    expect(renamed.missing).toEqual(['EPCOT Center'])
    expect(parseQueueTimesParks({ error: 'down' }).reason).toBeTruthy()
    expect(parseQueueTimesParks(parks, undefined, 'Universal').rows).toEqual([])
  })

  it("reads a park's rides at the top level and under lands, with the feed's own timestamp", () => {
    const json = {
      lands: [
        {
          id: 1,
          name: 'Tomorrowland',
          rides: [
            { id: 101, name: 'Space Mountain', is_open: true, wait_time: 45, last_updated: '2026-09-26T14:05:12.000Z' },
            { id: 102, name: 'Tomorrowland Speedway', is_open: false, wait_time: 0, last_updated: '2026-09-26T14:05:12.000Z' },
          ],
        },
      ],
      rides: [{ id: 201, name: 'Main Street Vehicles', is_open: true, wait_time: '5', last_updated: '2026-09-26T14:00:00.000Z' }, { id: 202, name: 'No time' }],
    }
    const got = parseQueueTimesWaits(json, { parkId: '6', parkName: 'Magic Kingdom' })
    expect(got.reason).toBeNull()
    expect(got.rows).toEqual([
      { source: 'queue_times', parkId: '6', parkName: 'Magic Kingdom', rideId: '201', rideName: 'Main Street Vehicles', isOpen: true, waitMinutes: 5, observedAt: '2026-09-26T14:00:00.000Z' },
      { source: 'queue_times', parkId: '6', parkName: 'Magic Kingdom', rideId: '101', rideName: 'Space Mountain', isOpen: true, waitMinutes: 45, observedAt: '2026-09-26T14:05:12.000Z' },
      { source: 'queue_times', parkId: '6', parkName: 'Magic Kingdom', rideId: '102', rideName: 'Tomorrowland Speedway', isOpen: false, waitMinutes: null, observedAt: '2026-09-26T14:05:12.000Z' },
    ])
    expect(parseQueueTimesWaits({ lands: [] }, { parkId: '6', parkName: 'Magic Kingdom' }).reason).toContain('no rides')
    expect(parseQueueTimesWaits(null, { parkId: '6', parkName: 'Magic Kingdom' }).rows).toEqual([])
  })

  const observation = (date: string, minutes: number | null, ride = 'r1', park = 'Magic Kingdom', isOpen = minutes !== null): WaitObservation => ({
    source: 'queue_times',
    parkId: '6',
    parkName: park,
    rideId: ride,
    rideName: ride,
    isOpen,
    waitMinutes: minutes,
    observedAt: `${date}T15:00:00.000Z`,
  })

  it('sums a day up as the mean posted wait across open rides, on the park clock', () => {
    const obs = [
      observation('2026-06-14', 40, 'r1'),
      observation('2026-06-14', 20, 'r2'),
      observation('2026-06-14', null, 'r3'),
      { ...observation('2026-06-14', 60, 'r1'), observedAt: '2026-06-15T02:30:00.000Z' }, // 10:30 pm on the 14th at the park
      observation('2026-06-15', 10, 'r1', 'Epcot'),
    ]
    expect(summariseWaits(obs)).toEqual([
      { parkName: 'Epcot', date: '2026-06-15', meanWaitMinutes: 10, observations: 1 },
      { parkName: 'Magic Kingdom', date: '2026-06-14', meanWaitMinutes: 40, observations: 3 },
    ])
  })

  it('ranks month-days across the year into tens, averaging the same date across years, and needs enough history', () => {
    // 20 month-days, means 10, 20, ..., 200: percentile rank in tens.
    const summaries: WaitDaySummary[] = []
    for (let i = 1; i <= 20; i += 1) summaries.push({ parkName: 'Magic Kingdom', date: `2025-03-${String(i).padStart(2, '0')}`, meanWaitMinutes: 10 * i, observations: 100 })
    // The same date a year on, twice as busy: the month-day's mean is the average of the two years.
    summaries.push({ parkName: 'Magic Kingdom', date: '2026-03-01', meanWaitMinutes: 30, observations: 100 })
    const index = indexWaitHistory(summaries)
    const mk = index.get('Magic Kingdom')!
    expect(mk.get('03-01')).toEqual({ level: 1, meanWaitMinutes: 20 }) // (10 + 30) / 2 = 20, the second lowest: 2 of 20 -> ceil(1) = 1
    expect(mk.get('03-02')).toEqual({ level: 1, meanWaitMinutes: 20 }) // tied with 03-01 at 20: same rank
    expect(mk.get('03-03')).toEqual({ level: 2, meanWaitMinutes: 30 }) // 3 of 20 -> ceil(1.5) = 2
    expect(mk.get('03-10')).toEqual({ level: 5, meanWaitMinutes: 100 })
    expect(mk.get('03-20')).toEqual({ level: 10, meanWaitMinutes: 200 })
    expect(mk.get('03-11')?.level).toBe(6)
    // A park with fewer month-days than the floor answers nothing.
    expect(indexWaitHistory(summaries.slice(0, 5)).has('Magic Kingdom')).toBe(false)
    expect(indexWaitHistory(summaries.slice(0, 5), 3).get('Magic Kingdom')?.get('03-05')?.level).toBe(10)
  })

  it('answers a date and a park from raw observations, whatever the year asked about', () => {
    const obs: WaitObservation[] = []
    for (let i = 1; i <= 20; i += 1) obs.push(observation(`2025-03-${String(i).padStart(2, '0')}`, 10 * i))
    expect(waitHistoryToBusyness(obs, { date: '2027-03-20', park: 'magic_kingdom' })).toEqual({ level: 10, source: 'wait_history', detail: 'Magic Kingdom: 200 min average wait on this date', fetchedOn: null })
    expect(waitHistoryToBusyness(obs, { date: '2027-03-20', park: 'epcot' })).toBeNull()
    expect(waitHistoryToBusyness(obs, { date: '2027-04-01', park: 'magic_kingdom' })).toBeNull()
    expect(waitHistoryToBusyness(obs, { date: '2027-03-20', park: 'magic_kingdom', parkNames: { magic_kingdom: 'Kingdom of Magic' } })).toBeNull()
  })
})

describe('how busy, in order', () => {
  const summaries: WaitDaySummary[] = []
  for (let i = 1; i <= 20; i += 1) summaries.push({ parkName: 'Magic Kingdom', date: `2025-06-${String(i).padStart(2, '0')}`, meanWaitMinutes: 10 * i, observations: 50 })
  const waitHistory = indexWaitHistory(summaries)
  const date = '2027-06-20'

  it('a typed level first, then the outlook, then the wait history, then a crowd calendar, then nothing', () => {
    const typed = crowd(date, 'magic_kingdom', 2, 'typed')
    const outlook = crowd(date, 'magic_kingdom', 8, 'ropedrop')
    const calendar = crowd(date, 'magic_kingdom', 5, 'thrill_data', '2026-09-01')
    expect(busynessFor({ date, park: 'magic_kingdom', crowdLevels: [typed, outlook, calendar], waitHistory })).toMatchObject({ level: 2, source: 'typed', detail: 'typed' })
    expect(busynessFor({ date, park: 'magic_kingdom', crowdLevels: [outlook, calendar], waitHistory })).toMatchObject({ level: 8, source: 'outlook', detail: 'ropedrop', fetchedOn: TODAY })
    expect(busynessFor({ date, park: 'magic_kingdom', crowdLevels: [calendar], waitHistory, waitHistoryAsOf: '2026-09-20' })).toMatchObject({ level: 10, source: 'wait_history', fetchedOn: '2026-09-20' })
    expect(busynessFor({ date, park: 'magic_kingdom', crowdLevels: [calendar] })).toMatchObject({ level: 5, source: 'crowd_level', detail: 'thrill_data', fetchedOn: '2026-09-01' })
    expect(busynessFor({ date, park: 'magic_kingdom' })).toBeNull()
    // The outlook can be handed apart from the crowd levels.
    expect(busynessFor({ date, park: 'magic_kingdom', outlook: [outlook] })?.source).toBe('outlook')
  })

  it('the resort as a whole: a resort-wide figure a tier has, else the mean of the parks that tier has', () => {
    const levels = [crowd(date, 'magic_kingdom', 8, 'ropedrop'), crowd(date, 'epcot', 4, 'ropedrop'), crowd(date, 'other', 3, 'thrill_data')]
    // The outlook has two parks and no resort-wide figure: their mean, before the calendar's resort figure is asked.
    expect(busynessFor({ date, park: 'other', crowdLevels: levels })).toMatchObject({ level: 6, source: 'outlook', detail: '2 of 4 parks' })
    expect(busynessFor({ date, park: 'rest', crowdLevels: [crowd(date, 'other', 3, 'thrill_data')] })).toMatchObject({ level: 3, source: 'crowd_level' })
    expect(busynessFor({ date, park: 'other', crowdLevels: [], waitHistory })).toMatchObject({ level: 10, source: 'wait_history', detail: '1 of 4 parks' })
  })

  it('maps a level to one of five colour steps', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(busynessStep)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
    expect(busynessStep(6.4)).toBe(3)
    expect(busynessStep(0)).toBe(1)
  })
})

describe('the calendar', () => {
  it('lays a month out Sunday first with padding, and each cell carries its weather, busyness, close, and marks', () => {
    const hours: ParkHours[] = [
      { destination: 'wdw', park: 'magic_kingdom', date: '2026-10-12', opens: '09:00', closes: '22:00', earlyEntry: '08:30', extendedEvening: null, source: 'themeparks_wiki', fetchedOn: '2026-09-25' },
      { destination: 'wdw', park: 'epcot', date: '2026-10-12', opens: '09:00', closes: '21:00', earlyEntry: null, extendedEvening: null, source: 'themeparks_wiki', fetchedOn: '2026-09-25' },
      { destination: 'wdw', park: 'epcot', date: '2026-11-01', opens: '09:00', closes: '21:00', earlyEntry: null, extendedEvening: null, source: 'themeparks_wiki', fetchedOn: '2026-09-26' },
    ]
    const month = calendarMonth({
      month: '2026-10',
      weather: [weather('2026-10-01', 'forecast', 90, 74, '2026-09-26', 30), weather('2026-10-12', 'subseasonal', 86, 70, '2026-09-24'), weather('2026-10-25', 'normal', 82, 65, '2026-09-01')],
      hours,
      busyness: { crowdLevels: [crowd('2026-10-12', 'other', 7, 'ropedrop', '2026-09-20'), crowd('2026-10-25', 'magic_kingdom', 3, 'typed', '2026-09-10')] },
      daysOff: [{ date: '2026-10-12', label: 'Fall break' }],
      holidays: [{ date: '2026-10-12', name: 'Columbus Day' }],
      blackouts: [{ from: '2026-10-05', to: '2026-10-09', label: 'Work trip' }],
      today: '2026-10-03',
    })
    expect(month.label).toBe('October 2026')
    expect(month.previous).toBe('2026-09')
    expect(month.next).toBe('2026-11')
    expect(month.weeks).toHaveLength(5)
    // October 1st, 2026 is a Thursday: four empty cells first.
    expect(month.weeks[0]!.slice(0, 4)).toEqual([null, null, null, null])
    expect(month.weeks[0]![4]!.day).toBe(1)
    expect(month.weeks[4]!.filter((c) => c !== null)).toHaveLength(7)
    const oct1 = month.weeks[0]![4]!
    expect(oct1).toMatchObject({ past: true, today: false, weekend: false, weather: { highF: 90, lowF: 74, precipChance: 30, horizon: 'forecast' }, busyness: null, earliestClose: null })
    const oct3 = month.weeks[0]![6]!
    expect(oct3).toMatchObject({ today: true, weekend: true, weather: null })
    const oct7 = month.weeks[1]![3]!
    expect(oct7.blackouts).toEqual(['Work trip'])
    const oct12 = month.weeks[2]![1]!
    expect(oct12).toMatchObject({
      weather: { horizon: 'subseasonal', highF: 86 },
      busyness: { level: 7, source: 'outlook' },
      earliestClose: { park: 'epcot', closes: '21:00' },
      daysOff: ['Fall break'],
      holidays: ['Columbus Day'],
      blackouts: [],
    })
    const oct25 = month.weeks[4]![0]!
    expect(oct25).toMatchObject({ weather: { horizon: 'normal' }, busyness: { level: 3, source: 'typed', detail: '1 of 4 parks' } })
    // A day with nothing at all is still a cell.
    const oct20 = month.weeks[3]![2]!
    expect(oct20).toEqual({ date: '2026-10-20', day: 20, weekend: false, past: false, today: false, weather: null, busyness: null, earliestClose: null, daysOff: [], holidays: [], blackouts: [] })
    expect(month.hours).toHaveLength(2)
    expect(month.freshness).toEqual({ weather: '2026-09-26', hours: '2026-09-25', busyness: '2026-09-20' })
    expect(month.horizonsShown).toEqual(['forecast', 'subseasonal', 'normal'])
    expect(month.busynessSourcesShown).toEqual(['typed', 'outlook'])
  })

  it('month arithmetic and the age in words', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(dataAge(null, TODAY)).toBe('never fetched')
    expect(dataAge(TODAY, TODAY)).toBe('fetched today')
    expect(dataAge('2026-09-25', TODAY)).toBe('fetched yesterday')
    expect(dataAge('2026-09-01', TODAY)).toBe('fetched 25 days ago')
  })
})
