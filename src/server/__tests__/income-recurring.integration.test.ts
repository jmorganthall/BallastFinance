/**
 * The recurring list and income (PRD §14, D52) against a live database: a
 * Simplifi paste is held, looked at and kept; a later paste changes what it
 * should and ends nothing a person has not confirmed; Simplifi names tie rows
 * to Ballast's accounts and debts, whose figures are the authority; and an
 * income source works out its take-home from paystub lines.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const entry = (name: string, amount: string, frequency: string, kind = 'Bill', category = 'Bills') =>
  `${name}\n\nNext: ${amount.replace('+', '')} on Oct 26, 2026\n\nExpenses (Joint)\n\nChecking\n\n${category}\n\n${kind}\n\n${amount}\n${frequency}\n\n$1.00\nYearly\n`

const FIRST = [
  entry('Car Fund', '$40.00', 'Every week', 'Transfer'),
  entry('Store Card Payment', '$250.00', 'Every month', 'Transfer'),
  entry('Power Company', '$120.00', 'Every month'),
  entry('Old Gym', '$30.00', 'Every month'),
  entry('Acme Payroll', '+$2,000.00', 'Every 2 weeks', 'Income', 'Personal Income'),
].join('\n')

const SECOND = [
  entry('Car Fund', '$40.00', 'Every week', 'Transfer'),
  entry('Store Card Payment', '$250.00', 'Every month', 'Transfer'),
  entry('Power Company', '$135.00', 'Every month'),
  entry('Acme Payroll', '+$2,000.00', 'Every 2 weeks', 'Income', 'Personal Income'),
  entry('Streaming Co', '$15.49', 'Every month', 'Subscription'),
].join('\n')

describeDb('the recurring list and income', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let carId: string
  let holidayId: string
  let storeId: string
  const TODAY = '2026-10-19'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Recurring ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    carId = (await engine.createReserveAccount({ name: 'Auto Maintenance', institutionLabel: 'Capital One 360' })).id
    holidayId = (await engine.createReserveAccount({ name: 'Holiday', institutionLabel: 'Capital One 360' })).id
    await engine.confirmTransfer({ reserveAccountId: carId, perWeekCents: 4500 })
    await engine.confirmTransfer({ reserveAccountId: holidayId, perWeekCents: 3000 })
    storeId = (
      await engine.createDebt({
        name: 'Store card',
        category: 'consumer',
        balanceCents: 300_000,
        aprBasisPoints: 2499,
        minPaymentRule: { type: 'fixed', amountCents: 5000 },
        plannedPaymentCents: 25_000,
      })
    ).id
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.incomePayments).where(eq(schema.incomePayments.householdId, householdId))
      await db.delete(schema.incomeSources).where(eq(schema.incomeSources.householdId, householdId))
      await db.delete(schema.recurringExpenses).where(eq(schema.recurringExpenses.householdId, householdId))
      await db.delete(schema.debts).where(eq(schema.debts.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('holds a paste to be looked at, and keeps nothing until told', async () => {
    const paste = await engine.stashSimplifiPaste(FIRST)
    expect(paste.problems).toEqual([])
    expect(await engine.listRecurring()).toEqual([])
    const pending = await engine.pendingSimplifiPaste()
    expect(pending!.diff.added.map((r) => r.name)).toHaveLength(5)
  })

  it('keeps the paste, with the links chosen in the preview', async () => {
    const result = await engine.keepSimplifiPaste({
      endIds: [],
      links: [
        { name: 'Car Fund', kind: 'account', id: carId },
        { name: 'Store Card Payment', kind: 'debt', id: storeId },
      ],
    })
    expect(result).toEqual({ added: 5, changed: 0, ended: 0 })
    expect(await engine.pendingSimplifiPaste()).toBeNull()

    const view = await engine.recurringView()
    expect(view.lastPastedOn).toBe(TODAY)
    const checks = new Map(view.checks.map((c) => [c.target.id, c]))
    // Simplifi says $40 a week; the confirmed transfer is $45: flagged, never corrected.
    expect(checks.get(carId)).toMatchObject({ differs: true, ballast: { cents: 4500, frequency: 'weekly' } })
    expect(checks.get(storeId)).toMatchObject({ differs: false, ballast: { cents: 25_000, frequency: 'monthly' } })
    expect(view.notInSimplifi.map((t) => t.id)).toEqual([holidayId])
    // Ballast's $45 a week for the car fund, the store card's $250, power $120, the gym $30.
    expect(view.outPerMonthCents).toBe(Math.ceil((4500 * 52 + 25_000 * 12 + 12_000 * 12 + 3000 * 12) / 12))
  })

  it('refuses a Simplifi name another account already has', async () => {
    await expect(engine.setSimplifiNames('account', holidayId, ['car fund'])).rejects.toThrow('already how Simplifi knows')
    await engine.setSimplifiNames('account', holidayId, ['Holiday Fund'])
    const targets = await engine.simplifiTargets()
    expect(targets.find((t) => t.id === holidayId)!.simplifiNames).toEqual(['Holiday Fund'])
  })

  it('takes a changed amount from the next paste, and ends a gone row only when confirmed', async () => {
    await engine.stashSimplifiPaste(SECOND)
    const pending = (await engine.pendingSimplifiPaste())!
    expect(pending.diff.changed.map((c) => c.item.name)).toEqual(['Power Company'])
    expect(pending.diff.gone.map((g) => g.name)).toEqual(['Old Gym'])

    expect(await engine.keepSimplifiPaste({ endIds: [] })).toEqual({ added: 1, changed: 1, ended: 0 })
    let items = await engine.listRecurring()
    expect(items.find((i) => i.name === 'Power Company')!.amountCents).toBe(13_500)
    expect(items.find((i) => i.name === 'Old Gym')!.endedOn).toBeNull()

    await engine.stashSimplifiPaste(SECOND)
    const gym = (await engine.pendingSimplifiPaste())!.diff.gone[0]!
    expect(await engine.keepSimplifiPaste({ endIds: [gym.id] })).toEqual({ added: 0, changed: 0, ended: 1 })
    items = await engine.listRecurring()
    expect(items.find((i) => i.name === 'Old Gym')!.endedOn).toBe(TODAY)
  })

  it('adds, changes and ends items Simplifi does not have, and never edits a Simplifi one', async () => {
    const id = await engine.addRecurring({ name: 'Sitter', amountCents: 6000, frequency: 'biweekly' })
    await engine.updateRecurring(id, { name: 'Babysitter', amountCents: 6500, frequency: 'biweekly' })
    await engine.endRecurring(id)
    const sitter = (await engine.listRecurring()).find((i) => i.id === id)!
    expect(sitter).toMatchObject({ name: 'Babysitter', source: 'manual', amountCents: 6500, endedOn: TODAY })

    const power = (await engine.listRecurring()).find((i) => i.name === 'Power Company')!
    await expect(engine.updateRecurring(power.id, { name: 'X', amountCents: 1, frequency: 'monthly' })).rejects.toThrow('comes from Simplifi')
    await expect(engine.endRecurring(power.id)).rejects.toThrow('comes from Simplifi')
  })

  it('works out a source from its paystub lines and checks it against Simplifi', async () => {
    const id = await engine.saveIncomeSource({
      personUserId: null,
      person: 'Alex',
      name: 'Acme',
      frequency: 'biweekly',
      startedOn: '2025-01-01',
      annualSalaryCents: 13_000_000,
      grossPerCheckCents: null,
      pretax: [{ label: '401k', percentBasisPoints: 600 }],
      taxes: [],
      netPerCheckCents: 300_000,
      spendingShareBasisPoints: 2000,
    })
    await engine.setSimplifiNames('income', id, ['Acme Payroll'])

    // $5,000 a check, $300 to the 401k, $3,000 home (so $1,700 of taxes); Simplifi says $2,000.
    let check = (await engine.recurringView()).checks.find((c) => c.target.id === id)!
    expect(check).toMatchObject({ differs: true, ballast: { cents: 300_000, frequency: 'biweekly' } })

    await engine.saveIncomeSource(
      {
        personUserId: null,
        person: 'Alex',
        name: 'Acme',
        frequency: 'biweekly',
        startedOn: '2025-01-01',
        annualSalaryCents: 13_000_000,
        grossPerCheckCents: null,
        pretax: [{ label: '401k', percentBasisPoints: 600 }],
        taxes: [],
        netPerCheckCents: 200_000,
        spendingShareBasisPoints: 2000,
      },
      id,
    )
    check = (await engine.recurringView()).checks.find((c) => c.target.id === id)!
    expect(check.differs).toBe(false)
    // Income never counts as money going out.
    expect((await engine.recurringView()).outPerMonthCents).toBe(
      Math.ceil((4500 * 52 + 25_000 * 12 + 13_500 * 12 + 1549 * 12) / 12),
    )

    const paymentId = await engine.addIncomePayment({
      incomeSourceId: id,
      paidOn: '2025-05-30',
      landedCents: 400_000,
      pretaxEstimateCents: 650_000,
      note: 'Q1',
    })
    const income = await engine.householdIncome()
    const acme = income.people[0]!.sources[0]!
    expect(acme.paycheck.netCents).toBe(200_000)
    expect(acme.payments[0]).toMatchObject({ spendingCents: 80_000, keptCents: 320_000 })
    expect(acme.bonus!.days).toBe(656)
    expect(income.netWithBonus.yearly).toBe(200_000 * 26 + Math.floor((400_000 * 365) / 656))

    await expect(
      engine.addIncomePayment({ incomeSourceId: id, paidOn: '2026-12-01', landedCents: 1, pretaxEstimateCents: null }),
    ).rejects.toThrow('once it has landed')
    await engine.removeIncomePayment(paymentId)
    expect(await engine.listIncomePayments()).toEqual([])

    const received = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'income_received')))
    expect(received).toHaveLength(2)
  })

  it("names a household member's income from their own account, and refuses someone outside the household", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ issuer: 'test', subject: crypto.randomUUID(), email: 'jo@example.com', displayName: 'Jo Smith' })
      .returning()
    await db.insert(schema.householdMembers).values({ householdId, userId: user!.id })
    expect(await engine.householdMembers()).toEqual([{ userId: user!.id, name: 'Jo' }])

    const base = {
      name: 'Beta',
      frequency: 'monthly' as const,
      startedOn: null,
      annualSalaryCents: null,
      grossPerCheckCents: null,
      pretax: [],
      taxes: [],
      netPerCheckCents: 400_000,
      spendingShareBasisPoints: 2000,
    }
    const id = await engine.saveIncomeSource({ ...base, personUserId: user!.id, person: 'ignored' })
    const saved = (await engine.listIncomeSources()).find((s) => s.id === id)!
    expect(saved).toMatchObject({ personUserId: user!.id, person: 'Jo' })

    await expect(engine.saveIncomeSource({ ...base, personUserId: crypto.randomUUID(), person: '' })).rejects.toThrow(
      'not in this household',
    )
    await expect(engine.saveIncomeSource({ ...base, personUserId: null, person: ' ' })).rejects.toThrow('Say whose income')

    await engine.endIncomeSource(id)
    await db.delete(schema.incomeSources).where(eq(schema.incomeSources.id, id))
    await db.delete(schema.householdMembers).where(eq(schema.householdMembers.userId, user!.id))
    await db.delete(schema.users).where(eq(schema.users.id, user!.id))
  })
})
