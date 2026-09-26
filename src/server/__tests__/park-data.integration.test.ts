/**
 * Ballast's own park data against a real database (PRD §16 D28-D29): each
 * table is written through the engine and read back, a re-poll of the same
 * postings stores nothing, the wait history summed in SQL matches the
 * domain's sum of the same rows, "Refresh park data" stores what a fake
 * fetch answers and says what it could not, and a calendar month comes
 * back with mixed horizons and sources. No network: every fetch is a fake.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, gte, lte, or } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { summariseWaits, type WaitObservation } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('park data', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  const TODAY = '2026-09-26'

  const observation = (date: string, minutes: number | null, ride: string, park = 'Magic Kingdom', hour = '15'): WaitObservation => ({
    source: 'queue_times',
    parkId: park === 'Magic Kingdom' ? '6' : '5',
    parkName: park,
    rideId: ride,
    rideName: `Ride ${ride}`,
    isOpen: minutes !== null,
    waitMinutes: minutes,
    observedAt: `${date}T${hour}:00:00.000Z`,
  })

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Parks ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    await db.delete(schema.parkWeather)
    await db.delete(schema.parkHours)
    await db.delete(schema.waitObservations)
    await clearOwnCrowdLevels()
  })

  /** Only this file's crowd levels: the other integration files share the table, and wiping it under them is a race. */
  const clearOwnCrowdLevels = () =>
    db.delete(schema.crowdLevels).where(or(eq(schema.crowdLevels.source, 'ropedrop'), and(gte(schema.crowdLevels.date, '2026-10-01'), lte(schema.crowdLevels.date, '2026-10-31'))))

  afterAll(async () => {
    await db.delete(schema.parkWeather)
    await db.delete(schema.parkHours)
    await db.delete(schema.waitObservations)
    await clearOwnCrowdLevels()
    if (householdId) await db.delete(schema.trips).where(eq(schema.trips.householdId, householdId))
    await client?.end()
  })

  it('weather is kept one row per date and horizon, and a later pull on the same horizon replaces the day', async () => {
    expect(await engine.recordParkWeather([{ date: '2026-10-01', highF: 90, lowF: 74, precipChance: 40 }], { destination: 'wdw', horizon: 'forecast', source: 'open_meteo', fetchedOn: '2026-09-25' })).toBe(1)
    await engine.recordParkWeather([{ date: '2026-10-01', highF: 88, lowF: 72, precipChance: null }], { destination: 'wdw', horizon: 'subseasonal', source: 'open_meteo', fetchedOn: '2026-09-25' })
    await engine.recordParkWeather([{ date: '2026-10-01', highF: 91, lowF: 75, precipChance: 55 }], { destination: 'wdw', horizon: 'forecast', source: 'open_meteo', fetchedOn: TODAY })
    const rows = await engine.parkWeather({ from: '2026-10-01', to: '2026-10-31' })
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.horizon === 'forecast')).toMatchObject({ highF: 91, lowF: 75, precipChance: 55, fetchedOn: TODAY, source: 'open_meteo' })
    await expect(engine.recordParkWeather([{ date: '2026-10-01', highF: 70, lowF: 80, precipChance: null }], { destination: 'wdw', horizon: 'normal', source: 'x', fetchedOn: TODAY })).rejects.toThrow(/low/)
    expect(await engine.recordParkWeather([], { destination: 'wdw', horizon: 'normal', source: 'x', fetchedOn: TODAY })).toBe(0)
  })

  it('park hours are kept one row per park and date, and read back by range', async () => {
    await engine.recordParkHours([{ date: '2026-10-01', opens: '09:00', closes: '22:00', earlyEntry: '08:30', extendedEvening: null }], { destination: 'wdw', park: 'magic_kingdom', source: 'themeparks_wiki', fetchedOn: TODAY })
    await engine.recordParkHours([{ date: '2026-10-01', opens: '09:00', closes: '21:00', earlyEntry: null, extendedEvening: null }], { destination: 'wdw', park: 'epcot', source: 'themeparks_wiki', fetchedOn: TODAY })
    await engine.recordParkHours([{ date: '2026-10-01', opens: '08:00', closes: '20:00', earlyEntry: null, extendedEvening: null }], { destination: 'wdw', park: 'epcot', source: 'themeparks_wiki', fetchedOn: TODAY })
    const rows = await engine.parkHours({ from: '2026-10-01', to: '2026-10-01' })
    expect(rows.map((r) => `${r.park} ${r.opens}-${r.closes}`).sort()).toEqual(['epcot 08:00-20:00', 'magic_kingdom 09:00-22:00'])
    await expect(engine.recordParkHours([{ date: '2026-10-01', opens: '9am', closes: '22:00', earlyEntry: null, extendedEvening: null }], { destination: 'wdw', park: 'epcot', source: 'x', fetchedOn: TODAY })).rejects.toThrow(/hours and minutes/)
    await expect(engine.recordParkHours([{ date: '2026-10-01', opens: '09:00', closes: '22:00', earlyEntry: null, extendedEvening: null }], { destination: 'wdw', park: 'rest', source: 'x', fetchedOn: TODAY })).rejects.toThrow(/theme parks/)
  })

  it('a poll stores each posting once: the same rows again are no rows, and the SQL day summary matches the domain', async () => {
    const batch = [
      observation('2026-06-14', 40, 'r1'),
      observation('2026-06-14', 20, 'r2'),
      observation('2026-06-14', null, 'r3'),
      observation('2026-06-15', 60, 'r1', 'Magic Kingdom', '02'), // 10 pm on the 14th at the park
      observation('2026-06-15', 10, 'r1', 'Epcot'),
    ]
    expect(await engine.recordWaitObservations(batch)).toBe(5)
    expect(await engine.recordWaitObservations(batch)).toBe(0)
    expect(await engine.recordWaitObservations([observation('2026-06-14', 45, 'r1', 'Magic Kingdom', '16')])).toBe(1)
    const summary = await engine.waitHistory()
    const expected = summariseWaits([...batch, observation('2026-06-14', 45, 'r1', 'Magic Kingdom', '16')])
    expect(summary).toEqual(expected)
    expect(summary).toEqual([
      { parkName: 'Epcot', date: '2026-06-15', meanWaitMinutes: 10, observations: 1 },
      { parkName: 'Magic Kingdom', date: '2026-06-14', meanWaitMinutes: 41.25, observations: 4 },
    ])
    expect(await engine.waitHistory({ park: 'Epcot' })).toHaveLength(1)
    expect(await engine.waitHistory({ window: { from: '06-15', to: '06-30' } })).toHaveLength(1)
    expect(await engine.waitHistory({ window: { from: '12-20', to: '06-14' } })).toHaveLength(1)
    await expect(engine.recordWaitObservations([{ ...observation('2026-06-14', 5, 'r9'), observedAt: 'yesterday' }])).rejects.toThrow(/time/)
  })

  it('"Refresh park data" stores what each fake source answered, finds the park ids once, and says what it could not read', async () => {
    const asked: string[] = []
    const fake = (async (url: string) => {
      asked.push(url)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
      if (url.startsWith('https://api.open-meteo.com/')) return json({ daily: { time: ['2026-09-27', '2026-09-28'], temperature_2m_max: [90, 88], temperature_2m_min: [74, 72], precipitation_probability_max: [30, 60] } })
      if (url.startsWith('https://seasonal-api.open-meteo.com/')) return json({ daily: { time: ['2026-09-28', '2026-10-20'], temperature_2m_max_member01: [86, 84], temperature_2m_max_member02: [88, 86], temperature_2m_min_member01: [70, 66], temperature_2m_min_member02: [72, 68] } })
      if (url.startsWith('https://archive-api.open-meteo.com/')) return json({ daily: { time: ['2016-10-25', '2017-10-25', '2016-11-30'], temperature_2m_max: [80, 84, 76], temperature_2m_min: [62, 66, 55] } })
      if (url.endsWith('/children')) return json({ children: [{ id: 'mk', name: 'Magic Kingdom Park', entityType: 'PARK' }, { id: 'ep', name: 'EPCOT', entityType: 'PARK' }] })
      if (url.endsWith('/mk/schedule')) return json({ schedule: [{ date: '2026-10-20', type: 'OPERATING', openingTime: '2026-10-20T09:00:00-04:00', closingTime: '2026-10-20T22:00:00-04:00' }, { date: '2025-01-01', type: 'OPERATING', openingTime: '2025-01-01T09:00:00-05:00', closingTime: '2025-01-01T22:00:00-05:00' }] })
      if (url.endsWith('/ep/schedule')) return new Response('down', { status: 503 })
      if (url.includes('ropedropplanner.com')) return json({ parks: [{ name: 'Magic Kingdom', days: [{ date: '2026-10-20', crowd_level: 8 }] }, { name: 'Epcot', days: [{ date: '2026-10-20', crowd_level: 4 }] }] })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const done = await engine.refreshParkData({ fetchImpl: fake })
    expect(done.weather).toBeGreaterThan(4) // 2 forecast + 2 subseasonal + the typical rows laid over 18 months
    expect(done.hours).toBe(1)
    expect(done.outlook).toBe(2)
    expect(done.notes).toEqual(['Park hours: the park service did not list Hollywood Studios, Animal Kingdom under Walt Disney World.', 'EPCOT hours: The park service answered 503'])
    expect(await engine.themeParkIds()).toEqual([{ park: 'magic_kingdom', id: 'mk', name: 'Magic Kingdom Park' }, { park: 'epcot', id: 'ep', name: 'EPCOT' }])
    const normals = (await engine.parkWeather({ from: '2026-10-25', to: '2027-11-30' })).filter((r) => r.horizon === 'normal')
    expect(normals.map((r) => `${r.date} ${r.highF}/${r.lowF}`)).toEqual(['2026-10-25 82/64', '2026-11-30 76/55', '2027-10-25 82/64', '2027-11-30 76/55'])
    expect(await engine.crowdLevels('wdw', '2026-10-20', '2026-10-20')).toHaveLength(2)

    // A second refresh reads the park ids from the setting, and typical figures fetched today are not fetched again.
    asked.length = 0
    await engine.refreshParkData({ fetchImpl: fake })
    expect(asked.some((u) => u.endsWith('/children'))).toBe(false)
    expect(asked.some((u) => u.startsWith('https://archive-api.open-meteo.com/'))).toBe(false)
    // Only the parts asked for run.
    asked.length = 0
    await engine.refreshParkData({ fetchImpl: fake, parts: ['outlook'] })
    expect(asked).toEqual(['https://ropedropplanner.com/api/crowd-calendar/walt-disney-world.json'])
  })

  it('a poll of the live waits finds the parks by the names set and says which the feed did not list', async () => {
    const fake = (async (url: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url === 'https://queue-times.com/parks.json') return json([{ id: 16, name: 'Walt Disney World', parks: [{ id: 6, name: 'Magic Kingdom' }, { id: 5, name: 'Epcot' }] }])
      if (url === 'https://queue-times.com/parks/6/queue_times.json') return json({ lands: [{ rides: [{ id: 1, name: 'Space Mountain', is_open: true, wait_time: 35, last_updated: '2026-09-26T14:05:00.000Z' }] }] })
      if (url === 'https://queue-times.com/parks/5/queue_times.json') return json({ lands: [] })
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const first = await engine.pollWaits({ fetchImpl: fake })
    expect(first.inserted).toBe(1)
    expect(first.notes).toEqual(["Live waits: the wait service did not list Disney's Hollywood Studios, Disney's Animal Kingdom.", 'Epcot: The answer had no rides with a posted time.'])
    expect((await engine.pollWaits({ fetchImpl: fake })).inserted).toBe(0)

    // With every park found, the list is kept and not asked for again on the next poll.
    const asked: string[] = []
    const whole = (async (url: string) => {
      asked.push(url)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (url === 'https://queue-times.com/parks.json') return json([{ id: 16, name: 'Walt Disney World', parks: [{ id: 6, name: 'Magic Kingdom' }, { id: 5, name: 'Epcot' }, { id: 7, name: "Disney's Hollywood Studios" }, { id: 8, name: "Disney's Animal Kingdom" }] }])
      return json({ lands: [] })
    }) as unknown as typeof fetch
    expect((await engine.pollWaits({ fetchImpl: whole })).notes).toHaveLength(4)
    asked.length = 0
    await engine.pollWaits({ fetchImpl: whole })
    expect(asked).toEqual(['6', '5', '7', '8'].map((id) => `https://queue-times.com/parks/${id}/queue_times.json`))
  })

  it('a calendar month comes back with mixed horizons and sources, the tapped day has its hours, and the freshness is the newest fetch', async () => {
    await engine.typeCrowdLevel((await engine.createTrip({ name: 'Disney', startDate: '2026-10-19', endDate: '2026-10-25', travelers: [{ name: 'Josh', band: 'adult' }], car: null })).id, { date: '2026-10-21', park: 'magic_kingdom', level: 2 })
    const month = await engine.calendarMonth('2026-10')
    expect(month.label).toBe('October 2026')
    const cell = (date: string) => month.weeks.flat().find((c) => c?.date === date)!
    expect(cell('2026-10-01')).toMatchObject({ weather: { horizon: 'forecast', highF: 91 }, earliestClose: { park: 'epcot', closes: '20:00' } })
    expect(cell('2026-10-20')).toMatchObject({ weather: { horizon: 'subseasonal', highF: 85, lowF: 67 }, busyness: { level: 6, source: 'outlook', detail: '2 of 4 parks' }, earliestClose: { park: 'magic_kingdom', closes: '22:00' } })
    expect(cell('2026-10-21')).toMatchObject({ busyness: { level: 2, source: 'typed', detail: '1 of 4 parks' } })
    expect(cell('2026-10-25')).toMatchObject({ weather: { horizon: 'normal', highF: 82 }, busyness: null })
    expect(cell('2026-10-12').holidays).toEqual(['Columbus Day'])
    expect(month.hours.map((h) => `${h.date} ${h.park}`)).toEqual(['2026-10-01 epcot', '2026-10-01 magic_kingdom', '2026-10-20 magic_kingdom'])
    expect(month.freshness).toEqual({ weather: TODAY, hours: TODAY, busyness: TODAY })
    expect(month.horizonsShown).toEqual(['forecast', 'subseasonal', 'normal'])
    await expect(engine.calendarMonth('2026-13')).rejects.toThrow(/month/)
  })
})
