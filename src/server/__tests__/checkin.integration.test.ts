/**
 * Phase B against a live database: check-in, drift, catch-up, close-out.
 *
 * The acceptance criterion (PRD §12) is that a full check-in and a close-out can
 * be completed, so these walk the whole loop rather than testing the pieces.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION, catchUpOptions, computeDrift } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('check-ins, drift and close-out', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string
  let today = '2026-09-19'

  const pin = (date: string) => {
    today = date
    engine = new Engine({ householdId, actorUserId: null, db, today })
  }

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `CheckIn ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id

    pin('2026-09-19')

    accountId = (
      await engine.createReserveAccount({
        name: 'Annual Expenses',
        institutionLabel: 'Capital One 360 — Annual Expenses',
      })
    ).id

    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Christmas 2026' },
      line_items: [
        { label: 'Gifts', unit_amount: '1700', quantity: 1, due_date: '2026-12-19', reserve_account: accountId },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
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

  it('records a confirmed balance', async () => {
    pin('2026-10-31')
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 50000 })

    const latest = await engine.latestConfirmedBalances()
    expect(latest.get(accountId)).toEqual({ amountCents: 50000, on: '2026-10-31' })
  })

  it('computes drift against what the plan says should be there', async () => {
    const view = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    const drift = computeDrift({ account: view, confirmedCents: 50000 })

    expect(drift.expectedCents).toBeGreaterThan(0)
    expect(drift.driftCents).toBe(50000 - drift.expectedCents)
  })

  it('does not change the weekly number from an offer alone', async () => {
    const before = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    const options = catchUpOptions({ shortfallCents: 19000, today, overWeeks: 4 })
    const bump = options.find((o) => o.kind === 'rate_bump')!

    // Issued but NOT confirmed: an offer the user ignored must not inflate the plan.
    await engine.issueInstruction({
      type: 'rate_bump',
      amountCents: bump.amountCents,
      targetId: accountId,
      targetLabel: 'Annual Expenses',
      endsOn: bump.endDate!,
    })

    const after = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(after.weekly.totalPerWeekCents).toBe(before.weekly.totalPerWeekCents)
    expect(await engine.outstandingInstructions()).toHaveLength(1)
  })

  it('folds an accepted rate bump into the weekly number once confirmed', async () => {
    const before = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    const [open] = await engine.outstandingInstructions()

    await engine.confirmInstruction({ instructionId: open!.instructionId })

    const after = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(after.weekly.totalPerWeekCents).toBeGreaterThan(before.weekly.totalPerWeekCents)
    expect(after.weekly.catchUp).toHaveLength(1)
    // And it drops off the to-do list.
    expect(await engine.outstandingInstructions()).toHaveLength(0)
  })

  it('keeps asking about a passed due date instead of dropping it', async () => {
    pin('2026-12-26')
    const prompts = await engine.closeOutPrompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.label).toBe('Gifts')
    expect(prompts[0]!.daysOverdue).toBe(7)

    // Still counted until a human answers.
    const view = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(view.shouldHaveSavedCents).toBe(170000)
  })

  it('retires the item on confirmation and takes it out of the totals', async () => {
    const [prompt] = await engine.closeOutPrompts()
    await engine.confirmSpend({ lineItemId: prompt!.lineItemId, actualAmountCents: 165000 })

    expect(await engine.closeOutPrompts()).toHaveLength(0)

    const view = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(view.shouldHaveSavedCents).toBe(0)
    expect(view.items).toHaveLength(0)
  })

  it('keeps the planned-versus-actual difference rather than discarding it', async () => {
    const rows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'spend_confirmed'))
    const ours = rows.filter((r) => r.householdId === householdId)
    expect(ours).toHaveLength(1)

    const payload = ours[0]!.payload as { planned_cents: number; actual_amount_cents: number }
    expect(payload.planned_cents).toBe(170000)
    expect(payload.actual_amount_cents).toBe(165000)
    // $50 less went out than planned; that money is still sitting in the account.
    expect(payload.planned_cents - payload.actual_amount_cents).toBe(5000)
  })

  it('refuses to close out the same item twice', async () => {
    const items = await engine.listLineItems()
    await expect(
      engine.confirmSpend({ lineItemId: items[0]!.id, actualAmountCents: 1 }),
    ).rejects.toThrow(/already closed out/)
  })
})
