import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { pendingMigrations, type MigrationJournal } from '../db-backup'

// The bootstrap asks as the owner, and so does this test: the app's restricted
// role cannot see the drizzle schema, and only the owner may create a database.
const url = process.env.DATABASE_MIGRATION_URL
const describeDb = url ? describe : describe.skip

const journal: MigrationJournal = JSON.parse(
  readFileSync(join(process.cwd(), 'drizzle', 'meta', '_journal.json'), 'utf8'),
)

describeDb('which migrations are waiting, against a live database', () => {
  let sql: ReturnType<typeof postgres>
  let fresh: ReturnType<typeof postgres> | null = null
  const freshName = `ballast_fresh_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

  beforeAll(() => {
    sql = postgres(url!, { max: 1, prepare: false })
  })

  afterAll(async () => {
    await fresh?.end()
    await sql`drop database if exists ${sql(freshName)}`.catch(() => {})
    await sql?.end()
  })

  it('finds nothing waiting on a database that is up to date', async () => {
    expect(await pendingMigrations(sql, journal)).toEqual({ fresh: false, pending: [] })
  })

  it('finds a migration newer than the last one applied', async () => {
    const withNext = { entries: [...journal.entries, { tag: '9999_next', when: Date.now() + 1e9 }] }
    expect(await pendingMigrations(sql, withNext)).toEqual({ fresh: false, pending: ['9999_next'] })
  })

  it('calls a database that was never migrated fresh, without failing on the missing table', async () => {
    await sql`create database ${sql(freshName)}`
    const freshUrl = new URL(url!)
    freshUrl.pathname = `/${freshName}`
    fresh = postgres(freshUrl.toString(), { max: 1, prepare: false })
    const result = await pendingMigrations(fresh, journal)
    expect(result.fresh).toBe(true)
    expect(result.pending).toHaveLength(journal.entries.length)
  })
})
