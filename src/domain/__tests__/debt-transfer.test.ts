import { describe, expect, it } from 'vitest'
import {
  DebtDataError,
  projectPayoff,
  validateTransferOffer,
  type Debt,
  type TransferOffer,
} from '../debt'
import { monthsInWords, offerWords, transferCheck, transferFeeCents } from '../debt-transfer'

const TODAY = '2026-09-19'

function debt(over: Partial<Debt> & Pick<Debt, 'id' | 'name'>): Debt {
  return {
    householdId: 'hh',
    category: 'consumer',
    balanceCents: 500000,
    balanceAsOf: TODAY,
    aprBasisPoints: 2499,
    promoRules: [],
    minPaymentRule: { type: 'fixed', amountCents: 20000 },
    fixedPayment: false,
    state: 'open',
    ...over,
  }
}

const ZERO_FOR_12: TransferOffer = { rateBasisPoints: 0, months: 12, feeBasisPoints: 300, chargedBack: false }

function card(over: Partial<Debt> = {}): Debt {
  return debt({
    id: 'new',
    name: 'New card',
    balanceCents: 0,
    creditLimitCents: 1000000,
    minPaymentRule: { type: 'fixed', amountCents: 2500 },
    transferOffer: ZERO_FOR_12,
    ...over,
  })
}

describe('a transfer offer is a fact that has to make sense (D61)', () => {
  const refused = (offer: TransferOffer, category: Debt['category'] = 'consumer', apr = 2499) =>
    expect(() => validateTransferOffer(offer, apr, category)).toThrow(DebtDataError)

  it('takes a card deal and a line of credit', () => {
    expect(() => validateTransferOffer(ZERO_FOR_12, 2499, 'consumer')).not.toThrow()
    expect(() => validateTransferOffer({ feeBasisPoints: 0 }, 899, 'consumer')).not.toThrow()
    expect(() =>
      validateTransferOffer({ rateBasisPoints: 0, untilDate: '2028-01-01', feeBasisPoints: 500, feeMinCents: 500 }, 2499, 'consumer'),
    ).not.toThrow()
  })

  it('refuses what cannot be a real offer', () => {
    refused(ZERO_FOR_12, 'auto')
    refused(ZERO_FOR_12, 'mortgage')
    refused({ ...ZERO_FOR_12, untilDate: '2028-01-01' }) // months and a date
    refused({ months: 12, feeBasisPoints: 300 }) // ends, no rate
    refused({ ...ZERO_FOR_12, rateBasisPoints: 2499 }) // not lower than the card's rate
    refused({ rateBasisPoints: 500, feeBasisPoints: 0 }) // never ends, yet a rate of its own
    refused({ ...ZERO_FOR_12, months: 0 })
    refused({ ...ZERO_FOR_12, months: 61 })
    refused({ ...ZERO_FOR_12, feeBasisPoints: -1 })
    refused({ ...ZERO_FOR_12, feeBasisPoints: 2001 })
    refused({ ...ZERO_FOR_12, feeMinCents: -1 })
  })
})

describe('the fee', () => {
  it('rounds up to the cent and never goes below its minimum', () => {
    expect(transferFeeCents({ feeBasisPoints: 300 }, 500000)).toBe(15000) // 3% of $5,000
    expect(transferFeeCents({ feeBasisPoints: 300 }, 33)).toBe(1) // 0.99 cents -> 1 cent
    expect(transferFeeCents({ feeBasisPoints: 300, feeMinCents: 500 }, 10000)).toBe(500) // $3 -> $5
    expect(transferFeeCents({ feeBasisPoints: 300 }, 0)).toBe(0)
  })
})

describe('is a transfer worth it (D61)', () => {
  it('moves a whole card onto an empty 0% card, the freed payment following the money', () => {
    const chase = debt({ id: 'chase', name: 'Chase' })
    const check = transferCheck({ debts: [chase], target: card(), today: TODAY })
    expect(check.refused).toBeNull()
    expect(check.roomCents).toBe(1000000)
    // $5,000 + 3% = $5,150, inside the $10,000 room: everything moves.
    expect(check.mostCents).toBe(500000)
    expect(check.recommendedCents).toBe(500000)
    const r = check.result!
    expect(r.feeCents).toBe(15000)
    expect(r.moves).toEqual([
      { debt: chase, amountCents: 500000, paymentBeforeCents: 20000, paymentAfterCents: 0 },
    ])
    // Chase's $200 goes to the new card, beside its own $25.
    expect(r.freedPerMonthCents).toBe(20000)
    expect(r.interestWithoutCents).toBe(projectPayoff({ debt: chase, today: TODAY }).totalInterestCents)
    expect(r.netSavingsCents).toBe(r.interestWithoutCents - r.interestWithCents - r.feeCents)
    expect(r.netSavingsCents).toBeGreaterThan(0)
    // 12 payments of $225 by 2027-09-19 take $2,700 off $5,150: $2,450 left when 0% ends.
    // Clearing $5,150 in 12 payments is $429.17, rounded up to $430.
    expect(r.deal).toEqual({ endsOn: '2027-09-19', rateBasisPoints: 0, leftAtEndCents: 245000, clearsAtPerMonthCents: 43000 })
    expect(r.horizonMonths).toBeNull()
    expect(r.monthsSooner).toBe(r.monthsWithout! - r.monthsWith!)
  })

  it('never moves a balance on a live deal, an auto loan, or a cheaper debt', () => {
    const onDeal = debt({
      id: 'deal',
      name: 'Discover',
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-06-01' }],
    })
    const car = debt({ id: 'car', name: 'Car', category: 'auto', aprBasisPoints: 3000 })
    const cheap = debt({ id: 'cu', name: 'Credit union', aprBasisPoints: 500 })
    const loc: Debt = card({ aprBasisPoints: 800, transferOffer: { feeBasisPoints: 0 } })
    const check = transferCheck({ debts: [onDeal, car, cheap], target: loc, today: TODAY })
    expect(check.sources).toEqual([])
    expect(check.leftOut.map((l) => [l.debt.id, l.reason.kind])).toEqual([
      ['deal', 'on_deal'],
      ['car', 'not_consumer'],
      ['cu', 'cheaper'],
    ])
    expect(check.result).toBeNull()
  })

  it('fills the costliest debt first, and the room caps the next', () => {
    const a = debt({ id: 'a', name: 'A', balanceCents: 400000, aprBasisPoints: 2999 })
    const b = debt({ id: 'b', name: 'B', balanceCents: 900000, aprBasisPoints: 1999 })
    const check = transferCheck({ debts: [b, a], target: card(), today: TODAY, amountCents: 900000 })
    expect(check.sources.map((d) => d.id)).toEqual(['a', 'b'])
    // $10,000 room / 1.03 = $9,708.73, down to whole dollars: $9,708 + $291.24 fee = $9,999.24.
    expect(check.mostCents).toBe(970800)
    expect(check.result!.moves.map((m) => [m.debt.id, m.amountCents])).toEqual([
      ['a', 400000],
      ['b', 500000],
    ])
    // B keeps a balance, so still pays its $200: only A's $200 is freed.
    expect(check.result!.freedPerMonthCents).toBe(20000)
  })

  it('holds a typed amount to the most that fits', () => {
    const chase = debt({ id: 'chase', name: 'Chase' })
    const over = transferCheck({ debts: [chase], target: card(), today: TODAY, amountCents: 900000 })
    expect(over.typed).toEqual({ cents: 900000, problem: 'over_most' })
    expect(over.result!.amountCents).toBe(500000)
    const none = transferCheck({ debts: [chase], target: card(), today: TODAY, amountCents: 0 })
    expect(none.typed!.problem).toBe('not_positive')
    const fine = transferCheck({ debts: [chase], target: card(), today: TODAY, amountCents: 123400 })
    expect(fine.typed!.problem).toBeNull()
    expect(fine.result!.amountCents).toBe(123400)
  })

  it('says nothing fits when the fee minimum is bigger than the room', () => {
    const chase = debt({ id: 'chase', name: 'Chase' })
    const tiny = card({ creditLimitCents: 400, transferOffer: { ...ZERO_FOR_12, feeMinCents: 500 } })
    const check = transferCheck({ debts: [chase], target: tiny, today: TODAY })
    expect(check.mostCents).toBe(0)
    expect(check.result).toBeNull()
  })

  it('keeps a 0% card holding only 0% money', () => {
    const chase = debt({ id: 'chase', name: 'Chase' })
    const carrying = card({ balanceCents: 120000 })
    expect(transferCheck({ debts: [chase], target: carrying, today: TODAY }).refused).toEqual({
      kind: 'mixes_rates',
      balanceCents: 120000,
      aprBasisPoints: 2499,
    })
    // A line of credit is one rate on everything, so a balance there is fine.
    const loc = card({ balanceCents: 120000, aprBasisPoints: 899, transferOffer: { feeBasisPoints: 0 } })
    const check = transferCheck({ debts: [chase], target: loc, today: TODAY })
    expect(check.refused).toBeNull()
    expect(check.roomCents).toBe(880000)
    expect(check.result!.deal).toBeNull()
  })

  it('asks for a limit it does not know, and uses one typed for this calculation', () => {
    const chase = debt({ id: 'chase', name: 'Chase' })
    expect(transferCheck({ debts: [chase], target: card({ creditLimitCents: null }), today: TODAY }).refused).toEqual({
      kind: 'needs_limit',
    })
    const typed = transferCheck({ debts: [chase], target: card({ creditLimitCents: null }), today: TODAY, limitCents: 300000 })
    expect(typed.roomCents).toBe(300000)
  })

  it('refuses an offer whose end has passed, and a target already on a deal', () => {
    const chase = debt({ id: 'chase', name: 'Chase' })
    const over = card({ transferOffer: { ...ZERO_FOR_12, months: undefined, untilDate: '2026-09-01' } })
    expect(transferCheck({ debts: [chase], target: over, today: TODAY }).refused!.kind).toBe('offer_over')
    const dealing = card({
      balanceCents: 100000,
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-03-01' }],
    })
    expect(transferCheck({ debts: [chase], target: dealing, today: TODAY }).refused!.kind).toBe('on_deal')
  })

  it('freed payment is nothing when a source on a planned payment moves only part', () => {
    const big = debt({ id: 'big', name: 'Big', balanceCents: 2000000, plannedPaymentCents: 40000 })
    const check = transferCheck({ debts: [big], target: card(), today: TODAY, amountCents: 300000 })
    expect(check.result!.moves[0]!.paymentAfterCents).toBe(40000)
    expect(check.result!.freedPerMonthCents).toBe(0)
  })

  it('compares over ten years when a debt is never paid off on its payment', () => {
    // $10 a month never covers 24.99% on $5,000.
    const stuck = debt({ id: 's', name: 'Stuck', minPaymentRule: { type: 'fixed', amountCents: 1000 } })
    const check = transferCheck({ debts: [stuck], target: card(), today: TODAY })
    expect(check.result!.horizonMonths).toBe(120)
    expect(check.result!.monthsWithout).toBeNull()
  })

  describe('over random households', () => {
    // A small seeded generator, so a failure names its case.
    function rng(seed: number) {
      let s = seed >>> 0
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 2 ** 32
      }
    }
    const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

    function household(seed: number) {
      const r = rng(seed)
      const debts = Array.from({ length: int(r, 1, 3) }, (_, i) =>
        debt({
          id: `d${i}`,
          name: `Debt ${i}`,
          balanceCents: int(r, 50000, 1500000),
          aprBasisPoints: int(r, 900, 2999),
          minPaymentRule:
            r() < 0.5
              ? { type: 'fixed', amountCents: int(r, 5000, 40000) }
              : { type: 'percent_with_floor', basisPoints: 100, floorCents: 2500 },
          plannedPaymentCents: r() < 0.3 ? int(r, 20000, 80000) : null,
        }),
      )
      const offer: TransferOffer = {
        rateBasisPoints: 0,
        months: int(r, 6, 21),
        feeBasisPoints: int(r, 0, 500),
        chargedBack: false,
      }
      const target = card({ creditLimitCents: int(r, 100000, 2500000), aprBasisPoints: int(r, 1999, 2999), transferOffer: offer })
      return { debts, target }
    }

    it('recommends the amount that saves the most, within the room, and never moves a deal', () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        const { debts, target } = household(seed)
        const check = transferCheck({ debts, target, today: TODAY })
        if (!check.result) continue
        const r = check.result
        expect(r.amountCents + r.feeCents, `seed ${seed}`).toBeLessThanOrEqual(check.roomCents!)
        if (check.recommendedCents !== null) {
          for (const amount of [10000, Math.floor(check.mostCents / 2 / 100) * 100, check.mostCents]) {
            if (amount <= 0 || amount > check.mostCents) continue
            const other = transferCheck({ debts, target, today: TODAY, amountCents: amount }).result!
            if (other.horizonMonths !== r.horizonMonths) continue
            if (amount % 10000 === 0 || amount === check.mostCents) {
              expect(r.netSavingsCents, `seed ${seed} amount ${amount}`).toBeGreaterThanOrEqual(other.netSavingsCents)
            }
          }
        }
      }
    })

    it('a free transfer at 0% never costs money', () => {
      for (let seed = 100; seed <= 130; seed += 1) {
        const { debts, target } = household(seed)
        const free = { ...target, aprBasisPoints: 2999, transferOffer: { ...target.transferOffer!, feeBasisPoints: 0, feeMinCents: undefined } }
        const check = transferCheck({ debts, target: free, today: TODAY })
        if (!check.result) continue
        expect(check.result.netSavingsCents, `seed ${seed}`).toBeGreaterThanOrEqual(0)
      }
    })
  })
})

describe('months in words', () => {
  it('says years and months', () => {
    expect(monthsInWords(1)).toBe('1 month')
    expect(monthsInWords(5)).toBe('5 months')
    expect(monthsInWords(12)).toBe('1 year')
    expect(monthsInWords(27)).toBe('2 years 3 months')
  })
})

describe('an offer in words', () => {
  const cents = (c: number) => `$${(c / 100).toFixed(2)}`
  const date = (d: string) => d
  it('says a card deal and a line of credit plainly', () => {
    expect(offerWords({ rateBasisPoints: 0, months: 18, feeBasisPoints: 300, feeMinCents: 500 }, 2624, cents, date)).toBe(
      '0% for 18 months, 3% fee (at least $5.00)',
    )
    expect(offerWords({ rateBasisPoints: 399, untilDate: '2028-03-01', feeBasisPoints: 0 }, 2499, cents, date)).toBe(
      '3.99% until 2028-03-01, no fee',
    )
    expect(offerWords({ feeBasisPoints: 200 }, 899, cents, date)).toBe('8.99% with no end, 2% fee')
  })
})
