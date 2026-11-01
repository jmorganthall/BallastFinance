/**
 * The layers hold (PRD D56 (6), docs/data-flow.md). Facts: every engine
 * method that writes a money fact's row records an event as it does
 * (Phase 4), so the log can always explain the row. Screens: a screen, a component
 * and the digest render what the domain worked out, and never work a money
 * figure out for themselves. They may read the household view, the
 * position and the debt statuses through the engine, and use the domain's
 * words, formatters and readings of those (a bar, a sentence, an order).
 * They may not call the calculations those are built from: if one is
 * needed on a screen, the figure belongs in the view.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The calculations behind every money figure: only the engine and the domain call these. */
const CALCULATIONS = [
  'position',
  'ledgerOf',
  'householdView',
  'householdCaughtUp',
  'debtStatuses',
  'outstandingInstructions',
  'onItsWayOf',
  'findShortfalls',
  'levelWeekly',
  'requirementsFor',
  'slotTicks',
  'countTowardParts',
  'projectPayoff',
  'promoCliff',
  'simulateMonths',
  'monthlyPaymentCents',
  'minimumPaymentCents',
  'likelyDebtBalance',
  'nextDue',
  'transferWeeksBetween',
]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** Every name a file imports from the domain. */
function domainImports(source: string): string[] {
  return [...source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@\/domain[^']*'/g)].flatMap((m) =>
    m[1]!
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!)
      .filter(Boolean),
  )
}

describe('the layers (D56 (6))', () => {
  it('no screen, component or the digest calls a calculation behind a money figure', () => {
    const rendering = [...files('src/app'), ...files('src/components'), 'src/server/digest.ts']
    const found = rendering.flatMap((path) =>
      domainImports(readFileSync(path, 'utf8'))
        .filter((name) => CALCULATIONS.includes(name))
        .map((name) => `${path}: ${name}`),
    )
    expect(found).toEqual([])
  })

  it('no screen, component or route reads the database except through the engine', () => {
    const found = [...files('src/app'), ...files('src/components')].filter((path) =>
      /from '@\/db\/(client|schema)'/.test(readFileSync(path, 'utf8')),
    )
    expect(found).toEqual([])
  })
})

/**
 * Every table a household owns: a write to one goes with its event, so the
 * log can always explain the row. The money facts first (Phase 4), then the
 * module facts -- assets, trips and their parts, the school calendar,
 * lodging quotes, income and the recurring list -- which record through
 * their own helpers. Settings append rather than log; reference data with no
 * household (crowd levels, park weather and hours, waits, lodging rates,
 * broker listings) and server upkeep are not a household's facts.
 */
const HOUSEHOLD_FACT_TABLES = [
  'reserveAccountsTable',
  'packagesTable',
  'lineItemsTable',
  'debtsTable',
  'assetsTable',
  'tripsTable',
  'tripVariantsTable',
  'tripLinesTable',
  'tripDaysTable',
  'tripReservationsTable',
  'tripTasksTable',
  'schoolDaysOffTable',
  'lodgingQuotesTable',
  'recurringExpensesTable',
  'incomeSourcesTable',
  'incomePaymentsTable',
]

/** The ways the engine records an event beside a write. */
const RECORDS = /\.insert\(events\)|this\.(recordEvent|recordTripChange|recordSchoolCalendarChange|recordLodgingQuoteChange)\(/

/**
 * Private helpers that write only on behalf of a caller that records the
 * change, each with why. Adding one here is a decision someone reviews.
 */
const WRITES_FOR_A_CALLER: Record<string, string> = {
  replaceLines: "a trip's lines laid out again; every caller (addVariant, updateVariant, refreshFetchedLines, and updateTrip / shiftTrip through rebuildVariants) records the trip change that causes it",
}

describe('the facts (Phase 4)', () => {
  it('no engine method writes a household fact without recording its event', () => {
    const source = readFileSync('src/server/engine.ts', 'utf8')
    // Each method, from its signature to the next one.
    const starts = [...source.matchAll(/\n {2}(?:private )?async (\w+)\(/g)]
    const found = starts.flatMap((m, i) => {
      const name = m[1]!
      if (name in WRITES_FOR_A_CALLER) return []
      const body = source.slice(m.index, starts[i + 1]?.index ?? source.length)
      const writes = HOUSEHOLD_FACT_TABLES.filter((t) => new RegExp(`\\.(insert|update|delete)\\(${t}\\)`).test(body))
      return writes.length > 0 && !RECORDS.test(body) ? [`${name}: ${writes.join(', ')}`] : []
    })
    expect(found).toEqual([])
  })

  it('every helper excused above still exists and is only called by methods that record', () => {
    const source = readFileSync('src/server/engine.ts', 'utf8')
    const starts = [...source.matchAll(/\n {2}(?:private )?async (\w+)\(/g)]
    const bodies = starts.map((m, i) => ({ name: m[1]!, body: source.slice(m.index, starts[i + 1]?.index ?? source.length) }))
    for (const helper of Object.keys(WRITES_FOR_A_CALLER)) {
      expect(bodies.some((b) => b.name === helper)).toBe(true)
      // Called directly, or through another helper that only it calls: every
      // caller up the chain records.
      const callersOf = (name: string): string[] =>
        bodies.filter((b) => b.name !== name && b.body.includes(`this.${name}(`)).map((b) => b.name)
      const unrecorded: string[] = []
      const walk = (name: string, seen: Set<string>) => {
        for (const caller of callersOf(name)) {
          if (seen.has(caller)) continue
          seen.add(caller)
          const body = bodies.find((b) => b.name === caller)!.body
          if (RECORDS.test(body)) continue
          const up = callersOf(caller)
          if (up.length === 0) unrecorded.push(caller)
          else walk(caller, seen)
        }
      }
      walk(helper, new Set())
      expect(unrecorded).toEqual([])
    }
  })
})
