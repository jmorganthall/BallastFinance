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
      expect((await engine.listLineItemChanges()).filter((c) => c.lineItemId === tyres.id)).toHaveLength(0)

      await engine.updateLineItem(tyres.id, { unitAmountCents: 40000 })
      after = (await engine.listLineItems()).find((i) => i.id === tyres.id)!
      expect(after.unitAmountCents).toBe(40000)
      expect((await engine.listLineItemChanges()).filter((c) => c.lineItemId === tyres.id)).toHaveLength(1)
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
          { label: 'Boat insurance', unit_amount: '530', due_date: '2027-01-16', reserve_account: accountId, recurrence: { every: 1, unit: 'year' } },
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
})
