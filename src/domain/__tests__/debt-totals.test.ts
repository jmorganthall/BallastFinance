import { describe, expect, it } from 'vitest'
import { debtTotals } from '@/domain'

describe('debtTotals', () => {
  it('adds the balances and payments and takes the latest payoff date', () => {
    expect(
      debtTotals([
        { balanceCents: 60_808, paymentCents: 3_000, payoffDate: '2029-01-07' },
        { balanceCents: 612_261, paymentCents: 25_000, payoffDate: '2028-06-15' },
      ]),
    ).toEqual({ count: 2, balanceCents: 673_069, perMonthCents: 28_000, lastPayoffDate: '2029-01-07' })
  })

  it('claims no date when any debt never pays off at its payment', () => {
    expect(
      debtTotals([
        { balanceCents: 10_000, paymentCents: 500, payoffDate: '2027-03-01' },
        { balanceCents: 50_000, paymentCents: 100, payoffDate: null },
      ]).lastPayoffDate,
    ).toBeNull()
  })

  it('is zero with no debts', () => {
    expect(debtTotals([])).toEqual({ count: 0, balanceCents: 0, perMonthCents: 0, lastPayoffDate: null })
  })
})
