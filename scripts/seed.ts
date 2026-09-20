/**
 * Seed the household (PRD §2: "This family is household #1").
 *
 * Creates the household, the signup allowlist, and the reserve accounts that
 * mirror the real Capital One 360 accounts. Idempotent: safe to re-run.
 *
 *   npx tsx scripts/seed.ts
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../src/db/schema'

const HOUSEHOLD = 'Morganthall'
const ALLOWED = (process.env.SEED_ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean)
const ACCOUNTS = [
  'Annual Expenses',
  'Gifts & Giving',
  'Long Term Savings',
  '911 Fund',
]

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('Set DATABASE_URL')

  const client = postgres(url, { max: 2, prepare: false })
  const db = drizzle(client, { schema })

  let [household] = await db
    .select()
    .from(schema.households)
    .where(eq(schema.households.name, HOUSEHOLD))

  if (!household) {
    ;[household] = await db
      .insert(schema.households)
      .values({ name: HOUSEHOLD, timezone: 'America/Chicago' })
      .returning()
    console.log(`created household ${HOUSEHOLD}`)
  } else {
    console.log(`household ${HOUSEHOLD} already exists`)
  }

  if (ALLOWED.length === 0) {
    console.log('no SEED_ALLOWED_EMAILS set — nobody can sign in yet')
  }
  for (const email of ALLOWED) {
    await db
      .insert(schema.allowedEmails)
      .values({ email: email.toLowerCase(), householdId: household!.id })
      .onConflictDoNothing()
    console.log(`allowed ${email}`)
  }

  for (const name of ACCOUNTS) {
    await db
      .insert(schema.reserveAccounts)
      .values({
        householdId: household!.id,
        name,
        institutionLabel: `Capital One 360 — ${name}`,
      })
      .onConflictDoNothing()
    console.log(`reserve account ${name}`)
  }

  await client.end()
  console.log('\nseed complete')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
