/**
 * Migration 0026 (PRD D56 (4)): every ask from before D35 still open is
 * ended once, by a recorded instruction_ended, and nothing else is touched:
 * a confirmed bump keeps running, a share-out's cover stays open, and an
 * ask already ended is not ended twice. The file's own SQL runs here,
 * narrowed to this test's household so other tests' asks are left alone.
 */

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('ending the asks from before D35 (D56 (4))', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    client = postgres(url!, { max: 2, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Old asks ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: '2026-09-19' })
    accountId = (await engine.createReserveAccount({ name: 'Annual', institutionLabel: 'C1' })).id
    const ask = (type: 'set_weekly_transfer' | 'rate_bump' | 'one_time_move', purpose?: 'cover' | 'catch_up') =>
      engine.issueInstruction({
        type,
        amountCents: 1000,
        targetId: accountId,
        targetLabel: 'Annual',
        purpose,
        endsOn: type === 'rate_bump' ? '2026-12-26' : undefined,
      })
    ids.transfer = await ask('set_weekly_transfer')
    ids.catchUp = await ask('one_time_move')
    ids.cover = await ask('one_time_move', 'cover')
    ids.confirmedBump = await ask('rate_bump')
    await engine.confirmInstruction({ instructionId: ids.confirmedBump })
    ids.withdrawn = await ask('rate_bump')
    await engine.endInstruction({ instructionId: ids.withdrawn })
  })

  afterAll(async () => {
    await client.end()
  })

  it('ends each one still open once, and leaves the rest as they were', async () => {
    const sql = readFileSync('drizzle/0026_end_old_asks.sql', 'utf8').trim().replace(/;$/, '')
    const mine = `${sql}\n  AND i."household_id" = '${householdId}'`
    await client.unsafe(mine)
    // Run twice: an ask already ended is never ended again.
    await client.unsafe(mine)

    const ended = (
      await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'instruction_ended')))
    ).map((e) => (e.payload as { instruction_id: string }).instruction_id)
    expect(ended.sort()).toEqual([ids.transfer, ids.catchUp, ids.withdrawn].sort())

    expect((await engine.outstandingInstructions()).map((i) => i.instructionId)).toEqual([ids.cover])
    expect((await engine.driftAdjustments()).accepted.map((a) => a.id)).toEqual([ids.confirmedBump])
  })
})
