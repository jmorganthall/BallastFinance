/**
 * A repeating plan moves on by itself on its date, and money goes out a bit
 * at a time until a person says it is finished (PRD D53), against a live
 * database.
 *
 * Ian's birthday party: $500 every year on Saturday 3 October, the money all
 * there. Three weeks after the party nobody has answered "did this get
 * spent?"; the next party saves anyway, and the spends, finishes, saves back
 * up and undos are events the position reads on every read.
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

describeDb('rounds (D53)', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let accountId: string
  let packageId: string
  let partyId: string
  let engine: Engine
  const pin = (date: string) => {
    engine = new Engine({ householdId, actorUserId: null, db, today: date })
  }
  const account = async (): Promise<AccountPosition> =>
    (await engine.position()).accounts.find((a) => a.account.id === accountId)!
  const party = async () => (await engine.listLineItems()).find((li) => li.id === partyId)!
  const plan = async () => (await engine.position()).plans.find((p) => p.package.id === packageId)!
  const lastSpend = async () => (await engine.roundHistory(packageId)).find((e) => e.kind === 'spend' && !e.undone)!
  /** Everything a screen reads for the account, the to-dos and the plan. */
  const figures = async () => {
    const p = await engine.position()
    return {
      account: p.accounts.find((a) => a.account.id === accountId),
      todos: p.todos,
      plan: p.plans.find((x) => x.package.id === packageId),
      prompts: await engine.closeOutPrompts(),
    }
  }

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Rounds ${crypto.randomUUID()}` }).returning()
    householdId = household!.id

    pin('2026-09-19')
    accountId = (await engine.createReserveAccount({ name: 'Gifts & Giving', institutionLabel: 'Cap One' })).id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Ian Birthday Party' },
      line_items: [
        {
          label: 'Ian Birthday Party',
          unit_amount: '500',
          due_date: '2026-10-03',
          reserve_account: accountId,
          recurrence: { every: 1, unit: 'year' },
        },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    packageId = created.packageId
    await engine.commitPackage(packageId)
    partyId = (await engine.listLineItems()).find((li) => li.packageId === packageId)!.id
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 50000 })
    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 1000 })
    // Three weeks after the party.
    pin('2026-10-24')
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('moves on by itself on the date: this year still asks and is held, next year saves', async () => {
    const prompts = await engine.closeOutPrompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      lineItemId: partyId,
      label: 'Ian Birthday Party (2026)',
      dueDate: '2026-10-03',
      plannedCents: 50000,
      spentCents: 0,
      needsCents: 50000,
    })
    const parts = (await plan()).parts
    expect(parts.map((x) => [x.lineItem.label, x.lineItem.dueDate, x.totalCents])).toEqual([
      ['Ian Birthday Party (2026)', '2026-10-03', 50000],
      ['Ian Birthday Party (2027)', '2027-10-03', 50000],
    ])
    expect(parts[0]!.status).toBe('ready_to_spend')
    expect(parts[1]!.savingSince).toEqual({ date: '2026-10-03', reason: 'last_occurrence' })
    // The stored date stays at the oldest open round.
    expect((await party()).dueDate).toBe('2026-10-03')
  })

  it('takes a spend off what the round holds and out of the account, and moves no weekly amount', async () => {
    const before = await account()
    await engine.recordSpend({ lineItemId: partyId, amountCents: 10000 })
    const after = await account()
    expect((await engine.closeOutPrompts())[0]).toMatchObject({ spentCents: 10000, needsCents: 40000 })
    expect(after.money.totalCents).toBe(before.money.totalCents - 10000)
    expect(after.money.countOwed).toBe(true)
    expect(after.weeklyExactCents).toBe(before.weeklyExactCents)
    expect(after.status).toBe(before.status)
  })

  it('undoes a spend back to exactly the figures from before it', async () => {
    const before = await figures()
    await engine.recordSpend({ lineItemId: partyId, amountCents: 20000 })
    expect((await figures()).prompts[0]!.needsCents).toBe(20000)
    const spend = await lastSpend()
    expect(spend.amountCents).toBe(20000)
    await engine.undoRoundEvent({ eventId: spend.eventId })
    expect(await figures()).toEqual(before)
    // It stays in the history, marked as taken back, and cannot be taken back twice.
    const history = await engine.roundHistory(packageId)
    expect(history.find((e) => e.eventId === spend.eventId)!.undone).toBe(true)
    await expect(engine.undoRoundEvent({ eventId: spend.eventId })).rejects.toThrow(/already taken back/)
  })

  it('finishes the round once its spends reach the total, more allowed, and leaves next year', async () => {
    await engine.recordSpend({ lineItemId: partyId, amountCents: 45000 })
    expect(await engine.closeOutPrompts()).toEqual([])
    expect((await party()).dueDate).toBe('2027-10-03')
    const parts = (await plan()).parts
    expect(parts.map((x) => [x.lineItem.label, x.lineItem.dueDate])).toEqual([['Ian Birthday Party', '2027-10-03']])
    // $50 more went out than planned: it came out of the account all the same.
    expect((await account()).money.spendsSinceCents).toBe(55000)
  })

  it('opens the round again when the spend that finished it is taken back', async () => {
    await engine.undoRoundEvent({ eventId: (await lastSpend()).eventId })
    expect((await engine.closeOutPrompts())[0]).toMatchObject({ dueDate: '2026-10-03', spentCents: 10000, needsCents: 40000 })
    expect((await party()).dueDate).toBe('2026-10-03')
  })

  it('on Finish leaves what the round still held in the account', async () => {
    const before = await account()
    await engine.finishRound({ lineItemId: partyId, roundDue: '2026-10-03' })
    const after = await account()
    expect(await engine.closeOutPrompts()).toEqual([])
    expect(after.money.totalCents).toBe(before.money.totalCents)
    expect((await party()).dueDate).toBe('2027-10-03')
  })

  it('saves a round lowered by an early spend back up, and that can be undone too', async () => {
    await engine.recordSpend({ lineItemId: partyId, roundDue: '2027-10-03', amountCents: 5000 })
    expect((await plan()).parts[0]!.totalCents).toBe(45000)
    const lowered = await account()
    await engine.saveRoundBackUp({ lineItemId: partyId, roundDue: '2027-10-03' })
    expect((await plan()).parts[0]).toMatchObject({ totalCents: 50000, round: { spentCents: 5000, countedSpentCents: 0 } })
    expect((await account()).weeklyExactCents).toBeGreaterThanOrEqual(lowered.weeklyExactCents)
    await expect(engine.saveRoundBackUp({ lineItemId: partyId, roundDue: '2027-10-03' })).rejects.toThrow(/Nothing spent/)
    const save = (await engine.roundHistory(packageId)).find((e) => e.kind === 'save_back_up')!
    await engine.undoRoundEvent({ eventId: save.eventId })
    expect((await plan()).parts[0]!.totalCents).toBe(45000)
  })

  it('finished before its date, moves on at once, saving from that day', async () => {
    await engine.finishRound({ lineItemId: partyId, roundDue: '2027-10-03' })
    expect((await party()).dueDate).toBe('2028-10-03')
    expect((await plan()).parts[0]!.savingSince).toEqual({ date: '2026-10-24', reason: 'finished' })
  })

  it('never gives money back past a count, which is the truth about what the account holds', async () => {
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 30000 })
    const before = await account()
    await engine.undoRoundEvent({ eventId: (await lastSpend()).eventId })
    expect((await account()).money.totalCents).toBe(before.money.totalCents)
  })

  it('stacks rounds nobody answered, oldest first, and a spend goes to the oldest', async () => {
    pin('2029-10-10')
    const prompts = await engine.closeOutPrompts()
    expect(prompts.map((x) => x.label)).toEqual(['Ian Birthday Party (2028)', 'Ian Birthday Party (2029)'])
    await engine.recordSpend({ lineItemId: partyId, amountCents: 50000 })
    expect((await engine.closeOutPrompts()).map((x) => x.dueDate)).toEqual(['2029-10-03'])
    expect((await party()).dueDate).toBe('2029-10-03')
    pin('2026-10-24')
  })

  it('a one-off finished by its spend retires, comes back on undo, and one taken out stays out', async () => {
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Cake' },
      line_items: [{ label: 'Cake', unit_amount: '100', due_date: '2026-10-31', reserve_account: accountId }],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
    const cakeId = (await engine.listLineItems()).find((li) => li.packageId === created.packageId)!.id
    const cake = async () => (await engine.listLineItems()).find((li) => li.id === cakeId)!

    // Bought early: left blank, it records what the round still holds.
    await engine.recordSpend({ lineItemId: cakeId })
    expect((await cake()).state).toBe('retired')
    const spend = (await engine.roundHistory(created.packageId))[0]!
    expect(spend.amountCents).toBe(10000)
    await engine.undoRoundEvent({ eventId: spend.eventId })
    expect((await cake()).state).toBe('accruing')

    await engine.recordSpend({ lineItemId: cakeId, amountCents: 2000 })
    await engine.retireLineItem(cakeId)
    const partial = (await engine.roundHistory(created.packageId)).find((e) => !e.undone)!
    await expect(engine.undoRoundEvent({ eventId: partial.eventId })).rejects.toThrow(/taken out of the plan/)
  })
})
