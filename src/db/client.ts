/**
 * The database connection.
 *
 * Two URLs by design (PRD §10): the app connects as a restricted role that
 * cannot UPDATE or DELETE events, while migrations run as the owner. Handing
 * the app the owner's credentials would quietly undo the append-only guarantee.
 *
 * The connection is created lazily, on first use, rather than at module import.
 * Importing this module used to throw when DATABASE_URL was absent, which meant
 * `next build` could not collect page data without a fake database URL in the
 * environment -- and a genuine misconfiguration surfaced as an import-time crash
 * in a route bundle rather than as a readable message. Now a build needs no
 * credentials at all, and a missing URL is reported the first time something
 * actually tries to query.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

type DrizzleDb = ReturnType<typeof create>

declare global {
  // eslint-disable-next-line no-var
  var __ballastDb: DrizzleDb | undefined
}

function create() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The app connects as the restricted role ' +
        '(ballast_app); migrations use DATABASE_MIGRATION_URL.',
    )
  }
  const client = postgres(url, { max: 10, prepare: false })
  return drizzle(client, { schema })
}

function resolve(): DrizzleDb {
  // Reused across hot reloads in development so a dev server does not exhaust
  // connections on every file save.
  if (!globalThis.__ballastDb) {
    const instance = create()
    if (process.env.NODE_ENV !== 'production') globalThis.__ballastDb = instance
    else return instance
  }
  return globalThis.__ballastDb!
}

let productionInstance: DrizzleDb | undefined

/**
 * A lazy stand-in for the Drizzle client. Methods are bound to the real
 * instance, so `db.select()` and `db.transaction()` behave normally.
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, property, _receiver) {
    const real =
      process.env.NODE_ENV === 'production'
        ? (productionInstance ??= create())
        : resolve()
    const value = Reflect.get(real as object, property)
    return typeof value === 'function' ? value.bind(real) : value
  },
  has(_target, property) {
    const real =
      process.env.NODE_ENV === 'production'
        ? (productionInstance ??= create())
        : resolve()
    return property in (real as object)
  },
})

export type Db = DrizzleDb
export { schema }
