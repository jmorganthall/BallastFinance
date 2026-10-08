/**
 * A plan never rolls over on its own (PRD §5, the one position, Step 2).
 *
 * When a repeating part's due date passes, nothing moves until a person
 * answers "Did this get spent?": the due date stays where it was, the part
 * is still owed in full as of today, and the account has to keep holding all
 * of it -- weeks or months later. Only confirming the spend rolls the part to
 * its next occurrence and starts the next cycle at $0.
 *
 * The household's transfer day is the default, Saturday, throughout.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION, type AccountPosition } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('a repeating plan is held in full until its spend is confirmed', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string
  let insuranceId: string

  const pin = (date: string) => {
    engine = new Engine({ householdId, actorUserId: null, db, today: date })
  }
  const account = async (): Promise<AccountPosition> =>
    (await engine.position()).accounts.find((a) => a.account.id === accountId)!
  const stored = async () => (await engine.listLineItems()).find((i) => i.id === insuranceId)!

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Held ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id

    // Saturday 19 Sep 2026. The yearly $1,200 insurance is due Saturday
    // 21 Nov; the account already holds all of it, and the bank moves $25
    // every Saturday.
    pin('2026-09-19')
    accountId = (
      await engine.createReserveAccount({
        name: 'Annual Expenses',
        institutionLabel: 'Capital One 360 — Annual Expenses',
      })
    ).id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Car insurance' },
      line_items: [
        {
          label: 'Insurance',
          unit_amount: '1200',
          quantity: 1,
          due_date: '2026-11-21',
          recurrence: 'year',
          reserve_account: accountId,
        },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
    insuranceId = (await engine.listLineItems())[0]!.id
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 120000 })
    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 2500 })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db
        .delete(schema.reserveAccounts)
        .where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('two weeks past its due date: the date has not moved and all $1,200 is still owed today', async () => {
    pin('2026-12-05')
    expect(await stored()).toMatchObject({ dueDate: '2026-11-21', state: 'accruing' })
    expect((await engine.closeOutPrompts()).map((p) => p.lineItemId)).toEqual([insuranceId])

    const a = await account()
    expect(a.parts).toHaveLength(1)
    expect(a.parts[0]).toMatchObject({
      isOverdue: true,
      outflowDate: '2026-12-05',
      totalCents: 120000,
      savedForCents: 120000,
      countedCents: 120000,
    })
    // The $1,200 count plus eleven Saturdays in (Sep 19, Dec 5] at $25.
    expect(a.money.totalCents).toBe(147500)
    expect(a.status).toBe('on_track')
  })

  it('six months past it, still nothing has moved', async () => {
    pin('2027-06-05')
    expect(await stored()).toMatchObject({ dueDate: '2026-11-21', state: 'accruing' })
    expect((await engine.closeOutPrompts())[0]).toMatchObject({ lineItemId: insuranceId, daysOverdue: 196 })

    const a = await account()
    expect(a.parts[0]).toMatchObject({
      isOverdue: true,
      outflowDate: '2027-06-05',
      savedForCents: 120000,
      countedCents: 120000,
    })
    // Thirty-seven Saturdays in (Sep 19, Jun 5] at $25 on top of the count.
    expect(a.money.totalCents).toBe(212500)
  })

  it('an account holding less than the whole amount is Short today, not next cycle', async () => {
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 100000 })
    const a = await account()
    expect(a.status).toBe('short')
    // Short today by at least the $200 of the bill that is not there. (The
    // run-forward also asks for the next round's share so far, Step 3; that
    // is not what this pins.)
    expect(a.short!.on).toBe('2027-06-05')
    expect(a.short!.byCents).toBeGreaterThanOrEqual(20000)
  })

  it('confirming the spend is what rolls it on and starts the next cycle at $0', async () => {
    await engine.confirmSpend({ lineItemId: insuranceId, actualAmountCents: 100000 })

    expect(await stored()).toMatchObject({ dueDate: '2027-11-21', state: 'accruing' })
    expect(await engine.closeOutPrompts()).toEqual([])
    const a = await account()
    expect(a.parts[0]).toMatchObject({
      isOverdue: false,
      outflowDate: '2027-11-21',
      savingSince: { date: '2027-06-05', reason: 'spent' },
      savedForCents: 0,
    })
    expect(a.money).toMatchObject({ startCents: 100000, spendsSinceCents: 100000, totalCents: 0 })
  })
})
