import { describe, expect, it } from 'vitest'
import { DEFAULT_SORT, nextSort, sortDebtRows, type SortableDebtRow } from './debt-sort'

// The screenshot's ladder, in payoff order. Names carry the rank so a failure
// reads as a sequence.
const rows: SortableDebtRow[] = [
  { rank: 1, name: 'US Bank Shield 0568', balanceCents: 670239, effectiveAprBasisPoints: 0, paymentCents: 47500, payoffDate: '2027-12-21' },
  { rank: 2, name: 'US Bank Shield 9795', balanceCents: 577542, effectiveAprBasisPoints: 3049, paymentCents: 30300, payoffDate: '2028-05-21' },
  { rank: 3, name: 'Car Payment', balanceCents: 1781712, effectiveAprBasisPoints: 599, paymentCents: 55525, payoffDate: '2029-09-21' },
  { rank: 4, name: 'AMEX', balanceCents: 1066893, effectiveAprBasisPoints: 990, paymentCents: 28253, payoffDate: '2030-07-21' },
  { rank: 5, name: 'Lightstream', balanceCents: 2128349, effectiveAprBasisPoints: 1254, paymentCents: 52633, payoffDate: '2031-02-21' },
  { rank: 6, name: 'US Bank Altitude Reserve', balanceCents: 567020, effectiveAprBasisPoints: 2049, paymentCents: 5671, payoffDate: null },
  { rank: 7, name: 'Mortgage', balanceCents: 38122696, effectiveAprBasisPoints: 475, paymentCents: 253940, payoffDate: '2045-10-21' },
]
const ranks = (sorted: SortableDebtRow[]) => sorted.map((row) => row.rank)

describe('sortDebtRows', () => {
  it('defaults to the payoff order and never mutates the input', () => {
    const copy = [...rows].reverse()
    expect(ranks(sortDebtRows(copy, DEFAULT_SORT))).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(ranks(copy)).toEqual([7, 6, 5, 4, 3, 2, 1])
  })

  it('orders by balance either way', () => {
    expect(ranks(sortDebtRows(rows, { key: 'balance', direction: 'asc' }))).toEqual([6, 2, 1, 4, 3, 5, 7])
    expect(ranks(sortDebtRows(rows, { key: 'balance', direction: 'desc' }))).toEqual([7, 5, 3, 4, 1, 2, 6])
  })

  it('orders by the effective rate, not the listed one', () => {
    // Rung 1 is a 0% promo on a card listed at 30.49%: it sorts as 0%.
    expect(ranks(sortDebtRows(rows, { key: 'rate', direction: 'asc' }))).toEqual([1, 7, 3, 4, 5, 6, 2])
  })

  it('orders by the monthly payment', () => {
    expect(ranks(sortDebtRows(rows, { key: 'payment', direction: 'desc' }))).toEqual([7, 3, 5, 1, 2, 4, 6])
  })

  it('orders names case-insensitively', () => {
    expect(ranks(sortDebtRows(rows, { key: 'name', direction: 'asc' }))).toEqual([4, 3, 5, 7, 6, 1, 2])
  })

  it('treats "never, at this rate" as the furthest-off date', () => {
    expect(ranks(sortDebtRows(rows, { key: 'payoff', direction: 'asc' }))).toEqual([1, 2, 3, 4, 5, 7, 6])
    expect(ranks(sortDebtRows(rows, { key: 'payoff', direction: 'desc' }))).toEqual([6, 7, 5, 4, 3, 2, 1])
  })

  it('breaks ties by payoff order', () => {
    const tied = rows.map((row) => ({ ...row, balanceCents: 100 }))
    expect(ranks(sortDebtRows(tied, { key: 'balance', direction: 'desc' }))).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

describe('nextSort', () => {
  it('starts a new column ascending and flips the current one', () => {
    expect(nextSort(DEFAULT_SORT, 'balance')).toEqual({ key: 'balance', direction: 'asc' })
    expect(nextSort({ key: 'balance', direction: 'asc' }, 'balance')).toEqual({ key: 'balance', direction: 'desc' })
    expect(nextSort({ key: 'balance', direction: 'desc' }, 'balance')).toEqual({ key: 'balance', direction: 'asc' })
  })
})
