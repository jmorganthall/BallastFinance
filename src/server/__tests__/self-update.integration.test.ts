import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, EngineError } from '../engine'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const BEFORE = '8d3ea70f1c2b3a4d5e6f708192a3b4c5d6e7f809'
const AFTER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

describeDb('update attempts and backups against a live database', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let a: Engine
  let b: Engine
  let nobody: Engine
  const userIds: string[] = []

  beforeAll(async () => {
    client = postgres(url!, { max: 2, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Test ${crypto.randomUUID()}`, timezone: 'America/Chicago' })
      .returning()
    householdId = household!.id
    for (const who of ['a', 'b']) {
      const [user] = await db
        .insert(schema.users)
        .values({ issuer: 'test', subject: `${who}-${crypto.randomUUID()}`, email: `${who}@example.com` })
        .returning()
      userIds.push(user!.id)
    }
    a = new Engine({ householdId, actorUserId: userIds[0]!, db })
    b = new Engine({ householdId, actorUserId: userIds[1]!, db })
    nobody = new Engine({ householdId, actorUserId: null, db })
  })

  afterAll(async () => {
    for (const id of userIds) await db.delete(schema.users).where(eq(schema.users.id, id))
    if (householdId) await db.delete(schema.households).where(eq(schema.households.id, householdId))
    await client?.end()
  })

  const historyRow = async (engine: Engine, id: string, runningRevision: string | null, minutesOn: number) => {
    const rows = await engine.updateHistory({ runningRevision: null, limit: 50 })
    const row = rows.find((r) => r.id === id)!
    const now = new Date(row.createdAt.getTime() + minutesOn * 60_000)
    // The running build started half a minute after the press, as after a real update.
    const runningSince = new Date(row.createdAt.getTime() + 30_000)
    return (await engine.updateHistory({ runningRevision, now, runningSince, limit: 50 })).find((r) => r.id === id)!
  }

  it('records an attempt before the call and keeps no token', async () => {
    const id = await a.recordUpdateAttempt({ url: 'http://wt:8080/v1/update', tokenSent: true, revisionBefore: BEFORE })
    const row = (await a.updateHistory({ runningRevision: BEFORE, limit: 50 })).find((r) => r.id === id)!
    expect(row.outcome).toBe('requested')
    expect(row.verdict).toBe('pending')
    expect(row.tokenSent).toBe(true)
  })

  it('settles a dropped call as no change when the build is the same ten minutes on', async () => {
    const id = await a.recordUpdateAttempt({ url: 'http://wt:8080/v1/update', tokenSent: true, revisionBefore: BEFORE })
    await a.finishUpdateAttempt(id, { outcome: 'dropped', error: 'ECONNRESET', elapsedMs: 120 })
    const row = await historyRow(a, id, BEFORE, 11)
    expect(row.verdict).toBe('no_change')
    expect(row.revisionAfter).toBe(BEFORE)
    expect(row.verdictAt).not.toBeNull()
  })

  it('settles it as updated once a different build answers, and keeps that', async () => {
    const id = await a.recordUpdateAttempt({ url: 'http://wt:8080/v1/update', tokenSent: true, revisionBefore: BEFORE })
    await a.finishUpdateAttempt(id, { outcome: 'accepted', httpStatus: 200, elapsedMs: 9000 })
    const row = await historyRow(a, id, AFTER, 1)
    expect(row.verdict).toBe('updated')
    expect(row.revisionAfter).toBe(AFTER)
    // Read again later on the old build: a settled row is never re-judged.
    expect((await historyRow(a, id, BEFORE, 30)).verdict).toBe('updated')
  })

  it('keeps a turned-down call failed', async () => {
    const id = await a.recordUpdateAttempt({ url: 'http://wt:8080/v1/update', tokenSent: true, revisionBefore: BEFORE })
    await a.finishUpdateAttempt(id, { outcome: 'rejected', httpStatus: 401, error: 'HTTP 401', verdict: 'failed' })
    const row = await historyRow(a, id, AFTER, 1)
    expect(row.verdict).toBe('failed')
    expect(row.httpStatus).toBe(401)
  })

  it('lists the newest first', async () => {
    const rows = await a.updateHistory({ runningRevision: BEFORE })
    expect(rows.length).toBeLessThanOrEqual(10)
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i]!.createdAt.getTime())
    }
  })

  it('shows a failed backup to each person until they say Got it', async () => {
    const [failed] = await db
      .insert(schema.databaseBackups)
      .values({ revision: AFTER, migrations: ['0024_update_now'], ok: false, elapsedMs: 12, reason: '/backups is not mounted' })
      .returning()
    const notice = await a.backupNotice()
    expect(notice?.id).toBe(failed!.id)
    expect(notice?.reason).toBe('/backups is not mounted')
    expect(notice?.migrations).toEqual(['0024_update_now'])

    await a.dismissBackupNotice(failed!.id)
    await a.dismissBackupNotice(failed!.id) // twice is fine
    expect(await a.backupNotice()).toBeNull()
    expect((await b.backupNotice())?.id).toBe(failed!.id)
    expect((await a.latestBackup())?.id).toBe(failed!.id)
  })

  it('shows nothing once the latest backup worked', async () => {
    const [ok] = await db
      .insert(schema.databaseBackups)
      .values({ revision: AFTER, migrations: ['0025_x'], ok: true, file: 'ballast-x-before-update.sql.gz', bytes: 2048, elapsedMs: 800 })
      .returning()
    expect(await b.backupNotice()).toBeNull()
    expect((await b.latestBackup())?.file).toBe(ok!.file)
  })

  it('refuses a dismissal with nobody signed in', async () => {
    const latest = await a.latestBackup()
    await expect(nobody.dismissBackupNotice(latest!.id)).rejects.toBeInstanceOf(EngineError)
  })
})
