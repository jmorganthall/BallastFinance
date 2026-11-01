/**
 * One snapshot per page, and an export that is the whole household
 * (docs/data-flow.md). A page reads through `Engine.reading`, so a write
 * landing between two of its reads is seen by neither; the export reads
 * every table the household owns, trips' own facts included, in that same
 * kind of snapshot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('one snapshot per page, and the whole household in the export', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let engine: Engine
  let accountId: string

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Reading ${crypto.randomUUID()}` }).returning()
    engine = new Engine({ householdId: household!.id, actorUserId: null, db, today: '2026-09-19' })
    accountId = (await engine.createReserveAccount({ name: 'Gifts', institutionLabel: 'C1' })).id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Party' },
      line_items: [{ label: 'Party', unit_amount: '500', due_date: '2026-12-05', reserve_account: accountId }],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 10000 })
  })

  afterAll(async () => {
    await client.end()
  })

  const holds = async (e: Engine) => (await e.position()).accounts.find((a) => a.account.id === accountId)!.money.totalCents

  it('never shows a page half before a write and half after', async () => {
    const seen = await engine.reading(async (page) => {
      const first = await holds(page)
      // Someone records a count while the page is being read.
      await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 25000 })
      const second = await holds(page)
      const view = await page.view()
      return { first, second, inView: view.position.accounts.find((a) => a.account.id === accountId)!.money.totalCents }
    })
    expect(seen).toEqual({ first: 10000, second: 10000, inView: 10000 })
    // The next page drawn sees it.
    expect(await holds(engine)).toBe(25000)
  })

  it('refuses a write inside a page’s read', async () => {
    await expect(
      engine.reading((page) => page.confirmBalance({ reserveAccountId: accountId, amountCents: 1 })),
    ).rejects.toThrow()
  })

  it('exports every table the household owns, trips’ own facts and the whole log included', async () => {
    await engine.createDebt({
      name: 'Card',
      category: 'consumer',
      balanceCents: 30000,
      aprBasisPoints: 2499,
      minPaymentRule: { type: 'fixed', amountCents: 5000 },
    })
    const trip = await engine.createTrip({
      name: 'Disney',
      startDate: '2027-03-06',
      endDate: '2027-03-12',
      travelers: [{ name: 'Bo', band: 'adult' }],
      car: null,
    })
    const out = await engine.exportAll()
    expect(Object.keys(out).sort()).toEqual(
      [
        'assets',
        'debts',
        'events',
        'income_payments',
        'income_sources',
        'line_items',
        'lodging_quotes',
        'members',
        'packages',
        'recurring_expenses',
        'reserve_accounts',
        'school_days_off',
        'school_year_days',
        'settings',
        'trip_days',
        'trip_lines',
        'trip_reservations',
        'trip_tasks',
        'trip_variants',
        'trips',
      ].sort(),
    )
    expect(out.reserve_accounts).toHaveLength(1)
    expect(out.debts).toHaveLength(1)
    expect(out.trips).toEqual([expect.objectContaining({ id: trip.id })])
    expect(out.trip_days!.length).toBeGreaterThan(0)
    // The log comes in the order it was recorded, the account's creation first.
    expect((out.events![0] as { kind: string }).kind).toBe('account_added')
  })
})
