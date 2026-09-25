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
import {
  INTAKE_CONTRACT_VERSION,
  aheadOptions,
  catchUpOptions,
  committedAfter,
  computeDrift,
} from '@/domain'

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

  it('eases off the weekly number once an accepted cut is confirmed', async () => {
    const before = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    // Over a different window from the bump above, so the cut ends on its own
    // date. Two adjustments ending the same day fold into one line on purpose.
    const cut = aheadOptions({
      extraCents: 8000,
      weeklyCents: before.weekly.totalPerWeekCents,
      today,
      overWeeks: 8,
    }).find((o) => o.kind === 'rate_cut')!

    const id = await engine.issueInstruction({
      type: 'rate_cut',
      amountCents: cut.amountCents,
      targetId: accountId,
      targetLabel: 'Annual Expenses',
      endsOn: cut.endDate!,
    })
    // Offered is not accepted: nothing moves yet.
    const offered = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(offered.weekly.totalPerWeekCents).toBe(before.weekly.totalPerWeekCents)

    await engine.confirmInstruction({ instructionId: id })

    const after = (await engine.accountViews()).find((v) => v.account.id === accountId)!
    expect(after.weekly.totalPerWeekCents).toBe(before.weekly.totalPerWeekCents - cut.perWeekCents!)
    expect(after.weekly.totalPerWeekCents).toBeGreaterThanOrEqual(0)
    // It shows as its own "less until" line, and the earlier bump keeps its own.
    expect(after.weekly.catchUp.find((g) => g.endDate === cut.endDate)?.perWeekCents).toBe(
      -cut.perWeekCents!,
    )
    expect(after.weekly.catchUp).toHaveLength(before.weekly.catchUp.length + 1)
    // What the plan says should be there is untouched by easing off.
    expect(after.shouldHaveSavedCents).toBe(before.shouldHaveSavedCents)
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

/**
 * The adjustment lifecycle (PRD D18, rev 28): a catch-up is offered once,
 * replaced rather than stacked, and can be stopped by recording one event.
 */
describeDb('the adjustment lifecycle (D18)', () => {
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
  const view = async () => (await engine.accountViews()).find((v) => v.account.id === accountId)!
  const netDrift = async () => {
    const balance = (await engine.latestConfirmedBalances()).get(accountId)!
    const commitments = (await engine.openCommitmentsByAccount()).get(accountId)!
    return computeDrift({
      account: await view(),
      confirmedCents: balance.amountCents,
      committedCents: committedAfter({ commitments, from: balance.on }),
    })
  }

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Lifecycle ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    pin('2026-09-19')
    accountId = (
      await engine.createReserveAccount({ name: 'Annual Expenses', institutionLabel: 'Capital One 360' })
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
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('never offers the same catch-up twice once the bump is confirmed', async () => {
    pin('2026-10-31')
    const before = await view()
    // $148.32 short. Accept the bump and mark it done the same day.
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: before.shouldHaveSavedCents - 14832 })
    const raw = await netDrift()
    expect(raw).toMatchObject({ committedCents: 0, driftCents: -14832 })

    const bump = catchUpOptions({ shortfallCents: 14832, today, overWeeks: 8 }).find((o) => o.kind === 'rate_bump')!
    const id = await engine.issueInstruction({
      type: 'rate_bump',
      amountCents: bump.amountCents,
      targetId: accountId,
      targetLabel: 'Annual Expenses',
      endsOn: bump.endDate!,
    })
    // Offered and unanswered, it already counts: the to-do covers the gap.
    expect((await netDrift()).driftCents).toBe(0)

    await engine.confirmInstruction({ instructionId: id })
    const after = await netDrift()
    expect(after.committedCents).toBe(14832)
    expect(after.driftCents).toBe(0)
    expect(catchUpOptions({ shortfallCents: -after.driftCents, today, overWeeks: 8 })).toEqual([])
    expect((await view()).weekly.catchUp).toHaveLength(1)
  })

  it('stops a running bump that day: the weekly figure drops, should-hold does not move', async () => {
    pin('2026-11-18')
    const before = await view()
    const running = (await engine.openCommitmentsByAccount()).get(accountId)!.running
    expect(running).toHaveLength(1)
    const bumpId = running[0]!.id

    await engine.endInstruction({ instructionId: bumpId })

    const after = await view()
    expect(after.weekly.catchUp).toEqual([])
    expect(after.weekly.totalPerWeekCents).toBeLessThan(before.weekly.totalPerWeekCents)
    expect(after.shouldHaveSavedCents).toBe(before.shouldHaveSavedCents)
    // Nothing is edited in place: the issued and confirmed events are as they were, plus one.
    const ended = await engine.listEndedInstructions()
    expect(ended).toEqual([{ instructionId: bumpId, endedOn: '2026-11-18' }])
    expect((await engine.listIssuedInstructions()).some((i) => i.instructionId === bumpId)).toBe(true)
    expect((await engine.listConfirmedInstructions()).some((c) => c.instructionId === bumpId)).toBe(true)
    // The stopped bump keeps only what it delivered (two Saturdays of eight), and has nothing left to add.
    const kept = (await engine.openCommitmentsByAccount()).get(accountId)!.running[0]!
    expect(kept).toMatchObject({ id: bumpId, endDate: '2026-11-18', amountCents: 3708 })
    expect(committedAfter({ commitments: (await engine.openCommitmentsByAccount()).get(accountId)!, from: today })).toBe(0)

    await expect(engine.endInstruction({ instructionId: bumpId })).rejects.toThrow(/already been ended/)
  })

  it('lets a newer open bump replace the older one, so only the newer is outstanding', async () => {
    pin('2026-11-21')
    const issue = (amountCents: number) =>
      engine.issueInstruction({
        type: 'rate_bump',
        amountCents,
        targetId: accountId,
        targetLabel: 'Annual Expenses',
        endsOn: '2027-01-16',
      })
    const older = await issue(8000)
    const newer = await issue(12000)

    const open = await engine.outstandingInstructions()
    expect(open.map((i) => i.instructionId)).toEqual([newer])
    // And only the newer prices what the transfer becomes.
    const pending = (await engine.driftAdjustments()).pending
    expect(pending.map((a) => a.id)).toEqual([newer])
    expect(pending[0]!.amountCents).toBe(12000)
    expect(older).not.toBe(newer)

    // Withdrawing the newer does not bring the older back.
    await engine.endInstruction({ instructionId: newer })
    expect(await engine.outstandingInstructions()).toEqual([])
    expect((await view()).pendingWeekly).toBeNull()
  })

  it('refuses to end an instruction another household issued', async () => {
    const [other] = await db
      .insert(schema.households)
      .values({ name: `Other ${crypto.randomUUID()}` })
      .returning()
    const stranger = new Engine({ householdId: other!.id, actorUserId: null, db, today })
    const [mine] = await engine.listIssuedInstructions()
    await expect(stranger.endInstruction({ instructionId: mine!.instructionId })).rejects.toThrow(
      /No such instruction/,
    )
    expect(await stranger.listEndedInstructions()).toEqual([])
  })
})
