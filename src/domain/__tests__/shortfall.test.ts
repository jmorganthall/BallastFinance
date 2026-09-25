/**
 * The first step of a share-out: what is short, and what covering it leaves
 * for the split. Plans short = behind pace; debts short = a deal-rate balance
 * the minimums will not clear before the rate ends.
 */

import { describe, expect, it } from 'vitest'
import { findShortfalls, takeTopUps, type Shortfall } from '../shortfall'
import type { AccountView } from '../rollup'
import type { Debt } from '../debt'

const TODAY = '2026-09-19'

function view(over: { id: string; name: string; shouldHaveSavedCents: number; items?: number }): AccountView {
  return {
    account: {
      id: over.id,
      householdId: 'hh',
      name: over.name,
      institutionLabel: '',
      scope: 'household',
      ownerUserId: null,
      active: true,
    },
    weekly: { totalPerWeekCents: 0, basePerWeekCents: 0, catchUpGroups: [], lines: [] } as unknown as AccountView['weekly'],
    pendingWeekly: null,
    shouldHaveSavedCents: over.shouldHaveSavedCents,
    outstandingCents: 0,
    items: new Array(over.items ?? 1).fill(null) as unknown as AccountView['items'],
  }
}

function debt(over: Partial<Debt> & Pick<Debt, 'id' | 'name'>): Debt {
  return {
    householdId: 'hh',
    category: 'consumer',
    balanceCents: 500000,
    balanceAsOf: TODAY,
    aprBasisPoints: 2499,
    promoRules: [],
    minPaymentRule: { type: 'fixed', amountCents: 15000 },
    fixedPayment: false,
    state: 'open',
    ...over,
  }
}

describe('what is short', () => {
  it('names an account that holds less than its plans say it should', () => {
    const short = findShortfalls({
      accounts: [
        { view: view({ id: 'a', name: 'Annual Expenses', shouldHaveSavedCents: 120000 }), confirmedCents: 80000 },
        { view: view({ id: 'b', name: 'Gifts', shouldHaveSavedCents: 30000 }), confirmedCents: 30000 },
        { view: view({ id: 'c', name: 'Ahead', shouldHaveSavedCents: 10000 }), confirmedCents: 25000 },
      ],
      debts: [],
      today: TODAY,
    })
    expect(short).toEqual([
      expect.objectContaining({ kind: 'plan', targetId: 'a', label: 'Annual Expenses', shortCents: 40000 }),
    ])
    expect(short[0]!.reason).toContain('$800.00')
    expect(short[0]!.reason).toContain('$1,200.00')
  })

  it('skips an account with no balance recorded or nothing planned', () => {
    const short = findShortfalls({
      accounts: [
        { view: view({ id: 'a', name: 'Unchecked', shouldHaveSavedCents: 120000 }), confirmedCents: null },
        { view: view({ id: 'b', name: 'Empty', shouldHaveSavedCents: 0, items: 0 }), confirmedCents: 0 },
      ],
      debts: [],
      today: TODAY,
    })
    expect(short).toEqual([])
  })

  it('names a deal-rate balance the minimums will not clear before the rate ends', () => {
    // $5,000 at 0% until 19 Jan 2027: four months of $150 minimums is $600,
    // leaving $4,400 to hit the full rate.
    const short = findShortfalls({
      accounts: [],
      debts: [
        debt({
          id: 'promo',
          name: 'Balance transfer',
          promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-01-19' }],
        }),
        debt({
          id: 'fine',
          name: 'Clearable',
          balanceCents: 50000,
          promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-01-19' }],
        }),
        debt({ id: 'plain', name: 'No deal' }),
      ],
      today: TODAY,
    })
    expect(short).toEqual([
      expect.objectContaining({ kind: 'debt', targetId: 'promo', shortCents: 440000 }),
    ])
    expect(short[0]!.reason).toContain('0% deal ends')
    expect(short[0]!.reason).toContain('$4,400.00')
  })

  it('is not short when what the household actually pays clears the deal in time', () => {
    // The same $5,000 at 0% until 19 Jan 2027, but the family pays $1,300 a
    // month at it: four months covers it, so there is no cliff to fill.
    const short = findShortfalls({
      accounts: [],
      debts: [
        debt({
          id: 'ontrack',
          name: 'Balance transfer',
          plannedPaymentCents: 130000,
          promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-01-19' }],
        }),
      ],
      today: TODAY,
    })
    expect(short).toEqual([])
  })

  it('puts a deadline before a pace, and the bigger hole first within each', () => {
    const short = findShortfalls({
      accounts: [
        { view: view({ id: 'small', name: 'Small', shouldHaveSavedCents: 10000 }), confirmedCents: 9000 },
        { view: view({ id: 'big', name: 'Big', shouldHaveSavedCents: 100000 }), confirmedCents: 50000 },
      ],
      debts: [
        debt({
          id: 'promo',
          name: 'Deal',
          promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-01-19' }],
        }),
      ],
      today: TODAY,
    })
    expect(short.map((s) => s.targetId)).toEqual(['promo', 'big', 'small'])
  })
})

describe('covering what was ticked', () => {
  const chosen: Shortfall[] = [
    { kind: 'debt', targetId: 'd', label: 'Deal', shortCents: 40000, reason: '' },
    { kind: 'plan', targetId: 'a', label: 'Annual', shortCents: 25000, reason: '' },
  ]

  it('covers each in order and leaves the rest for the split', () => {
    const { topUps, remainingCents } = takeTopUps(chosen, 100000)
    expect(topUps.map((t) => t.amountCents)).toEqual([40000, 25000])
    expect(remainingCents).toBe(35000)
  })

  it('covers what it can when the money runs out, and never goes negative', () => {
    const { topUps, remainingCents } = takeTopUps(chosen, 50000)
    expect(topUps.map((t) => [t.targetId, t.amountCents])).toEqual([
      ['d', 40000],
      ['a', 10000],
    ])
    expect(remainingCents).toBe(0)
    expect(takeTopUps(chosen, 0)).toEqual({ topUps: [], remainingCents: 0 })
  })
})
