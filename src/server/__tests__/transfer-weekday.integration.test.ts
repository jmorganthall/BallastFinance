/**
 * The transfer day is a household setting (PRD D31). Asserts what the app
 * produces once a household says its money moves on Fridays: the setting
 * reads back, every figure in the position counts Fridays -- the weekly
 * amount, a part's steady line, the transfers that have arrived, and whether
 * the transfer set up at the bank reaches the due date -- and nothing derived
 * was stored to go stale.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION, transferWeeksBetween, type AccountPosition } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('the transfer day setting', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string

  const on = (today: string) => new Engine({ householdId, actorUserId: null, db, today })
  const accountOf = async (e: Engine): Promise<AccountPosition> =>
    (await e.position()).accounts.find((a) => a.account.id === accountId)!

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `Transfer day ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id

    // Saturday 19 Sep 2026.
    engine = on('2026-09-19')

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
    expect(transferWeeksBetween('2026-09-19', '2027-01-15', 6)).toBe(16)

    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    // 60,000 / 16 = 3,750 exactly.
    expect(a.weeklyExactCents).toBe(3750)
    expect(a.parts[0]!.steadyPerWeekCents).toBe(3750)
    expect(p.todos).toEqual([expect.objectContaining({ kind: 'set_transfer', reason: 'confirm', toCents: 3750 })])
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
    expect(transferWeeksBetween('2026-09-19', '2027-01-15', 5)).toBe(17)

    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    // 60,000 / 17 = 3,529.4 -> 3,530.
    expect(a.weeklyExactCents).toBe(3530)
    expect(a.parts[0]!.steadyPerWeekCents).toBe(3530)
    expect(p.todos).toEqual([expect.objectContaining({ kind: 'set_transfer', reason: 'confirm', toCents: 3530 })])

    // The setting is a dated row like every other rule; nothing derived is stored.
    const rows = await db
      .select()
      .from(schema.settings)
      .where(and(eq(schema.settings.householdId, householdId), eq(schema.settings.key, 'transfer_weekday')))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.value).toBe(5)
    expect(rows[0]!.effectiveFrom).toBe('2026-09-19')
  })

  it("steps a part's steady line on the Friday once the day is Friday", async () => {
    // One Friday of 17 in (Sep 19, Sep 25]: ceil(60,000 / 17) = 3,530.
    const onFriday = await accountOf(on('2026-09-25'))
    expect(onFriday.parts[0]!.savedForCents).toBe(3530)

    // No Friday yet in (Sep 19, Sep 24].
    const onThursday = await accountOf(on('2026-09-24'))
    expect(onThursday.parts[0]!.savedForCents).toBe(0)
  })

  it('counts the transfer set up at the bank on the household day, and re-derives when the day changes', async () => {
    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 3530 })

    // Friday: 17 transfers of $35.30 = 60,010 >= 60,000 by the due date.
    let p = await engine.position()
    let a = p.accounts.find((x) => x.account.id === accountId)!
    expect(a.status).toBe('on_track')
    // The next transfer is Friday Sep 25, one transfer at $35.30.
    expect(a.bank).toEqual({ perWeekCents: 3530, confirmedOn: '2026-09-19', nextWeekCents: 3530 })
    expect(p.todos).toEqual([])
    // Two Fridays in (Sep 19, Oct 2] have arrived: 2 x 3,530.
    expect((await accountOf(on('2026-10-02'))).money).toMatchObject({
      from: 'nothing',
      on: '2026-09-19',
      transfersSinceCents: 7060,
      totalCents: 7060,
    })

    // The same bank transfer on Saturdays: 16 x 3,530 = 56,480, which is
    // 3,520 short of 60,000 on the due date, and the ask is back to 3,750.
    await engine.setTransferWeekday(6)
    p = await engine.position()
    a = p.accounts.find((x) => x.account.id === accountId)!
    expect(a.status).toBe('short')
    expect(a.short).toEqual({ on: '2027-01-15', byCents: 3520 })
    expect(a.weeklyExactCents).toBe(3750)
    expect(p.todos).toEqual([
      {
        kind: 'set_transfer',
        accountId,
        accountName: 'Annual Expenses',
        fromCents: 3530,
        toCents: 3750,
        reason: 'raise',
        blocking: true,
      },
    ])
    // One Saturday in (Sep 19, Oct 2].
    expect((await accountOf(on('2026-10-02'))).money.transfersSinceCents).toBe(3530)

    // Back to Friday: nothing was stored, so nothing is left over from Saturday.
    await engine.setTransferWeekday(5)
    a = await accountOf(engine)
    expect(a.status).toBe('on_track')
    expect(a.short).toBeNull()
  })

  it('reads an unreadable stored value as the default rather than breaking', async () => {
    await engine.putSetting('transfer_weekday', 'friday')
    expect(await engine.transferWeekday()).toBe(6)
    await engine.setTransferWeekday(0)
    expect(await engine.transferWeekday()).toBe(0)
  })
})
