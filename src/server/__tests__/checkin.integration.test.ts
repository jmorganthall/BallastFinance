/**
 * Check-ins and close-out against a live database, read through the one
 * position (PRD §5, D35).
 *
 * The acceptance criterion (PRD §12) is that a full check-in and a close-out
 * can be completed, so these walk the whole loop rather than testing the
 * pieces: a count replaces what the account likely holds, the account is
 * judged on the transfer confirmed at the bank, and the position derives
 * what to do about it -- raise the transfer, or make a one-time move when a
 * date is too near for the transfer to reach.
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

describeDb('check-ins and close-out (D35)', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string
  let packageId: string

  const pin = (date: string) => {
    engine = new Engine({ householdId, actorUserId: null, db, today: date })
  }
  const account = async (): Promise<AccountPosition> =>
    (await engine.position()).accounts.find((a) => a.account.id === accountId)!

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `CheckIn ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id

    // Saturday 19 Sep 2026: a transfer day. The step stays the default $10.
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
    packageId = created.packageId
    await engine.commitPackage(packageId)
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

  it('asks for the transfer before it judges the account, and records nothing for asking', async () => {
    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    // Never counted, nothing stated at commit, no transfer known: $0 from the commit.
    expect(a.money).toMatchObject({ from: 'nothing', on: '2026-09-19', totalCents: 0 })
    // $1,700 over the 13 Saturdays in (Sep 19, Dec 19]: 170,000 / 13 = 13,076.9 -> 13,077,
    // rounded up to the $10 step: $140.
    expect(a.weeklyExactCents).toBe(13077)
    expect(a.weeklyCents).toBe(14000)
    expect(a.status).toBe('unconfirmed')
    expect(p.todos).toEqual([
      {
        kind: 'set_transfer',
        accountId,
        accountName: 'Annual Expenses',
        fromCents: null,
        toCents: 14000,
        reason: 'confirm',
        blocking: true,
      },
    ])
    expect(p.allCaughtUp).toBe(false)

    // The to-do is derived on every read, never issued ahead of time: an ask
    // nobody acted on is not a fact anywhere.
    expect(await engine.listIssuedInstructions()).toEqual([])
    expect(await engine.outstandingInstructions()).toEqual([])
  })

  it('judges the account on the transfer once a person confirms it', async () => {
    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 14000 })

    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    // Today is a transfer day, so the next transfer is today's.
    expect(a.bank).toEqual({ perWeekCents: 14000, confirmedOn: '2026-09-19', nextWeekCents: 14000 })
    // 0 + 13 x 14,000 = 182,000 >= 170,000 on Dec 19.
    expect(a.status).toBe('on_track')
    expect(a.short).toBeNull()
    expect(p.todos).toEqual([])
    expect(p.allCaughtUp).toBe(true)

    // Asked and done at once: on the record, never left open.
    const issued = await engine.listIssuedInstructions()
    expect(issued).toHaveLength(1)
    expect(issued[0]).toMatchObject({ type: 'set_weekly_transfer', amountCents: 14000, targetId: accountId })
    expect(await engine.outstandingInstructions()).toEqual([])
  })

  it('records a confirmed balance, which replaces what the account likely holds', async () => {
    pin('2026-10-31')
    // Before the count: six Saturdays in (Sep 19, Oct 31] at $140 = $840.
    expect((await account()).money).toMatchObject({
      from: 'nothing',
      on: '2026-09-19',
      transfersSinceCents: 84000,
      totalCents: 84000,
    })

    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 50000 })

    const latest = await engine.latestConfirmedBalances()
    expect(latest.get(accountId)).toEqual({ amountCents: 50000, on: '2026-10-31' })
    expect((await account()).money).toEqual({
      from: 'count',
      on: '2026-10-31',
      startCents: 50000,
      transfersSinceCents: 0,
      movesSinceCents: 0,
      spendsSinceCents: 0,
      totalCents: 50000,
    })
  })

  it('a count that finds less makes the account Short and asks to raise the transfer', async () => {
    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    // Seven Saturdays in (Oct 31, Dec 19]: 50,000 + 7 x 14,000 = 148,000, which is
    // 22,000 short of 170,000 on the day the gifts are due.
    expect(a.status).toBe('short')
    expect(a.short).toEqual({ on: '2026-12-19', byCents: 22000 })
    // (170,000 - 50,000) / 7 = 17,142.9 -> 17,143, rounded up to $180. Seven
    // transfers is far enough that the transfer, not a move, closes the gap.
    expect(a.weeklyExactCents).toBe(17143)
    expect(a.weeklyCents).toBe(18000)
    expect(a.oneTimeMove).toBeNull()
    expect(p.todos).toEqual([
      {
        kind: 'set_transfer',
        accountId,
        accountName: 'Annual Expenses',
        fromCents: 14000,
        toCents: 18000,
        reason: 'raise',
        blocking: true,
      },
    ])
    // The part is due on the day the account runs short, so it is Short too, and so is its plan.
    expect(a.parts.map((x) => x.status)).toEqual(['short'])
    expect(p.plans.find((x) => x.package.id === packageId)!.status).toBe('short')
    expect(p.allCaughtUp).toBe(false)
  })

  it('confirming the raised transfer puts the account back on track; the part is catching up, not short', async () => {
    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 18000 })

    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    // 50,000 + 7 x 18,000 = 176,000 >= 170,000.
    expect(a.status).toBe('on_track')
    expect(a.short).toBeNull()
    expect(a.bank).toMatchObject({ perWeekCents: 18000, confirmedOn: '2026-10-31', nextWeekCents: 18000 })
    expect(p.todos).toEqual([])
    expect(p.allCaughtUp).toBe(true)
    // Confirming the transfer moves no money today.
    expect(a.money.totalCents).toBe(50000)

    // The steady line: 170,000 / 13 = 13,076.9 -> 13,077 a week from the commit,
    // and 6 of 13 transfers in by Oct 31: ceil(170,000 x 6 / 13) = ceil(78,461.5) = 78,462.
    // The $500 counted toward it is below that: catching up, which the account
    // covers. Nothing is due sooner, so the gap is money not in the account yet.
    const [gifts] = a.parts
    expect(gifts).toMatchObject({
      savingSince: { date: '2026-09-19', reason: 'plan_started' },
      steadyPerWeekCents: 13077,
      savedForCents: 78462,
      countedCents: 50000,
      coveringSoonerCents: 0,
      notYetHereCents: 28462,
      status: 'catching_up',
    })
    expect(p.plans.find((x) => x.package.id === packageId)!.status).toBe('catching_up')

    // The chart reads the same position.
    const chart = await engine.planChart(packageId)
    expect(chart?.countedToday).toEqual({ date: '2026-10-31', cents: 50000 })
    expect(chart?.targetCents).toBe(170000)
    expect(chart?.catchUp).not.toBeNull()
  })

  it('carries the transfers since the count until the next one', async () => {
    pin('2026-11-14')
    // Saturdays Nov 7 and 14 at the $180 in force since Oct 31: 50,000 + 36,000.
    expect((await account()).money).toMatchObject({
      from: 'count',
      on: '2026-10-31',
      startCents: 50000,
      transfersSinceCents: 36000,
      totalCents: 86000,
    })
  })

  it('keeps asking about a passed due date instead of dropping it', async () => {
    pin('2026-12-26')
    const prompts = await engine.closeOutPrompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.label).toBe('Gifts')
    expect(prompts[0]!.daysOverdue).toBe(7)

    // Still owed until a human answers: it goes out today in the run-forward.
    const a = await account()
    // Eight Saturdays in (Oct 31, Dec 26] at $180: 50,000 + 144,000.
    expect(a.money.totalCents).toBe(194000)
    expect(a.horizon).toBe('2026-12-26')
    expect(a.parts).toHaveLength(1)
    expect(a.parts[0]).toMatchObject({
      isOverdue: true,
      outflowDate: '2026-12-26',
      totalCents: 170000,
      savedForCents: 170000,
      countedCents: 170000,
      status: 'on_track',
    })
    expect(a.status).toBe('on_track')
  })

  it('retires the item on confirmation and takes it out of the totals', async () => {
    const [prompt] = await engine.closeOutPrompts()
    await engine.confirmSpend({ lineItemId: prompt!.lineItemId, actualAmountCents: 165000 })

    expect(await engine.closeOutPrompts()).toHaveLength(0)

    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    expect(a.parts).toEqual([])
    expect(a.horizon).toBeNull()
    // What was spent leaves the likely balance until the next count: 194,000 - 165,000.
    expect(a.money).toMatchObject({ spendsSinceCents: 165000, totalCents: 29000 })
    const plan = p.plans.find((x) => x.package.id === packageId)!
    expect(plan.parts).toEqual([])
    expect(plan.totalCents).toBe(0)
    expect((await engine.packageViews()).find((v) => v.package.id === packageId)!.totalCents).toBe(0)
    // With no plan left in the account nothing it asks for is blocking.
    expect(p.allCaughtUp).toBe(true)
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
 * One-time moves (D34, D35). A date too near for the transfer to reach asks
 * for a move; a move marked done is money the account holds until a count
 * includes it; and nothing is counted until a person says it is done.
 *
 * Round-up is zero here so every figure is exact. The plan is built so the
 * transfer the position asks for on the commit day is $100 exactly:
 *   Registration $500 due Sat 24 Oct: 5 Saturdays from Sep 19, 3 from Oct 3.
 *   Gifts $2,200 due Sat 27 Mar 2027: 27 Saturdays from Sep 19, 25 from Oct 3.
 *   On Sep 19, W = max(50,000 / 5, 270,000 / 27) = 10,000.
 */
describeDb('one-time moves (D34, D35)', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string

  const pin = (date: string) => {
    engine = new Engine({ householdId, actorUserId: null, db, today: date })
  }
  const account = async (): Promise<AccountPosition> =>
    (await engine.position()).accounts.find((a) => a.account.id === accountId)!
  const doneMoves = async () => (await engine.openCommitmentsByAccount()).get(accountId)!.doneMoves

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Moves ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    pin('2026-09-19')
    await engine.putSetting('transfer_round_up_cents', 0)
    accountId = (
      await engine.createReserveAccount({ name: 'Annual Expenses', institutionLabel: 'Capital One 360' })
    ).id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'This year' },
      line_items: [
        { label: 'Registration', unit_amount: '500', quantity: 1, due_date: '2026-10-24', reserve_account: accountId },
        { label: 'Gifts', unit_amount: '2200', quantity: 1, due_date: '2027-03-27', reserve_account: accountId },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.settings).where(eq(schema.settings.householdId, householdId))
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('asks for a transfer that meets every date, and nothing else once it is set', async () => {
    const before = await account()
    expect(before.weeklyExactCents).toBe(10000)
    expect(before.oneTimeMove).toBeNull()

    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 10000 })
    const p = await engine.position()
    expect(p.accounts.find((a) => a.account.id === accountId)!.status).toBe('on_track')
    expect(p.todos).toEqual([])
    expect(p.allCaughtUp).toBe(true)
  })

  it('a check-in that finds too little, with a date too near for the transfer, asks for a one-time move', async () => {
    pin('2026-10-03')
    // Two Saturdays at $100 since the commit: on track as far as anyone knows.
    const before = await account()
    expect(before.money.totalCents).toBe(20000)
    expect(before.status).toBe('on_track')

    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 5000 })

    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    expect(a.money).toMatchObject({ from: 'count', startCents: 5000, totalCents: 5000 })
    // On the $100 transfer: 5,000 + 3 x 10,000 = 35,000 by Oct 24, 15,000 short of 50,000.
    expect(a.status).toBe('short')
    expect(a.short).toEqual({ on: '2026-10-24', byCents: 15000 })
    // Oct 24 is 3 transfers away, too near to set the transfer. A move alone
    // puts it right on the $100 already set up: 5,000 + M + 30,000 >= 50,000
    // and 5,000 + M + 250,000 >= 270,000 both hold from M = 15,000. The level
    // amount agrees: W = (270,000 - 5,000 - M) / 25 = 10,000 with that move,
    // so the transfer is not asked to change.
    expect(a.weeklyExactCents).toBe(10000)
    expect(a.transferChange).toBeNull()
    expect(a.oneTimeMove).toEqual({ amountCents: 15000, byDate: '2026-10-24' })
    expect(p.todos).toEqual([
      {
        kind: 'move_in',
        accountId,
        accountName: 'Annual Expenses',
        amountCents: 15000,
        byDate: '2026-10-24',
        blocking: true,
      },
    ])
    expect(a.parts.every((x) => x.status === 'short')).toBe(true)
    expect(p.allCaughtUp).toBe(false)
  })

  it('marking the move done counts it as held until the next count includes it (D34)', async () => {
    await engine.confirmMoveIn({ reserveAccountId: accountId, amountCents: 15000 })

    // Asked and done at once: nothing left on the list, and the money is carried.
    expect(await engine.outstandingInstructions()).toEqual([])
    const move = (await engine.listIssuedInstructions()).find((i) => i.type === 'one_time_move')!
    expect(move).toMatchObject({ amountCents: 15000, targetId: accountId, purpose: 'catch_up' })
    expect(await doneMoves()).toEqual([
      { instructionId: move.instructionId, amountCents: 15000, confirmedOn: '2026-10-03' },
    ])

    const p = await engine.position()
    const a = p.accounts.find((x) => x.account.id === accountId)!
    expect(a.money).toMatchObject({ from: 'count', startCents: 5000, movesSinceCents: 15000, totalCents: 20000 })
    // 20,000 + 30,000 = 50,000 by Oct 24 and 20,000 + 250,000 = 270,000 by Mar 27.
    expect(a.status).toBe('on_track')
    expect(a.oneTimeMove).toBeNull()
    expect(p.todos).toEqual([])
    expect(p.allCaughtUp).toBe(true)

    // A count entered later the same day includes it, so it is carried no more.
    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 20000 })
    expect(await doneMoves()).toEqual([])
    expect((await account()).money).toMatchObject({
      from: 'count',
      startCents: 20000,
      movesSinceCents: 0,
      totalCents: 20000,
    })
    expect((await account()).status).toBe('on_track')
  })

  it('carries a move-out marked done at the amount given, and a count takes it over', async () => {
    const outId = await engine.issueInstruction({
      type: 'one_time_move_out',
      amountCents: 1000,
      targetId: accountId,
      targetLabel: 'Annual Expenses',
    })
    await engine.confirmInstruction({ instructionId: outId, actualAmountCents: 800 })

    expect(await doneMoves()).toEqual([{ instructionId: outId, amountCents: -800, confirmedOn: '2026-10-03' }])
    const a = await account()
    expect(a.money).toMatchObject({ movesSinceCents: -800, totalCents: 19200 })
    // 19,200 + 30,000 = 49,200 by Oct 24: $8 short, which is what a move now has to cover.
    expect(a.status).toBe('short')
    expect(a.short).toEqual({ on: '2026-10-24', byCents: 800 })
    expect(a.oneTimeMove).toEqual({ amountCents: 800, byDate: '2026-10-24' })

    await engine.confirmBalance({ reserveAccountId: accountId, amountCents: 19200 })
    expect(await doneMoves()).toEqual([])
    const counted = await account()
    expect(counted.money).toMatchObject({ from: 'count', startCents: 19200, movesSinceCents: 0, totalCents: 19200 })
    expect(counted.short).toEqual({ on: '2026-10-24', byCents: 800 })
  })

  it('counts an old catch-up ask only once it is done, and never asks for the same money twice', async () => {
    // A catch-up move still on the to-do list from before D35.
    const id = await engine.issueInstruction({
      type: 'one_time_move',
      amountCents: 800,
      targetId: accountId,
      targetLabel: 'Annual Expenses',
    })
    expect((await engine.outstandingInstructions()).map((i) => i.instructionId)).toEqual([id])

    // Open, it stands in for the move the position would ask for...
    let p = await engine.position()
    let a = p.accounts.find((x) => x.account.id === accountId)!
    expect(a.oneTimeMove).toBeNull()
    expect(p.todos).toEqual([])
    // ...but the money is not there until someone says it is: the account is
    // judged on what the bank holds and moves, never on a to-do not yet done.
    expect(a.money.totalCents).toBe(19200)
    expect(a.status).toBe('short')
    expect(p.allCaughtUp).toBe(false)

    await engine.confirmInstruction({ instructionId: id })
    p = await engine.position()
    a = p.accounts.find((x) => x.account.id === accountId)!
    expect(a.money).toMatchObject({ movesSinceCents: 800, totalCents: 20000 })
    expect(a.status).toBe('on_track')
    expect(p.allCaughtUp).toBe(true)
    expect(await engine.outstandingInstructions()).toEqual([])
  })
})

/**
 * A bump or cut confirmed before D35 still runs on the transfer days until it
 * ends, is stopped (D18), or a transfer set later replaces it. Nothing
 * issues one any more; these are the rows a household already has.
 *
 * Round-up zero. The roof is $5,200 due Sat 18 Sep 2027, 52 Saturdays from
 * the commit, so the transfer is $100 exactly.
 */
describeDb('a bump or cut from before D35', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string
  let bumpId: string

  const pin = (date: string) => {
    engine = new Engine({ householdId, actorUserId: null, db, today: date })
  }
  const account = async (): Promise<AccountPosition> =>
    (await engine.position()).accounts.find((a) => a.account.id === accountId)!

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Lifecycle ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    pin('2026-09-19')
    await engine.putSetting('transfer_round_up_cents', 0)
    accountId = (
      await engine.createReserveAccount({ name: 'Annual Expenses', institutionLabel: 'Capital One 360' })
    ).id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Roof' },
      line_items: [
        { label: 'Roof', unit_amount: '5200', quantity: 1, due_date: '2027-09-18', reserve_account: accountId },
      ],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId)
    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 10000 })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.settings).where(eq(schema.settings.householdId, householdId))
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('runs a bump on the transfer days only once it was marked done', async () => {
    pin('2026-10-12') // a Monday
    expect((await account()).weeklyExactCents).toBe(10000)

    // $80 over the 4 Saturdays in (Oct 12, Nov 7]: $20 a week.
    bumpId = await engine.issueInstruction({
      type: 'rate_bump',
      amountCents: 8000,
      targetId: accountId,
      targetLabel: 'Annual Expenses',
      endsOn: '2026-11-07',
    })
    // Offered is not accepted: the bank's figures do not move.
    expect((await account()).bank).toMatchObject({ perWeekCents: 10000, nextWeekCents: 10000 })

    await engine.confirmInstruction({ instructionId: bumpId })
    // The transfer as set up is unchanged; the bump rides on top of it on Oct 17.
    expect((await account()).bank).toMatchObject({ perWeekCents: 10000, nextWeekCents: 12000 })
  })

  it('stops a running bump that day, keeping what it delivered; nothing is edited in place', async () => {
    pin('2026-10-26') // a Monday
    const before = await account()
    // Five Saturdays in (Sep 19, Oct 26] at $100, plus the bump's two ($20 on Oct 17 and 24).
    expect(before.money).toMatchObject({ from: 'nothing', transfersSinceCents: 54000, totalCents: 54000 })

    await engine.endInstruction({ instructionId: bumpId })

    const after = await account()
    // Next Saturday is back to the transfer alone; the $40 that arrived stays arrived.
    expect(after.bank).toMatchObject({ perWeekCents: 10000, nextWeekCents: 10000 })
    expect(after.money.totalCents).toBe(54000)
    // The steady line of the plan is not the bank's business.
    expect(after.parts[0]!.savedForCents).toBe(before.parts[0]!.savedForCents)
    // The stopped bump keeps only what it delivered: two Saturdays of four.
    expect(await engine.acceptedDriftAdjustments()).toEqual([
      { id: bumpId, reserveAccountId: accountId, amountCents: 4000, startDate: '2026-10-12', endDate: '2026-10-26' },
    ])
    // The issued and confirmed events are as they were, plus one.
    expect(await engine.listEndedInstructions()).toEqual([{ instructionId: bumpId, endedOn: '2026-10-26' }])
    expect((await engine.listIssuedInstructions()).some((i) => i.instructionId === bumpId)).toBe(true)
    expect((await engine.listConfirmedInstructions()).some((c) => c.instructionId === bumpId)).toBe(true)

    await expect(engine.endInstruction({ instructionId: bumpId })).rejects.toThrow(/already been ended/)
  })

  it('lets a transfer set after a cut began replace it', async () => {
    // $40 off over the 4 Saturdays in (Oct 26, Nov 21]: $10 a week less.
    const cutId = await engine.issueInstruction({
      type: 'rate_cut',
      amountCents: 4000,
      targetId: accountId,
      targetLabel: 'Annual Expenses',
      endsOn: '2026-11-21',
    })
    await engine.confirmInstruction({ instructionId: cutId })
    expect((await account()).bank).toMatchObject({ perWeekCents: 10000, nextWeekCents: 9000 })

    pin('2026-11-02') // a Monday
    expect((await account()).bank?.nextWeekCents).toBe(9000)

    // "Yes, the transfer is set to this": the whole transfer, cut included.
    await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 10000 })
    const a = await account()
    expect(a.bank).toEqual({ perWeekCents: 10000, confirmedOn: '2026-11-02', nextWeekCents: 10000 })
    // Six Saturdays at $100, the stopped bump's $40, and the one Saturday the cut ran (-$10).
    expect(a.money.totalCents).toBe(60000 + 4000 - 1000)
    // 63,000 + 46 x 10,000 = 523,000 by the roof's due date.
    expect(a.status).toBe('on_track')
  })

  it('refuses to end an instruction another household issued', async () => {
    const [other] = await db
      .insert(schema.households)
      .values({ name: `Other ${crypto.randomUUID()}` })
      .returning()
    const stranger = new Engine({ householdId: other!.id, actorUserId: null, db, today: '2026-11-02' })
    const [mine] = await engine.listIssuedInstructions()
    await expect(stranger.endInstruction({ instructionId: mine!.instructionId })).rejects.toThrow(
      /No such instruction/,
    )
    expect(await stranger.listEndedInstructions()).toEqual([])
  })
})
