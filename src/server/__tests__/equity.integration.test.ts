/**
 * Phase F acceptance (PRD §15): homes and vehicles are entered and tied to
 * their loans, the rate comes from the weekly average or a typed quote, and
 * the screen's two answers are the derivation module's, from stored facts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, EngineError } from '@/server/engine'
import { homeCost, mostHouseForPayment, DEFAULT_HOME_BUYING } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('equity and the next home', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let otherHouseholdId: string
  let engine: Engine
  let other: Engine
  const TODAY = '2026-09-23'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Equity ${crypto.randomUUID()}` }).returning()
    const [neighbour] = await db.insert(schema.households).values({ name: `Other ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    otherHouseholdId = neighbour!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    other = new Engine({ householdId: otherHouseholdId, actorUserId: null, db, today: TODAY })
  })

  afterAll(async () => {
    for (const id of [householdId, otherHouseholdId].filter(Boolean)) {
      await db.delete(schema.debts).where(eq(schema.debts.householdId, id))
      await db.delete(schema.assets).where(eq(schema.assets.householdId, id))
    }
    await client?.end()
  })

  it('works out what selling leaves and what house it buys', async () => {
    const house = await engine.createAsset({ name: 'House', kind: 'home', valueCents: 50_000_000 })
    const car = await engine.createAsset({ name: 'Car', kind: 'vehicle', valueCents: 2_000_000 })
    expect(house.sellingCostBasisPoints).toBe(700) // the usual figure for a home
    expect(car.sellingCostBasisPoints).toBe(0)

    const mortgage = await engine.createDebt({
      name: 'Mortgage',
      category: 'mortgage',
      balanceCents: 30_000_000,
      aprBasisPoints: 350,
      minPaymentRule: { type: 'fixed', amountCents: 250_000 },
    })
    const carLoan = await engine.createDebt({
      name: 'Car loan',
      category: 'auto',
      balanceCents: 1_200_000,
      aprBasisPoints: 599,
      minPaymentRule: { type: 'fixed', amountCents: 40_000 },
    })

    // Before the loans are tied to anything, the screen must say the figure is too high.
    let view = await engine.nextHome()
    expect(view.position.unlinkedSecuredDebts.map((d) => d.name).sort()).toEqual(['Car loan', 'Mortgage'])
    expect(view.rate).toBeNull()
    expect(view.mostHouse).toBeNull()

    await engine.linkDebtToAsset(mortgage.id, house.id)
    await engine.linkDebtToAsset(carLoan.id, car.id)
    await engine.recordMarketMortgageRate({ rateBasisPoints: 626, observedOn: '2026-09-17', series: 'MORTGAGE30US' })

    view = await engine.nextHome(40_000_000)
    expect(view.position.unlinkedSecuredDebts).toEqual([])
    // $500,000 - $35,000 - $300,000, plus $20,000 - $12,000.
    expect(view.position.countedCents).toBe(16_500_000 + 800_000)
    expect(view.rate).toMatchObject({ rateBasisPoints: 626, source: 'weekly_average', stale: false })
    expect(view.targetPaymentCents).toBe(250_000) // no stated payment: the mortgage's

    const common = { equityCents: 17_300_000, rateBasisPoints: 626, assumptions: DEFAULT_HOME_BUYING }
    expect(view.mostHouse).toEqual(mostHouseForPayment({ ...common, targetMonthlyCents: 250_000 }))
    expect(view.atPrice).toEqual(homeCost({ ...common, priceCents: 40_000_000 }))
  })

  it('prefers a typed rate and a stated payment, and goes back when they are cleared', async () => {
    await engine.setTypedMortgageRate(599)
    await engine.setHomeBuyingAssumptions({ ...DEFAULT_HOME_BUYING, currentHousingPaymentCents: 310_000 })
    let view = await engine.nextHome()
    expect(view.rate).toMatchObject({ rateBasisPoints: 599, source: 'typed' })
    expect(view.targetPaymentCents).toBe(310_000)

    await engine.setTypedMortgageRate(null)
    await engine.setHomeBuyingAssumptions({ ...DEFAULT_HOME_BUYING })
    view = await engine.nextHome()
    expect(view.rate).toMatchObject({ rateBasisPoints: 626, source: 'weekly_average' })
    expect(view.targetPaymentCents).toBe(250_000)

    await expect(engine.setTypedMortgageRate(0)).rejects.toThrow(EngineError)
  })

  it('stamps a new value with today, and keeps the before and after', async () => {
    const later = new Engine({ householdId, actorUserId: null, db, today: '2026-10-01' })
    const [house] = (await later.listAssets()).filter((a) => a.name === 'House')
    await later.updateAsset(house!.id, { name: 'Our house' })
    expect((await later.listAssets()).find((a) => a.id === house!.id)!.valueAsOf).toBe(TODAY)
    await later.updateAsset(house!.id, { valueCents: 51_000_000 })
    expect((await later.listAssets()).find((a) => a.id === house!.id)).toMatchObject({
      valueCents: 51_000_000,
      valueAsOf: '2026-10-01',
    })

    const changes = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'asset_changed')))
    expect(changes).toHaveLength(2)
    expect(changes.map((e) => (e.payload as { after: { value_cents: number } }).after.value_cents)).toContain(51_000_000)
  })

  it("cannot tie a debt to another household's home, or reach another household's asset", async () => {
    const theirs = await other.createAsset({ name: 'Their house', kind: 'home', valueCents: 30_000_000 })
    const [mortgage] = (await engine.listDebts()).filter((d) => d.name === 'Mortgage')
    await expect(engine.linkDebtToAsset(mortgage!.id, theirs.id)).rejects.toThrow(EngineError)
    await expect(engine.updateAsset(theirs.id, { valueCents: 1 })).rejects.toThrow(EngineError)
    await expect(engine.removeAsset(theirs.id)).rejects.toThrow(EngineError)
    expect((await other.listAssets())[0]!.valueCents).toBe(30_000_000)
  })

  it('leaves the loan in place, untied, when a home is removed', async () => {
    const [car] = (await engine.listAssets()).filter((a) => a.name === 'Car')
    await engine.removeAsset(car!.id)
    const carLoan = (await engine.listDebts()).find((d) => d.name === 'Car loan')!
    expect(carLoan.assetId).toBeNull()
    expect((await engine.nextHome()).position.unlinkedSecuredDebts.map((d) => d.name)).toEqual(['Car loan'])

    const removed = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'asset_removed')))
    expect(removed).toHaveLength(1)
  })

  it('refuses a value the database would never hold', async () => {
    await expect(engine.createAsset({ name: 'Boat', kind: 'vehicle', valueCents: -1 })).rejects.toThrow()
    await expect(engine.createAsset({ name: ' ', kind: 'vehicle', valueCents: 1 })).rejects.toThrow(EngineError)
  })
})
