/**
 * Explore against a real database (PRD D42, D55): the family's shape is a
 * setting that round-trips and refuses nonsense, the ranking reads the
 * household's typed crowd levels, blackouts and school calendar and the
 * drive from home, a drive is kept without a trip, and "Plan this" makes a
 * trip whose days come laid out. No network.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, EngineError } from '@/server/engine'
import { DEFAULT_TRIP_SHAPE, layoutFromCode, shapeCode, TripPlanError } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('explore', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  const TODAY = '2026-10-31'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Explore ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    await db.delete(schema.crowdLevels).where(eq(schema.crowdLevels.destination, 'wdw'))
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.trips).where(eq(schema.trips.householdId, householdId))
      await db.delete(schema.schoolDaysOff).where(eq(schema.schoolDaysOff.householdId, householdId))
    }
    await db.delete(schema.crowdLevels).where(eq(schema.crowdLevels.destination, 'wdw'))
    await client?.end()
  })

  it('keeps the family shape as a setting, the usual one until changed, and refuses one that cannot be laid out', async () => {
    expect(await engine.tripShape()).toEqual(DEFAULT_TRIP_SHAPE)
    await engine.setTripShape({ ...DEFAULT_TRIP_SHAPE, parkDaysMin: 2, parkDaysMax: 3, easyStretchMinutes: 210 })
    expect(await engine.tripShape()).toMatchObject({ parkDaysMin: 2, parkDaysMax: 3, easyStretchMinutes: 210 })
    await expect(engine.setTripShape({ ...DEFAULT_TRIP_SHAPE, parkDaysMin: 4, parkDaysMax: 2 })).rejects.toThrow(TripPlanError)
    await engine.setTripShape(DEFAULT_TRIP_SHAPE)
  })

  it('needs a home on the map before a drive can be kept without a trip', async () => {
    await expect(engine.recordHomeDrive({ miles: 480, minutes: 450, fetchedOn: TODAY })).rejects.toThrow(EngineError)
    await engine.setHomeLocation({ label: 'Home', latitude: 35.0, longitude: -80.0, address: '1 Main St', resolvedName: 'Somewhere' })
    await engine.recordHomeDrive({ miles: 480, minutes: 450, fetchedOn: TODAY })
    expect(await engine.homeDrive()).toEqual({ miles: 480, minutes: 450, fetchedOn: TODAY })
  })

  it('ranks in the family shape from the household facts: a quiet typed week first, a blackout left out, school counted', async () => {
    // Quiet over Sat Nov 14 - Mon Nov 16, packed every other day of November.
    const levels = Array.from({ length: 30 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, park: 'other' as const, level: i + 1 >= 14 && i + 1 <= 16 ? 1 : 9 }))
    await engine.recordCrowdLevels(levels, { destination: 'wdw', source: 'typed', fetchedOn: TODAY })
    await engine.setBlackoutDates([{ from: '2026-12-01', to: '2027-12-31', label: 'Not this year' }])
    await engine.addSchoolDayOff({ date: '2026-11-13', label: 'Teacher day', schoolYear: '2026-27' })
    await engine.addSchoolDayOff({ date: '2026-11-16', label: 'Teacher day', schoolYear: '2026-27' })
    await engine.addSchoolDayOff({ date: '2027-06-01', label: 'Summer', schoolYear: '2026-27' })
    const r = await engine.explore({ parkDays: { min: 3, max: 3 } })
    expect(r.driveKnown).toBe(true)
    expect(r.stretchMinutes).toBe(240)
    const best = r.top[0]!
    expect(best.firstParkDate).toBe('2026-11-14')
    expect(best.crowdAverage).toBe(1)
    expect(best.uses).toEqual(['Teacher day'])
    expect(r.top.every((w) => w.endDate < '2026-12-01')).toBe(true)
    expect(r.excludedByBlackout).toBeGreaterThan(0)
    expect(r.startSteps[best.startDate]).toBe(1)
    // The strip reads the same ranking.
    const year = await engine.calendarYear('wdw', r.startSteps)
    expect(year.flatMap((m) => m.days).find((d) => d.date === best.startDate)?.start).toBe(1)
  })

  it('"Plan this" makes a trip whose days come laid out, the evening we leave a travel day and a quick day noted', async () => {
    const best = (await engine.explore({ parkDays: { min: 3, max: 3 } })).top[0]!
    const layout = layoutFromCode(best.startDate, best.endDate, shapeCode(best))!
    const trip = await engine.createTrip({ name: 'Disney, Nov 2026', startDate: best.startDate, endDate: best.endDate, travelers: [{ name: 'Josh', band: 'adult' }], car: null, layout })
    const days = await engine.listTripDays(trip.id)
    expect(days.map((d) => d.park)).toEqual(layout.map((l) => l.park))
    expect(days.map((d) => d.plan.notes)).toEqual(layout.map((l) => l.notes))
    const changes = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'trip_changed')))
    expect(changes.length).toBeGreaterThan(0)
  })
})

describeDb('what a night costs', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let otherId: string
  let engine: Engine
  let other: Engine
  const TODAY = '2026-10-31'
  const PAGE = [
    'MONTH\tALL RESORTS\tVS YEAR\tVALUE\tMODERATE\tDELUXE',
    'January 2027 AMONG THE 3 CHEAPEST\t$494\t-10%\t$173\t$294\t$633',
    'February 2027\t$547\t+0%\t$211\t$328\t$696',
    'Every figure is Disney’s own average price per night for a four-night midweek stay, as published on Disney’s own site in September 2026.',
  ].join('\n')

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [a] = await db.insert(schema.households).values({ name: `Nights ${crypto.randomUUID()}` }).returning()
    const [b] = await db.insert(schema.households).values({ name: `Other ${crypto.randomUUID()}` }).returning()
    householdId = a!.id
    otherId = b!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    other = new Engine({ householdId: otherId, actorUserId: null, db, today: TODAY })
    await db.delete(schema.lodgingRates)
  })

  afterAll(async () => {
    await db.delete(schema.lodgingRates)
    await client?.end()
  })

  it('holds a pasted page until it is kept, refuses a page with nothing readable, and keeps it once', async () => {
    await expect(engine.readLodgingPaste('nothing here')).rejects.toThrow(EngineError)
    const pull = await engine.readLodgingPaste(PAGE)
    expect(pull.rates).toHaveLength(8)
    expect(await engine.lodgingStays()).toEqual([])
    expect(await engine.keepLodgingPull()).toBe(8)
    expect(await engine.pendingLodgingPull()).toBeNull()
    expect(await engine.lodgingStays()).toEqual(['all', 'tier:value', 'tier:moderate', 'tier:deluxe'])
    // The same page again replaces, never doubles.
    await engine.readLodgingPaste(PAGE)
    await engine.keepLodgingPull()
    expect(await engine.lodgingRates({ from: '2027-01-01', to: '2027-02-28' })).toHaveLength(8)
  })

  it("prices Explore's windows night by night, a quote over Disney's rate, each change an event, another household's quote out of reach", async () => {
    await engine.setTripShape({ ...DEFAULT_TRIP_SHAPE, parkDaysMin: 3, parkDaysMax: 3, stay: { kind: 'tier', tier: 'moderate' } })
    await engine.setBlackoutDates([
      { from: '2026-11-01', to: '2027-01-09', label: 'Not yet' },
      { from: '2027-01-20', to: '2027-12-31', label: 'Not then' },
    ])
    const before = await engine.explore()
    expect(before.stay).toBe('tier:moderate')
    const w = before.top[0]!
    // No drive looked up: full travel days, so the resort nights are the travel day down and each park day.
    expect(w.price?.lodging).toMatchObject({ perNightCents: 294_00, weakest: 'rates_month' })
    expect(w.reasons).toContain('about $294.00 a night')

    const q = await engine.typeLodgingQuote({ stay: 'tier:moderate', fromDate: w.resortNights[0]!, toDate: w.resortNights.at(-1)!, nightlyCents: 150_00, note: 'Phone' })
    const after = (await engine.explore()).top.find((t) => t.startDate === w.startDate)!
    expect(after.price?.lodging).toMatchObject({ perNightCents: 150_00, weakest: 'typed', disagrees: true })

    await expect(other.removeLodgingQuote(q.id)).rejects.toThrow(EngineError)
    await engine.removeLodgingQuote(q.id)
    expect(await engine.lodgingQuotes()).toEqual([])
    const log = await db.select().from(schema.events).where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'lodging_quote_changed')))
    expect(log).toHaveLength(2)
  })
})
