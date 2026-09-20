import { describe, expect, it } from 'vitest'
import {
  debtFormValuesFrom,
  debtFormValuesOf,
  EMPTY_DEBT_FORM,
  parseDebtForm,
  type DebtFormValues,
} from '../debt-form'

function filled(over: Partial<DebtFormValues> = {}): DebtFormValues {
  return {
    ...EMPTY_DEBT_FORM,
    name: 'US Bank Altitude Reserve',
    balance: '$7,199.66',
    apr: '20.49',
    credit_limit: '15000',
    min_type: 'percent_with_floor',
    min_percent: '1',
    min_floor: '30',
    ...over,
  }
}

function problemsOf(values: DebtFormValues) {
  const result = parseDebtForm(values)
  return result.ok ? [] : result.problems
}

describe('the add-a-debt form, parsed', () => {
  it('accepts exactly what was typed into the screenshot that failed', () => {
    const result = parseDebtForm(filled())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input).toEqual({
      name: 'US Bank Altitude Reserve',
      category: 'consumer',
      balanceCents: 719966,
      aprBasisPoints: 2049,
      minPaymentRule: { type: 'percent_with_floor', basisPoints: 100, floorCents: 3000 },
      promoRules: [],
      creditLimitCents: 1500000,
      plannedPaymentCents: null,
    })
  })

  it('takes a rate with the percent sign a statement prints', () => {
    expect(parseDebtForm(filled({ apr: '20.49%' })).ok).toBe(true)
  })

  it('names the box each problem belongs to, and reports every problem at once', () => {
    const problems = problemsOf(filled({ name: '  ', balance: 'lots', apr: 'high' }))
    expect(problems.map((p) => p.field)).toEqual(['name', 'balance', 'apr'])
  })

  it('checks the minimum-payment boxes that are actually showing', () => {
    expect(problemsOf(filled({ min_type: 'fixed', min_amount: '' })).map((p) => p.field)).toEqual([
      'min_amount',
    ])
    expect(problemsOf(filled({ min_type: 'fixed', min_amount: '0' }))[0]!.message).toMatch(
      /more than zero/,
    )
    expect(problemsOf(filled({ min_type: 'percent', min_percent: '' })).map((p) => p.field)).toEqual(
      ['min_percent'],
    )
    // A hidden floor box is not a problem when the rule has no floor.
    expect(parseDebtForm(filled({ min_type: 'percent', min_percent: '2', min_floor: '' })).ok).toBe(
      true,
    )
    expect(
      problemsOf(filled({ min_type: 'percent_with_floor', min_floor: '' })).map((p) => p.field),
    ).toEqual(['min_floor'])
  })

  it('refuses negatives with a reason a person can act on', () => {
    expect(problemsOf(filled({ balance: '-5' }))[0]!.message).toMatch(/negative/)
    expect(problemsOf(filled({ apr: '-1' }))[0]!.message).toMatch(/negative/)
    expect(problemsOf(filled({ credit_limit: '-1' }))[0]!.message).toMatch(/negative/)
  })

  it('leaves the credit limit optional', () => {
    const result = parseDebtForm(filled({ credit_limit: '' }))
    expect(result.ok && result.input.creditLimitCents).toBeNull()
    expect(problemsOf(filled({ credit_limit: 'none' })).map((p) => p.field)).toEqual([
      'credit_limit',
    ])
  })

  describe('a promotional rate', () => {
    it('needs an end date, and a blank rate means 0%', () => {
      expect(
        problemsOf(filled({ has_promo: true, promo_rate: '', promo_until: '' })).map((p) => p.field),
      ).toEqual(['promo_until'])

      const result = parseDebtForm(filled({ has_promo: true, promo_rate: '', promo_until: '2027-03-01' }))
      expect(result.ok && result.input.promoRules).toEqual([
        { rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-03-01' },
      ])
    })

    it('rejects an impossible date', () => {
      expect(
        problemsOf(filled({ has_promo: true, promo_until: '2027-02-30' })).map((p) => p.field),
      ).toEqual(['promo_until'])
    })

    it('catches a promo rate that is not actually cheaper, before it reaches the engine', () => {
      const problems = problemsOf(filled({ has_promo: true, promo_rate: '24.99', promo_until: '2027-03-01' }))
      expect(problems).toHaveLength(1)
      expect(problems[0]!.field).toBe('promo_rate')
      expect(problems[0]!.message).toMatch(/not lower than the normal rate of 20.49%/)
    })

    it('is ignored entirely when the box is unticked, whatever the hidden fields hold', () => {
      const result = parseDebtForm(filled({ has_promo: false, promo_rate: 'junk', promo_until: 'junk' }))
      expect(result.ok && result.input.promoRules).toEqual([])
    })
  })

  it('shows a stored debt in the boxes exactly as it would be re-parsed', () => {
    const stored = {
      name: 'US Bank Altitude Reserve',
      category: 'consumer' as const,
      balanceCents: 719966,
      aprBasisPoints: 2049,
      minPaymentRule: { type: 'percent_with_floor' as const, basisPoints: 100, floorCents: 3000 },
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full' as const, untilDate: '2027-03-01' }],
      creditLimitCents: 1500000,
      plannedPaymentCents: null,
    }
    const values = debtFormValuesOf(stored)
    expect(values).toMatchObject({
      balance: '7199.66',
      apr: '20.49',
      credit_limit: '15000.00',
      min_type: 'percent_with_floor',
      min_percent: '1',
      min_floor: '30.00',
      has_promo: true,
      promo_rate: '0',
      promo_until: '2027-03-01',
    })
    const back = parseDebtForm(values)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.input).toEqual({ ...stored, promoRules: stored.promoRules })
  })

  it('round-trips through FormData the way the server sees it', () => {
    const data = new FormData()
    data.set('name', 'Card')
    data.set('category', 'auto')
    data.set('balance', '1200')
    data.set('apr', '6.5%')
    data.set('min_type', 'fixed')
    data.set('min_amount', '250')
    data.set('has_promo', 'on')
    data.set('promo_rate', '0')
    data.set('promo_until', '2027-01-15')

    const values = debtFormValuesFrom((name) => data.get(name))
    expect(values.has_promo).toBe(true)
    expect(values.credit_limit).toBe('')

    const result = parseDebtForm(values)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.category).toBe('auto')
    expect(result.input.aprBasisPoints).toBe(650)
    expect(result.input.minPaymentRule).toEqual({ type: 'fixed', amountCents: 25000 })
    expect(result.input.promoRules[0]!.untilDate).toBe('2027-01-15')
  })
})
