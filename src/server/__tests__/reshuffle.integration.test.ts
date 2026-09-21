/**
 * Reshuffle, end to end: a plan committed with the whole of a far-off bill
 * already counted, re-spread through the engine, and what the screens then
 * derive from the recorded events.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('reshuffle', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string
  let progressiveId: string
  const TODAY = '2026-09-19'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Reshuffle ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    accountId = (
      await engine.createReserveAccount({
        name: 'Annual Expenses',
        institutionLabel: 'Capital One 360 — Annual Expenses',
      })
    ).id

    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Annual bills', module: 'manual' },
      line_items: [
        { label: 'Soon', unit_amount: 400, quantity: 1, due_date: '2026-10-17', reserve_account: accountId },
        {
          label: 'Progressive Auto Insurance',
          unit_amount: 844,
          quantity: 1,
          due_date: '2027-01-09',
          reserve_account: accountId,
          recurrence: { every: 6, unit: 'month' },
        },
        { label: 'Far', unit_amount: 4000, quantity: 1, due_date: '2027-06-26', reserve_account: accountId },
      ],
    })
    if (!created.ok) throw new Error(created.problems.map((p) => p.message).join(' '))
    const items = await engine.listLineItems()
    progressiveId = items.find((i) => i.label === 'Progressive Auto Insurance')!.id
    // The spreadsheet had the whole $844 reserved for the bill four months out.
    await engine.commitPackage(created.packageId, { openingByLineItem: { [progressiveId]: 84400 } })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('shows the far-off bill fully funded while a nearer part saves every week', async () => {
    const view = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    const progressive = view.items.find((i) => i.lineItem.id === progressiveId)!
    expect(progressive.shouldHaveSavedCents).toBe(84400)
    expect(progressive.paceSince).toBe('2026-07-09')
    expect(progressive.paceCents).toBe(34386)
    expect(view.weekly.totalPerWeekCents).toBe(20000)
  })

  it('previews without recording anything', async () => {
    const plan = (await engine.reshufflePreview(accountId))!
    expect(plan.openings.map((o) => o.openingCents)).toEqual([40000, 44400])
    expect(plan.perWeekNowCents).toBe(20000)
    expect(plan.perWeekAfterCents).toBe(12500)
    const view = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(view.weekly.totalPerWeekCents).toBe(20000)
  })

  it('records each changed part as counted today, and the screens agree with the preview', async () => {
    const plan = (await engine.reshuffleAccount(accountId))!
    const view = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(view.weekly.totalPerWeekCents).toBe(plan.perWeekAfterCents)
    // The account's total is untouched: only where it is counted moved.
    expect(view.shouldHaveSavedCents).toBe(84400)
    const progressive = view.items.find((i) => i.lineItem.id === progressiveId)!
    expect(progressive.shouldHaveSavedCents).toBe(44400)
    expect(progressive.weekly.totalPerWeekCents).toBe(2500)

    const cycles = await engine.listCycleStarts()
    expect(cycles.map((c) => c.origin)).toEqual(['commit', 'counted', 'counted'])
    // Progressive's pace still runs from July: a count never moves the clock.
    expect(progressive.paceSince).toBe('2026-07-09')
  })

  it('then finds nothing more to change', async () => {
    const again = (await engine.reshuffleAccount(accountId))!
    expect(again.openings).toEqual([])
    expect((await engine.listCycleStarts()).length).toBe(3)
  })
})
