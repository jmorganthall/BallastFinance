/**
 * Phase D acceptance (PRD §12): the optimizer answers a real allocation's debt
 * share, and balances move only through confirmations.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('debts, the ladder and the optimizer', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  const TODAY = '2026-09-19'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Debts ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })

    await engine.createDebt({
      name: 'Store card',
      category: 'consumer',
      balanceCents: 40000,
      aprBasisPoints: 2999,
      minPaymentRule: { type: 'fixed', amountCents: 4000 },
    })
    await engine.createDebt({
      name: 'Big card',
      category: 'consumer',
      balanceCents: 900000,
      aprBasisPoints: 2199,
      minPaymentRule: { type: 'percent_with_floor', basisPoints: 200, floorCents: 2500 },
    })
    await engine.createDebt({
      name: 'Car loan',
      category: 'auto',
      balanceCents: 1200000,
      aprBasisPoints: 599,
      minPaymentRule: { type: 'fixed', amountCents: 40000 },
    })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.debts).where(eq(schema.debts.householdId, householdId))
    }
    await client?.end()
  })

  it('ranks by interest first at the default weighting', async () => {
    const ladder = await engine.debtLadder()
    expect(ladder[0]!.debt.name).toBe('Store card') // 29.99%
    expect(ladder.map((r) => r.rank)).toEqual([1, 2, 3])
  })

  it('re-sorts when the slider moves toward cash flow', async () => {
    const cashFlow = await engine.debtLadder(0)
    // The car loan frees the most per dollar owed at its minimum.
    expect(cashFlow[0]!.debt.name).not.toBe('Big card')
    expect(cashFlow.map((r) => r.debt.name)).toHaveLength(3)
  })

  it('accumulates cost and freed cash down the ladder', async () => {
    const ladder = await engine.debtLadder()
    expect(ladder[2]!.cumulativeCostCents).toBe(40000 + 900000 + 1200000)
    expect(ladder[2]!.cumulativeFreedPerMonthCents).toBeGreaterThan(
      ladder[0]!.cumulativeFreedPerMonthCents,
    )
  })

  it('answers where a lump sum should go', async () => {
    const result = await engine.optimiseLumpSum(107500)
    expect(result.allocations[0]!.debtName).toBe('Store card')
    expect(result.allocations[0]!.clearsIt).toBe(true)
    expect(result.monthlyFreedCents).toBe(4000)
    expect(result.why).toContain('Store card')
  })

  it('hands an allocation run’s debt share to the optimizer, naming real debts', async () => {
    const { plan, instructionIds } = await engine.runAllocation({ floorCents: 250000 })
    expect(plan.netCents).toBe(215000)

    const outstanding = await engine.outstandingInstructions()
    const debtInstructions = outstanding.filter((i) => i.type === 'debt_payment')

    // Not one vague "put $1,075 at debt" but named debts.
    expect(debtInstructions.length).toBeGreaterThanOrEqual(1)
    expect(debtInstructions.some((i) => i.targetLabel === 'Store card')).toBe(true)
    expect(debtInstructions.reduce((s, i) => s + i.amountCents, 0)).toBe(107500)
    expect(instructionIds.length).toBeGreaterThanOrEqual(5)
  })

  it('moves a balance only when a payment is confirmed', async () => {
    const before = (await engine.listDebts()).find((d) => d.name === 'Store card')!
    expect(before.balanceCents).toBe(40000)

    await engine.confirmDebtPayment({ debtId: before.id, amountCents: 10000 })

    const after = (await engine.listDebts()).find((d) => d.name === 'Store card')!
    expect(after.balanceCents).toBe(30000)
    expect(after.balanceAsOf).toBe(TODAY)
    expect(after.state).toBe('open')
  })

  it('marks a debt paid off when the balance reaches zero and drops it from the ladder', async () => {
    const store = (await engine.listDebts()).find((d) => d.name === 'Store card')!
    await engine.confirmDebtPayment({ debtId: store.id, amountCents: 30000 })

    const after = (await engine.listDebts()).find((d) => d.name === 'Store card')!
    expect(after.balanceCents).toBe(0)
    expect(after.state).toBe('paid_off')

    const ladder = await engine.debtLadder()
    expect(ladder.map((r) => r.debt.name)).not.toContain('Store card')
  })

  it('never lets an overpayment drive a balance negative', async () => {
    const car = (await engine.listDebts()).find((d) => d.name === 'Car loan')!
    await engine.confirmDebtPayment({ debtId: car.id, amountCents: 99_999_999 })
    const after = (await engine.listDebts()).find((d) => d.name === 'Car loan')!
    expect(after.balanceCents).toBe(0)
    expect(after.state).toBe('paid_off')
  })

  it('records every payment in the append-only log', async () => {
    const rows = (
      await db.select().from(schema.events).where(eq(schema.events.kind, 'payment_confirmed'))
    ).filter((r) => r.householdId === householdId)
    expect(rows).toHaveLength(3)
  })

  it('warns about a promotional rate that is about to end', async () => {
    const promo = await engine.createDebt({
      name: 'Balance transfer',
      category: 'consumer',
      balanceCents: 120000,
      aprBasisPoints: 2699,
      minPaymentRule: { type: 'fixed', amountCents: 120000 },
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2026-10-19' }],
    })

    const warnings = await engine.promoWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.debt.id).toBe(promo.id)
    expect(warnings[0]!.monthlyToClearCents).toBe(120000)

    // And it jumps the queue when there is money that could clear it.
    const result = await engine.optimiseLumpSum(120000)
    expect(result.allocations[0]!.debtName).toBe('Balance transfer')
    expect(result.allocations[0]!.reason).toContain('promotional rate is about to end')
  })
})
