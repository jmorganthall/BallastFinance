/**
 * Container bootstrap: everything that must be true before the app serves a
 * request, done automatically so a first run is one command.
 *
 * Order matters and each step exists for a reason:
 *
 *   1. Wait for the database. Compose health checks help, but a restarting
 *      stack can still race.
 *   2. Run migrations AS THE OWNER. Migration 0001 creates the restricted
 *      `ballast_app` role and revokes UPDATE/DELETE on events from it.
 *   3. Set that role's password from APP_DB_PASSWORD. This is the step that
 *      used to be a manual `ALTER ROLE` buried in the docs -- and forgetting it
 *      meant the app could not connect at all, or worse, someone "fixed" it by
 *      handing the app the owner's credentials, which silently undoes the
 *      append-only guarantee.
 *   4. Seed the household and allowlist, idempotently. Without an allowlist
 *      entry nobody can sign in, so a fresh stack would come up unusable.
 *
 * Migrations run through drizzle-orm's programmatic migrator rather than the
 * drizzle-kit CLI: drizzle-kit is a devDependency and is not in the runtime
 * image, so a CLI call here would try to fetch it from npm on every boot.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from '../src/db/schema'
import { seedHousehold } from './seed'

const APP_ROLE = process.env.APP_DB_ROLE ?? 'ballast_app'
const MIGRATIONS_FOLDER = process.env.MIGRATIONS_FOLDER ?? './drizzle'

function log(message: string): void {
  console.log(`[bootstrap] ${message}`)
}

async function waitForDatabase(url: string, attempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = postgres(url, { max: 1, prepare: false, connect_timeout: 5 })
    try {
      await probe`select 1`
      await probe.end()
      log('database is reachable')
      return
    } catch (error) {
      await probe.end().catch(() => {})
      if (attempt === attempts) {
        throw new Error(
          `database not reachable after ${attempts} attempts: ${(error as Error).message}`,
        )
      }
      if (attempt === 1) log('waiting for the database…')
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

/**
 * Set the app role's password.
 *
 * ALTER ROLE takes no bind parameters, so the password cannot be passed as one.
 * Postgres `format('%L', …)` does the quoting server-side, which is why the
 * statement is built in a query rather than by string-concatenating here.
 */
async function setAppRolePassword(sql: postgres.Sql, password: string): Promise<void> {
  const [row] = await sql<{ present: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = ${APP_ROLE}::text) as present
  `
  if (!row?.present) {
    throw new Error(
      `role "${APP_ROLE}" does not exist after migrations — check that migration 0001 ran`,
    )
  }

  // The casts are required: Postgres cannot infer a parameter's type from its
  // position inside format(), and fails with "could not determine data type".
  const [built] = await sql<{ stmt: string }[]>`
    select format(
      'ALTER ROLE %I WITH LOGIN PASSWORD %L',
      ${APP_ROLE}::text,
      ${password}::text
    ) as stmt
  `
  if (!built?.stmt) throw new Error('could not build the ALTER ROLE statement')

  await sql.unsafe(built.stmt)
  log(`password set for the restricted role "${APP_ROLE}"`)
}

async function main(): Promise<void> {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL
  if (!migrationUrl) {
    throw new Error(
      'DATABASE_MIGRATION_URL is not set. Migrations must run as the database owner, ' +
        'not as the restricted app role.',
    )
  }

  await waitForDatabase(migrationUrl)

  const sql = postgres(migrationUrl, {
    max: 1,
    prepare: false,
    // Migrations are idempotent and emit "already exists, skipping" notices on
    // every boot after the first. Keeping them would make a healthy start look
    // alarming in the container log.
    onnotice: (notice) => {
      if (notice.code !== '42P06' && notice.code !== '42P07') console.warn(notice.message)
    },
  })
  const db = drizzle(sql, { schema })

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    log('migrations applied')

    const appPassword = process.env.APP_DB_PASSWORD
    if (appPassword) {
      await setAppRolePassword(sql, appPassword)
    } else {
      log(`APP_DB_PASSWORD not set — leaving "${APP_ROLE}" as it is`)
    }

    const allowedEmails = (process.env.SEED_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)

    const result = await seedHousehold(db, {
      householdName: process.env.SEED_HOUSEHOLD_NAME || undefined,
      allowedEmails,
      log,
    })

    if (result.allowedEmails.length === 0) {
      log('WARNING: no SEED_ALLOWED_EMAILS set — nobody can sign in yet')
    }

    log('ready')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('[bootstrap] failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
