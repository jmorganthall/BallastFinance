/**
 * The weekly digest (PRD §8). Asserts the text a person reads on their phone,
 * not just that a function returned something: a digest whose numbers are right
 * but whose wording is unreadable has failed the §9 plain-language requirement.
 *
 * Every figure is the one position's (D35), worked out by hand below. From
 * Sat 19 Sep 2026 (a transfer day) the $1,350 airfare due Sat 26 Sep is one
 * transfer away and the $1,800 of tickets due Sat 16 Jan 2027 seventeen, with
 * nothing held. A date four transfers away or fewer never sets the weekly
 * amount, so W and a one-time move M solve
 *     W = (315000 − M) / 17   and   135000 − M − W = 0
 * giving M = $1,237.50 and W = $112.50, which asks for $120 at the $10 step.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import {
  buildCheckInNudge,
  buildDueDatePrompts,
  buildWeeklyDigest,
  buildWeeklyDigestIfDue,
  weeklyDigestDueToday,
} from '@/server/digest'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('weekly digest', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let accountId: string
  let engine: Engine

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `Digest ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id

    engine = new Engine({ householdId, actorUserId: null, db, today: '2026-09-19' })

    const account = await engine.createReserveAccount({
      name: 'Annual Expenses',
      institutionLabel: 'Capital One 360 — Annual Expenses',
    })
    accountId = account.id
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Disney Feb 2027' },
      line_items: [
        { label: 'Park tickets', unit_amount: '600', quantity: 3, due_date: '2027-01-16', reserve_account: account.id },
        { label: 'Airfare', unit_amount: '450', quantity: 3, due_date: '2026-09-26', reserve_account: account.id },
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

  it('leads with what the reader has to do', async () => {
    const digest = await buildWeeklyDigest({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
    })

    expect(digest.kind).toBe('weekly_digest')
    // Nobody has said what the bank moves yet, and the $1,350 airfare is one
    // transfer away. Level from here, W = (315,000 - M) / 17 and
    // 135,000 - M - W = 0 give M = 123,750 and W = 11,250 ($120 at the $10
    // step): two things to do, confirm the transfer and make the move.
    expect(digest.summary).toBe('Ballast: 2 thing(s) to do this week.')
    expect(digest.body).toContain('**Not caught up yet.**')
    expect(digest.body).toContain(
      '- **Annual Expenses**: transfer not confirmed yet — needs $120.00/week',
    )
    expect(digest.body).toContain('## Still to do')
    expect(digest.body).toContain(
      '- Tell Ballast what the recurring transfer into Annual Expenses moves each week. It needs $120.00.',
    )
    expect(digest.body).toContain(
      '- Move $1,237.50 into Annual Expenses once, by 2026-09-26. It is too soon for the weekly transfer to cover.',
    )
  })

  it('warns about what lands in the next two weeks', async () => {
    const digest = await buildWeeklyDigest({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
    })
    expect(digest.body).toContain('Coming up in the next two weeks')
    expect(digest.body).toContain('Airfare')
    // The one four months out is not a surprise yet.
    expect(digest.body).not.toMatch(/Coming up[\s\S]*Park tickets/)
  })

  it('deep-links to the screen that resolves it', async () => {
    const digest = await buildWeeklyDigest({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
    })
    expect(digest.link).toBe('https://ballast.example/')

    const nudge = await buildCheckInNudge({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
      afterWeeks: 0,
    })
    expect(nudge?.link).toBe('https://ballast.example/check-in')
  })

  it('carries structured detail so n8n can format its own message', async () => {
    const digest = await buildWeeklyDigest({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
    })
    expect(digest.detail).toEqual({
      all_caught_up: false,
      bank_per_week_cents: 0,
      accounts: [
        {
          id: accountId,
          name: 'Annual Expenses',
          status: 'unconfirmed',
          bank_per_week_cents: null,
          needs_per_week_cents: 12000,
          likely_holds_cents: 0,
          short_on: null,
        },
      ],
      todo_count: 2,
      outstanding_count: 0,
      close_out_count: 0,
    })
  })

  it('goes out on the household transfer day and on no other (PRD D31)', async () => {
    const base = { householdId, baseUrl: 'https://ballast.example', db }

    // Saturday until the household says otherwise: 19 Sep 2026 is one.
    expect(await weeklyDigestDueToday({ ...base, today: '2026-09-19' })).toBe(true)
    expect(await weeklyDigestDueToday({ ...base, today: '2026-09-18' })).toBe(false)
    expect(await buildWeeklyDigestIfDue({ ...base, today: '2026-09-18' })).toBeNull()
    expect((await buildWeeklyDigestIfDue({ ...base, today: '2026-09-19' }))?.kind).toBe('weekly_digest')

    // A Friday household gets it on Friday, and nothing on Saturday.
    await engine.setTransferWeekday(5)
    expect(await weeklyDigestDueToday({ ...base, today: '2026-09-18' })).toBe(true)
    expect(await weeklyDigestDueToday({ ...base, today: '2026-09-19' })).toBe(false)
    expect(await buildWeeklyDigestIfDue({ ...base, today: '2026-09-19' })).toBeNull()

    // They set up the $120 asked for, and say so on that Friday.
    const onFriday = new Engine({ householdId, actorUserId: null, db, today: '2026-09-18' })
    await onFriday.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 12000 })

    const friday = await buildWeeklyDigestIfDue({ ...base, today: '2026-09-18' })
    expect(friday?.kind).toBe('weekly_digest')
    expect(friday!.body).toContain('This week — 2026-09-18')
    // And the numbers in it count Fridays. From Fri 18 Sep the airfare due
    // Sat 26 Sep has one Friday before it (the 25th): $120 arrives against
    // $1,350 due, so the account runs short by $1,230 that day, and that is
    // the one-time move -- with it, the 17 Fridays to 16 Jan bring $3,270
    // for the $3,150 due. (Counted in Saturdays it would be two transfers
    // and $1,110.)
    expect(friday!.summary).toBe('Ballast: 1 thing(s) to do this week.')
    expect(friday!.body).toContain(
      '- **Annual Expenses**: $120.00/week at the bank — runs short on 2026-09-26 by $1,230.00',
    )
    expect(friday!.body).toContain(
      '- Move $1,230.00 into Annual Expenses once, by 2026-09-26. It is too soon for the weekly transfer to cover.',
    )
    expect(friday!.detail).toMatchObject({
      all_caught_up: false,
      bank_per_week_cents: 12000,
      accounts: [
        {
          status: 'short',
          bank_per_week_cents: 12000,
          needs_per_week_cents: 12000,
          likely_holds_cents: 0,
          short_on: '2026-09-26',
        },
      ],
      todo_count: 1,
    })
  })

  it('says All caught up once every account is covered on its confirmed transfer', async () => {
    // The $1,230 is marked moved (D34): the account likely holds it until
    // the next count. On $120 a Friday that is exactly $1,350 by 26 Sep,
    // and $1,230 + 17 x $120 = $3,270 by 16 Jan for the $3,150 due.
    const onFriday = new Engine({ householdId, actorUserId: null, db, today: '2026-09-18' })
    await onFriday.confirmMoveIn({ reserveAccountId: accountId, amountCents: 123000 })

    const digest = await buildWeeklyDigest({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-18',
    })
    expect(digest.summary).toBe('Ballast: all caught up.')
    expect(digest.body).toContain(
      '**All caught up.** On autopilot, every account covers everything due through 2027-01-16.',
    )
    expect(digest.body).toContain(
      '- **Annual Expenses**: $120.00/week at the bank — covers everything through 2027-01-16',
    )
    expect(digest.body).not.toContain('## Still to do')
    expect(digest.detail).toMatchObject({
      all_caught_up: true,
      accounts: [{ status: 'on_track', likely_holds_cents: 123000, short_on: null }],
      todo_count: 0,
    })
  })

  it('nudges only when a balance is actually stale', async () => {
    const stale = await buildCheckInNudge({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
      afterWeeks: 2,
    })
    expect(stale).not.toBeNull() // never checked in

    await engine.confirmBalance({
      reserveAccountId: (await engine.listReserveAccounts())[0]!.id,
      amountCents: 1000,
    })

    const fresh = await buildCheckInNudge({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
      afterWeeks: 2,
    })
    expect(fresh).toBeNull() // just checked in
  })

  it('prompts about a passed due date in words a person can answer', async () => {
    const prompts = await buildDueDatePrompts({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-10-03',
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.summary).toContain('did the Airfare money get spent from Annual Expenses?')
    expect(prompts[0]!.body).toContain('stays counted in your totals')
  })
})
