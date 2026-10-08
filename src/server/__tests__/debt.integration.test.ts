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

  it('keeps what the household actually pays each month, and can change it', async () => {
    const created = await engine.createDebt({
      name: 'Balance transfer',
      category: 'consumer',
      balanceCents: 500000,
      aprBasisPoints: 3049,
      minPaymentRule: { type: 'fixed', amountCents: 5000 },
      plannedPaymentCents: 50000,
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-09-19' }],
    })
    expect((await engine.listDebts()).find((d) => d.id === created.id)!.plannedPaymentCents).toBe(50000)
    // On track at $500 a month, so it really is a 0% debt, and spare money
    // goes at the card that costs something instead.
    const ladder = await engine.debtLadder()
    expect(ladder.find((r) => r.debt.id === created.id)!.effectiveAprBasisPoints).toBe(0)
    const onTrack = await engine.optimiseLumpSum(107500)
    expect(onTrack.allocations.map((a) => a.debtName)).toEqual(['Store card', 'Big card'])

    await engine.updateDebt(created.id, { plannedPaymentCents: null })
    expect((await engine.listDebts()).find((d) => d.id === created.id)!.plannedPaymentCents).toBeNull()
    // At the $50 minimum it cannot clear in time: now it is the cliff it
    // looks like, priced at the full 30.49%, and the remainder goes there.
    const cliff = await engine.optimiseLumpSum(107500)
    expect(cliff.allocations.map((a) => a.debtName)).toEqual(['Store card', 'Balance transfer'])
    expect(cliff.allocations[1]!.reason).toContain('30.49%')
    await engine.removeDebt(created.id)
  })

  it('answers where a lump sum should go', async () => {
    const result = await engine.optimiseLumpSum(107500)
    expect(result.allocations[0]!.debtName).toBe('Store card')
    expect(result.allocations[0]!.clearsIt).toBe(true)
    // The store card's $40 minimum goes, and the $675 left dents the big
    // card: 2% of $9,000 is $180, 2% of $8,325 is $166.50, so $13.50 a
    // month comes back from that too.
    expect(result.monthlyFreedCents).toBe(4000 + 1350)
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

  it('notes the facts as they stood on the payment that paid it off, for a future snowball (D37)', async () => {
    const store = (await engine.listDebts()).find((d) => d.name === 'Store card')!
    const payments = (await db.select().from(schema.events).where(eq(schema.events.kind, 'payment_confirmed')))
      .filter((r) => r.householdId === householdId)
      .map((r) => r.payload as { debt_id: string; amount_cents: number; paid_off?: Record<string, unknown> })
      .filter((p) => p.debt_id === store.id)
    expect(payments.map((p) => p.amount_cents)).toEqual([10000, 30000])
    // The $100 payment left $300 owing: nothing to note.
    expect(payments[0]!.paid_off).toBeUndefined()
    expect(payments[1]!.paid_off).toEqual({
      balance_before_cents: 30000,
      min_payment_rule: { type: 'fixed', amountCents: 4000 },
      planned_payment_cents: null,
      apr_basis_points: 2999,
      category: 'consumer',
    })
  })

  it('asks before a payment pays off a loan, and records nothing until it is answered (D37)', async () => {
    const car = (await engine.listDebts()).find((d) => d.name === 'Car loan')!
    await expect(engine.confirmDebtPayment({ debtId: car.id, amountCents: 99_999_999 })).rejects.toThrow(
      /would pay off Car loan/,
    )
    expect((await engine.listDebts()).find((d) => d.name === 'Car loan')).toMatchObject({
      balanceCents: 1200000,
      state: 'open',
    })
  })

  it('never lets an overpayment drive a balance negative', async () => {
    const car = (await engine.listDebts()).find((d) => d.name === 'Car loan')!
    await engine.confirmDebtPayment({ debtId: car.id, amountCents: 99_999_999, confirmPayoff: true })
    const after = (await engine.listDebts()).find((d) => d.name === 'Car loan')!
    expect(after.balanceCents).toBe(0)
    expect(after.state).toBe('paid_off')
  })

  it('a statement balance of $0 on a loan asks first too, and notes the payoff', async () => {
    const boat = await engine.createDebt({
      name: 'Boat loan',
      category: 'auto',
      balanceCents: 50000,
      aprBasisPoints: 799,
      minPaymentRule: { type: 'fixed', amountCents: 10000 },
    })
    await expect(engine.updateDebtBalance({ debtId: boat.id, balanceCents: 0 })).rejects.toThrow(
      /would pay off Boat loan/,
    )
    expect((await engine.listDebts()).find((d) => d.id === boat.id)!.balanceCents).toBe(50000)

    await engine.updateDebtBalance({ debtId: boat.id, balanceCents: 0, confirmPayoff: true })
    expect((await engine.listDebts()).find((d) => d.id === boat.id)!.state).toBe('paid_off')
    const updates = (await db.select().from(schema.events).where(eq(schema.events.kind, 'debt_balance_updated')))
      .map((r) => r.payload as { debt_id: string; paid_off?: Record<string, unknown> })
      .filter((p) => p.debt_id === boat.id)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.paid_off).toMatchObject({ balance_before_cents: 50000, category: 'auto', apr_basis_points: 799 })
  })

  it('refuses to add a car loan or mortgage that is already paid off', async () => {
    await expect(
      engine.createDebt({
        name: 'Old car',
        category: 'auto',
        balanceCents: 0,
        aprBasisPoints: 499,
        minPaymentRule: { type: 'fixed', amountCents: 30000 },
      }),
    ).rejects.toThrow(/already paid off/)
    expect((await engine.listDebts()).map((d) => d.name)).not.toContain('Old car')
  })

  it('refuses to turn an idle card into a car loan or mortgage, which would vanish as paid off', async () => {
    const store = (await engine.listDebts()).find((d) => d.name === 'Store card')!
    await expect(engine.updateDebt(store.id, { category: 'auto' })).rejects.toThrow(/already paid off/)
    expect((await engine.idleDebts()).map((d) => d.name)).toContain('Store card')
  })

  it('keeps a card with nothing owed on the idle list, and a typed balance puts it back in the order', async () => {
    // Paid off above: the card is idle, and the two loans are done and off the screen.
    expect((await engine.idleDebts()).map((d) => d.name)).toEqual(['Store card'])
    expect((await engine.paidOffLoans()).map((d) => d.name)).toEqual(['Boat loan', 'Car loan'])

    const spare = await engine.createDebt({
      name: 'Spare card',
      category: 'consumer',
      balanceCents: 0,
      aprBasisPoints: 2749,
      minPaymentRule: { type: 'percent_with_floor', basisPoints: 200, floorCents: 2500 },
      creditLimitCents: 800000,
    })
    expect((await engine.idleDebts()).map((d) => d.id)).toContain(spare.id)
    expect((await engine.debtLadder()).map((r) => r.debt.id)).not.toContain(spare.id)

    await engine.updateDebtBalance({ debtId: spare.id, balanceCents: 25000 })
    expect((await engine.idleDebts()).map((d) => d.id)).not.toContain(spare.id)
    expect((await engine.debtLadder()).map((r) => r.debt.id)).toContain(spare.id)

    await engine.removeDebt(spare.id)
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
