/**
 * The transfer day is a household setting (PRD D31). Asserts what the app
 * produces once a household says its money moves on Fridays: the setting
 * reads back, every weekly figure counts Fridays, and nothing derived was
 * stored to go stale.
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

describeDb('the transfer day setting', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `Transfer day ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id

    // Saturday 19 Sep 2026.
    engine = new Engine({ householdId, actorUserId: null, db, today: '2026-09-19' })

    const account = await engine.createReserveAccount({
      name: 'Annual Expenses',
      institutionLabel: 'Capital One 360 — Annual Expenses',
    })
    accountId = account.id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Tickets' },
      line_items: [
        // Due Friday 15 Jan 2027: 16 Saturdays away, 17 Fridays.
        { label: 'Park tickets', unit_amount: '600', quantity: 1, due_date: '2027-01-15', reserve_account: account.id },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
    await engine.putSetting('transfer_round_up_cents', 0)
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.settings).where(eq(schema.settings.householdId, householdId))
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db
        .delete(schema.reserveAccounts)
        .where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('is Saturday until a person picks a day', async () => {
    expect(await engine.transferWeekday()).toBe(6)
    const [view] = await engine.accountViews()
    expect(view!.weekly.totalPerWeekCents).toBe(Math.ceil(60000 / 16))
  })

  it('refuses anything that is not a day of the week', async () => {
    for (const bad of [7, -1, 2.5, NaN]) {
      await expect(engine.setTransferWeekday(bad)).rejects.toThrow(/day of the week/)
    }
    expect(await engine.transferWeekday()).toBe(6)
  })

  it('reads back the day it was given, and every weekly figure follows it', async () => {
    await engine.setTransferWeekday(5)
    expect(await engine.transferWeekday()).toBe(5)

    const [view] = await engine.accountViews()
    expect(view!.weekly.totalPerWeekCents).toBe(Math.ceil(60000 / 17))
    expect(view!.items[0]!.components[0]!.weeks).toBe(17)

    // The setting is a dated row like every other rule; nothing derived is stored.
    const rows = await db
      .select()
      .from(schema.settings)
      .where(and(eq(schema.settings.householdId, householdId), eq(schema.settings.key, 'transfer_weekday')))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.value).toBe(5)
    expect(rows[0]!.effectiveFrom).toBe('2026-09-19')
  })

  it('steps should-hold on the Friday once the day is Friday', async () => {
    const friday = new Engine({ householdId, actorUserId: null, db, today: '2026-09-25' })
    const [onFriday] = await friday.accountViews()
    expect(onFriday!.shouldHaveSavedCents).toBe(Math.ceil(60000 / 17))
    expect(onFriday!.account.id).toBe(accountId)

    const thursday = new Engine({ householdId, actorUserId: null, db, today: '2026-09-24' })
    const [onThursday] = await thursday.accountViews()
    expect(onThursday!.shouldHaveSavedCents).toBe(0)
  })

  it('reads an unreadable stored value as the default rather than breaking', async () => {
    await engine.putSetting('transfer_weekday', 'friday')
    expect(await engine.transferWeekday()).toBe(6)
    await engine.setTransferWeekday(0)
    expect(await engine.transferWeekday()).toBe(0)
  })
})
