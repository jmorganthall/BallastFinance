/**
 * Every write to a money fact goes with its event (the layering plan's
 * Phase 4, docs/data-flow.md): creating an account, a plan or a debt;
 * renaming a plan; a part's date moved on by its rounds; a one-off retired
 * by its finished round; a debt's balance taken to zero by a payment; and a
 * setting changed twice in a day, which is two rows, the later the setting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('every money fact is written with its event (Phase 4)', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  const pin = (today: string) => {
    engine = new Engine({ householdId, actorUserId: null, db, today })
  }
  const logged = async (kind: (typeof schema.eventKindEnum.enumValues)[number]) =>
    (
      await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, kind)))
        .orderBy(schema.events.recordedAt, schema.events.id)
    ).map((e) => e.payload as Record<string, unknown>)

  beforeAll(async () => {
    client = postgres(url!, { max: 2, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Logged ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    pin('2026-09-19')
  })

  afterAll(async () => {
    await client.end()
  })

  it('records an account, a plan, a new name and a debt as they are made', async () => {
    const account = await engine.createReserveAccount({ name: 'Gifts', institutionLabel: 'C1' })
    expect(await logged('account_added')).toEqual([
      expect.objectContaining({ reserve_account_id: account.id, name: 'Gifts', scope: 'household' }),
    ])

    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Party' },
      line_items: [{ label: 'Party', unit_amount: '500', due_date: '2026-10-03', reserve_account: account.id }],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    expect(await logged('package_created')).toEqual([
      expect.objectContaining({
        package_id: created.packageId,
        name: 'Party',
        line_items: [expect.objectContaining({ line_item_id: created.lineItemIds[0], unit_amount_cents: 50000, due_date: '2026-10-03' })],
      }),
    ])

    await engine.renamePackage(created.packageId, 'Birthday party')
    // Saving the same name again changes nothing, and records nothing.
    await engine.renamePackage(created.packageId, 'Birthday party')
    expect(await logged('package_renamed')).toEqual([
      { package_id: created.packageId, before: 'Party', after: 'Birthday party' },
    ])

    const debt = await engine.createDebt({
      name: 'Card',
      category: 'consumer',
      balanceCents: 30000,
      aprBasisPoints: 2499,
      minPaymentRule: { type: 'fixed', amountCents: 5000 },
      balanceAsOf: '2026-09-15',
    })
    expect(await logged('debt_added')).toEqual([
      expect.objectContaining({ debt_id: debt.id, balance_cents: 30000, as_of: '2026-09-15' }),
    ])
    // The balance it was entered with opens its history.
    expect(await engine.debtHistory(debt.id)).toEqual([{ on: '2026-09-15', kind: 'stated', amountCents: 30000 }])

    // A payment that clears it writes the zero with an event; the history
    // lists the payment once, not a second "stated $0".
    await engine.confirmDebtPayment({ debtId: debt.id, amountCents: 30000 })
    expect(await logged('debt_balance_updated')).toEqual([
      expect.objectContaining({ debt_id: debt.id, balance_cents: 0, cleared_by_payment: true }),
    ])
    expect((await engine.debtHistory(debt.id)).map((e) => e.kind)).toEqual(['stated', 'paid'])
  })

  it('records a part moved on by its rounds, and a one-off its round retired', async () => {
    const [account] = await engine.listReserveAccounts()
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Yearly' },
      line_items: [
        { label: 'Yearly', unit_amount: '100', due_date: '2026-10-03', reserve_account: account!.id, recurrence: { every: 1, unit: 'year' } },
        { label: 'Once', unit_amount: '50', due_date: '2026-10-10', reserve_account: account!.id },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
    const [yearlyId, onceId] = created.lineItemIds

    // Past the date, the round is finished: the part's stored date moves on a year.
    pin('2026-10-05')
    await engine.finishRound({ lineItemId: yearlyId! })
    await engine.finishRound({ lineItemId: onceId! })
    const changes = (await logged('line_item_changed')).filter((c) => c.reason === 'rounds')
    expect(changes).toEqual([
      expect.objectContaining({
        line_item_id: yearlyId,
        before: expect.objectContaining({ dueDate: '2026-10-03' }),
        after: expect.objectContaining({ dueDate: '2027-10-03' }),
      }),
      expect.objectContaining({ line_item_id: onceId, state: { before: 'accruing', after: 'retired' } }),
    ])
    // The log and the rows agree.
    const items = await engine.listLineItems()
    expect(items.find((i) => i.id === yearlyId)!.dueDate).toBe('2027-10-03')
    expect(items.find((i) => i.id === onceId)!.state).toBe('retired')
  })

  it('keeps a setting changed twice in a day as two rows, the later the setting', async () => {
    await engine.setTransferWeekday(5)
    await engine.setTransferWeekday(3)
    expect(await engine.transferWeekday()).toBe(3)
    const rows = await db
      .select()
      .from(schema.settings)
      .where(and(eq(schema.settings.householdId, householdId), eq(schema.settings.key, 'transfer_weekday')))
    expect(rows.map((r) => r.value).sort()).toEqual([3, 5])
  })

  it("opens an older debt's history with its balance while untouched, and with the day it was entered once paid", async () => {
    // A debt as it was entered before Phase 4: a row, no debt_added.
    const [row] = await db
      .insert(schema.debts)
      .values({
        householdId,
        name: 'Old card',
        category: 'consumer',
        balanceCents: 120000,
        balanceAsOf: '2026-08-01',
        aprBasisPoints: 2499,
        promoRules: [],
        minPaymentRule: { type: 'fixed', amountCents: 4000 },
        state: 'open',
        enteredOn: '2026-08-03',
      })
      .returning()
    expect(await engine.debtHistory(row!.id)).toEqual([{ on: '2026-08-01', kind: 'stated', amountCents: 120000 }])

    await engine.confirmDebtPayment({ debtId: row!.id, amountCents: 4000 })
    const history = await engine.debtHistory(row!.id)
    expect(history[0]).toEqual({ on: '2026-08-03', kind: 'entered' })
    expect(history.map((e) => e.kind)).toEqual(['entered', 'paid'])
  })
})
