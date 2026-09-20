/**
 * The database connection.
 *
 * Two URLs by design (PRD §10): the app connects as a restricted role that
 * cannot UPDATE or DELETE events, while migrations run as the owner. Handing
 * the app the owner's credentials would quietly undo the append-only guarantee.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

declare global {
  // eslint-disable-next-line no-var
  var __ballastDb: ReturnType<typeof create> | undefined
}

function create() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const client = postgres(url, { max: 10, prepare: false })
  return drizzle(client, { schema })
}

// Reused across hot reloads in development so a dev server does not exhaust
// connections on every file save.
export const db = globalThis.__ballastDb ?? create()
if (process.env.NODE_ENV !== 'production') globalThis.__ballastDb = db

export type Db = typeof db
export { schema }
