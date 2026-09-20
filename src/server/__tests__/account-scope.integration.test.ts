/**
 * Account scope against a live database (PRD §2).
 *
 * Two engines for the same household, one per spouse, because the whole point
 * is that they differ — and only on the write side.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('individual vs household accounts', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let josh: Engine
  let shelby: Engine
  let joshId: string
  let shelbyId: string
  let sharedId: string
  let joshsOwnId: string
  const TODAY = '2026-09-19'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })

    const [household] = await db
      .insert(schema.households)
      .values({ name: `Scope ${crypto.randomUUID()}` })
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
    joshId = await mk(`josh-${crypto.randomUUID()}@example.com`)
    shelbyId = await mk(`shelby-${crypto.randomUUID()}@example.com`)

    josh = new Engine({ householdId, actorUserId: joshId, db, today: TODAY })
    shelby = new Engine({ householdId, actorUserId: shelbyId, db, today: TODAY })

    sharedId = (
      await josh.createReserveAccount({ name: 'Annual Expenses', institutionLabel: 'Cap One' })
    ).id
    joshsOwnId = (
      await josh.createReserveAccount({
        name: "Josh's fun money",
        institutionLabel: 'Cap One',
        scope: 'individual',
      })
    ).id
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db
        .delete(schema.reserveAccounts)
        .where(eq(schema.reserveAccounts.householdId, householdId))
      await db
        .delete(schema.householdMembers)
        .where(eq(schema.householdMembers.householdId, householdId))
    }
    await client?.end()
  })

  it('records the creator as the owner of an individual account', async () => {
    const account = (await josh.listReserveAccounts()).find((a) => a.id === joshsOwnId)!
    expect(account.scope).toBe('individual')
    expect(account.ownerUserId).toBe(joshId)
  })

  it('leaves a shared account unowned', async () => {
    const account = (await josh.listReserveAccounts()).find((a) => a.id === sharedId)!
    expect(account.scope).toBe('household')
    expect(account.ownerUserId).toBeNull()
  })

  // --- reads are NOT restricted -------------------------------------------

  it("lets Shelby see Josh's account, because hiding it would make her totals a lie", async () => {
    const names = (await shelby.listReserveAccounts()).map((a) => a.name)
    expect(names).toContain("Josh's fun money")
  })

  it('shows it in her derived views too', async () => {
    const ids = (await shelby.accountViews()).map((v) => v.account.id)
    expect(ids).toContain(joshsOwnId)
  })

  it('marks it unwritable for her and writable for him', async () => {
    const hers = (await shelby.reserveAccountsForViewer()).find((a) => a.id === joshsOwnId)!
    const his = (await josh.reserveAccountsForViewer()).find((a) => a.id === joshsOwnId)!
    expect(hers.writable).toBe(false)
    expect(his.writable).toBe(true)
  })

  it('leaves the shared account writable for both', async () => {
    for (const who of [josh, shelby]) {
      const shared = (await who.reserveAccountsForViewer()).find((a) => a.id === sharedId)!
      expect(shared.writable).toBe(true)
    }
  })

  // --- writes ARE restricted ----------------------------------------------

  it('refuses a plan from Shelby funded by Josh’s account', async () => {
    const result = await shelby.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Her plan against his account' },
      line_items: [
        { label: 'x', unit_amount: '100', quantity: 1, due_date: '2027-01-16', reserve_account: joshsOwnId },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.message).toContain('belongs to someone else')
    expect(await shelby.listPackages()).toHaveLength(0)
  })

  it('allows the same plan from Josh', async () => {
    const result = await josh.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'His plan' },
      line_items: [
        { label: 'x', unit_amount: '100', quantity: 1, due_date: '2027-01-16', reserve_account: joshsOwnId },
      ],
    })
    expect(result.ok).toBe(true)
  })

  it("refuses Shelby confirming a balance on Josh's account", async () => {
    await expect(
      shelby.confirmBalance({ reserveAccountId: joshsOwnId, amountCents: 5000 }),
    ).rejects.toThrow(/belongs to someone else/)
  })

  it('allows Josh confirming his own', async () => {
    await josh.confirmBalance({ reserveAccountId: joshsOwnId, amountCents: 5000 })
    const latest = await josh.latestConfirmedBalances()
    expect(latest.get(joshsOwnId)?.amountCents).toBe(5000)
  })

  it('allows either spouse to confirm the shared account', async () => {
    await shelby.confirmBalance({ reserveAccountId: sharedId, amountCents: 1200 })
    const latest = await shelby.latestConfirmedBalances()
    expect(latest.get(sharedId)?.amountCents).toBe(1200)
  })

  it("refuses Shelby moving a line item into Josh's account", async () => {
    const created = await shelby.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Her shared plan' },
      line_items: [
        { label: 'y', unit_amount: '100', quantity: 1, due_date: '2027-01-16', reserve_account: sharedId },
      ],
    })
    expect(created.ok).toBe(true)

    const item = (await shelby.listLineItems()).find((li) => li.label === 'y')!
    await expect(
      shelby.updateLineItem(item.id, { reserveAccountId: joshsOwnId }),
    ).rejects.toThrow(/belongs to someone else/)

    // And the row is untouched, not half-written.
    const after = (await shelby.listLineItems()).find((li) => li.id === item.id)!
    expect(after.reserveAccountId).toBe(sharedId)
  })

  it('still lets her edit that item in ways she is allowed to', async () => {
    const item = (await shelby.listLineItems()).find((li) => li.label === 'y')!
    await shelby.updateLineItem(item.id, { quantity: 3 })
    const after = (await shelby.listLineItems()).find((li) => li.id === item.id)!
    expect(after.quantity).toBe(3)
  })
})
