/**
 * Phase C acceptance (PRD §12): "an allocation run produces confirmable
 * instructions."
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

describeDb('allocation runs', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  const TODAY = '2026-09-19'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Alloc ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })

    await engine.createReserveAccount({
      name: 'Long Term Savings',
      institutionLabel: 'Capital One 360 — Long Term Savings',
    })
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

  it('previews without recording anything', async () => {
    const plan = await engine.previewAllocation(250000)
    expect(plan.netCents).toBe(215000)
    expect(await engine.outstandingInstructions()).toHaveLength(0)
  })

  it('turns one number into separately confirmable instructions', async () => {
    const { plan, instructionIds } = await engine.runAllocation({ floorCents: 250000 })

    expect(plan.netCents).toBe(215000)
    // debt, two lifestyle halves, long-term savings, emergency
    expect(instructionIds).toHaveLength(5)

    const outstanding = await engine.outstandingInstructions()
    expect(outstanding).toHaveLength(5)
    expect(outstanding.some((i) => i.type === 'debt_payment' && i.amountCents === 107500)).toBe(true)
  })

  it('names the real reserve account when one matches the destination', async () => {
    const outstanding = await engine.outstandingInstructions()
    const longTerm = outstanding.find((i) => i.targetLabel === 'Long Term Savings')
    expect(longTerm).toBeDefined()
    expect(longTerm!.amountCents).toBe(32250)

    const accounts = await engine.listReserveAccounts()
    // It points at the account's id, not a placeholder string.
    expect(longTerm!.targetId).toBe(accounts[0]!.id)
  })

  it('splits the fun money into two dated halves', async () => {
    const halves = (await engine.outstandingInstructions()).filter(
      (i) => i.targetLabel === 'Fun money',
    )
    expect(halves).toHaveLength(2)
    expect(halves.reduce((s, h) => s + h.amountCents, 0)).toBe(53750)
    expect(halves.map((h) => h.endsOn).sort()).toEqual(['2026-09-19', '2026-10-03'])
  })

  it('records the run as one event with the whole split', async () => {
    const rows = (
      await db.select().from(schema.events).where(eq(schema.events.kind, 'allocation_entered'))
    ).filter((r) => r.householdId === householdId)

    expect(rows).toHaveLength(1)
    const payload = rows[0]!.payload as {
      floor_cents: number
      buffer_cents: number
      net_cents: number
      splits: { destination: string; amount_cents: number }[]
      instruction_set: string[]
    }
    expect(payload.floor_cents).toBe(250000)
    expect(payload.buffer_cents).toBe(35000)
    expect(payload.net_cents).toBe(215000)
    expect(payload.splits.reduce((s, x) => s + x.amount_cents, 0)).toBe(215000)
    expect(payload.instruction_set).toHaveLength(5)
  })

  it('confirming one instruction leaves the others outstanding', async () => {
    const before = await engine.outstandingInstructions()
    await engine.confirmInstruction({ instructionId: before[0]!.instructionId })
    expect(await engine.outstandingInstructions()).toHaveLength(before.length - 1)
  })

  it('records nothing when the floor does not clear the buffer', async () => {
    const before = (await engine.outstandingInstructions()).length
    const { plan, instructionIds } = await engine.runAllocation({ floorCents: 30000 })
    expect(plan.netCents).toBe(0)
    expect(instructionIds).toHaveLength(0)
    expect(await engine.outstandingInstructions()).toHaveLength(before)
  })

  it('covers what is short first, off the top, and splits the rest', async () => {
    // A plan in Long Term Savings that should hold $400 by now, with $100
    // actually there: $300 behind. Cover it, then share the rest by the rules.
    const [account] = await engine.listReserveAccounts()
    const created = await engine.createPackageFromIntake({
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Roof fund' },
      line_items: [{ label: 'Roof', unit_amount: '4000', due_date: '2027-09-18', reserve_account: account!.id }],
    })
    if (!created.ok) throw new Error(JSON.stringify(created.problems))
    await engine.commitPackage(created.packageId, { openingCents: 40000 })
    await engine.confirmBalance({ reserveAccountId: account!.id, amountCents: 10000 })

    const short = await engine.shortfalls()
    expect(short).toEqual([
      expect.objectContaining({ kind: 'plan', targetId: account!.id, shortCents: 30000 }),
    ])

    const cover = await engine.chosenShortfalls([`plan:${account!.id}`, 'plan:not-a-real-one'])
    expect(cover).toHaveLength(1)

    const before = (await engine.outstandingInstructions()).length
    const { plan, instructionIds } = await engine.runAllocation({ floorCents: 100000, cover })
    expect(plan.netCents).toBe(65000)
    expect(plan.topUpCents).toBe(30000)
    expect(plan.splitCents).toBe(35000)
    expect(plan.shares.reduce((sum, s) => sum + s.amountCents, 0)).toBe(35000)

    const outstanding = await engine.outstandingInstructions()
    expect(outstanding.length - before).toBe(instructionIds.length)
    const topUp = outstanding.find(
      (i) => i.type === 'one_time_move' && i.targetId === account!.id && i.amountCents === 30000,
    )
    expect(topUp).toBeDefined()
    expect(topUp!.note).toContain('behind')

    // Not enough to cover it all: it takes what there is, and nothing is split.
    const partial = await engine.previewAllocation(50000, undefined, cover)
    expect(partial.topUps[0]!.amountCents).toBe(15000)
    expect(partial.splitCents).toBe(0)
  })
})
