import { describe, expect, it } from 'vitest'
import {
  DebtDataError,
  DEFAULT_PROMO_LEAD_WEEKS,
  effectiveAprBasisPoints,
  interestOverNextYearCents,
  minimumPaymentCents,
  projectPayoff,
  promoExpiryWarning,
  scoreDebts,
  snowballLadder,
  validateDebtRates,
  type Debt,
} from '../debt'

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

describe('minimum payments', () => {
  it('handles a fixed monthly amount', () => {
    expect(minimumPaymentCents(debt({ id: 'a', name: 'Card' }))).toBe(15000)
  })

  it('handles a percentage of the balance', () => {
    expect(
      minimumPaymentCents(
        debt({ id: 'a', name: 'Card', balanceCents: 500000, minPaymentRule: { type: 'percent', basisPoints: 200 } }),
      ),
    ).toBe(10000) // 2% of $5,000
  })

  it('applies a floor when the percentage falls below it', () => {
    const rule = { type: 'percent_with_floor' as const, basisPoints: 200, floorCents: 2500 }
    expect(minimumPaymentCents(debt({ id: 'a', name: 'x', balanceCents: 500000, minPaymentRule: rule }))).toBe(10000)
    expect(minimumPaymentCents(debt({ id: 'b', name: 'y', balanceCents: 50000, minPaymentRule: rule }))).toBe(2500)
  })

  it('never demands more than the balance', () => {
    expect(minimumPaymentCents(debt({ id: 'a', name: 'x', balanceCents: 5000 }))).toBe(5000)
  })
})

describe('promo-aware effective APR', () => {
  it('uses the plain APR when there is no promo', () => {
    expect(effectiveAprBasisPoints(debt({ id: 'a', name: 'x' }), TODAY)).toBe(2499)
  })

  it('uses the promo rate while the promo is comfortably in the future', () => {
    const d = debt({
      id: 'a',
      name: 'Balance transfer',
      balanceCents: 300000,
      aprBasisPoints: 2499,
      minPaymentRule: { type: 'fixed', amountCents: 30000 },
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-09-19' }],
    })
    // 12 months at $300/mo clears $3,000, so the 0% is believable.
    expect(effectiveAprBasisPoints(d, TODAY)).toBe(0)
  })

  it('prices at the post-promo rate immediately when the balance cannot be cleared in time', () => {
    const d = debt({
      id: 'a',
      name: 'Deferred interest',
      balanceCents: 300000,
      aprBasisPoints: 2999,
      // $50/mo over 12 months is $600 against a $3,000 balance: no chance.
      minPaymentRule: { type: 'fixed', amountCents: 5000 },
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-09-19' }],
    })
    // This is the cliff the spreadsheet could not see: a 0% APR scoring zero.
    expect(effectiveAprBasisPoints(d, TODAY)).toBe(2999)
  })

  it('ramps toward the real rate as a clearable promo nears expiry', () => {
    const make = (untilDate: string) =>
      debt({
        id: 'a',
        name: 'BT',
        balanceCents: 100000,
        aprBasisPoints: 2400,
        minPaymentRule: { type: 'fixed', amountCents: 100000 },
        promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate }],
      })

    const farOff = effectiveAprBasisPoints(make('2027-06-19'), TODAY)
    const nearing = effectiveAprBasisPoints(make('2026-10-19'), TODAY)

    expect(farOff).toBe(0)
    // Inside the lead window it has started climbing, but has not jumped to full.
    expect(nearing).toBeGreaterThan(0)
    expect(nearing).toBeLessThan(2400)
  })

  it('blends a partial-balance promo across tranches by balance', () => {
    const d = debt({
      id: 'a',
      name: 'Card with a BT',
      balanceCents: 200000,
      aprBasisPoints: 2000,
      minPaymentRule: { type: 'fixed', amountCents: 100000 },
      promoRules: [
        { rateBasisPoints: 0, appliesTo: 'amount', amountCents: 100000, untilDate: '2027-09-19' },
      ],
    })
    // Half at 0%, half at 20% -> 10%.
    expect(effectiveAprBasisPoints(d, TODAY)).toBe(1000)
  })

  it('ignores a promo that has already expired', () => {
    const d = debt({
      id: 'a',
      name: 'x',
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2026-01-01' }],
    })
    expect(effectiveAprBasisPoints(d, TODAY)).toBe(2499)
  })

  it('warns in time to actually clear the balance', () => {
    const d = debt({
      id: 'a',
      name: 'BT',
      balanceCents: 120000,
      minPaymentRule: { type: 'fixed', amountCents: 120000 },
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2026-10-19' }],
    })
    const warning = promoExpiryWarning(d, TODAY, DEFAULT_PROMO_LEAD_WEEKS)
    expect(warning).not.toBeNull()
    expect(warning!.untilDate).toBe('2026-10-19')
    expect(warning!.monthlyToClearCents).toBe(120000) // one month left
  })

  it('does not warn while the deadline is still far off', () => {
    const d = debt({
      id: 'a',
      name: 'BT',
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-09-19' }],
    })
    expect(promoExpiryWarning(d, TODAY)).toBeNull()
  })
})

describe('scoring', () => {
  const debts = [
    debt({ id: 'high-rate', name: 'Store card', balanceCents: 200000, aprBasisPoints: 2999, minPaymentRule: { type: 'fixed', amountCents: 5000 } }),
    debt({ id: 'high-freed', name: 'Small loan', balanceCents: 50000, aprBasisPoints: 900, minPaymentRule: { type: 'fixed', amountCents: 20000 } }),
    debt({ id: 'mortgage', name: 'Mortgage', category: 'mortgage', balanceCents: 20000000, aprBasisPoints: 450, minPaymentRule: { type: 'fixed', amountCents: 150000 } }),
  ]

  it('normalises the long-term score against the worst rate in the inventory', () => {
    const scores = scoreDebts({ debts, today: TODAY })
    const worst = scores.find((s) => s.debt.id === 'high-rate')!
    expect(worst.longTerm).toBe(1)
    expect(scores.find((s) => s.debt.id === 'mortgage')!.longTerm).toBeCloseTo(450 / 2999, 5)
  })

  it('normalises the short-term score against the best cash-freed ratio', () => {
    const scores = scoreDebts({ debts, today: TODAY })
    expect(scores.find((s) => s.debt.id === 'high-freed')!.shortTerm).toBe(1)
  })

  it('puts avoiding interest first at the default 70/30', () => {
    const scores = scoreDebts({ debts, today: TODAY })
    expect(scores[0]!.debt.id).toBe('high-rate')
  })

  it('re-sorts toward freeing cash flow when the slider moves', () => {
    const cashFlow = scoreDebts({ debts, today: TODAY, weight: 0 })
    expect(cashFlow[0]!.debt.id).toBe('high-freed')

    const interest = scoreDebts({ debts, today: TODAY, weight: 1 })
    expect(interest[0]!.debt.id).toBe('high-rate')
  })

  it('leaves out paid-off and zero-balance debts', () => {
    const scores = scoreDebts({
      debts: [...debts, debt({ id: 'done', name: 'Done', state: 'paid_off' }), debt({ id: 'zero', name: 'Zero', balanceCents: 0 })],
      today: TODAY,
    })
    expect(scores.map((s) => s.debt.id)).not.toContain('done')
    expect(scores.map((s) => s.debt.id)).not.toContain('zero')
  })

  it('copes with an empty inventory', () => {
    expect(scoreDebts({ debts: [], today: TODAY })).toEqual([])
  })
})

describe('the snowball ladder', () => {
  const debts = [
    debt({ id: 'a', name: 'A', balanceCents: 100000, aprBasisPoints: 2999, minPaymentRule: { type: 'fixed', amountCents: 5000 } }),
    debt({ id: 'b', name: 'B', balanceCents: 200000, aprBasisPoints: 1999, minPaymentRule: { type: 'fixed', amountCents: 8000 } }),
  ]

  it('accumulates cost and freed cash down the rungs', () => {
    const ladder = snowballLadder(scoreDebts({ debts, today: TODAY }))
    expect(ladder[0]!.cumulativeCostCents).toBe(100000)
    expect(ladder[0]!.cumulativeFreedPerMonthCents).toBe(5000)
    expect(ladder[1]!.cumulativeCostCents).toBe(300000)
    expect(ladder[1]!.cumulativeFreedPerMonthCents).toBe(13000)
  })

  it('shows how long the freed cash takes to repay the cost', () => {
    const ladder = snowballLadder(scoreDebts({ debts, today: TODAY }))
    expect(ladder[0]!.breakEvenMonths).toBe(20) // $1,000 / $50
    expect(ladder[1]!.breakEvenMonths).toBe(Math.ceil(300000 / 13000))
  })
})

describe('payoff projections', () => {
  it('clears a fixed-payment loan and dates it', () => {
    const d = debt({
      id: 'a',
      name: 'Car',
      category: 'auto',
      balanceCents: 1200000,
      aprBasisPoints: 599,
      minPaymentRule: { type: 'fixed', amountCents: 40000 },
      fixedPayment: true,
    })
    const projection = projectPayoff({ debt: d, today: TODAY })
    expect(projection.months).toBeGreaterThan(30)
    expect(projection.months).toBeLessThan(36)
    expect(projection.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(projection.totalInterestCents).toBeGreaterThan(0)
  })

  it('gets there sooner with extra money each month', () => {
    const d = debt({
      id: 'a',
      name: 'Card',
      balanceCents: 500000,
      aprBasisPoints: 2499,
      minPaymentRule: { type: 'fixed', amountCents: 15000 },
    })
    const base = projectPayoff({ debt: d, today: TODAY })
    const faster = projectPayoff({ debt: d, today: TODAY, extraPerMonthCents: 20000 })
    expect(faster.months!).toBeLessThan(base.months!)
    expect(faster.totalInterestCents).toBeLessThan(base.totalInterestCents)
  })

  it('says plainly when a minimum never clears the balance', () => {
    const d = debt({
      id: 'a',
      name: 'Trap',
      balanceCents: 500000,
      aprBasisPoints: 2999,
      // 1% of balance against ~2.5%/mo interest: it only ever grows.
      minPaymentRule: { type: 'percent', basisPoints: 100 },
    })
    const projection = projectPayoff({ debt: d, today: TODAY })
    expect(projection.months).toBeNull()
    expect(projection.payoffDate).toBeNull()
  })

  it('is already done at a zero balance', () => {
    expect(projectPayoff({ debt: debt({ id: 'a', name: 'x', balanceCents: 0 }), today: TODAY }).months).toBe(0)
  })
})

describe('interest over the coming year', () => {
  it('is zero on a believable 0% promo', () => {
    const d = debt({
      id: 'a',
      name: 'BT',
      balanceCents: 300000,
      minPaymentRule: { type: 'fixed', amountCents: 30000 },
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-09-19' }],
    })
    expect(interestOverNextYearCents(d, TODAY)).toBe(0)
  })

  it('is substantial on a high-rate balance', () => {
    const d = debt({ id: 'a', name: 'Card', balanceCents: 500000, aprBasisPoints: 2499 })
    const interest = interestOverNextYearCents(d, TODAY)
    expect(interest).toBeGreaterThan(80000)
    expect(interest).toBeLessThan(130000)
  })
})

describe('guarding against the one data-entry mistake that breaks everything', () => {
  it('accepts a real promotional rate', () => {
    expect(() =>
      validateDebtRates({
        aprBasisPoints: 2499,
        promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-01-01' }],
      }),
    ).not.toThrow()
  })

  it('refuses a 0% promo entered against a 0% standard rate', () => {
    // This silently disables the promo cliff: with nothing to revert to, the
    // debt never climbs the ladder and the household is told it is fine.
    expect(() =>
      validateDebtRates({
        aprBasisPoints: 0,
        promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-01-01' }],
      }),
    ).toThrow(DebtDataError)
  })

  it('refuses a promo rate above the rate it reverts to', () => {
    expect(() =>
      validateDebtRates({
        aprBasisPoints: 999,
        promoRules: [{ rateBasisPoints: 1999, appliesTo: 'full', untilDate: '2027-01-01' }],
      }),
    ).toThrow(/not lower than/)
  })

  it('says which field to fix', () => {
    expect(() =>
      validateDebtRates({
        aprBasisPoints: 0,
        promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-01-01' }],
      }),
    ).toThrow(/interest rate field/)
  })
})
