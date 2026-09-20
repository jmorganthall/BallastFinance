/**
 * The weekly digest (PRD §8). Asserts the text a person reads on their phone,
 * not just that a function returned something: a digest whose numbers are right
 * but whose wording is unreadable has failed the §9 plain-language requirement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { buildCheckInNudge, buildDueDatePrompts, buildWeeklyDigest } from '@/server/digest'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('weekly digest', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
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

  it('leads with the one number the reader acts on', async () => {
    const digest = await buildWeeklyDigest({
      householdId,
      baseUrl: 'https://ballast.example',
      db,
      today: '2026-09-19',
    })

    expect(digest.kind).toBe('weekly_digest')
    expect(digest.summary).toMatch(/^Ballast: move \$[\d,]+\.\d{2} this week/)
    expect(digest.body).toContain('**Annual Expenses**')
    expect(digest.body).toContain('/week')
    expect(digest.body).toContain('should hold')
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
    const detail = digest.detail as { total_per_week_cents: number; accounts: unknown[] }
    expect(detail.total_per_week_cents).toBeGreaterThan(0)
    expect(detail.accounts).toHaveLength(1)
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
