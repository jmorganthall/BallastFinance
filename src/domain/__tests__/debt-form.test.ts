import { describe, expect, it } from 'vitest'
import {
  debtFormValuesFrom,
  debtFormValuesOf,
  EMPTY_DEBT_FORM,
  debtLinkSite,
  parseDebtForm,
  parseDebtLink,
  parseTryCard,
  type DebtFormValues,
} from '../debt-form'
import { debtTermsChanged } from '../debt'

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
      paymentDay: null,
      linkUrl: null,
      transferOffer: null,
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
        { rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-03-01', chargedBack: true },
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
      paymentDay: null,
      linkUrl: 'https://www.usbank.com/',
      transferOffer: null,
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

describe('the payment day (D49 (3))', () => {
  const base = {
    ...EMPTY_DEBT_FORM,
    name: 'Shield',
    balance: '6702.39',
    apr: '30.49',
    min_amount: '40',
  }
  it('takes a day of the month, or none', () => {
    const day = parseDebtForm({ ...base, payment_day: '13' })
    expect(day.ok && day.input.paymentDay).toBe(13)
    const none = parseDebtForm({ ...base, payment_day: ' ' })
    expect(none.ok && none.input.paymentDay).toBeNull()
  })
  it('refuses anything that is not a day of the month, next to its box', () => {
    for (const payment_day of ['0', '32', 'the 13th', '1.5']) {
      const result = parseDebtForm({ ...base, payment_day })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.problems.map((p) => p.field)).toEqual(['payment_day'])
    }
  })
})

describe('more about the deal (D49 (9))', () => {
  const base = {
    ...EMPTY_DEBT_FORM,
    name: 'Store card',
    balance: '900',
    apr: '26.99',
    min_amount: '25',
    has_promo: true,
    promo_rate: '0',
    promo_until: '2027-06-30',
  }
  it('a new deal is taken as charged back unless the person says otherwise', () => {
    const yes = parseDebtForm(base)
    expect(yes.ok && yes.input.promoRules[0]).toMatchObject({ chargedBack: true })
    const no = parseDebtForm({ ...base, promo_charged_back: 'no', promo_started: '2026-06-30' })
    expect(no.ok && no.input.promoRules[0]).toMatchObject({ chargedBack: false, startDate: '2026-06-30' })
    const unsure = parseDebtForm({ ...base, promo_charged_back: '' })
    expect(unsure.ok && 'chargedBack' in unsure.input.promoRules[0]!).toBe(false)
  })
  it('a deal must start before it ends', () => {
    const late = parseDebtForm({ ...base, promo_started: '2027-07-01' })
    expect(!late.ok && late.problems.map((p) => p.field)).toEqual(['promo_started'])
  })
})

describe('a link to the lender (D60)', () => {
  const base = { ...EMPTY_DEBT_FORM, name: 'Sapphire', balance: '1200', apr: '24.99', min_amount: '40' }
  it('keeps a web address, takes one typed without https, and none when blank', () => {
    expect(parseDebtLink('https://secure.chase.com/web/auth/dashboard')).toEqual({ ok: true, url: 'https://secure.chase.com/web/auth/dashboard' })
    expect(parseDebtLink('  chase.com/login ')).toEqual({ ok: true, url: 'https://chase.com/login' })
    expect(parseDebtLink('http://card.example.com')).toEqual({ ok: true, url: 'http://card.example.com/' })
    expect(parseDebtLink('')).toEqual({ ok: true, url: null })
    const form = parseDebtForm({ ...base, link: 'www.chase.com' })
    expect(form.ok && form.input.linkUrl).toBe('https://www.chase.com/')
  })
  it('refuses anything that is not a web address, next to its box', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://files.example.com', 'chase', 'two words.com', 'mailto:help@chase.com']) {
      expect(parseDebtLink(link).ok).toBe(false)
      const result = parseDebtForm({ ...base, link })
      expect(!result.ok && result.problems.map((p) => p.field)).toEqual(['link'])
    }
  })
  it('names the site without www, comes back in the edit form, and is a change the history names', () => {
    expect(debtLinkSite('https://www.chase.com/login')).toBe('chase.com')
    expect(debtLinkSite('https://secure.bankofamerica.com/')).toBe('secure.bankofamerica.com')
    const values = debtFormValuesOf({
      name: 'Sapphire',
      category: 'consumer',
      balanceCents: 120000,
      aprBasisPoints: 2499,
      minPaymentRule: { type: 'fixed', amountCents: 4000 },
      promoRules: [],
      linkUrl: 'https://www.chase.com/',
    })
    expect(values.link).toBe('https://www.chase.com/')
    const again = parseDebtForm(values)
    expect(again.ok && again.input.linkUrl).toBe('https://www.chase.com/')
    expect(debtTermsChanged({ link_url: null }, { link_url: 'https://www.chase.com/' })).toEqual(['link'])
  })
})

describe('a transfer offer on the form (D61)', () => {
  const offer = (over: Partial<DebtFormValues> = {}) =>
    filled({ has_offer: true, offer_ends: 'months', offer_rate: '0', offer_months: '18', offer_fee: '3', ...over })
  const fieldsOf = (values: DebtFormValues) => problemsOf(values).map((p) => p.field)

  it('reads a card offer, and gives it back to the boxes', () => {
    const result = parseDebtForm(offer({ offer_fee_min: '5', offer_by: '2026-12-31' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.transferOffer).toEqual({
      rateBasisPoints: 0,
      months: 18,
      feeBasisPoints: 300,
      feeMinCents: 500,
      transferBy: '2026-12-31',
      chargedBack: false,
    })
    const back = debtFormValuesOf({ ...result.input })
    expect(parseDebtForm(back)).toEqual(result)
  })

  it('reads a line of credit as its own rate, with no rate of its own', () => {
    const result = parseDebtForm(offer({ apr: '8.99', offer_ends: 'never', offer_rate: '', offer_fee: '0' }))
    expect(result.ok && result.input.transferOffer).toEqual({ feeBasisPoints: 0 })
  })

  it('puts each problem next to its box', () => {
    expect(fieldsOf(offer({ offer_months: '0' }))).toEqual(['offer_months'])
    expect(fieldsOf(offer({ offer_ends: 'until', offer_until: '' }))).toEqual(['offer_until'])
    expect(fieldsOf(offer({ offer_rate: '21' }))).toEqual(['offer_rate'])
    expect(fieldsOf(offer({ offer_fee: '' }))).toEqual(['offer_fee'])
    expect(fieldsOf(offer({ offer_fee_min: 'lots' }))).toEqual(['offer_fee_min'])
    expect(fieldsOf(offer({ category: 'auto' }))).toEqual(['has_offer'])
  })

  it('carries the boxes through a submitted form', () => {
    const values = offer({ offer_charged_back: 'yes' })
    expect(debtFormValuesFrom((name) => (typeof values[name as keyof DebtFormValues] === 'boolean' ? (values[name as keyof DebtFormValues] ? 'on' : null) : values[name as keyof DebtFormValues]))).toEqual(values)
  })

  it('says when the offer changed in the history', () => {
    expect(debtTermsChanged({ transfer_offer: null }, { transfer_offer: { feeBasisPoints: 300 } })).toEqual(['transfer offer'])
  })
})

describe('try a card (D61)', () => {
  const query = (over: Record<string, string> = {}) => {
    const q: Record<string, string> = {
      apr: '24.99',
      credit_limit: '10000',
      min_type: 'fixed',
      min_amount: '25',
      offer_ends: 'months',
      offer_rate: '0',
      offer_months: '12',
      offer_fee: '3',
      ...over,
    }
    return (name: string) => q[name] ?? null
  }

  it('makes an empty card with the offer, named when no name is typed', () => {
    const tried = parseTryCard(query(), '2026-11-13')
    expect(tried.ok).toBe(true)
    if (!tried.ok) return
    expect(tried.card).toMatchObject({
      name: 'The new card',
      balanceCents: 0,
      creditLimitCents: 1000000,
      transferOffer: { rateBasisPoints: 0, months: 12, feeBasisPoints: 300 },
    })
  })

  it('asks for a minimum payment and a credit limit', () => {
    const noMinimum = parseTryCard(query({ min_amount: '' }), '2026-11-13')
    expect(!noMinimum.ok && noMinimum.problems.map((p) => p.field)).toEqual(['min_amount'])
    const noLimit = parseTryCard(query({ credit_limit: '' }), '2026-11-13')
    expect(!noLimit.ok && noLimit.problems.map((p) => p.field)).toEqual(['credit_limit'])
  })
})
