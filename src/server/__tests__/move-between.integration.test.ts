/**
 * Spare money from one account into one that is Short (PRD D40), against a
 * live database.
 *
 * The position asks for it as one to-do before any new money; marking it
 * done records the move out and the move in together, so the same dollars
 * are never counted in both accounts or in neither; and an individual
 * account's side is its owner's to mark. Two engines, one per spouse.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('spare money between accounts (D40)', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let josh: Engine
  let shelby: Engine
  let soonId: string
  let laterId: string
  // Saturday, a transfer day.
  const TODAY = '2026-09-19'

  const instructionEvents = async () =>
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'instruction_issued')))

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `Between ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id

    const mk = async (email: string) => {
      const [u] = await db
        .insert(schema.users)
        .values({ issuer: 'https://accounts.google.com', subject: crypto.randomUUID(), email })
        .returning()
      await db.insert(schema.householdMembers).values({ userId: u!.id, householdId })
      return u!.id
    }
    const joshId = await mk(`josh-${crypto.randomUUID()}@example.com`)
    const shelbyId = await mk(`shelby-${crypto.randomUUID()}@example.com`)
    josh = new Engine({ householdId, actorUserId: joshId, db, today: TODAY })
    shelby = new Engine({ householdId, actorUserId: shelbyId, db, today: TODAY })

    soonId = (await josh.createReserveAccount({ name: 'Soon', institutionLabel: 'Cap One' })).id
    // Josh's own: only he may move money out of it.
    laterId = (
      await josh.createReserveAccount({ name: 'Later', institutionLabel: 'Cap One', scope: 'individual' })
    ).id

    for (const [name, accountId, due] of [
      ['Due soon', soonId, '2026-10-01'],
      ['Due later', laterId, '2028-09-16'],
    ] as const) {
      const created = await josh.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name },
        line_items: [{ label: name, unit_amount: '500', due_date: due, reserve_account: accountId }],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await josh.commitPackage(created.packageId)
    }

    // Soon holds nothing and $500 is due in under two weeks; Later holds
    // $1,000 against $500 due in two years. Neither transfer moves anything.
    await josh.confirmBalance({ reserveAccountId: soonId, amountCents: 0 })
    await josh.confirmBalance({ reserveAccountId: laterId, amountCents: 100000 })
    await josh.confirmTransfer({ reserveAccountId: soonId, perWeekCents: 0 })
    await josh.confirmTransfer({ reserveAccountId: laterId, perWeekCents: 0 })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
      await db.delete(schema.householdMembers).where(eq(schema.householdMembers.householdId, householdId))
    }
    await client?.end()
  })

  it('asks for the spare $500 to move across, as one to-do, before any new money', async () => {
    const p = await josh.position()
    const soon = p.accounts.find((a) => a.account.id === soonId)!
    const later = p.accounts.find((a) => a.account.id === laterId)!
    expect(soon.status).toBe('short')
    expect(soon.missingTodayCents).toBe(50000)
    expect(later.status).toBe('on_track')
    expect(later.extraCents).toBe(50000)
    // Not a raise and not a move from checking: the spare money comes first.
    expect(p.todos).toEqual([
      {
        kind: 'move_between',
        fromAccountId: laterId,
        fromAccountName: 'Later',
        accountId: soonId,
        accountName: 'Soon',
        amountCents: 50000,
        byDate: '2026-10-01',
        blocking: true,
      },
    ])
    expect(soon.transferChange).toBeNull()
    expect(soon.oneTimeMove).toBeNull()
  })

  it("refuses Shelby moving money out of Josh's own account, and records nothing", async () => {
    const before = (await instructionEvents()).length
    await expect(
      shelby.confirmMoveBetween({ fromAccountId: laterId, toAccountId: soonId, amountCents: 50000 }),
    ).rejects.toThrow(/belongs to someone else/)
    expect(await instructionEvents()).toHaveLength(before)
  })

  it('records the move out and the move in together, and every figure is worked out again', async () => {
    // By id, not position: the query has no order, so the rows can come back in any.
    const before = new Set((await instructionEvents()).map((e) => e.id))
    await josh.confirmMoveBetween({ fromAccountId: laterId, toAccountId: soonId, amountCents: 50000 })

    const added = (await instructionEvents()).filter((e) => !before.has(e.id))
    expect(added.map((e) => (e.payload as { type: string; target_id: string }).type).sort()).toEqual([
      'one_time_move',
      'one_time_move_out',
    ])

    const p = await josh.position()
    const soon = p.accounts.find((a) => a.account.id === soonId)!
    const later = p.accounts.find((a) => a.account.id === laterId)!
    expect(soon.money.totalCents).toBe(50000)
    expect(later.money.totalCents).toBe(50000)
    expect(soon.status).toBe('on_track')
    expect(later.status).toBe('on_track')
    expect(soon.parts[0]!.status).toBe('on_track')
    expect(p.todos.filter((t) => t.blocking)).toEqual([])
    expect(p.allCaughtUp).toBe(true)
  })

  it('refuses a move from an account into itself', async () => {
    await expect(
      josh.confirmMoveBetween({ fromAccountId: soonId, toAccountId: soonId, amountCents: 100 }),
    ).rejects.toThrow(/two different accounts/)
  })
})
