/**
 * Resorts and the raw layer against a real database (D64, proposed): the
 * seeded resort list reads back whole and valid, a paste is kept raw and
 * append-only before anything read from it is kept, the rates name the
 * pull they came from, and Explore prices a stay a person spelled one way
 * from Disney's rate spelled another. No network.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { DEFAULT_TRIP_SHAPE } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('resorts and raw pulls', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let engine: Engine
  const TODAY = '2026-10-31'
  // A page no other test pastes, so its fingerprint is this test's own.
  const PAGE = [
    `Resort test ${crypto.randomUUID()}`,
    'MONTH\tALL RESORTS\tVS YEAR\tVALUE\tMODERATE\tDELUXE',
    'January 2027 AMONG THE 3 CHEAPEST\t$494\t-10%\t$173\t$294\t$633',
    'February 2027\t$547\t+0%\t$211\t$328\t$696',
    'RESORT\tJAN\tFEB\tYEAR\tROOM ALERT',
    'Pop Century Resort\t$190\t$205\t$198\tWatch',
    'Every figure is Disney’s own average price per night for a four-night midweek stay, as published on Disney’s own site in September 2026.',
  ].join('\n')

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Resorts ${crypto.randomUUID()}` }).returning()
    engine = new Engine({ householdId: household!.id, actorUserId: null, db, today: TODAY })
    await db.delete(schema.lodgingRates)
  })

  afterAll(async () => {
    await db.delete(schema.lodgingRates)
    await client?.end()
  })

  it('reads the seeded resort list back whole, every row on its brand\'s ladder', async () => {
    const { resorts, aliases, perks } = await engine.resortCatalogue()
    expect(resorts.filter((r) => r.destination === 'wdw')).toHaveLength(32)
    expect(resorts.filter((r) => r.destination === 'uor')).toHaveLength(11)
    expect(aliases.length).toBeGreaterThan(0)
    expect(perks.map((p) => p.resortId).sort()).toEqual(['uor-hard-rock', 'uor-portofino-bay', 'uor-royal-pacific'])
  })

  it('refuses a resort off its brand\'s ladder at the database too', async () => {
    await expect(db.insert(schema.resorts).values({ id: 'uor-test', destination: 'uor', brand: 'universal', name: `Test ${crypto.randomUUID()}`, tier: 'moderate', dvc: false })).rejects.toThrow()
    await expect(db.insert(schema.resorts).values({ id: 'uor-test', destination: 'uor', brand: 'universal', name: `Test ${crypto.randomUUID()}`, tier: 'value', dvc: true })).rejects.toThrow()
  })

  it('keeps a paste raw before its rates, once however often it is pasted, and the rates name it', async () => {
    const first = await engine.readLodgingPaste(PAGE)
    expect(first.pullId).toBeDefined()
    const again = await engine.readLodgingPaste(PAGE)
    expect(again.pullId).toBe(first.pullId)
    const raw = await engine.sourcePull(first.pullId!)
    expect(raw).toMatchObject({ source: 'resortings', how: 'pasted', mediaType: 'text/plain', body: PAGE, pulledOn: TODAY })
    expect(raw!.sha256).toMatch(/^[0-9a-f]{64}$/)

    expect(await engine.keepLodgingPull()).toBeGreaterThan(0)
    const rows = await db.select().from(schema.lodgingRates).where(eq(schema.lodgingRates.stay, 'Pop Century Resort'))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.pullId === first.pullId)).toBe(true)
  })

  it('will not let a kept pull be changed or removed', async () => {
    const id = await engine.landPull({ source: 'test', url: 'https://example.com/', how: 'fetched', mediaType: 'text/plain', body: `raw ${crypto.randomUUID()}`, pulledOn: TODAY })
    // Drizzle wraps the database's refusal; the trigger's own words are its cause.
    const refusal = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) }
    await expect(db.update(schema.sourcePulls).set({ body: 'edited' }).where(eq(schema.sourcePulls.id, id))).rejects.toMatchObject(refusal)
    await expect(db.delete(schema.sourcePulls).where(eq(schema.sourcePulls.id, id))).rejects.toMatchObject(refusal)
    expect((await engine.sourcePull(id))!.body).toMatch(/^raw /)
  })

  it('prices a stay spelled one way from Disney\'s rate spelled another', async () => {
    await engine.setTripShape({ ...DEFAULT_TRIP_SHAPE, parkDaysMin: 3, parkDaysMax: 3, stay: { kind: 'resort', name: "Disney's Pop Century" } })
    await engine.setBlackoutDates([
      { from: '2026-11-01', to: '2027-01-09', label: 'Not yet' },
      { from: '2027-01-20', to: '2027-12-31', label: 'Not then' },
    ])
    const r = await engine.explore()
    expect(r.stay).toBe("Disney's Pop Century")
    expect(r.top[0]!.price?.lodging).toMatchObject({ perNightCents: 190_00, weakest: 'rates_month' })
    await engine.setBlackoutDates([])
    await engine.setTripShape(DEFAULT_TRIP_SHAPE)
  })

  it('predicts a week Disney has not priced from its rate a year earlier, and says it is predicted (D64 (6))', async () => {
    // Pop Century's November a year back; Disney has published nothing for November 2026 in this database.
    await engine.recordLodgingRates([
      { source: 'resortings', stay: 'Pop Century Resort', period: 'month', periodStart: '2025-11-01', nightlyCents: 170_00, observedOn: '2025-09-01', fetchedOn: '2025-09-15', sourceUrl: 'https://resortings.com/' },
    ])
    await engine.setTripShape({ ...DEFAULT_TRIP_SHAPE, parkDaysMin: 3, parkDaysMax: 3, stay: { kind: 'resort', name: "Disney's Pop Century" } })
    await engine.setBlackoutDates([{ from: '2026-12-01', to: '2027-12-31', label: 'Not then' }])
    const r = await engine.explore()
    const lodging = r.top[0]!.price!.lodging
    expect(lodging).toMatchObject({ certainty: 'predicted', weakest: 'predicted', perNightCents: 170_00 })
    expect(lodging.bases[0]).toMatch(/Disney's rate for the month a year earlier, \$170\.00 a night/)
    await engine.setBlackoutDates([])
    await engine.setTripShape(DEFAULT_TRIP_SHAPE)
  })
})
