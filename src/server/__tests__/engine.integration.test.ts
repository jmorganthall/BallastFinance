/**
 * End-to-end against a real PostgreSQL, because the Phase A acceptance
 * criterion (PRD §12) is about what the APP produces, not what a pure function
 * returns: "the Disney package is recreated in the app and the per-account
 * weekly instruction matches the sheet's math".
 *
 * Skipped automatically when no database is configured, so the unit suite still
 * runs anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION, formatCents } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('engine against a live database', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let annualId: string
  let longTermId: string

  // A fixed "today" so the expected figures never drift with the calendar.
  const TODAY = '2026-09-19'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `Test ${crypto.randomUUID()}`, timezone: 'America/Chicago' })
      .returning()
    householdId = household!.id

    engine = new Engine({ householdId, actorUserId: null, db })
    // Pin the clock.
    Object.defineProperty(engine, 'today', { value: () => TODAY })

    annualId = (await engine.createReserveAccount({
      name: 'Annual Expenses',
      institutionLabel: 'Capital One 360 — Annual Expenses',
    })).id
    longTermId = (await engine.createReserveAccount({
      name: 'Long Term Savings',
      institutionLabel: 'Capital One 360 — Long Term Savings',
    })).id
  })

  afterAll(async () => {
    if (householdId) {
      // events blocks DELETE by design, so clear it as owner via TRUNCATE-free path:
      // household cascade would hit the trigger, so drop child rows we control first.
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db
        .delete(schema.reserveAccounts)
        .where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('refuses an intake that does not resolve, without writing anything', async () => {
    const before = (await engine.listPackages()).length
    const result = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Broken' },
      line_items: [
        { label: 'x', unit_amount: '100', quantity: 1, due_date: '2027-01-16', reserve_account: 'Nope' },
      ],
    })
    expect(result.ok).toBe(false)
    expect((await engine.listPackages()).length).toBe(before)
  })

  it('creates the Disney package as a draft that costs nothing yet', async () => {
    const result = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Disney Feb 2027', module: 'manual' },
      line_items: [
        { label: 'Park tickets', unit_amount: '600', quantity: 1, due_date: '2027-01-16', reserve_account: 'Annual Expenses' },
        { label: 'Airfare', unit_amount: '450', quantity: 1, due_date: '2026-11-21', reserve_account: 'Annual Expenses' },
        { label: 'Lodging', unit_amount: '1200', quantity: 1, due_date: '2027-01-16', reserve_account: 'Long Term Savings' },
      ],
    })
    expect(result.ok).toBe(true)

    const [pkg] = await engine.listPackages()
    expect(pkg!.state).toBe('simulated')
    expect(pkg!.committedAt).toBeNull()

    // A draft moves no money.
    for (const view of await engine.accountViews()) {
      expect(view.weekly.totalPerWeekCents).toBe(0)
    }
  })

  it('prices what committing it would demand, before committing', async () => {
    const [pkg] = await engine.listPackages()
    const lines = await engine.whatIf(pkg!.id)

    expect(lines.length).toBe(2)
    const annual = lines.find((l) => l.accountId === annualId)!
    expect(annual.currentPerWeekCents).toBe(0)
    expect(annual.addedPerWeekCents).toBeGreaterThan(0)

    // Asking the question did not change the live numbers.
    for (const view of await engine.accountViews()) {
      expect(view.weekly.totalPerWeekCents).toBe(0)
    }
  })

  it('commits with $0 reserved and starts the accruals', async () => {
    const [pkg] = await engine.listPackages()
    await engine.commitPackage(pkg!.id)

    const [committed] = await engine.listPackages()
    expect(committed!.state).toBe('active')
    expect(committed!.committedAt).toBe(TODAY)

    const views = await engine.accountViews()
    // Nothing saved yet on day one...
    expect(views.every((v) => v.shouldHaveSavedCents === 0)).toBe(true)
    // ...but every account now has a number to move.
    expect(views.every((v) => v.weekly.totalPerWeekCents > 0)).toBe(true)
  })

  it('refuses to commit twice', async () => {
    const [pkg] = await engine.listPackages()
    await expect(engine.commitPackage(pkg!.id)).rejects.toThrow(/already committed/)
  })

  it('adds two travelers and produces a new decomposed instruction', async () => {
    const before = (await engine.accountViews()).find((v) => v.account.id === annualId)!
    const beforeWeekly = before.weekly.totalPerWeekCents
    expect(before.weekly.catchUp).toHaveLength(0) // nothing but the base plan yet

    const tickets = (await engine.listLineItems()).find((li) => li.label === 'Park tickets')!
    await engine.updateLineItem(tickets.id, { quantity: 3 })

    const after = (await engine.accountViews()).find((v) => v.account.id === annualId)!

    // The ongoing part is untouched; the increase arrives as a dated catch-up.
    expect(after.weekly.ongoingPerWeekCents).toBe(before.weekly.ongoingPerWeekCents)
    expect(after.weekly.catchUp).toHaveLength(1)
    expect(after.weekly.catchUp[0]!.endDate).toBe('2027-01-16')
    expect(after.weekly.totalPerWeekCents).toBeGreaterThan(beforeWeekly)

    // The parts add up to the headline number a human types into the bank.
    const parts =
      after.weekly.ongoingPerWeekCents +
      after.weekly.catchUp.reduce((s, g) => s + g.perWeekCents, 0)
    expect(parts).toBe(after.weekly.totalPerWeekCents)

    // Two more travelers at $600 is $1,200 more to find.
    expect(after.outstandingCents - before.outstandingCents).toBe(120000)
  })

  it('records the edit as an event rather than overwriting history', async () => {
    const changes = await engine.listLineItemChanges()
    expect(changes).toHaveLength(1)
    expect(changes[0]!.before.quantity).toBe(1)
    expect(changes[0]!.after.quantity).toBe(3)
  })

  it('does not record an event for an edit that moves no money', async () => {
    const before = (await engine.listLineItemChanges()).length
    const airfare = (await engine.listLineItems()).find((li) => li.label === 'Airfare')!
    await engine.updateLineItem(airfare.id, { label: 'Airfare (3 travelers)' })
    expect((await engine.listLineItemChanges()).length).toBe(before)
  })

  it('funds every item exactly by its due date', async () => {
    const views = await engine.packageViews()
    for (const item of views[0]!.items) {
      const delivered = item.components.reduce((s, c) => s + c.amountCents, 0)
      expect(delivered, `${item.lineItem.label} funds in full`).toBe(item.totalCents)
    }
  })

  it('keeps one household from seeing another', async () => {
    const [other] = await db.insert(schema.households).values({ name: 'Someone else' }).returning()
    const otherEngine = new Engine({ householdId: other!.id, actorUserId: null, db })

    expect(await otherEngine.listPackages()).toEqual([])
    expect(await otherEngine.listReserveAccounts()).toEqual([])
    expect(await otherEngine.accountViews()).toEqual([])

    // And it cannot reach into ours by id.
    const [ourPackage] = await engine.listPackages()
    await expect(otherEngine.commitPackage(ourPackage!.id)).rejects.toThrow(/No such package/)

    await db.delete(schema.households).where(eq(schema.households.id, other!.id))
  })

  it('reports the account instruction in the form a human acts on', async () => {
    const annual = (await engine.accountViews()).find((v) => v.account.id === annualId)!
    const line = `Set ${annual.account.name} recurring transfer to ${formatCents(annual.weekly.totalPerWeekCents)}/week`
    expect(line).toMatch(/^Set Annual Expenses recurring transfer to \$\d+\.\d{2}\/week$/)
  })
})
