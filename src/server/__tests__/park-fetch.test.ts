/**
 * The park-data adapters (PRD §16, D28) against a fake fetch: each asks the
 * documented URL with the app's own User-Agent and no origin or referer,
 * hands the body to its parser, throws on an error status, and answers
 * nothing with a reason for a body that is not what was asked for. None of
 * these hosts is reachable from the sandbox; nothing here is a live call.
 */

import { describe, expect, it } from 'vitest'
import {
  archiveWindow,
  fetchArchive,
  fetchForecast,
  fetchQueueTimesParks,
  fetchQueueTimesWaits,
  fetchRopeDropOutlook,
  fetchSubseasonal,
  fetchThemeParksChildren,
  fetchThemeParksSchedule,
  openMeteoArchiveUrl,
  openMeteoForecastUrl,
  openMeteoSeasonalUrl,
  parkDataFetchEnabled,
  queueTimesWaitsUrl,
  themeParksChildrenUrl,
  themeParksScheduleUrl,
} from '../park-fetch'

interface Seen {
  url: string
  headers: Record<string, string>
}

const answering = (body: unknown, status = 200, seen: Seen[] = []) =>
  (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch

describe('the switch and the URLs', () => {
  it('is on unless PARK_DATA_FETCH=off', () => {
    expect(parkDataFetchEnabled({})).toBe(true)
    expect(parkDataFetchEnabled({ PARK_DATA_FETCH: 'OFF' })).toBe(false)
  })

  it('asks Open-Meteo for Fahrenheit at the park point on the park clock', () => {
    expect(openMeteoForecastUrl('wdw')).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=28.3852&longitude=-81.5639&daily=temperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_probability_max%2Cweather_code&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=16',
    )
    expect(openMeteoSeasonalUrl('wdw')).toBe(
      'https://seasonal-api.open-meteo.com/v1/seasonal?latitude=28.3852&longitude=-81.5639&daily=temperature_2m_max%2Ctemperature_2m_min&temperature_unit=fahrenheit&timezone=America%2FNew_York',
    )
    expect(openMeteoArchiveUrl('wdw', '2016-09-19', '2026-09-19')).toBe(
      'https://archive-api.open-meteo.com/v1/archive?latitude=28.3852&longitude=-81.5639&start_date=2016-09-19&end_date=2026-09-19&daily=temperature_2m_max%2Ctemperature_2m_min&temperature_unit=fahrenheit&timezone=America%2FNew_York',
    )
    expect(archiveWindow('2026-09-26')).toEqual({ from: '2016-09-19', to: '2026-09-19' })
    expect(archiveWindow('2028-03-07')).toEqual({ from: '2018-02-28', to: '2028-02-29' })
    expect(themeParksChildrenUrl('wdw')).toBe('https://api.themeparks.wiki/v1/entity/e957da41-3552-4cf6-b636-5babc5cbc4e5/children')
    expect(themeParksScheduleUrl('75ea578a-adc8-4116-a54d-dccb60765ef9')).toBe('https://api.themeparks.wiki/v1/entity/75ea578a-adc8-4116-a54d-dccb60765ef9/schedule')
    expect(queueTimesWaitsUrl('6')).toBe('https://queue-times.com/parks/6/queue_times.json')
  })
})

describe('the weather adapters', () => {
  const daily = { daily: { time: ['2026-09-27'], temperature_2m_max: [91.4], temperature_2m_min: [74.5], precipitation_probability_max: [45] } }

  it('fetches the forecast with the app User-Agent and no origin or referer, and reads it', async () => {
    const seen: Seen[] = []
    expect(await fetchForecast('wdw', answering(daily, 200, seen))).toEqual({ rows: [{ date: '2026-09-27', highF: 91, lowF: 75, precipChance: 45 }], reason: null })
    expect(seen[0]!.url).toBe(openMeteoForecastUrl('wdw'))
    expect(seen[0]!.headers['user-agent']).toMatch(/^BallastFinance\//)
    expect(seen[0]!.headers.accept).toBe('application/json')
    expect(Object.keys(seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain('origin')
    expect(Object.keys(seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain('referer')
  })

  it('throws on an error status so the last good rows stay, and answers nothing for a body that is not JSON', async () => {
    await expect(fetchForecast('wdw', answering('busy', 503))).rejects.toThrow('503')
    expect(await fetchForecast('wdw', answering('<html>captive portal</html>'))).toEqual({ rows: [], reason: 'The weather service did not answer with JSON.' })
  })

  it('fetches the seasonal outlook and averages its members', async () => {
    const seasonal = { daily: { time: ['2026-10-10'], temperature_2m_max_member01: [84], temperature_2m_max_member02: [88], temperature_2m_min_member01: [66], temperature_2m_min_member02: [70] } }
    expect(await fetchSubseasonal('wdw', answering(seasonal))).toEqual({ rows: [{ date: '2026-10-10', highF: 86, lowF: 68, precipChance: null }], reason: null })
    await expect(fetchSubseasonal('wdw', answering('', 500))).rejects.toThrow('500')
  })

  it('fetches ten years of archive ending a week ago', async () => {
    const seen: Seen[] = []
    expect((await fetchArchive('wdw', '2026-09-26', answering(daily, 200, seen))).rows).toHaveLength(1)
    expect(seen[0]!.url).toContain('start_date=2016-09-19&end_date=2026-09-19')
  })
})

describe('the park hours adapters', () => {
  it('finds the park ids among the destination children and reads a schedule', async () => {
    const children = { children: [{ id: 'mk', name: 'Magic Kingdom Park', entityType: 'PARK' }] }
    const got = await fetchThemeParksChildren('wdw', answering(children))
    expect(got.rows).toEqual([{ park: 'magic_kingdom', id: 'mk', name: 'Magic Kingdom Park' }])
    expect(got.missing).toEqual(['epcot', 'hollywood_studios', 'animal_kingdom'])
    const schedule = { schedule: [{ date: '2026-10-01', type: 'OPERATING', openingTime: '2026-10-01T09:00:00-04:00', closingTime: '2026-10-01T22:00:00-04:00' }] }
    const seen: Seen[] = []
    expect(await fetchThemeParksSchedule('mk', answering(schedule, 200, seen))).toEqual({ rows: [{ date: '2026-10-01', opens: '09:00', closes: '22:00', earlyEntry: null, extendedEvening: null }], reason: null })
    expect(seen[0]!.url).toBe('https://api.themeparks.wiki/v1/entity/mk/schedule')
    await expect(fetchThemeParksSchedule('mk', answering('', 404))).rejects.toThrow('404')
    expect((await fetchThemeParksSchedule('mk', answering({ nope: 1 }))).reason).toBeTruthy()
  })
})

describe('the crowd outlook adapter', () => {
  it('reads the link from the setting, refuses one that is not a web address, and reads what comes back defensively', async () => {
    const seen: Seen[] = []
    const json = { parks: [{ name: 'Magic Kingdom', days: [{ date: '2027-06-12', crowd_level: 7 }] }] }
    expect(await fetchRopeDropOutlook('https://ropedropplanner.com/api/x.json', answering(json, 200, seen))).toEqual({ rows: [{ date: '2027-06-12', park: 'magic_kingdom', level: 7 }], reason: null })
    expect(seen[0]!.url).toBe('https://ropedropplanner.com/api/x.json')
    expect(await fetchRopeDropOutlook('ftp://nope', answering(json))).toEqual({ rows: [], reason: 'The outlook link is not a web address.' })
    expect((await fetchRopeDropOutlook('https://ropedropplanner.com/api/x.json', answering({ ok: true }))).reason).toContain('Nothing in the outlook')
    await expect(fetchRopeDropOutlook('https://ropedropplanner.com/api/x.json', answering('', 429))).rejects.toThrow('429')
  })
})

describe('the live waits adapters', () => {
  it('finds the parks by name under the group and reads a park', async () => {
    const parks = [{ id: 16, name: 'Walt Disney World', parks: [{ id: 6, name: 'Magic Kingdom' }, { id: 5, name: 'Epcot' }] }]
    const got = await fetchQueueTimesParks({ magic_kingdom: 'Magic Kingdom', epcot: 'Epcot', hollywood_studios: "Disney's Hollywood Studios" }, 'Walt Disney World', answering(parks))
    expect(got.rows.map((r) => r.id)).toEqual(['6', '5'])
    expect(got.missing).toEqual(["Disney's Hollywood Studios"])
    const waits = { lands: [{ id: 1, name: 'Tomorrowland', rides: [{ id: 101, name: 'Space Mountain', is_open: true, wait_time: 45, last_updated: '2026-09-26T14:05:12.000Z' }] }] }
    const seen: Seen[] = []
    const read = await fetchQueueTimesWaits({ park: 'magic_kingdom', id: '6', name: 'Magic Kingdom' }, answering(waits, 200, seen))
    expect(read.rows).toEqual([{ source: 'queue_times', parkId: '6', parkName: 'Magic Kingdom', rideId: '101', rideName: 'Space Mountain', isOpen: true, waitMinutes: 45, observedAt: '2026-09-26T14:05:12.000Z' }])
    expect(seen[0]!.url).toBe('https://queue-times.com/parks/6/queue_times.json')
    expect(seen[0]!.headers['user-agent']).toMatch(/^BallastFinance\//)
    await expect(fetchQueueTimesWaits({ park: 'magic_kingdom', id: '6', name: 'Magic Kingdom' }, answering('', 502))).rejects.toThrow('502')
  })
})
