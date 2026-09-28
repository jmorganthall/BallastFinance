/**
 * Editing, against a live database: a plan can be changed after it exists,
 * money already in an account can be counted toward its plans, a recurring
 * part rolls forward when confirmed spent, and a debt can be corrected or
 * removed. Every one of these leaves an event behind.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION, assignExtraToPlans, computeDrift } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('editing plans and debts', () => {
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

  const eventsOfKind = async (kind: (typeof schema.eventKindEnum.enumValues)[number]) =>
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, kind)))
      .orderBy(schema.events.recordedAt)

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Editing ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    pin('2026-09-19')
    accountId = (
      await engine.createReserveAccount({
        name: 'Annual Expenses',
        institutionLabel: 'Capital One 360 — Annual Expenses',
      })
    ).id
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.debts).where(eq(schema.debts.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  describe('committing with money already set aside', () => {
    let packageId: string

    it('splits the declared opening across the parts by cost and lowers the weekly number', async () => {
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Car costs' },
        line_items: [
          { label: 'Insurance', unit_amount: '600', due_date: '2027-01-16', reserve_account: accountId, recurrence: 'semiannual' },
          { label: 'Registration', unit_amount: '200', due_date: '2027-01-16', reserve_account: accountId, recurrence: { every: 1, unit: 'year' } },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      packageId = created.packageId
      expect(created.lineItemIds).toHaveLength(2)

      await engine.commitPackage(packageId, { openingCents: 40000 })

      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      // $400 split 3:1 by cost -> $300 and $100, already delivered.
      const byLabel = Object.fromEntries(view.items.map((i) => [i.lineItem.label, i]))
      expect(byLabel.Insurance!.shouldHaveSavedCents).toBe(30000)
      expect(byLabel.Registration!.shouldHaveSavedCents).toBe(10000)
      // Only the remaining $400 is spread over the 17 weeks to the due date.
      expect(view.weekly.totalPerWeekCents).toBe(Math.ceil(30000 / 17) + Math.ceil(10000 / 17))
      expect(byLabel.Insurance!.lineItem.recurrence).toEqual({ every: 6, unit: 'month' })

      const [commit] = await eventsOfKind('package_committed')
      expect((commit!.payload as { opening_cents: number }).opening_cents).toBe(40000)
    })

    it('renames the plan and refuses a clash with a live one', async () => {
      await engine.renamePackage(packageId, 'Car running costs')
      expect((await engine.listPackages()).find((p) => p.id === packageId)!.name).toBe('Car running costs')

      const other = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Other' },
        line_items: [{ label: 'x', unit_amount: '1', due_date: '2027-01-16', reserve_account: accountId }],
      })
      if (!other.ok) throw new Error('setup')
      await expect(engine.renamePackage(other.packageId, 'car running costs')).rejects.toThrow(/already a plan/)
      await engine.retirePackage(other.packageId)
    })

    it('adds a part to a live plan starting today, not backdated to the commit', async () => {
      pin('2026-10-17')
      const id = await engine.addLineItem(packageId, {
        label: 'Tyres',
        unitAmountCents: 34000,
        quantity: 1,
        dueDate: '2027-01-16',
        reserveAccountId: accountId,
      })
      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      const tyres = view.items.find((i) => i.lineItem.id === id)!
      expect(tyres.lineItem.state).toBe('accruing')
      expect(tyres.components[0]!.startDate).toBe('2026-10-17')
      expect(tyres.shouldHaveSavedCents).toBe(0)
      expect(tyres.weekly.totalPerWeekCents).toBe(Math.ceil(34000 / 13)) // 13 Saturdays left
      expect(await eventsOfKind('line_item_added')).toHaveLength(1)
    })

    it('edits every field of a part, and only a money change leaves a component behind', async () => {
      const tyres = (await engine.listLineItems()).find((i) => i.label === 'Tyres')!
      await engine.updateLineItem(tyres.id, { label: 'Winter tyres', recurrence: { every: 1, unit: 'year' } })
      let after = (await engine.listLineItems()).find((i) => i.id === tyres.id)!
      expect(after.label).toBe('Winter tyres')
      expect(after.recurrence).toEqual({ every: 1, unit: 'year' })
      // Starting to repeat moved its timeline to its last occurrence (D30):
      // recorded, with equal money snapshots, so it leaves no component.
      expect(after.timelineStart).toBe('last_occurrence')
      const toggled = (await engine.listLineItemChanges()).filter((c) => c.lineItemId === tyres.id)
      expect(toggled).toHaveLength(1)
      expect(toggled[0]!.before).toEqual(toggled[0]!.after)
      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      expect(view.items.find((i) => i.lineItem.id === tyres.id)!.components.map((c) => c.kind)).toEqual(['base'])

      await engine.updateLineItem(tyres.id, { unitAmountCents: 40000 })
      after = (await engine.listLineItems()).find((i) => i.id === tyres.id)!
      expect(after.unitAmountCents).toBe(40000)
      expect((await engine.listLineItemChanges()).filter((c) => c.lineItemId === tyres.id)).toHaveLength(2)
    })

    it('takes a part out of a plan without deleting its history', async () => {
      const tyres = (await engine.listLineItems()).find((i) => i.label === 'Winter tyres')!
      await engine.retireLineItem(tyres.id)
      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      expect(view.items.find((i) => i.lineItem.id === tyres.id)!.lineItem.state).toBe('retired')
      expect(view.totalCents).toBe(80000)
      expect(await eventsOfKind('line_item_retired')).toHaveLength(1)
    })

    it('rolls a recurring part forward when confirmed spent, and starts again at $0', async () => {
      pin('2027-01-20') // past the 2027-01-16 due date
      const insurance = (await engine.listLineItems()).find((i) => i.label === 'Insurance')!
      expect((await engine.closeOutPrompts()).some((p) => p.lineItemId === insurance.id)).toBe(true)

      await engine.confirmSpend({ lineItemId: insurance.id, actualAmountCents: 60000 })

      const after = (await engine.listLineItems()).find((i) => i.id === insurance.id)!
      expect(after.state).toBe('accruing')
      expect(after.dueDate).toBe('2027-07-16') // six months on
      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      const item = view.items.find((i) => i.lineItem.id === insurance.id)!
      expect(item.components[0]!.startDate).toBe('2027-01-20')
      expect(item.shouldHaveSavedCents).toBe(0)
      // The one-off registration, confirmed, retires as before.
      const registration = (await engine.listLineItems()).find((i) => i.label === 'Registration')!
      await engine.updateLineItem(registration.id, { recurrence: null })
      await engine.confirmSpend({ lineItemId: registration.id, actualAmountCents: 20000 })
      expect((await engine.listLineItems()).find((i) => i.id === registration.id)!.state).toBe('retired')
    })

    it('stops a whole plan', async () => {
      await engine.retirePackage(packageId)
      expect((await engine.listPackages()).find((p) => p.id === packageId)!.state).toBe('retired')
      expect((await engine.listLineItems()).filter((i) => i.packageId === packageId).every((i) => i.state === 'retired')).toBe(true)
      expect(await eventsOfKind('package_retired')).toHaveLength(2)
    })

    it('deletes a finished plan for good, only with its name typed back, and keeps its history', async () => {
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Santa Visit' },
        line_items: [{ label: 'Photos', unit_amount: '45', due_date: '2028-12-19', reserve_account: accountId }],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await engine.commitPackage(created.packageId, { openingCents: 0 })
      const commitsBefore = (await eventsOfKind('package_committed')).length

      // A live plan cannot be deleted, whatever is typed.
      await expect(engine.deletePackage(created.packageId, 'Santa Visit')).rejects.toThrow(/finished/)
      await engine.retirePackage(created.packageId)

      // The name has to match exactly; nothing changes when it does not.
      await expect(engine.deletePackage(created.packageId, 'santa visit')).rejects.toThrow(/does not match/)
      await expect(engine.deletePackage(created.packageId, '')).rejects.toThrow(/does not match/)
      expect((await engine.listPackages()).some((p) => p.id === created.packageId)).toBe(true)

      await engine.deletePackage(created.packageId, '  Santa Visit ')
      expect((await engine.listPackages()).some((p) => p.id === created.packageId)).toBe(false)
      expect((await engine.listLineItems()).some((i) => i.packageId === created.packageId)).toBe(false)

      // The log keeps what the plan was, and everything recorded before it.
      const [deleted] = await eventsOfKind('package_deleted')
      expect(deleted!.payload).toMatchObject({
        package_id: created.packageId,
        name: 'Santa Visit',
        line_items: [{ label: 'Photos', unit_amount_cents: 4500, due_date: '2028-12-19' }],
      })
      expect(await eventsOfKind('package_committed')).toHaveLength(commitsBefore)

      // Deleting it again is refused rather than silently succeeding.
      await expect(engine.deletePackage(created.packageId, 'Santa Visit')).rejects.toThrow(/No such package/)
    })
  })

  describe('counting an overage toward the plans', () => {
    it('raises should-hold to what is actually there and drops the weekly number', async () => {
      pin('2026-09-19')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Christmas 2026' },
        line_items: [
          { label: 'Gifts', unit_amount: '1000', due_date: '2026-12-19', reserve_account: accountId },
          { label: 'Food', unit_amount: '300', due_date: '2026-12-24', reserve_account: accountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await engine.commitPackage(created.packageId)

      const before = (await engine.accountViews()).find((v) => v.account.id === accountId)!
      expect(before.shouldHaveSavedCents).toBe(0)
      // The account actually holds $1,150.
      await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 115000 })
      const drift = computeDrift({ account: before, confirmedCents: 115000 })
      expect(drift.driftCents).toBe(115000)

      const { assignments, leftoverCents } = assignExtraToPlans({
        extraCents: drift.driftCents,
        items: before.items,
      })
      expect(assignments.map((a) => [a.label, a.addedCents])).toEqual([
        ['Gifts', 100000],
        ['Food', 15000],
      ])
      expect(leftoverCents).toBe(0)

      await engine.recordOpeningBalances(
        assignments.map((a) => ({ lineItemId: a.lineItemId, openingCents: a.openingCents })),
      )

      const after = (await engine.accountViews()).find((v) => v.account.id === accountId)!
      expect(after.shouldHaveSavedCents).toBe(115000)
      expect(computeDrift({ account: after, confirmedCents: 115000 }).driftCents).toBe(0)
      // Gifts is fully funded: nothing more to set aside for it. Food needs $150
      // over the 13 Saturdays left before Thursday 2026-12-24.
      const gifts = after.items.find((i) => i.lineItem.label === 'Gifts')!
      expect(gifts.weekly.totalPerWeekCents).toBe(0)
      expect(after.weekly.totalPerWeekCents).toBe(Math.ceil(15000 / 13))
      expect(await eventsOfKind('opening_recorded')).toHaveLength(2)
    })

    it('shares the extra out through the allocation engine and asks for it to be moved out', async () => {
      const { plan, instructionIds } = await engine.runAllocation({
        floorCents: 100000,
        sourceAccountId: accountId,
      })
      expect(plan.netCents).toBeGreaterThan(0)
      const outstanding = await engine.outstandingInstructions()
      const moveOut = outstanding.find((i) => i.type === 'one_time_move_out')!
      expect(moveOut.targetId).toBe(accountId)
      expect(moveOut.amountCents).toBe(plan.netCents)
      expect(instructionIds).toContain(moveOut.instructionId)
    })
  })

  describe('correcting a debt', () => {
    let debtId: string

    it('takes a dated balance at creation', async () => {
      const debt = await engine.createDebt({
        name: 'Store card',
        category: 'consumer',
        balanceCents: 40000,
        aprBasisPoints: 2999,
        minPaymentRule: { type: 'fixed', amountCents: 4000 },
        balanceAsOf: '2026-08-01',
      })
      debtId = debt.id
      expect(debt.balanceAsOf).toBe('2026-08-01')
    })

    it('changes the terms and records before and after', async () => {
      await engine.updateDebt(debtId, {
        name: 'Store card (Josh)',
        aprBasisPoints: 2499,
        minPaymentRule: { type: 'percent_with_floor', basisPoints: 200, floorCents: 2500 },
        creditLimitCents: 500000,
      })
      const after = (await engine.listDebts()).find((d) => d.id === debtId)!
      expect(after.name).toBe('Store card (Josh)')
      expect(after.aprBasisPoints).toBe(2499)
      expect(after.minPaymentRule).toEqual({ type: 'percent_with_floor', basisPoints: 200, floorCents: 2500 })
      expect(after.creditLimitCents).toBe(500000)
      expect(after.balanceCents).toBe(40000) // untouched: the balance has its own paths

      const [event] = await eventsOfKind('debt_updated')
      const payload = event!.payload as { before: { apr_basis_points: number }; after: { apr_basis_points: number } }
      expect(payload.before.apr_basis_points).toBe(2999)
      expect(payload.after.apr_basis_points).toBe(2499)
    })

    it('still refuses a promo rate that is not cheaper', async () => {
      await expect(
        engine.updateDebt(debtId, {
          promoRules: [{ rateBasisPoints: 2999, appliesTo: 'full', untilDate: '2027-06-01' }],
        }),
      ).rejects.toThrow(/not lower/)
    })

    it('removes a debt, keeping what it said on the event', async () => {
      await engine.removeDebt(debtId)
      expect((await engine.listDebts()).find((d) => d.id === debtId)).toBeUndefined()
      const [event] = await eventsOfKind('debt_removed')
      expect((event!.payload as { name: string }).name).toBe('Store card (Josh)')
    })
  })

  describe('what a recurring plan would already have set aside', () => {
    it('offers the elapsed part of each repeating cycle, and commits it part by part', async () => {
      // Other tests move the clock; this one is priced against 19 Sep 2026.
      const engine = new Engine({ householdId, actorUserId: null, db, today: '2026-09-19' })
      // Insurance every year, next due 16 Jan 2027: the last one was 16 Jan
      // 2026, so most of a year's saving should already be there. The one-off
      // registration has no history and gets nothing.
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Offered opening' },
        line_items: [
          { label: 'Boat insurance', unit_amount: '530', due_date: '2027-01-16', reserve_account: accountId, recurrence: { every: 1, unit: 'year' }, timeline_start: 'commit' },
          { label: 'Boat one-off', unit_amount: '200', due_date: '2027-01-16', reserve_account: accountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))

      const suggested = await engine.suggestedOpenings(created.packageId)
      expect(suggested.map((s) => s.label)).toEqual(['Boat insurance'])
      expect(suggested[0]!.lastOccurrence).toBe('2026-01-16')
      // 16 Jan 2026 is a Friday, so the cycle holds 53 Saturdays (17 Jan 2026
      // through 16 Jan 2027) and 36 of them have passed by 19 Sep 2026:
      // 36/53 of $530, rounded up.
      expect(suggested[0]!.cents).toBe(36000)

      await engine.commitPackage(created.packageId, {
        openingByLineItem: Object.fromEntries(suggested.map((s) => [s.lineItemId, s.cents])),
      })
      const view = (await engine.packageViews()).find((v) => v.package.id === created.packageId)!
      const byLabel = Object.fromEntries(view.items.map((i) => [i.lineItem.label, i]))
      // The money lands on the part it belongs to, not spread by cost.
      expect(byLabel['Boat insurance']!.shouldHaveSavedCents).toBe(36000)
      expect(byLabel['Boat one-off']!.shouldHaveSavedCents).toBe(0)

      const commits = await eventsOfKind('package_committed')
      const mine = commits.find((e) => (e.payload as { package_id: string }).package_id === created.packageId)!
      expect((mine.payload as { opening_cents: number }).opening_cents).toBe(36000)
    })
  })

  describe('a repeating part starts its timeline at its last occurrence (PRD D30)', () => {
    let packageId: string
    let insuranceId: string

    it('defaults a repeating part to its last occurrence and a one-off to the commit, and offers no opening for the former', async () => {
      pin('2026-09-26')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Home bills' },
        line_items: [
          { label: 'Home insurance', unit_amount: '1200', due_date: '2026-11-15', reserve_account: accountId, recurrence: { every: 1, unit: 'year' } },
          { label: 'Gutter clean', unit_amount: '300', due_date: '2026-11-15', reserve_account: accountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      packageId = created.packageId
      const items = (await engine.listLineItems()).filter((i) => i.packageId === packageId)
      const insurance = items.find((i) => i.label === 'Home insurance')!
      insuranceId = insurance.id
      expect(insurance.timelineStart).toBe('last_occurrence')
      expect(items.find((i) => i.label === 'Gutter clean')!.timelineStart).toBe('commit')

      expect(await engine.suggestedOpenings(packageId)).toEqual([])
      // Asked as if it started today, the D8 figure is there for the form to show.
      const asToday = await engine.suggestedOpenings(packageId, {
        timelineStartByLineItem: { [insuranceId]: 'commit' },
      })
      expect(asToday.map((s) => [s.label, s.lastOccurrence, s.cents])).toEqual([['Home insurance', '2025-11-15', 103847]])
    })

    it('commits with the base running from the last occurrence, on its pace, at the steady rate; the typed opening goes to the one-off', async () => {
      await engine.commitPackage(packageId, { openingCents: 10000 })
      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      const byLabel = Object.fromEntries(view.items.map((i) => [i.lineItem.label, i]))
      const insurance = byLabel['Home insurance']!
      expect(insurance.components.map((c) => [c.kind, c.startDate, c.endDate])).toEqual([['base', '2025-11-15', '2026-11-15']])
      expect(insurance.shouldHaveSavedCents).toBe(103847)
      expect(insurance.paceCents).toBe(103847)
      expect(insurance.remainingCents).toBe(16153)
      expect(insurance.weekly.totalPerWeekCents).toBe(2308)
      // The $100 typed at commit is the one-off's: the insurance already counts its share.
      expect(byLabel['Gutter clean']!.shouldHaveSavedCents).toBe(10000)
      expect(byLabel['Gutter clean']!.components[0]!.kind).toBe('opening')
    })

    it('can be unticked later, which is recorded, and the part then runs from the commit as before', async () => {
      const changesBefore = (await engine.listLineItemChanges()).filter((c) => c.lineItemId === insuranceId).length
      await engine.updateLineItem(insuranceId, { timelineStart: 'commit' })
      const item = (await engine.packageViews())
        .find((v) => v.package.id === packageId)!
        .items.find((i) => i.lineItem.id === insuranceId)!
      expect(item.lineItem.timelineStart).toBe('commit')
      expect(item.components.map((c) => [c.kind, c.startDate])).toEqual([['base', '2026-09-26']])
      expect(item.shouldHaveSavedCents).toBe(0)
      expect(item.weekly.totalPerWeekCents).toBe(17143) // $1,200 over the 7 Saturdays left

      // The toggle is in the log with equal money snapshots (no catch-up) and the switch beside them.
      const changes = (await engine.listLineItemChanges()).filter((c) => c.lineItemId === insuranceId)
      expect(changes).toHaveLength(changesBefore + 1)
      expect(changes.at(-1)!.before).toEqual(changes.at(-1)!.after)
      const [event] = (await eventsOfKind('line_item_changed')).filter(
        (e) => (e.payload as { line_item_id: string }).line_item_id === insuranceId,
      )
      expect(event!.payload).toMatchObject({ timeline_start: { before: 'last_occurrence', after: 'commit' } })

      // And back again.
      await engine.updateLineItem(insuranceId, { timelineStart: 'last_occurrence' })
      const back = (await engine.packageViews())
        .find((v) => v.package.id === packageId)!
        .items.find((i) => i.lineItem.id === insuranceId)!
      expect(back.components[0]!.startDate).toBe('2025-11-15')
      expect(back.shouldHaveSavedCents).toBe(103847)
    })

    it('honours the commit form: a part unticked at commit starts today and takes the offered opening', async () => {
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Unticked at commit' },
        line_items: [
          { label: 'Car insurance', unit_amount: '600', due_date: '2026-11-15', reserve_account: accountId, recurrence: { every: 6, unit: 'month' } },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      const [car] = (await engine.listLineItems()).filter((i) => i.packageId === created.packageId)
      const starts = { [car!.id]: 'commit' as const }
      const offered = await engine.suggestedOpenings(created.packageId, { timelineStartByLineItem: starts })
      expect(offered).toHaveLength(1)
      await engine.commitPackage(created.packageId, {
        openingByLineItem: { [car!.id]: offered[0]!.cents },
        timelineStartByLineItem: starts,
      })
      const item = (await engine.packageViews())
        .find((v) => v.package.id === created.packageId)!
        .items[0]!
      expect(item.lineItem.timelineStart).toBe('commit')
      expect(item.components.map((c) => [c.kind, c.startDate])).toEqual([
        ['opening', '2026-09-26'],
        ['base', '2026-09-26'],
      ])
      expect(item.shouldHaveSavedCents).toBe(offered[0]!.cents)
    })

    it('refuses a one-off that starts anywhere but the commit, at the database', async () => {
      const gutter = (await engine.listLineItems()).find((i) => i.packageId === packageId && i.label === 'Gutter clean')!
      // The engine coerces; the CHECK is the backstop for anything that bypasses it.
      await engine.updateLineItem(gutter.id, { timelineStart: 'last_occurrence' })
      expect((await engine.listLineItems()).find((i) => i.id === gutter.id)!.timelineStart).toBe('commit')
      const failure = await db
        .update(schema.lineItems)
        .set({ timelineStart: 'last_occurrence' })
        .where(eq(schema.lineItems.id, gutter.id))
        .then(
          () => null,
          (error: unknown) => error as { message: string; cause?: { constraint_name?: string } },
        )
      expect(failure).not.toBeNull()
      expect(failure!.cause?.constraint_name ?? failure!.message).toMatch(/line_items_one_off_starts_at_commit/)
    })

    it('starts the next cycle at the spend date once confirmed spent, and rolls forward', async () => {
      pin('2026-11-20')
      await engine.confirmSpend({ lineItemId: insuranceId, actualAmountCents: 120000 })
      const item = (await engine.packageViews())
        .find((v) => v.package.id === packageId)!
        .items.find((i) => i.lineItem.id === insuranceId)!
      expect(item.lineItem.dueDate).toBe('2027-11-15')
      expect(item.components.map((c) => [c.kind, c.startDate, c.endDate])).toEqual([['base', '2026-11-20', '2027-11-15']])
      expect(item.shouldHaveSavedCents).toBe(0)
      expect(item.paceCents).toBe(0)
      pin('2026-09-19')
    })
  })

  describe('"Saving since" is a day a person can see and change (PRD D33)', () => {
    let packageId: string
    let insuranceId: string
    let gutterId: string

    it('commits with a day given: the base runs from it, the heading and the chart start there, and no opening is offered', async () => {
      pin('2026-09-26')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Saving since a day' },
        line_items: [
          { label: 'Home insurance', unit_amount: '1200', due_date: '2026-11-15', reserve_account: accountId, recurrence: { every: 1, unit: 'year' } },
          { label: 'Gutter clean', unit_amount: '300', due_date: '2026-11-15', reserve_account: accountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      packageId = created.packageId
      const items = (await engine.listLineItems()).filter((i) => i.packageId === packageId)
      insuranceId = items.find((i) => i.label === 'Home insurance')!.id
      gutterId = items.find((i) => i.label === 'Gutter clean')!.id

      const choice = { [insuranceId]: { kind: 'typed' as const, date: '2026-03-15' } }
      expect(await engine.suggestedOpenings(packageId, { timelineStartByLineItem: choice })).toEqual([])
      await engine.commitPackage(packageId, { openingCents: 10000, timelineStartByLineItem: choice })

      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      const insurance = view.items.find((i) => i.lineItem.id === insuranceId)!
      expect(insurance.lineItem.timelineStart).toBe('typed')
      expect(insurance.lineItem.timelineStartDate).toBe('2026-03-15')
      expect(insurance.components.map((c) => [c.kind, c.startDate, c.endDate])).toEqual([['base', '2026-03-15', '2026-11-15']])
      expect(insurance.savingSince).toEqual({ date: '2026-03-15', reason: { kind: 'typed' }, chosenDate: null })
      expect(insurance.paceSince).toBe('2026-03-15')
      expect(insurance.shouldHaveSavedCents).toBe(insurance.paceCents)
      // The $100 typed at commit went to the one-off, as under D30.
      expect(view.items.find((i) => i.lineItem.id === gutterId)!.shouldHaveSavedCents).toBe(10000)
      // The plan is headed by the earliest day any part runs from, and the chart starts there too.
      expect(view.savingSince).toBe('2026-03-15')
      const curve = (await engine.packageCurve(packageId))!
      expect(curve.from).toBe('2026-03-15')
      expect(curve.points[0]!.date).toBe('2026-03-15')
    })

    it('refuses a day after today or not before the due date, and a typed choice with no day, in plain words', async () => {
      await expect(
        engine.updateLineItem(insuranceId, { timelineStart: 'typed', timelineStartDate: '2026-09-27' }),
      ).rejects.toThrow('The day you have been saving since cannot be after today.')
      await expect(
        engine.updateLineItem(insuranceId, { timelineStart: 'typed', timelineStartDate: null }),
      ).rejects.toThrow('Pick the day you have been saving for this since.')
      await expect(
        engine.updateLineItem(insuranceId, { dueDate: '2026-03-15' }),
      ).rejects.toThrow('The day you have been saving since has to be before the day it is needed.')
    })

    it('changing the day is a line_item_changed event with equal money snapshots and the day in timeline_start', async () => {
      const changesBefore = (await engine.listLineItemChanges()).filter((c) => c.lineItemId === insuranceId).length
      await engine.updateLineItem(insuranceId, { timelineStartDate: '2026-01-10' })
      const item = (await engine.packageViews())
        .find((v) => v.package.id === packageId)!
        .items.find((i) => i.lineItem.id === insuranceId)!
      expect(item.components[0]!.startDate).toBe('2026-01-10')
      const changes = (await engine.listLineItemChanges()).filter((c) => c.lineItemId === insuranceId)
      expect(changes).toHaveLength(changesBefore + 1)
      expect(changes.at(-1)!.before).toEqual(changes.at(-1)!.after)
      const mine = (await eventsOfKind('line_item_changed')).filter(
        (e) => (e.payload as { line_item_id: string }).line_item_id === insuranceId,
      )
      expect(mine.at(-1)!.payload).toMatchObject({
        timeline_start: { before: { kind: 'typed', date: '2026-03-15' }, after: { kind: 'typed', date: '2026-01-10' } },
      })

      // Back to the last occurrence: the day is cleared, and the record reads as D30 wrote it.
      await engine.updateLineItem(insuranceId, { timelineStart: 'last_occurrence' })
      const back = (await engine.listLineItems()).find((i) => i.id === insuranceId)!
      expect(back.timelineStart).toBe('last_occurrence')
      expect(back.timelineStartDate).toBeNull()
      const last = (await eventsOfKind('line_item_changed'))
        .filter((e) => (e.payload as { line_item_id: string }).line_item_id === insuranceId)
        .at(-1)!
      expect(last.payload).toMatchObject({
        timeline_start: { before: { kind: 'typed', date: '2026-01-10' }, after: 'last_occurrence' },
      })
    })

    it('leaves a day given inert on a counted cycle, and the view says why', async () => {
      await engine.updateLineItem(insuranceId, { timelineStart: 'typed', timelineStartDate: '2026-03-15' })
      await engine.recordOpeningBalances([{ lineItemId: insuranceId, openingCents: 90000 }])
      const item = (await engine.packageViews())
        .find((v) => v.package.id === packageId)!
        .items.find((i) => i.lineItem.id === insuranceId)!
      expect(item.components.map((c) => [c.kind, c.startDate])).toEqual([
        ['opening', '2026-09-26'],
        ['base', '2026-09-26'],
      ])
      expect(item.shouldHaveSavedCents).toBe(90000)
      expect(item.savingSince).toEqual({ date: '2026-09-26', reason: { kind: 'opened', on: '2026-09-26' }, chosenDate: '2026-03-15' })
      expect(item.lineItem.timelineStartDate).toBe('2026-03-15')
    })

    it('keeps a one-off at the commit with no day, and the database refuses a typed choice without one', async () => {
      await engine.updateLineItem(gutterId, { timelineStart: 'typed', timelineStartDate: '2026-03-15' })
      const gutter = (await engine.listLineItems()).find((i) => i.id === gutterId)!
      expect([gutter.timelineStart, gutter.timelineStartDate]).toEqual(['commit', null])

      const failure = await db
        .update(schema.lineItems)
        .set({ timelineStart: 'typed', timelineStartDate: null })
        .where(eq(schema.lineItems.id, insuranceId))
        .then(
          () => null,
          (error: unknown) => error as { message: string; cause?: { constraint_name?: string } },
        )
      expect(failure).not.toBeNull()
      expect(failure!.cause?.constraint_name ?? failure!.message).toMatch(/line_items_typed_start_has_date/)
      pin('2026-09-19')
    })
  })

  describe('counting toward a plan on the day it was committed', () => {
    it('takes the counted figure over the same-day commit opening', async () => {
      // The spreadsheet import commits every plan with its "reserved now"
      // the same day the household then checks in and counts the extra
      // toward it. Two cycle starts on one date: the later one is what the
      // person just confirmed, and it must win.
      const engine = new Engine({ householdId, actorUserId: null, db, today: '2026-09-19' })
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Same-day count' },
        line_items: [
          { label: 'Water filter', unit_amount: '45', due_date: '2026-10-05', reserve_account: accountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await engine.commitPackage(created.packageId, { openingCents: 1837 })

      const before = (await engine.packageViews()).find((v) => v.package.id === created.packageId)!
      expect(before.items[0]!.shouldHaveSavedCents).toBe(1837)

      await engine.recordOpeningBalances([{ lineItemId: created.lineItemIds[0]!, openingCents: 4500 }])
      const after = (await engine.packageViews()).find((v) => v.package.id === created.packageId)!
      expect(after.items[0]!.shouldHaveSavedCents).toBe(4500)
      expect(after.weekly.totalPerWeekCents).toBe(0)
    })
  })
})
