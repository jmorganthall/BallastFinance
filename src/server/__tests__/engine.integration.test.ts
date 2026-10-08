/**
 * End-to-end against a real PostgreSQL, because the Phase A acceptance
 * criterion (PRD §12) is about what the APP produces, not what a pure function
 * returns: "the Disney package is recreated in the app and the per-account
 * weekly instruction matches the sheet's math".
 *
 * Since D35 every figure asserted here is read off the one position
 * (`engine.position()`): the weekly amount is the smallest level transfer
 * that meets every due date, and an account is judged on the transfer
 * confirmed at the bank. TODAY is a Saturday, the default transfer day, and
 * "n transfers" below is `transferWeeksBetween(TODAY, date)`: the Saturdays
 * in (TODAY, date]. The household's step is the default $10.
 *
 *   Airfare,      $450,  due Sat 21 Nov 2026:  9 transfers (Annual Expenses)
 *   Park tickets, $600,  due Sat 16 Jan 2027: 17 transfers (Annual Expenses)
 *   Lodging,      $1200, due Sat 16 Jan 2027: 17 transfers (Long Term Savings)
 *
 * Skipped automatically when no database is configured, so the unit suite still
 * runs anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, type CommitPreview } from '@/server/engine'
import {
  INTAKE_CONTRACT_VERSION,
  derivedTodoSentence,
  derivedTodoSentenceParts,
  transferWeeksBetween,
} from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('engine against a live database', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let annualId: string
  let longTermId: string
  let preview: CommitPreview[] = []

  // A fixed "today" so the expected figures never drift with the calendar.
  const TODAY = '2026-09-19'

  const accountOf = async (id: string) => {
    const p = await engine.position()
    return { p, a: p.accounts.find((x) => x.account.id === id)! }
  }

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `Test ${crypto.randomUUID()}`, timezone: 'America/Chicago' })
      .returning()
    householdId = household!.id

    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })

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

  it('counts transfers the way the figures below assume', () => {
    expect(transferWeeksBetween(TODAY, '2026-11-21')).toBe(9)
    expect(transferWeeksBetween(TODAY, '2027-01-16')).toBe(17)
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

    // A draft moves no money: no account has a part, a weekly amount or a to-do.
    const p = await engine.position()
    expect(p.plans).toEqual([])
    expect(p.todos).toEqual([])
    for (const a of p.accounts) {
      expect(a.parts).toEqual([])
      expect(a.weeklyCents).toBe(0)
    }
  })

  it('prices what committing it would demand, before committing', async () => {
    const [pkg] = await engine.listPackages()
    preview = await engine.whatIfCommit(pkg!.id)

    // Annual: $450 by 21 Nov over 9 transfers is $50.00; $1,050 by 16 Jan
    // over 17 is ceil(105000 / 17) = $61.77. The larger sets the level:
    // $61.77, rounded up to the $10 step, $70.
    // Long Term: $1,200 by 16 Jan over 17 is ceil(120000 / 17) = $70.59 -> $80.
    // Nothing is due within four transfers, so neither needs a one-time move.
    expect(preview).toHaveLength(2)
    expect(preview.find((l) => l.accountId === annualId)).toEqual({
      accountId: annualId,
      accountName: 'Annual Expenses',
      weeklyNowCents: 0,
      weeklyAfterCents: 7000,
      moveAfterCents: 0,
      moveBy: null,
    })
    expect(preview.find((l) => l.accountId === longTermId)).toEqual({
      accountId: longTermId,
      accountName: 'Long Term Savings',
      weeklyNowCents: 0,
      weeklyAfterCents: 8000,
      moveAfterCents: 0,
      moveBy: null,
    })

    // Asking the question did not change the live numbers.
    const p = await engine.position()
    expect(p.plans).toEqual([])
    expect(p.accounts.every((a) => a.weeklyCents === 0 && a.parts.length === 0)).toBe(true)
  })

  it('commits with $0 reserved and asks for each account\'s transfer', async () => {
    const [pkg] = await engine.listPackages()
    await engine.commitPackage(pkg!.id)

    const [committed] = await engine.listPackages()
    expect(committed!.state).toBe('active')
    expect(committed!.committedAt).toBe(TODAY)

    const p = await engine.position()
    const annual = p.accounts.find((a) => a.account.id === annualId)!
    const longTerm = p.accounts.find((a) => a.account.id === longTermId)!
    for (const a of [annual, longTerm]) {
      // Nothing saved yet on day one: never counted, nothing said to be set
      // aside at commit, so the account starts from $0 on the commit day...
      expect(a.money).toMatchObject({ from: 'nothing', on: TODAY, totalCents: 0 })
      // ...and every steady line starts today, so nothing is owed yet either.
      expect(a.parts.every((x) => x.savedForCents === 0 && x.status === 'on_track')).toBe(true)
      // No transfer has been confirmed, so the account is not judged yet.
      expect(a.status).toBe('unconfirmed')
    }

    // The figures worked out above, now live, and the same the preview gave.
    expect(annual.weeklyExactCents).toBe(6177)
    expect(annual.weeklyCents).toBe(7000)
    expect(longTerm.weeklyExactCents).toBe(7059)
    expect(longTerm.weeklyCents).toBe(8000)
    for (const line of preview) {
      expect(p.accounts.find((a) => a.account.id === line.accountId)!.weeklyCents).toBe(
        line.weeklyAfterCents,
      )
    }

    // Every account now has a number to move: the to-do is to set it up.
    expect(p.todos).toHaveLength(2)
    expect(p.todos).toEqual(
      expect.arrayContaining([
        { kind: 'set_transfer', accountId: annualId, accountName: 'Annual Expenses', fromCents: null, toCents: 7000, reason: 'confirm', blocking: true },
        { kind: 'set_transfer', accountId: longTermId, accountName: 'Long Term Savings', fromCents: null, toCents: 8000, reason: 'confirm', blocking: true },
      ]),
    )
    expect(p.allCaughtUp).toBe(false)
  })

  it('refuses to commit twice', async () => {
    const [pkg] = await engine.listPackages()
    await expect(engine.commitPackage(pkg!.id)).rejects.toThrow(/already committed/)
  })

  it('is all caught up once the transfers asked for are confirmed', async () => {
    await engine.confirmTransfer({ reserveAccountId: annualId, perWeekCents: 7000 })
    await engine.confirmTransfer({ reserveAccountId: longTermId, perWeekCents: 8000 })

    // Annual at $70: $630 by 21 Nov (needs $450), $1,190 by 16 Jan (needs
    // $1,050). Long Term at $80: $1,360 by 16 Jan (needs $1,200).
    const p = await engine.position()
    expect(p.accounts.map((a) => a.status)).toEqual(['on_track', 'on_track'])
    expect(p.todos).toEqual([])
    expect(p.allCaughtUp).toBe(true)
    expect(p.coveredThrough).toBe('2027-01-16')
  })

  it('adds two travelers and asks for the transfer to rise by what they cost', async () => {
    const { p: before, a: annualBefore } = await accountOf(annualId)
    const planBefore = before.plans[0]!
    const airfareBefore = annualBefore.parts.find((x) => x.lineItem.label === 'Airfare')!

    const tickets = (await engine.listLineItems()).find((li) => li.label === 'Park tickets')!
    await engine.updateLineItem(tickets.id, { quantity: 3 })

    const { p: after, a: annual } = await accountOf(annualId)

    // Tickets are now $1,800, so $2,250 is due by 16 Jan: ceil(225000 / 17)
    // = $132.36 a week, $70.59 more than before -- the extra $1,200 over the
    // 17 transfers left, ceil(120000 / 17). Rounded up to the step, $140.
    expect(annual.weeklyExactCents).toBe(13236)
    expect(annual.weeklyExactCents - annualBefore.weeklyExactCents).toBe(7059)
    expect(annual.weeklyCents).toBe(14000)

    // The part that did not change keeps its steady share; the tickets'
    // share is their new total over the same 17 transfers.
    const airfare = annual.parts.find((x) => x.lineItem.label === 'Airfare')!
    const ticketPart = annual.parts.find((x) => x.lineItem.label === 'Park tickets')!
    expect(airfare.steadyPerWeekCents).toBe(airfareBefore.steadyPerWeekCents)
    expect(airfare.steadyPerWeekCents).toBe(5000) // $450 over 9
    expect(ticketPart.steadyPerWeekCents).toBe(10589) // ceil(180000 / 17)

    // On the $70 the bank moves, 17 transfers bring $1,190 by 16 Jan against
    // $2,250 due: $1,060 short. The airfare, due first, is still covered.
    expect(annual.status).toBe('short')
    expect(annual.short).toEqual({ on: '2027-01-16', byCents: 106000 })
    expect(ticketPart.status).toBe('short')
    expect(airfare.status).toBe('on_track')
    expect(after.plans[0]!.status).toBe('short')

    // The one to-do is to raise it; the other account is untouched.
    expect(after.todos).toEqual([
      { kind: 'set_transfer', accountId: annualId, accountName: 'Annual Expenses', fromCents: 7000, toCents: 14000, reason: 'raise', blocking: true },
    ])
    expect(after.accounts.find((a) => a.account.id === longTermId)).toMatchObject({
      status: 'on_track',
      weeklyCents: 8000,
    })
    expect(after.allCaughtUp).toBe(false)

    // Two more travelers at $600 is $1,200 more to find.
    expect(after.plans[0]!.totalCents - planBefore.totalCents).toBe(120000)
  })

  it('reports the account instruction in the form a human acts on', async () => {
    const [todo] = (await engine.position()).todos
    // Where to do it, which account, the new figure a week, and what it is now.
    const sentence = derivedTodoSentence(todo!)
    expect(sentence).toMatch(/^In Capital One 360, .*Annual Expenses.* \$140\.00 per week/)
    expect(sentence).toContain('$70.00')
    // The account the money goes to is marked, so the screen can set it apart (D34).
    expect(derivedTodoSentenceParts(todo!).filter((part) => part.target)).toEqual([
      { text: 'Annual Expenses', target: true },
    ])
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
    // A cent under the exact figure: 17 x $132.35 = $2,249.95 by 16 Jan, five
    // cents short of the $2,250 due. The weekly amount is the smallest that works.
    await engine.confirmTransfer({ reserveAccountId: annualId, perWeekCents: 13235 })
    let { a: annual } = await accountOf(annualId)
    expect(annual.status).toBe('short')
    expect(annual.short).toEqual({ on: '2027-01-16', byCents: 5 })

    // At exactly $132.36 every date passes: $1,191.24 by 21 Nov for the $450
    // airfare, and $2,250.12 by 16 Jan for everything.
    await engine.confirmTransfer({ reserveAccountId: annualId, perWeekCents: 13236 })
    ;({ a: annual } = await accountOf(annualId))
    expect(annual.status).toBe('on_track')
    expect(annual.short).toBeNull()
    expect(annual.parts.every((x) => x.status === 'on_track')).toBe(true)

    // And at the $140 asked for, with every account covered on the transfer
    // actually set up, the household is all caught up again.
    await engine.confirmTransfer({ reserveAccountId: annualId, perWeekCents: 14000 })
    const p = await engine.position()
    expect(p.accounts.every((a) => a.status === 'on_track')).toBe(true)
    expect(p.todos).toEqual([])
    expect(p.allCaughtUp).toBe(true)
  })

  it('keeps one household from seeing another', async () => {
    const [other] = await db.insert(schema.households).values({ name: 'Someone else' }).returning()
    const otherEngine = new Engine({ householdId: other!.id, actorUserId: null, db })

    expect(await otherEngine.listPackages()).toEqual([])
    expect(await otherEngine.listReserveAccounts()).toEqual([])
    const theirs = await otherEngine.position()
    expect(theirs.accounts).toEqual([])
    expect(theirs.plans).toEqual([])
    expect(theirs.todos).toEqual([])

    // And it cannot reach into ours by id.
    const [ourPackage] = await engine.listPackages()
    await expect(otherEngine.commitPackage(ourPackage!.id)).rejects.toThrow(/No such package/)
    await expect(otherEngine.whatIfCommit(ourPackage!.id)).resolves.toEqual([])
    await expect(
      otherEngine.confirmTransfer({ reserveAccountId: annualId, perWeekCents: 1 }),
    ).rejects.toThrow(/No such reserve account/)

    await db.delete(schema.households).where(eq(schema.households.id, other!.id))
  })
})
