/**
 * Done, Done lately and Undo on This week (PRD D62), against a live database.
 *
 * A Done records the to-do it was shown, once: a second press on a page
 * opened before the first records nothing and names who got there first.
 * Undo puts every figure back exactly as it was, either spouse may press it
 * on a shared account, only the owner on an individual one, and never once
 * the account has been counted since. Each test gets its own household.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION, todoKey } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('Done and Undo on This week (D62)', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  // Saturday, a transfer day.
  const TODAY = '2026-11-14'

  beforeAll(() => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
  })
  afterAll(async () => {
    await client?.end()
  })

  /** A household with a shared account and Josh's own, each with a plan and no transfer told to Ballast yet. */
  async function household() {
    const [h] = await db.insert(schema.households).values({ name: `Done ${crypto.randomUUID()}` }).returning()
    const householdId = h!.id
    const member = async (email: string) => {
      const [u] = await db
        .insert(schema.users)
        .values({ issuer: 'https://accounts.google.com', subject: crypto.randomUUID(), email })
        .returning()
      await db.insert(schema.householdMembers).values({ userId: u!.id, householdId })
      return u!.id
    }
    const joshId = await member(`josh-${crypto.randomUUID()}@example.com`)
    const shelbyId = await member(`shelby-${crypto.randomUUID()}@example.com`)
    const josh = new Engine({ householdId, actorUserId: joshId, db, today: TODAY })
    const shelby = new Engine({ householdId, actorUserId: shelbyId, db, today: TODAY })
    const sharedId = (await josh.createReserveAccount({ name: 'Shared', institutionLabel: 'Cap One' })).id
    const mineId = (await josh.createReserveAccount({ name: 'Mine', institutionLabel: 'Cap One', scope: 'individual' })).id
    for (const [name, accountId, due] of [
      ['Trip', sharedId, '2027-01-16'],
      ['Gift', mineId, '2027-03-06'],
    ] as const) {
      const created = await josh.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name },
        line_items: [{ label: name, unit_amount: '1200', due_date: due, reserve_account: accountId }],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await josh.commitPackage(created.packageId)
    }
    await josh.confirmBalance({ reserveAccountId: sharedId, amountCents: 0 })
    await josh.confirmBalance({ reserveAccountId: mineId, amountCents: 0 })
    const eventCount = async () =>
      (await db.select().from(schema.events).where(eq(schema.events.householdId, householdId))).length
    const transferTodo = async (accountId: string) => {
      const todo = (await josh.position()).todos.find((t) => t.kind === 'set_transfer' && t.accountId === accountId)
      if (!todo || todo.kind !== 'set_transfer') throw new Error('expected a transfer to-do')
      return todo
    }
    return { householdId, joshId, shelbyId, josh, shelby, sharedId, mineId, eventCount, transferTodo }
  }

  it('records the to-do it was shown, and Undo puts every figure back exactly', async () => {
    const { josh, shelby, sharedId, joshId, transferTodo } = await household()
    const before = await josh.position()
    const todo = await transferTodo(sharedId)

    const done = await josh.markTodoDone({ key: todoKey(todo), amountCents: todo.toCents })
    expect(done.status).toBe('recorded')
    if (done.status !== 'recorded') return
    expect(done.newTodoKeys).not.toContain(todoKey(todo))
    const moved = await josh.position()
    expect(moved.todos.map(todoKey)).not.toContain(todoKey(todo))

    // Shelby sees it under Done lately, with who pressed it, and may undo it.
    const [press] = await shelby.donePresses()
    expect(press).toMatchObject({ groupId: done.groupId, actorUserId: joshId, accountIds: [sharedId], undoable: true })
    await shelby.undoDone(done.groupId)

    expect(await josh.position()).toEqual(before)
    expect(await josh.donePresses()).toEqual([])
    // Nothing is left waiting as an open ask either.
    expect((await josh.view()).household.todos.filter((t) => t.from === 'ask')).toEqual([])
  })

  it('records nothing for a second press on a page opened before the first, and names who did it', async () => {
    const { josh, shelby, sharedId, joshId, eventCount, transferTodo } = await household()
    const todo = await transferTodo(sharedId)
    await josh.markTodoDone({ key: todoKey(todo), amountCents: todo.toCents })
    const events = await eventCount()

    const second = await shelby.markTodoDone({ key: todoKey(todo), amountCents: todo.toCents })
    expect(second.status).toBe('already')
    if (second.status !== 'already') return
    expect(second.press?.actorUserId).toBe(joshId)
    expect(await eventCount()).toBe(events)
  })

  it('lets only the owner undo on an individual account', async () => {
    const { josh, shelby, mineId, transferTodo } = await household()
    const todo = await transferTodo(mineId)
    const done = await josh.markTodoDone({ key: todoKey(todo), amountCents: todo.toCents })
    if (done.status !== 'recorded') throw new Error('expected it recorded')
    await expect(shelby.undoDone(done.groupId)).rejects.toThrow(/belongs to someone else/)
    await josh.undoDone(done.groupId)
    expect(await josh.donePresses()).toEqual([])
  })

  it('offers no Undo once the account has been counted since', async () => {
    const { josh, sharedId, transferTodo } = await household()
    const todo = await transferTodo(sharedId)
    const done = await josh.markTodoDone({ key: todoKey(todo), amountCents: todo.toCents })
    if (done.status !== 'recorded') throw new Error('expected it recorded')
    await josh.confirmBalance({ reserveAccountId: sharedId, amountCents: 5000 })
    const [press] = await josh.donePresses()
    expect(press!.undoable).toBe(false)
    await expect(josh.undoDone(done.groupId)).rejects.toThrow(/can no longer be undone/)
  })

  it('records an undo as an event, never an edit', async () => {
    const { householdId, josh, sharedId, transferTodo } = await household()
    const todo = await transferTodo(sharedId)
    const done = await josh.markTodoDone({ key: todoKey(todo), amountCents: todo.toCents })
    if (done.status !== 'recorded') throw new Error('expected it recorded')
    await josh.undoDone(done.groupId)
    const undos = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'event_undone')))
    expect(undos).toHaveLength(1)
    expect(undos[0]!.payload).toMatchObject({ group_id: done.groupId, kind: 'instruction_issued' })
  })
})
