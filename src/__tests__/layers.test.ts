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

/** The rows money figures are built from: a write to one goes with its event. */
const MONEY_FACT_TABLES = ['reserveAccountsTable', 'packagesTable', 'lineItemsTable', 'debtsTable']

describe('the facts (Phase 4)', () => {
  it('no engine method writes a money fact without recording its event', () => {
    const source = readFileSync('src/server/engine.ts', 'utf8')
    // Each method, from its signature to the next one.
    const starts = [...source.matchAll(/\n {2}(?:private )?async (\w+)\(/g)]
    const found = starts.flatMap((m, i) => {
      const body = source.slice(m.index, starts[i + 1]?.index ?? source.length)
      const writes = MONEY_FACT_TABLES.filter((t) => new RegExp(`\\.(insert|update|delete)\\(${t}\\)`).test(body))
      const records = /\.insert\(events\)|this\.recordEvent\(/.test(body)
      return writes.length > 0 && !records ? [`${m[1]}: ${writes.join(', ')}`] : []
    })
    expect(found).toEqual([])
  })
})
