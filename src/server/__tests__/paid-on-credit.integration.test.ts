/**
 * Paid on credit (asked for by the household on Nov 27, 2026), against a live
 * database: a plan's spend goes on a card, This week asks for one move to the
 * bills account and then one payment to the card, and the card shows the
 * charge until it is paid while the payoff math never sees it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, EngineError } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('paid on credit', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let disneyId: string
  let billsId: string
  let packageId: string
  let ticketsId: string
  let hotelId: string
  let deltaId: string
  let engine: Engine
  const TODAY = '2026-11-27'

  const credit = async () => (await engine.view()).household.todos.filter((t) => t.from === 'credit')
  const delta = async () => (await engine.listDebts()).find((d) => d.id === deltaId)!
  const disney = async () => (await engine.position()).accounts.find((a) => a.account.id === disneyId)!

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Paid on credit ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })

    disneyId = (await engine.createReserveAccount({ name: 'Disney', institutionLabel: 'Cap One' })).id
    billsId = (await engine.createReserveAccount({ name: 'Joint checking', institutionLabel: 'Cap One' })).id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Disney 2027' },
      line_items: [
        { label: 'Park tickets', unit_amount: '500', due_date: '2026-12-20', reserve_account: disneyId },
        { label: 'Hotel deposit', unit_amount: '300', due_date: '2026-12-20', reserve_account: disneyId },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    packageId = created.packageId
    await engine.commitPackage(packageId)
    const parts = (await engine.listLineItems()).filter((li) => li.packageId === packageId)
    ticketsId = parts.find((li) => li.label === 'Park tickets')!.id
    hotelId = parts.find((li) => li.label === 'Hotel deposit')!.id
    await engine.confirmBalance({ reserveAccountId: disneyId, amountCents: 80000 })
    deltaId = (await engine.createDebt({
      name: 'Delta Reserve',
      category: 'consumer',
      balanceCents: 100000,
      balanceAsOf: TODAY,
      aprBasisPoints: 2499,
      minPaymentRule: { type: 'fixed', amountCents: 4000 },
    })).id
    await engine.setBillsAccount({ kind: 'reserve_account', accountId: billsId })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.debts).where(eq(schema.debts.householdId, householdId))
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('only a card or line of credit can be paid on', async () => {
    const carId = (await engine.createDebt({
      name: 'Car loan',
      category: 'auto',
      balanceCents: 900000,
      balanceAsOf: TODAY,
      aprBasisPoints: 500,
      minPaymentRule: { type: 'fixed', amountCents: 30000 },
    })).id
    await expect(engine.recordSpend({ lineItemId: ticketsId, amountCents: 100, debtId: carId })).rejects.toThrow(EngineError)
  })

  it('records the charges as spends, shows them on the card, and asks for one move', async () => {
    await engine.recordSpend({ lineItemId: ticketsId, amountCents: 12000, debtId: deltaId })
    await engine.recordSpend({ lineItemId: hotelId, amountCents: 5000, debtId: deltaId })

    expect((await disney()).money.totalCents).toBe(80000 - 17000)
    const card = await delta()
    expect(card.balanceCents).toBe(100000)
    expect(card.onCardFromPlansCents).toBe(17000)

    const todos = await credit()
    expect(todos).toHaveLength(1)
    expect(todos[0]!.todo).toMatchObject({ kind: 'move_to_bills', fromAccountId: disneyId, amountCents: 17000, toName: 'Joint checking' })
    expect((await engine.view()).household.caughtUp).toBe(false)
  })

  it('refuses a move for charges other than the ones open', async () => {
    const todo = (await credit())[0]!.todo
    await expect(
      engine.confirmCreditMove({ fromAccountId: disneyId, chargeIds: todo.charges.slice(0, 1).map((c) => c.chargeId) }),
    ).rejects.toThrow(EngineError)
  })

  it('after the move asks for one payment, and the charges can no longer be taken back', async () => {
    const todo = (await credit())[0]!.todo
    await engine.confirmCreditMove({ fromAccountId: disneyId, chargeIds: todo.charges.map((c) => c.chargeId) })

    const after = await credit()
    expect(after.map((t) => t.todo)).toEqual([
      expect.objectContaining({ kind: 'pay_card', debtId: deltaId, amountCents: 17000, fromName: 'Joint checking' }),
    ])
    // Moving changes no figure a second time.
    expect((await disney()).money.totalCents).toBe(80000 - 17000)

    const spend = (await engine.roundHistory(packageId)).find((e) => e.kind === 'spend')!
    expect(spend.debtId).toBe(deltaId)
    expect(spend.settled).toBe(true)
    await expect(engine.undoRoundEvent({ eventId: spend.eventId })).rejects.toThrow(EngineError)
  })

  it('after the payment the card is back to its balance and nothing is left to do', async () => {
    const todo = (await credit())[0]!.todo
    await engine.confirmCreditPayoff({ debtId: deltaId, chargeIds: todo.charges.map((c) => c.chargeId) })

    expect(await credit()).toEqual([])
    const card = await delta()
    expect(card.balanceCents).toBe(100000)
    expect(card.onCardFromPlansCents).toBeUndefined()
    expect(card.state).toBe('open')
    expect((await engine.debtHistory(deltaId)).map((e) => e.kind)).toEqual([
      'stated',
      'charged_from_plan',
      'charged_from_plan',
      'paid_from_plans',
    ])
  })

  it('skips the move for a plan held in the bills account', async () => {
    await engine.setBillsAccount({ kind: 'reserve_account', accountId: disneyId })
    await engine.recordSpend({ lineItemId: ticketsId, amountCents: 3000, debtId: deltaId })
    expect((await credit()).map((t) => t.todo)).toEqual([
      expect.objectContaining({ kind: 'pay_card', amountCents: 3000, fromName: 'Disney' }),
    ])
  })
})
