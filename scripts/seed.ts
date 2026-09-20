/**
 * Seed the household (PRD §2: "This family is household #1").
 *
 * Creates the household, the signup allowlist, and the reserve accounts that
 * mirror the real Capital One 360 accounts. Idempotent: safe to re-run, and
 * safe to run on every container start.
 *
 * Standalone:  npx tsx scripts/seed.ts
 * On boot:     called by scripts/bootstrap.ts
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../src/db/schema'

export const DEFAULT_HOUSEHOLD = 'Morganthall'
export const DEFAULT_ACCOUNTS = [
  'Annual Expenses',
  'Gifts & Giving',
  'Long Term Savings',
  '911 Fund',
]

type Db = ReturnType<typeof drizzle<typeof schema>>

export interface SeedResult {
  householdId: string
  createdHousehold: boolean
  allowedEmails: string[]
  accounts: string[]
}

export async function seedHousehold(
  db: Db,
  options: {
    householdName?: string
    allowedEmails?: string[]
    accounts?: string[]
    log?: (message: string) => void
  } = {},
): Promise<SeedResult> {
  const householdName = options.householdName ?? DEFAULT_HOUSEHOLD
  const accounts = options.accounts ?? DEFAULT_ACCOUNTS
  const emails = (options.allowedEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  const log = options.log ?? (() => {})

  let [household] = await db
    .select()
    .from(schema.households)
    .where(eq(schema.households.name, householdName))

  let createdHousehold = false
  if (!household) {
    ;[household] = await db
      .insert(schema.households)
      .values({ name: householdName, timezone: 'America/Chicago' })
      .returning()
    createdHousehold = true
    log(`created household "${householdName}"`)
  }
  if (!household) throw new Error('could not create the household')

  for (const email of emails) {
    await db
      .insert(schema.allowedEmails)
      .values({ email, householdId: household.id })
      .onConflictDoNothing()
    log(`allowed ${email}`)
  }

  for (const name of accounts) {
    await db
      .insert(schema.reserveAccounts)
      .values({
        householdId: household.id,
        name,
        institutionLabel: `Capital One 360 — ${name}`,
      })
      .onConflictDoNothing()
  }
  log(`${accounts.length} reserve accounts present`)

  return {
    householdId: household.id,
    createdHousehold,
    allowedEmails: emails,
    accounts,
  }
}

/** Run directly: npx tsx scripts/seed.ts */
async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL (or DATABASE_MIGRATION_URL)')

  const client = postgres(url, { max: 2, prepare: false })
  const db = drizzle(client, { schema })

  const result = await seedHousehold(db, {
    allowedEmails: (process.env.SEED_ALLOWED_EMAILS ?? '').split(','),
    log: (m) => console.log(m),
  })

  if (result.allowedEmails.length === 0) {
    console.log('\nno SEED_ALLOWED_EMAILS set — nobody can sign in yet')
  }
  await client.end()
  console.log('\nseed complete')
}

// Only when executed as a script, not when imported by the bootstrap.
if (process.argv[1] && /seed\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
