import { describe, expect, it } from 'vitest'
import { optimiseLumpSum } from '../optimizer'
import { projectPayoff, type Debt } from '../debt'

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
    // Only the cleared debt frees its minimum: the big card has a set payment,
    // so denting it frees nothing until it is gone.
    expect(result.monthlyFreedCents).toBe(4000)
    expect(result.allocations[1]!.monthlyFreedCents).toBe(0)
    expect(result.allocations[1]!.reason).not.toContain('minimum drops')
  })

  it('reports interest avoided over the next year', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })
    expect(result.interestAvoidedCents).toBeGreaterThan(0)
  })

  it('reports interest never paid over the life of the debts, and months knocked off', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })
    const [cleared, dented] = result.allocations

    // Clearing the store card outright saves every cent of interest it would
    // have cost at its minimum, and ends it that many months early.
    const storeAlone = projectPayoff({ debt: debts[0]!, today: TODAY })
    expect(cleared!.lifetimeInterestAvoidedCents).toBe(storeAlone.totalInterestCents)
    expect(cleared!.monthsSooner).toBe(storeAlone.months)

    // A $675 dent in the big card: less interest over its life, gone sooner.
    const bigBefore = projectPayoff({ debt: debts[1]!, today: TODAY })
    const bigAfter = projectPayoff({ debt: { ...debts[1]!, balanceCents: 900000 - 67500 }, today: TODAY })
    expect(dented!.lifetimeInterestAvoidedCents).toBe(
      bigBefore.totalInterestCents - bigAfter.totalInterestCents,
    )
    expect(dented!.lifetimeInterestAvoidedCents).toBeGreaterThan(0)
    expect(dented!.monthsSooner).toBe(bigBefore.months! - bigAfter.months!)
    expect(dented!.monthsSooner).toBeGreaterThan(0)
    expect(dented!.reason).toMatch(/Gone \d+ months sooner\.$/)

    // The long view exceeds the twelve-month view when payoff takes years.
    expect(result.lifetimeInterestAvoidedCents).toBe(
      cleared!.lifetimeInterestAvoidedCents! + dented!.lifetimeInterestAvoidedCents!,
    )
    expect(result.lifetimeInterestAvoidedCents!).toBeGreaterThan(result.interestAvoidedCents)
  })

  it('is honest when a debt would never be paid off at its minimum', () => {
    // 1% of the balance a month against 29.99% never gets there.
    const endless = debt({
      id: 'endless',
      name: 'Endless card',
      balanceCents: 500000,
      aprBasisPoints: 2999,
      minPaymentRule: { type: 'percent', basisPoints: 100 },
    })
    const result = optimiseLumpSum({ debts: [endless], amountCents: 100000, today: TODAY })
    expect(result.allocations[0]!.lifetimeInterestAvoidedCents).toBeNull()
    expect(result.allocations[0]!.monthsSooner).toBeNull()
    expect(result.allocations[0]!.reason).not.toContain('sooner')
    // No "life of the loan" figure, but the next-year figure still stands.
    expect(result.lifetimeInterestAvoidedCents).toBeNull()
    expect(result.interestAvoidedCents).toBeGreaterThan(0)
  })

  it('explains itself in plain language, leaving the figures to the figures', () => {
    const result = optimiseLumpSum({ debts, amountCents: 107500, today: TODAY })
    expect(result.why).toBe(
      'This clears Store card outright. The rest goes at Big card, the most expensive one left.',
    )
  })
})

describe('a partial payment still frees cash when the minimum follows the balance', () => {
  it('reports how far a percent-of-balance minimum falls', () => {
    const card = debt({
      id: 'pct',
      name: 'Rewards card',
      balanceCents: 1000000,
      aprBasisPoints: 2049,
      minPaymentRule: { type: 'percent', basisPoints: 200 },
    })
    const result = optimiseLumpSum({ debts: [card], amountCents: 201959, today: TODAY })
    const [only] = result.allocations
    expect(only!.clearsIt).toBe(false)
    // 2% of $10,000.00 is $200.00. After the payment the balance is $7,980.41,
    // and 2% of that is $159.6082, rounded up to $159.61.
    expect(only!.minimumBeforeCents).toBe(20000)
    expect(only!.minimumAfterCents).toBe(15961)
    expect(only!.monthlyFreedCents).toBe(4039)
    expect(result.monthlyFreedCents).toBe(4039)
    expect(only!.reason).toContain('Its minimum drops from $200.00 to $159.61 a month.')
    // It shrinks, so it has an end, however far off: the long view exists.
    expect(only!.lifetimeInterestAvoidedCents).not.toBeNull()
    expect(only!.lifetimeInterestAvoidedCents!).toBeGreaterThan(result.interestAvoidedCents)
    expect(result.lifetimeInterestAvoidedCents).toBe(only!.lifetimeInterestAvoidedCents)
  })

  it('frees nothing while a floor is what sets the minimum', () => {
    // 2% of $2,000 is $40, under the $50 floor; after paying $500 it is $30, still under.
    const card = debt({
      id: 'floored',
      name: 'Floored card',
      balanceCents: 200000,
      minPaymentRule: { type: 'percent_with_floor', basisPoints: 200, floorCents: 5000 },
    })
    const result = optimiseLumpSum({ debts: [card], amountCents: 50000, today: TODAY })
    expect(result.allocations[0]!.minimumBeforeCents).toBe(5000)
    expect(result.allocations[0]!.minimumAfterCents).toBe(5000)
    expect(result.monthlyFreedCents).toBe(0)
    expect(result.allocations[0]!.reason).not.toContain('minimum drops')
  })

  it("adds a dented card's smaller minimum to what the knockouts free", () => {
    const debts = [
      debt({ id: 'small', name: 'Store card', balanceCents: 40000, aprBasisPoints: 2999, minPaymentRule: { type: 'fixed', amountCents: 4000 } }),
      debt({ id: 'pct', name: 'Rewards card', balanceCents: 1000000, aprBasisPoints: 2049, minPaymentRule: { type: 'percent', basisPoints: 200 } }),
    ]
    const result = optimiseLumpSum({ debts, amountCents: 241959, today: TODAY })
    // $400 clears the store card; the remaining $2,019.59 dents the rewards card.
    expect(result.allocations.map((a) => a.amountCents)).toEqual([40000, 201959])
    expect(result.monthlyFreedCents).toBe(4000 + 4039)
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

describe('a deal that is on track is left alone', () => {
  it('sends the remainder to the card that actually costs something', () => {
    // $5,000 at 0% until next September, minimum $50 -- but paid at $500 a
    // month, which clears it in time. Every dollar put there avoids nothing.
    const debts = [
      debt({
        id: 'deal',
        name: 'Balance transfer',
        balanceCents: 500000,
        aprBasisPoints: 3049,
        minPaymentRule: { type: 'fixed', amountCents: 5000 },
        plannedPaymentCents: 50000,
        promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-09-19' }],
      }),
      debt({ id: 'card', name: 'Rewards card', balanceCents: 700000, aprBasisPoints: 2049 }),
    ]
    const result = optimiseLumpSum({ debts, amountCents: 201959, today: TODAY })
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]!.debtName).toBe('Rewards card')
    expect(result.allocations[0]!.reason).toContain('20.49%')
  })

  it('still goes at the deal when the household is NOT on track to clear it', () => {
    const debts = [
      debt({
        id: 'deal',
        name: 'Balance transfer',
        balanceCents: 500000,
        aprBasisPoints: 3049,
        minPaymentRule: { type: 'fixed', amountCents: 5000 },
        promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-09-19' }],
      }),
      debt({ id: 'card', name: 'Rewards card', balanceCents: 700000, aprBasisPoints: 2049 }),
    ]
    const result = optimiseLumpSum({ debts, amountCents: 201959, today: TODAY })
    expect(result.allocations[0]!.debtName).toBe('Balance transfer')
    expect(result.allocations[0]!.reason).toContain('30.49%')
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

describe('a deal-rate card takes only what its payments would leave at the full rate', () => {
  // The user's case: $5,775.42 at 0% until 31 Mar 2028, $303 a month, full
  // rate 30.49%. $321.42 would survive the deal. Beyond that, every dollar
  // put there saves nothing while a 20.49% card is open.
  const shield = debt({
    id: 'shield',
    name: 'US Bank Shield 9795 (Balance Transfer)',
    balanceCents: 577542,
    aprBasisPoints: 3049,
    minPaymentRule: { type: 'percent_with_floor', basisPoints: 100, floorCents: 30300 },
    promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2028-03-31' }],
  })
  const altitude = debt({
    id: 'altitude',
    name: 'Altitude Reserve',
    balanceCents: 719966,
    aprBasisPoints: 2049,
    minPaymentRule: { type: 'percent_with_floor', basisPoints: 100, floorCents: 3000 },
  })

  it('covers the cliff, then moves on to the card that costs something', () => {
    const result = optimiseLumpSum({ debts: [shield, altitude], amountCents: 201959, today: '2026-09-21' })
    expect(result.allocations.map((a) => [a.debtName, a.amountCents])).toEqual([
      ['US Bank Shield 9795 (Balance Transfer)', 32142],
      ['Altitude Reserve', 201959 - 32142],
    ])
    expect(result.allocations[0]!.reason).toContain('0% deal ends 2028-03-31')
    expect(result.allocations[0]!.reason).toContain('This covers it')
    expect(result.allocations[1]!.reason).toContain('20.49%')
    expect(result.unallocatedCents).toBe(0)
    // What covering the cliff saves is the interest on the survivor, not a
    // year of 30.49% on the whole card.
    expect(result.allocations[0]!.lifetimeInterestAvoidedCents).toBeLessThan(2000)
  })

  it('sends nothing more to the card once the first step has covered its cliff', () => {
    // The share-out's "cover what is short" already paid $321.42: the
    // optimizer sees the balance after that, and the card is a deal again.
    const covered = { ...shield, balanceCents: 577542 - 32142 }
    const result = optimiseLumpSum({ debts: [covered, altitude], amountCents: 181429, today: '2026-09-21' })
    expect(result.allocations.map((a) => a.debtName)).toEqual(['Altitude Reserve'])
  })

  it('leaves money over rather than paying early a deal it is on track to clear', () => {
    const covered = { ...shield, balanceCents: 577542 - 32142 }
    const result = optimiseLumpSum({ debts: [covered], amountCents: 181429, today: '2026-09-21' })
    expect(result.allocations).toEqual([])
    expect(result.unallocatedCents).toBe(181429)
    expect(result.why).toContain('on track to clear')
    expect(result.why).toContain('left over')
  })

  it('covers part of a cliff when that is all there is, and says so', () => {
    const result = optimiseLumpSum({ debts: [shield, altitude], amountCents: 10000, today: '2026-09-21' })
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]!.amountCents).toBe(10000)
    expect(result.allocations[0]!.reason).toContain('covers part of it')
  })
})
