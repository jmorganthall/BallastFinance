import { describe, expect, it } from 'vitest'
import type { Debt } from '../debt'
import {
  AssetDataError,
  DEFAULT_HOME_BUYING,
  assetEquity,
  equityPosition,
  homeCost,
  mortgagePaymentsCents,
  mostHouseForPayment,
  principalAndInterestCents,
  sellingCostCents,
  validateAssetInputs,
  validateHomeBuying,
  valueFreshness,
  type Asset,
  type HomeBuyingAssumptions,
} from '../equity'

const TODAY = '2026-09-23'

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'house',
    householdId: 'h',
    name: 'House',
    kind: 'home',
    valueCents: 50_000_000,
    valueAsOf: TODAY,
    sellingCostBasisPoints: 700,
    state: 'owned',
    ...overrides,
  }
}

function debt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: 'mortgage',
    householdId: 'h',
    name: 'Mortgage',
    category: 'mortgage',
    balanceCents: 30_000_000,
    balanceAsOf: TODAY,
    aprBasisPoints: 350,
    promoRules: [],
    minPaymentRule: { type: 'fixed', amountCents: 250_000 },
    fixedPayment: false,
    state: 'open',
    assetId: 'house',
    ...overrides,
  }
}

const A: HomeBuyingAssumptions = { ...DEFAULT_HOME_BUYING }

describe('principal and interest', () => {
  it('matches the textbook figure, rounded up: $200,000 at 6% over 30 years', () => {
    // $1,199.10 to the nearest cent; the household rule rounds a cost up.
    expect(principalAndInterestCents(20_000_000, 600, 360)).toBe(119_911)
  })

  it('divides evenly at 0%, rounding up', () => {
    expect(principalAndInterestCents(100_001, 0, 10)).toBe(10_001)
  })

  it('is nothing on no loan', () => {
    expect(principalAndInterestCents(0, 650, 360)).toBe(0)
  })
})

describe('the monthly cost of a house', () => {
  it('adds up every part, checked by hand: $400,000 with $100,000 of equity at 6.50%', () => {
    const cost = homeCost({ priceCents: 40_000_000, equityCents: 10_000_000, rateBasisPoints: 650, assumptions: A })
    expect(cost.buyingCostsCents).toBe(1_200_000) // 3% of $400,000
    expect(cost.downPaymentCents).toBe(8_800_000) // $100,000 - $12,000
    expect(cost.loanCents).toBe(31_200_000)
    expect(cost.principalAndInterestCents).toBe(197_206)
    expect(cost.propertyTaxCents).toBe(36_667) // $4,400 a year / 12, up
    expect(cost.insuranceCents).toBe(20_000)
    expect(cost.mortgageInsuranceCents).toBe(0) // 78% loan
    expect(cost.totalCents).toBe(253_873)
    expect(cost.downPaymentBasisPoints).toBe(2200)
  })

  it('adds mortgage insurance under 20% down', () => {
    const cost = homeCost({ priceCents: 30_000_000, equityCents: 3_000_000, rateBasisPoints: 650, assumptions: A })
    expect(cost.loanCents).toBe(27_900_000)
    expect(cost.mortgageInsuranceCents).toBe(11_625) // 0.5% of $279,000 / 12
    expect(cost.totalCents).toBe(176_347 + 11_625 + 27_500 + 20_000)
  })

  it('charges no mortgage insurance at exactly 20% down, and does a cent under', () => {
    const at = homeCost({ priceCents: 10_000_000, equityCents: 2_300_000, rateBasisPoints: 650, assumptions: A })
    expect(at.loanCents).toBe(8_000_000)
    expect(at.mortgageInsuranceCents).toBe(0)
    const under = homeCost({ priceCents: 10_000_000, equityCents: 2_299_999, rateBasisPoints: 650, assumptions: A })
    expect(under.mortgageInsuranceCents).toBeGreaterThan(0)
  })

  it('says what buying costs the equity does not cover, rather than borrowing them', () => {
    const cost = homeCost({ priceCents: 30_000_000, equityCents: 500_000, rateBasisPoints: 650, assumptions: A })
    expect(cost.downPaymentCents).toBe(0)
    expect(cost.loanCents).toBe(30_000_000)
    expect(cost.buyingCostsShortCents).toBe(400_000)
  })

  it('needs no loan when the equity buys it outright', () => {
    const cost = homeCost({ priceCents: 30_000_000, equityCents: 50_000_000, rateBasisPoints: 650, assumptions: A })
    expect(cost.loanCents).toBe(0)
    expect(cost.principalAndInterestCents).toBe(0)
    expect(cost.leftOverCents).toBe(50_000_000 - 30_000_000 - 900_000)
  })

  it('treats underwater equity as none', () => {
    const cost = homeCost({ priceCents: 30_000_000, equityCents: -5_000_000, rateBasisPoints: 650, assumptions: A })
    expect(cost.downPaymentCents).toBe(0)
    expect(cost.buyingCostsShortCents).toBe(900_000)
  })

  it('never costs less as the price goes up', () => {
    let seed = 7
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)
    for (let trial = 0; trial < 50; trial += 1) {
      const equity = Math.floor(rand() * 30_000_000)
      const rate = Math.floor(rand() * 1200)
      let last = -1
      for (let price = 0; price <= 150_000_000; price += 250_000 + Math.floor(rand() * 500_000)) {
        const total = homeCost({ priceCents: price, equityCents: equity, rateBasisPoints: rate, assumptions: A }).totalCents
        expect(total, `equity ${equity} rate ${rate} price ${price}`).toBeGreaterThanOrEqual(last)
        last = total
      }
    }
  })
})

describe('the most house a payment covers', () => {
  it('fits the payment, and the next $1,000 up does not', () => {
    for (const [target, equity, rate] of [
      [253_873, 10_000_000, 650],
      [300_000, 0, 700],
      [450_000, 25_000_000, 612],
      [150_000, 2_000_000, 0],
    ] as const) {
      const best = mostHouseForPayment({ targetMonthlyCents: target, equityCents: equity, rateBasisPoints: rate, assumptions: A })
      expect(best).not.toBeNull()
      expect(best!.totalCents).toBeLessThanOrEqual(target)
      expect(best!.priceCents % 100_000).toBe(0)
      const next = homeCost({ priceCents: best!.priceCents + 100_000, equityCents: equity, rateBasisPoints: rate, assumptions: A })
      expect(next.totalCents, `target ${target}`).toBeGreaterThan(target)
    }
  })

  it('finds the hand-checked house again from its own payment', () => {
    // $2,538.73 buys the $400,000 house above; rounding down to $1,000 lands on it.
    const best = mostHouseForPayment({ targetMonthlyCents: 253_873, equityCents: 10_000_000, rateBasisPoints: 650, assumptions: A })
    expect(best!.priceCents).toBe(40_000_000)
  })

  it('is null when insurance and HOA alone are more than the payment', () => {
    const best = mostHouseForPayment({
      targetMonthlyCents: 10_000,
      equityCents: 10_000_000,
      rateBasisPoints: 650,
      assumptions: { ...A, hoaCentsPerMonth: 5_000 },
    })
    expect(best).toBeNull()
  })

  it('buys less at a higher rate', () => {
    const at = (rate: number) =>
      mostHouseForPayment({ targetMonthlyCents: 300_000, equityCents: 10_000_000, rateBasisPoints: rate, assumptions: A })!.priceCents
    expect(at(700)).toBeLessThan(at(600))
  })
})

describe('equity', () => {
  it('takes selling costs and every secured debt off the value', () => {
    const second = debt({ id: 'heloc', name: 'HELOC', balanceCents: 2_000_000 })
    const row = assetEquity(asset(), [debt(), second])
    expect(row.sellingCostCents).toBe(3_500_000)
    expect(row.owedCents).toBe(32_000_000)
    expect(row.walkAwayCents).toBe(50_000_000 - 3_500_000 - 32_000_000)
    expect(row.counted).toBe(true)
  })

  it('rounds selling costs up, so what is left rounds down', () => {
    expect(sellingCostCents({ valueCents: 1_000_001, sellingCostBasisPoints: 700 })).toBe(70_001)
  })

  it('counts homes and cars with something left, and shows an underwater car without netting it', () => {
    const car = asset({ id: 'car', name: 'Car', kind: 'vehicle', valueCents: 2_000_000, sellingCostBasisPoints: 0 })
    const truck = asset({ id: 'truck', name: 'Truck', kind: 'vehicle', valueCents: 1_500_000, sellingCostBasisPoints: 0 })
    const carLoan = debt({ id: 'car-loan', category: 'auto', balanceCents: 1_200_000, assetId: 'car' })
    const truckLoan = debt({ id: 'truck-loan', category: 'auto', balanceCents: 2_500_000, assetId: 'truck' })
    const position = equityPosition([asset(), car, truck], [debt(), carLoan, truckLoan])
    expect(position.countedCents).toBe(16_500_000 + 800_000)
    expect(position.assets.find((r) => r.asset.id === 'truck')!.counted).toBe(false)
    expect(position.assets.find((r) => r.asset.id === 'truck')!.walkAwayCents).toBe(-1_000_000)
  })

  it('ignores paid-off debts and sold assets', () => {
    const position = equityPosition(
      [asset(), asset({ id: 'old', name: 'Old house', state: 'sold' })],
      [debt({ state: 'paid_off', balanceCents: 0 })],
    )
    expect(position.assets).toHaveLength(1)
    expect(position.countedCents).toBe(46_500_000)
  })

  it('flags home and car loans that are not linked to anything owned', () => {
    const position = equityPosition(
      [asset()],
      [
        debt({ id: 'loose', assetId: null }),
        debt({ id: 'on-sold', assetId: 'gone' }),
        debt({ id: 'card', category: 'consumer', assetId: null }),
      ],
    )
    expect(position.unlinkedSecuredDebts.map((d) => d.id)).toEqual(['loose', 'on-sold'])
  })
})

describe('the current housing payment', () => {
  it('is what goes at each open mortgage', () => {
    expect(
      mortgagePaymentsCents([
        debt(),
        debt({ id: 'm2', plannedPaymentCents: 300_000 }),
        debt({ id: 'car', category: 'auto' }),
        debt({ id: 'old', state: 'paid_off', balanceCents: 0 }),
      ]),
    ).toBe(250_000 + 300_000)
  })
})

describe('checks', () => {
  it('refuses nonsense', () => {
    expect(() => validateAssetInputs({ valueCents: -1, sellingCostBasisPoints: 0 })).toThrow(AssetDataError)
    expect(() => validateAssetInputs({ valueCents: 1, sellingCostBasisPoints: 6000 })).toThrow(AssetDataError)
    expect(() => validateHomeBuying({ ...A, termMonths: 0 })).toThrow(AssetDataError)
    expect(() => validateHomeBuying({ ...A, propertyTaxBasisPoints: -1 })).toThrow(AssetDataError)
    expect(() => validateHomeBuying(A)).not.toThrow()
  })

  it('flags a value older than a quarter', () => {
    expect(valueFreshness({ valueAsOf: '2026-06-01', state: 'owned' }, TODAY).stale).toBe(true)
    expect(valueFreshness({ valueAsOf: '2026-08-01', state: 'owned' }, TODAY).stale).toBe(false)
    expect(valueFreshness({ valueAsOf: '2020-01-01', state: 'sold' }, TODAY).stale).toBe(false)
  })
})

describe('the assumptions form', () => {
  it('round-trips the defaults', async () => {
    const { homeBuyingFormValuesOf, parseHomeBuyingForm } = await import('../equity')
    const values = homeBuyingFormValuesOf(DEFAULT_HOME_BUYING)
    expect(values).toMatchObject({ propertyTaxPercent: '1.1', insurancePerYear: '2400', termYears: '30', currentHousingPayment: '' })
    expect(parseHomeBuyingForm(values)).toEqual({ ok: true, assumptions: DEFAULT_HOME_BUYING })
  })

  it('reads a stated payment, and names the box that is wrong', async () => {
    const { homeBuyingFormValuesOf, parseHomeBuyingForm } = await import('../equity')
    const values = homeBuyingFormValuesOf(DEFAULT_HOME_BUYING)
    const parsed = parseHomeBuyingForm({ ...values, currentHousingPayment: '$2,650.50', termYears: '15' })
    expect(parsed).toMatchObject({ ok: true, assumptions: { currentHousingPaymentCents: 265_050, termMonths: 180 } })
    expect(parseHomeBuyingForm({ ...values, propertyTaxPercent: 'lots' })).toEqual({ ok: false, message: 'Property tax needs a number.' })
    expect(parseHomeBuyingForm({ ...values, termYears: '2.5' })).toMatchObject({ ok: false })
  })
})
