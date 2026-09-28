/**
 * The first step of a share-out: what is short, and what covering it leaves
 * for the split. A plan is short when its account needs a one-time move the
 * weekly transfer cannot make in time (D35); a debt is short when a
 * deal-rate balance the minimums will not clear before the rate ends.
 */

import { describe, expect, it } from 'vitest'
import { findShortfalls, takeTopUps, type Shortfall } from '../shortfall'
import type { AccountPosition } from '../position'
import type { Debt } from '../debt'

const TODAY = '2026-09-19'

function account(over: {
  id: string
  name: string
  moneyCents?: number
  move?: { amountCents: number; byDate: string } | null
}): Pick<AccountPosition, 'account' | 'oneTimeMove' | 'money'> {
  const total = over.moneyCents ?? 0
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
    oneTimeMove: over.move ?? null,
    money: {
      from: 'count',
      on: TODAY,
      startCents: total,
      transfersSinceCents: 0,
      movesSinceCents: 0,
      spendsSinceCents: 0,
      totalCents: total,
    },
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
  it('names an account that needs a one-time move, and only that', () => {
    const short = findShortfalls({
      accounts: [
        account({ id: 'a', name: 'Annual Expenses', moneyCents: 80000, move: { amountCents: 40000, byDate: '2026-10-03' } }),
        account({ id: 'b', name: 'Gifts', moneyCents: 30000 }),
      ],
      debts: [],
      today: TODAY,
    })
    expect(short).toEqual([
      expect.objectContaining({ kind: 'plan', targetId: 'a', label: 'Annual Expenses', shortCents: 40000 }),
    ])
    expect(short[0]!.reason).toContain('$800.00')
    expect(short[0]!.reason).toContain('$400.00')
    expect(short[0]!.reason).toContain('2026-10-03')
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

  it("puts a debt's deadline before a plan's move, and the bigger hole first within each", () => {
    const short = findShortfalls({
      accounts: [
        account({ id: 'small', name: 'Small', move: { amountCents: 1000, byDate: '2026-10-03' } }),
        account({ id: 'big', name: 'Big', move: { amountCents: 50000, byDate: '2026-10-03' } }),
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
