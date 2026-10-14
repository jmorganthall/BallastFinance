/**
 * PRD D49 (1)-(2): a payment marked done comes off the balance, whichever way
 * it was marked, and a debt's balance is the last one stated less the
 * payments marked done since.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('debt payments reach the balance', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  const TODAY = '2026-10-14'
  const STATED_ON = '2026-09-20'

  const balanceOf = async (name: string) => (await engine.listDebts()).find((d) => d.name === name)!

  const payByTodo = async (debtId: string, label: string, askedCents: number, actualCents?: number) => {
    const instructionId = await engine.issueInstruction({
      type: 'debt_payment',
      amountCents: askedCents,
      targetId: debtId,
      targetLabel: label,
    })
    await engine.confirmInstruction({ instructionId, actualAmountCents: actualCents })
    return instructionId
  }

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Debt payments ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })

    for (const name of ['Shield 0568', 'Shield 9795', 'Store card']) {
      await engine.createDebt({
        name,
        category: 'consumer',
        balanceCents: name === 'Store card' ? 20000 : 670239,
        balanceAsOf: STATED_ON,
        aprBasisPoints: 3049,
        minPaymentRule: { type: 'fixed', amountCents: 4000 },
      })
    }
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.debts).where(eq(schema.debts.householdId, householdId))
    }
    await client?.end()
  })

  it('"Done" on a pay-a-debt to-do takes what was paid off the balance', async () => {
    const debt = await balanceOf('Shield 0568')
    await payByTodo(debt.id, debt.name, 50000, 47500)

    const after = await balanceOf('Shield 0568')
    expect(after.balanceCents).toBe(670239 - 47500)
    // A payment is not a look at the statement: the balance is still as of then.
    expect(after.balanceAsOf).toBe(STATED_ON)
    expect(after.state).toBe('open')
  })

  it('takes the amount asked when no other amount was said', async () => {
    const debt = await balanceOf('Shield 9795')
    await payByTodo(debt.id, debt.name, 30300)
    expect((await balanceOf('Shield 9795')).balanceCents).toBe(670239 - 30300)
  })

  it('counts a to-do once however many times "Done" was pressed', async () => {
    const debt = await balanceOf('Shield 9795')
    const instructionId = await payByTodo(debt.id, debt.name, 10000)
    await engine.confirmInstruction({ instructionId })
    expect((await balanceOf('Shield 9795')).balanceCents).toBe(670239 - 30300 - 10000)
  })

  it('a payment on the form and one on a to-do both come off', async () => {
    const debt = await balanceOf('Shield 0568')
    await engine.confirmDebtPayment({ debtId: debt.id, amountCents: 2500 })
    const after = await balanceOf('Shield 0568')
    expect(after.balanceCents).toBe(670239 - 47500 - 2500)
    expect(after.balanceAsOf).toBe(STATED_ON)
  })

  it('a stated balance already includes what was paid before it; payments after it come off it', async () => {
    const debt = await balanceOf('Shield 0568')
    await engine.updateDebtBalance({ debtId: debt.id, balanceCents: 600000 })
    const stated = await balanceOf('Shield 0568')
    expect(stated.balanceCents).toBe(600000)
    expect(stated.balanceAsOf).toBe(TODAY)

    await payByTodo(debt.id, debt.name, 47500)
    expect((await balanceOf('Shield 0568')).balanceCents).toBe(600000 - 47500)
  })

  it('a to-do payment that clears the debt marks it paid off and takes it off the ladder', async () => {
    const debt = await balanceOf('Store card')
    await payByTodo(debt.id, debt.name, 25000)

    const after = await balanceOf('Store card')
    expect(after.balanceCents).toBe(0)
    expect(after.state).toBe('paid_off')
    expect((await engine.debtLadder()).map((r) => r.debt.name)).not.toContain('Store card')
  })

  it('a to-do that is not a debt payment leaves every debt alone', async () => {
    const before = await engine.listDebts()
    const instructionId = await engine.issueInstruction({
      type: 'one_time_move',
      amountCents: 10000,
      targetId: before[0]!.id,
      targetLabel: 'Not a debt payment',
    })
    await engine.confirmInstruction({ instructionId })
    expect((await engine.listDebts()).map((d) => d.balanceCents)).toEqual(before.map((d) => d.balanceCents))
  })
})
