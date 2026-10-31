/**
 * The layers hold (PRD D56 (6), docs/data-flow.md): a screen, a component
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
})
