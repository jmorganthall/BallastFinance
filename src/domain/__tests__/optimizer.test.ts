import { describe, expect, it } from 'vitest'
import { optimiseLumpSum } from '../optimizer'
import type { Debt } from '../debt'

const TODAY = '2026-09-19'

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

describe('knockouts first', () => {
  const debts = [
    debt({ id: 'small', name: 'Store card', balanceCents: 40000, aprBasisPoints: 2999, minPaymentRule: { type: 'fixed', amountCents: 4000 } }),
    debt({ id: 'big', name: 'Big card', balanceCents: 900000, aprBasisPoints: 2199, minPaymentRule: { type: 'fixed', amountCents: 25000 } }),
  ]

  it('eliminates what it can, then puts the rest at the priciest debt', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })

    expect(result.allocations).toHaveLength(2)
    const [first, second] = result.allocations
    expect(first!.debtName).toBe('Store card')
    expect(first!.clearsIt).toBe(true)
    expect(first!.amountCents).toBe(40000)
    expect(second!.debtName).toBe('Big card')
    expect(second!.clearsIt).toBe(false)
    expect(second!.amountCents).toBe(67500)
  })

  it('accounts for every cent it was given', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })
    const spent = result.allocations.reduce((s, a) => s + a.amountCents, 0)
    expect(spent + result.unallocatedCents).toBe(107500)
    expect(result.unallocatedCents).toBe(0)
  })

  it('reports the monthly obligation it removes', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })
    // Only the cleared debt frees its minimum; a partial payment frees nothing.
    expect(result.monthlyFreedCents).toBe(4000)
  })

  it('reports interest avoided over the next year', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })
    expect(result.interestAvoidedCents).toBeGreaterThan(0)
  })

  it('explains itself in plain language', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })
    expect(result.why).toContain('clears Store card outright')
    expect(result.why).toContain('most expensive one left')
    expect(result.why).toMatch(/\$\d+\.\d{2} a month back/)
  })
})

describe('the slider changes the answer', () => {
  // One debt is expensive; the other frees far more cash per dollar. Both are
  // affordable, so the ORDER of knockouts is what the weighting decides.
  const debts = [
    debt({ id: 'pricey', name: 'Pricey', balanceCents: 100000, aprBasisPoints: 2999, minPaymentRule: { type: 'fixed', amountCents: 2000 } }),
    debt({ id: 'freeing', name: 'Freeing', balanceCents: 100000, aprBasisPoints: 700, minPaymentRule: { type: 'fixed', amountCents: 30000 } }),
  ]

  it('takes the expensive one first when set to avoid interest', () => {
    const result = optimiseLumpSum({ debts, amountCents: 100000, today: TODAY, weight: 1 })
    expect(result.allocations[0]!.debtName).toBe('Pricey')
  })

  it('takes the cash-freeing one first when set to free up cash flow', () => {
    const result = optimiseLumpSum({ debts, amountCents: 100000, today: TODAY, weight: 0 })
    expect(result.allocations[0]!.debtName).toBe('Freeing')
  })
})

describe('promo urgency overrides the ranking', () => {
  const debts = [
    debt({
      id: 'promo',
      name: 'Balance transfer',
      balanceCents: 80000,
      aprBasisPoints: 2699,
      minPaymentRule: { type: 'fixed', amountCents: 80000 },
      // Inside the 8-week lead window.
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2026-10-19' }],
    }),
    debt({ id: 'plain', name: 'Plain card', balanceCents: 80000, aprBasisPoints: 2999, minPaymentRule: { type: 'fixed', amountCents: 8000 } }),
  ]

  it('clears the expiring promo first even though another debt scores higher', () => {
    const result = optimiseLumpSum({ debts, amountCents: 80000, today: TODAY })
    expect(result.allocations[0]!.debtName).toBe('Balance transfer')
    expect(result.allocations[0]!.reason).toContain('promotional rate is about to end')
  })

  it('does not jump the queue when the amount cannot clear it anyway', () => {
    const result = optimiseLumpSum({ debts, amountCents: 20000, today: TODAY })
    // Too little to clear either, so it goes at the most expensive one.
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]!.clearsIt).toBe(false)
  })
})

describe('splitting beats concentrating when it can', () => {
  it('clears two small debts rather than denting one big one', () => {
    const debts = [
      debt({ id: 's1', name: 'Small one', balanceCents: 30000, aprBasisPoints: 2499, minPaymentRule: { type: 'fixed', amountCents: 3000 } }),
      debt({ id: 's2', name: 'Small two', balanceCents: 40000, aprBasisPoints: 2499, minPaymentRule: { type: 'fixed', amountCents: 4000 } }),
      debt({ id: 'big', name: 'Big', balanceCents: 900000, aprBasisPoints: 2499, minPaymentRule: { type: 'fixed', amountCents: 20000 } }),
    ]
    const result = optimiseLumpSum({ debts, amountCents: 70000, today: TODAY, weight: 0.3 })

    const cleared = result.allocations.filter((a) => a.clearsIt).map((a) => a.debtName).sort()
    expect(cleared).toEqual(['Small one', 'Small two'])
    expect(result.monthlyFreedCents).toBe(7000)
  })
})

describe('degenerate inputs produce sane answers, not crashes', () => {
  it('has nothing to say with no debts', () => {
    const result = optimiseLumpSum({ debts: [], amountCents: 100000, today: TODAY })
    expect(result.allocations).toEqual([])
    expect(result.unallocatedCents).toBe(100000)
    expect(result.why).toBe('There is nothing to pay off.')
  })

  it('has nothing to say with no money', () => {
    const result = optimiseLumpSum({
      debts: [debt({ id: 'a', name: 'Card' })],
      amountCents: 0,
      today: TODAY,
    })
    expect(result.allocations).toEqual([])
  })

  it('ignores debts already paid off', () => {
    const result = optimiseLumpSum({
      debts: [debt({ id: 'a', name: 'Done', state: 'paid_off' })],
      amountCents: 100000,
      today: TODAY,
    })
    expect(result.allocations).toEqual([])
  })

  it('never allocates more than it was given, even when it could clear everything', () => {
    const debts = [
      debt({ id: 'a', name: 'A', balanceCents: 10000 }),
      debt({ id: 'b', name: 'B', balanceCents: 10000 }),
    ]
    const result = optimiseLumpSum({ debts, amountCents: 1000000, today: TODAY })
    const spent = result.allocations.reduce((s, a) => s + a.amountCents, 0)
    expect(spent).toBeLessThanOrEqual(1000000)
    expect(spent).toBe(20000)
    expect(result.allocations.every((a) => a.clearsIt)).toBe(true)
    // The surplus is reported rather than quietly absorbed -- it is real money
    // the household still has to place somewhere.
    expect(result.unallocatedCents).toBe(980000)
    expect(result.why).toContain('left over')
  })
})
