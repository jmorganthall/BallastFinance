/**
 * The "add a debt" form, parsed once.
 *
 * The browser runs this before submitting so a slip is caught next to the box
 * it happened in, and the server runs the same function on what arrives so a
 * bypassed browser cannot get junk past it. One validator, two callers: the
 * messages cannot drift apart, and neither side has its own idea of what a
 * rate looks like.
 *
 * Pure: strings in, either a debt input or a list of problems out.
 */

import { assertCivilDate, type CivilDate } from './dates'
import { parseAmountOrNull, parsePercentOrNull, type Cents } from './money'
import type { DebtCategory, MinPaymentRule, PromoRule } from './debt'

/** Exactly what the form's boxes hold, as typed. */
export interface DebtFormValues {
  name: string
  category: string
  balance: string
  apr: string
  credit_limit: string
  min_type: string
  min_amount: string
  min_percent: string
  min_floor: string
  has_promo: boolean
  promo_rate: string
  promo_until: string
}

export type DebtFormField = keyof DebtFormValues

export interface DebtFormProblem {
  field: DebtFormField
  message: string
}

export interface DebtInput {
  name: string
  category: DebtCategory
  balanceCents: Cents
  aprBasisPoints: number
  minPaymentRule: MinPaymentRule
  promoRules: PromoRule[]
  creditLimitCents: Cents | null
}

export const EMPTY_DEBT_FORM: DebtFormValues = {
  name: '',
  category: 'consumer',
  balance: '',
  apr: '',
  credit_limit: '',
  min_type: 'fixed',
  min_amount: '',
  min_percent: '',
  min_floor: '',
  has_promo: false,
  promo_rate: '',
  promo_until: '',
}

const CATEGORIES: readonly DebtCategory[] = ['consumer', 'auto', 'mortgage']

export type DebtFormResult =
  | { ok: true; input: DebtInput }
  | { ok: false; problems: DebtFormProblem[] }

export function parseDebtForm(values: DebtFormValues): DebtFormResult {
  const problems: DebtFormProblem[] = []
  const problem = (field: DebtFormField, message: string) => problems.push({ field, message })

  const name = values.name.trim()
  if (!name) problem('name', 'Give the debt a name.')

  const category = CATEGORIES.includes(values.category as DebtCategory)
    ? (values.category as DebtCategory)
    : null
  if (!category) problem('category', 'Pick what kind of debt this is.')

  const balanceCents = parseAmountOrNull(values.balance)
  if (balanceCents === null) problem('balance', 'Enter the balance owed, like 5000 or 5,000.00.')
  else if (balanceCents < 0) problem('balance', 'A balance cannot be negative.')

  const aprBasisPoints = parsePercentOrNull(values.apr)
  if (aprBasisPoints === null) problem('apr', 'Enter the interest rate as a number, like 24.99.')
  else if (aprBasisPoints < 0) problem('apr', 'An interest rate cannot be negative.')

  const limitRaw = values.credit_limit.trim()
  const creditLimitCents = limitRaw === '' ? null : parseAmountOrNull(limitRaw)
  if (limitRaw !== '' && creditLimitCents === null) {
    problem('credit_limit', 'That did not look like an amount. Leave it blank if there is none.')
  } else if (creditLimitCents !== null && creditLimitCents < 0) {
    problem('credit_limit', 'A credit limit cannot be negative.')
  }

  let minPaymentRule: MinPaymentRule | null = null
  if (values.min_type === 'percent' || values.min_type === 'percent_with_floor') {
    const basisPoints = parsePercentOrNull(values.min_percent)
    if (basisPoints === null || basisPoints <= 0) {
      problem('min_percent', 'Enter the minimum payment percentage, like 2.')
    }
    if (values.min_type === 'percent') {
      if (basisPoints !== null && basisPoints > 0) minPaymentRule = { type: 'percent', basisPoints }
    } else {
      const floorCents = parseAmountOrNull(values.min_floor)
      if (floorCents === null || floorCents < 0) {
        problem('min_floor', 'Enter the amount the minimum never drops below, like 25.')
      }
      if (basisPoints !== null && basisPoints > 0 && floorCents !== null && floorCents >= 0) {
        minPaymentRule = { type: 'percent_with_floor', basisPoints, floorCents }
      }
    }
  } else if (values.min_type === 'fixed') {
    const amountCents = parseAmountOrNull(values.min_amount)
    if (amountCents === null) problem('min_amount', 'Enter the minimum payment each month, like 150.')
    else if (amountCents <= 0) problem('min_amount', 'The minimum payment must be more than zero.')
    else minPaymentRule = { type: 'fixed', amountCents }
  } else {
    problem('min_type', 'Pick how the minimum payment works.')
  }

  const promoRules: PromoRule[] = []
  if (values.has_promo) {
    const rateBasisPoints = parsePercentOrNull(values.promo_rate.trim() === '' ? '0' : values.promo_rate)
    if (rateBasisPoints === null || rateBasisPoints < 0) {
      problem('promo_rate', 'Enter the promotional rate as a number, like 0 or 2.99.')
    }
    const untilDate = values.promo_until.trim()
    let validUntil: CivilDate | null = null
    if (!untilDate) {
      problem('promo_until', 'Enter the date the deal ends.')
    } else {
      try {
        assertCivilDate(untilDate)
        validUntil = untilDate
      } catch {
        problem('promo_until', 'That is not a real date.')
      }
    }
    if (rateBasisPoints !== null && aprBasisPoints !== null && rateBasisPoints >= aprBasisPoints) {
      problem(
        'promo_rate',
        `A promotional rate of ${(rateBasisPoints / 100).toFixed(2)}% is not lower than the normal ` +
          `rate of ${(aprBasisPoints / 100).toFixed(2)}%. Put the rate the debt goes back to in the ` +
          `interest rate field, not the promotional one.`,
      )
    }
    if (rateBasisPoints !== null && rateBasisPoints >= 0 && validUntil) {
      promoRules.push({ rateBasisPoints, appliesTo: 'full', untilDate: validUntil })
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    input: {
      name,
      category: category!,
      balanceCents: balanceCents!,
      aprBasisPoints: aprBasisPoints!,
      minPaymentRule: minPaymentRule!,
      promoRules,
      creditLimitCents,
    },
  }
}

/** Lift a submitted FormData into the same shape the browser validated. */
export function debtFormValuesFrom(get: (name: string) => unknown): DebtFormValues {
  const text = (name: keyof DebtFormValues) => {
    const value = get(name)
    return typeof value === 'string' ? value : ''
  }
  const flag = (name: keyof DebtFormValues) => get(name) === 'on' || get(name) === 'true'
  return {
    name: text('name'),
    category: text('category') || 'consumer',
    balance: text('balance'),
    apr: text('apr'),
    credit_limit: text('credit_limit'),
    min_type: text('min_type') || 'fixed',
    min_amount: text('min_amount'),
    min_percent: text('min_percent'),
    min_floor: text('min_floor'),
    has_promo: flag('has_promo'),
    promo_rate: text('promo_rate'),
    promo_until: text('promo_until'),
  }
}
