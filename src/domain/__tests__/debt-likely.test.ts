import { describe, expect, it } from 'vitest'
import { likelyDebtBalance, balanceAfterPayments, type Debt, type DebtPaymentMade } from '../debt'

// PRD D49 (2)-(3): the likely balance, from the last stated one.

function card(over: Partial<Debt> = {}): Debt {
  return {
    id: 'd',
    householdId: 'hh',
    name: 'Shield 0568',
    category: 'consumer',
    balanceCents: 670239,
    balanceAsOf: '2026-09-20',
    aprBasisPoints: 3049,
    promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2028-01-12' }],
    minPaymentRule: { type: 'fixed', amountCents: 4000 },
    plannedPaymentCents: 47500,
    fixedPayment: false,
    state: 'open',
    ...over,
  }
}

const paid = (on: string, amountCents: number, regular = true): DebtPaymentMade => ({
  on: on as DebtPaymentMade['on'],
  amountCents,
  regular,
})

describe('likelyDebtBalance', () => {
  it('with no payment day, is the stated balance less the payments marked done, nothing assumed', () => {
    const debt = card({ paymentDay: null })
    expect(likelyDebtBalance({ debt, payments: [], today: '2026-12-31' })).toBe(670239)
    expect(likelyDebtBalance({ debt, payments: [paid('2026-10-01', 47500), paid('2026-10-05', 1000, false)], today: '2026-10-14' })).toBe(670239 - 48500)
    expect(balanceAfterPayments(100, [60, 60])).toBe(0)
  })

  it('assumes the planned payment on each payment day since the statement, at the deal rate', () => {
    const debt = card({ paymentDay: 13 })
    // Oct 13 is the only payment day after Sep 20 and on or before Oct 14.
    expect(likelyDebtBalance({ debt, payments: [], today: '2026-10-14' })).toBe(670239 - 47500)
    // Before the day comes round, nothing is assumed yet.
    expect(likelyDebtBalance({ debt, payments: [], today: '2026-10-12' })).toBe(670239)
    // A statement on the day says nothing has happened since.
    expect(likelyDebtBalance({ debt: card({ paymentDay: 13, balanceAsOf: '2026-10-14' }), payments: [], today: '2026-10-14' })).toBe(670239)
  })

  it('a regular payment marked done replaces that month\'s assumed one; a to-do payment comes off on top', () => {
    const debt = card({ paymentDay: 13 })
    expect(likelyDebtBalance({ debt, payments: [paid('2026-10-12', 47500)], today: '2026-10-14' })).toBe(670239 - 47500)
    expect(likelyDebtBalance({ debt, payments: [paid('2026-10-20', 50000)], today: '2026-10-21' })).toBe(670239 - 50000)
    expect(likelyDebtBalance({ debt, payments: [paid('2026-10-12', 10000, false)], today: '2026-10-14' })).toBe(670239 - 10000 - 47500)
  })

  it('charges a month of interest at the full rate before each assumed payment', () => {
    const debt = card({
      balanceCents: 100000,
      balanceAsOf: '2026-09-01',
      promoRules: [],
      plannedPaymentCents: null,
      paymentDay: 15,
    })
    // Sep 15: 100,000 + round(100,000 x 30.49% / 12) = 100,000 + 2,541 = 102,541, less 4,000 = 98,541.
    // Oct 15: 98,541 + round(98,541 x 30.49% / 12) = 98,541 + 2,504 = 101,045, less 4,000 = 97,045.
    expect(likelyDebtBalance({ debt, payments: [], today: '2026-10-20' })).toBe(97045)
  })

  it('a deal that ends before a payment day is charged the full rate from then', () => {
    const debt = card({
      balanceCents: 100000,
      balanceAsOf: '2026-09-01',
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2026-10-01' }],
      plannedPaymentCents: null,
      paymentDay: 15,
    })
    // Sep 15 at 0%: 100,000 - 4,000 = 96,000. Oct 15 at 30.49%: 96,000 + 2,439 - 4,000 = 94,439.
    expect(likelyDebtBalance({ debt, payments: [], today: '2026-10-20' })).toBe(94439)
  })

  it('a day past a short month\'s end falls on its last day, and the balance never goes below zero', () => {
    const debt = card({ balanceCents: 5000, balanceAsOf: '2027-01-31', promoRules: [], paymentDay: 31, plannedPaymentCents: 4000 })
    // Feb 28 is that month's payment day.
    expect(likelyDebtBalance({ debt, payments: [], today: '2027-02-27' })).toBe(5000)
    expect(likelyDebtBalance({ debt, payments: [], today: '2027-02-28' })).toBe(5000 + 127 - 4000)
    expect(likelyDebtBalance({ debt, payments: [], today: '2027-04-30' })).toBe(0)
  })
})
