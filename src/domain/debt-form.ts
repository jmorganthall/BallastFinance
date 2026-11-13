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
import {
  DebtDataError,
  MAX_OFFER_MONTHS,
  validateTransferOffer,
  type Debt,
  type DebtCategory,
  type MinPaymentRule,
  type PromoRule,
  type TransferOffer,
} from './debt'

/** Exactly what the form's boxes hold, as typed. */
export interface DebtFormValues {
  name: string
  category: string
  balance: string
  apr: string
  credit_limit: string
  /** What the household actually pays each month, blank for "just the minimum". */
  monthly_payment: string
  /** The day of the month the payment goes out, blank for none (D49 (3)). */
  payment_day: string
  min_type: string
  min_amount: string
  min_percent: string
  min_floor: string
  has_promo: boolean
  promo_rate: string
  promo_until: string
  /** 'yes', 'no', or '' for not sure yet (taken as yes; D49 (9)). */
  promo_charged_back: string
  /** When the deal started, blank for the day the debt was entered. */
  promo_started: string
  /** Where to go to see or pay it: the lender's site, blank for none (D60). */
  link: string
  /** A standing offer to move money onto it (D61). */
  has_offer: boolean
  /** 'months' from the transfer, 'until' a date, or 'never' (a line of credit's own rate). */
  offer_ends: string
  offer_rate: string
  offer_months: string
  offer_until: string
  /** The fee, a percentage of what is moved. */
  offer_fee: string
  /** The least the fee can be, blank for none. */
  offer_fee_min: string
  /** The last day to transfer, blank for none said. */
  offer_by: string
  /** 'no' or 'yes': is interest charged back if it is not cleared in time. */
  offer_charged_back: string
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
  plannedPaymentCents: Cents | null
  paymentDay: number | null
  /** The lender's page for this debt, an http(s) address, or null (D60). */
  linkUrl: string | null
  /** A standing offer to move money onto it, or null (D61). */
  transferOffer: TransferOffer | null
}

export const EMPTY_DEBT_FORM: DebtFormValues = {
  name: '',
  category: 'consumer',
  balance: '',
  apr: '',
  credit_limit: '',
  monthly_payment: '',
  payment_day: '',
  min_type: 'fixed',
  min_amount: '',
  min_percent: '',
  min_floor: '',
  has_promo: false,
  promo_rate: '',
  promo_until: '',
  promo_charged_back: 'yes',
  promo_started: '',
  link: '',
  has_offer: false,
  offer_ends: 'months',
  offer_rate: '',
  offer_months: '',
  offer_until: '',
  offer_fee: '',
  offer_fee_min: '',
  offer_by: '',
  offer_charged_back: 'no',
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

  const monthlyRaw = values.monthly_payment.trim()
  const plannedPaymentCents = monthlyRaw === '' ? null : parseAmountOrNull(monthlyRaw)
  if (monthlyRaw !== '' && plannedPaymentCents === null) {
    problem('monthly_payment', 'That did not look like an amount. Leave it blank if you just pay the minimum.')
  } else if (plannedPaymentCents !== null && plannedPaymentCents < 0) {
    problem('monthly_payment', 'What you pay each month cannot be negative.')
  }

  const dayRaw = values.payment_day.trim()
  const paymentDay = dayRaw === '' ? null : /^\d{1,2}$/.test(dayRaw) ? Number(dayRaw) : NaN
  if (paymentDay !== null && !(paymentDay >= 1 && paymentDay <= 31)) {
    problem('payment_day', 'Enter the day of the month it goes out, 1 to 31, or leave it blank.')
  }

  const link = parseDebtLink(values.link)
  if (!link.ok) problem('link', link.message)

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
    const startedRaw = values.promo_started.trim()
    let startDate: CivilDate | undefined
    if (startedRaw) {
      try {
        assertCivilDate(startedRaw)
        startDate = startedRaw
        if (validUntil && startedRaw >= validUntil) {
          problem('promo_started', 'The deal has to start before it ends.')
        }
      } catch {
        problem('promo_started', 'That is not a real date.')
      }
    }
    const chargedBack =
      values.promo_charged_back === 'yes' ? true : values.promo_charged_back === 'no' ? false : undefined
    if (rateBasisPoints !== null && rateBasisPoints >= 0 && validUntil) {
      promoRules.push({
        rateBasisPoints,
        appliesTo: 'full',
        untilDate: validUntil,
        ...(chargedBack === undefined ? {} : { chargedBack }),
        ...(startDate ? { startDate } : {}),
      })
    }
  }

  const transferOffer = values.has_offer ? parseOffer(values, aprBasisPoints, category, problem) : null

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
      // Zero means the same as blank: nothing beyond the minimum.
      plannedPaymentCents: plannedPaymentCents ? plannedPaymentCents : null,
      paymentDay,
      linkUrl: link.ok ? link.url : null,
      transferOffer,
    },
  }
}

/** The offer's boxes (D61), each problem next to its box; null when any is wrong. */
function parseOffer(
  values: DebtFormValues,
  aprBasisPoints: number | null,
  category: DebtCategory | null,
  problem: (field: DebtFormField, message: string) => void,
): TransferOffer | null {
  let ok = true
  const fail = (field: DebtFormField, message: string) => {
    ok = false
    problem(field, message)
  }
  if (category !== null && category !== 'consumer') {
    fail('has_offer', 'Only a credit card or a line of credit can carry a transfer offer.')
  }
  const offer: TransferOffer = { feeBasisPoints: 0 }
  const ends = values.offer_ends
  if (ends === 'months' || ends === 'until') {
    const rate = parsePercentOrNull(values.offer_rate.trim() === '' ? '0' : values.offer_rate)
    if (rate === null || rate < 0) fail('offer_rate', 'Enter the rate on what is moved, like 0 or 3.99.')
    else if (aprBasisPoints !== null && rate >= aprBasisPoints) {
      fail('offer_rate', 'The offer has to be lower than the interest rate above, the rate it goes back to.')
    } else offer.rateBasisPoints = rate
    if (ends === 'months') {
      const raw = values.offer_months.trim()
      const months = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN
      if (!(months >= 1 && months <= MAX_OFFER_MONTHS)) fail('offer_months', `Enter how many months it lasts, 1 to ${MAX_OFFER_MONTHS}.`)
      else offer.months = months
    } else {
      const until = civilOrNull(values.offer_until)
      if (!until) fail('offer_until', 'Enter the date the offer\'s rate ends.')
      else offer.untilDate = until
    }
    offer.chargedBack = values.offer_charged_back === 'yes'
  } else if (ends !== 'never') {
    fail('offer_ends', 'Pick how long the offer lasts.')
  }

  const fee = parsePercentOrNull(values.offer_fee)
  if (fee === null || fee < 0 || fee > 2000) fail('offer_fee', 'Enter the fee as a percentage, like 3, or 0 for none.')
  else offer.feeBasisPoints = fee
  const minRaw = values.offer_fee_min.trim()
  if (minRaw !== '') {
    const min = parseAmountOrNull(minRaw)
    if (min === null || min < 0) fail('offer_fee_min', 'That did not look like an amount. Leave it blank if there is none.')
    else if (min > 0) offer.feeMinCents = min
  }
  if (values.offer_by.trim() !== '') {
    const by = civilOrNull(values.offer_by)
    if (!by) fail('offer_by', 'That is not a real date.')
    else offer.transferBy = by
  }
  if (!ok || aprBasisPoints === null || category === null) return null
  try {
    validateTransferOffer(offer, aprBasisPoints, category)
  } catch (error) {
    if (error instanceof DebtDataError) {
      problem('has_offer', error.message)
      return null
    }
    throw error
  }
  return offer
}

function civilOrNull(raw: string): CivilDate | null {
  const typed = raw.trim()
  if (!typed) return null
  try {
    assertCivilDate(typed)
    return typed
  } catch {
    return null
  }
}

/** The name an imagined card goes by when none is typed. */
export const TRY_A_CARD_NAME = 'The new card'

/**
 * "Try a card" (D61): a card or line of credit that is not in Ballast, typed
 * to see what moving money onto it would do. The same boxes and checks as the
 * debt form, with no balance and an offer it must have; a credit limit is
 * needed, since the room is what decides how much can move. Nothing is
 * stored: the result is a debt for `transferCheck` alone.
 */
export function parseTryCard(
  get: (name: string) => unknown,
  today: CivilDate,
): { ok: true; card: Debt; values: DebtFormValues } | { ok: false; problems: DebtFormProblem[]; values: DebtFormValues } {
  const typed = debtFormValuesFrom(get)
  const values: DebtFormValues = {
    ...typed,
    name: typed.name.trim() || TRY_A_CARD_NAME,
    category: 'consumer',
    balance: '0',
    has_promo: false,
    has_offer: true,
    link: '',
  }
  const parsed = parseDebtForm(values)
  const problems = parsed.ok ? [] : [...parsed.problems]
  if (parsed.ok && parsed.input.creditLimitCents === null) {
    problems.push({ field: 'credit_limit', message: 'Enter the credit limit: it decides how much can move.' })
  }
  if (!parsed.ok || problems.length > 0) return { ok: false, problems, values }
  const input = parsed.input
  return {
    ok: true,
    values,
    card: {
      id: 'try-a-card',
      householdId: '',
      name: input.name,
      category: 'consumer',
      balanceCents: 0,
      balanceAsOf: today,
      aprBasisPoints: input.aprBasisPoints,
      promoRules: [],
      minPaymentRule: input.minPaymentRule,
      creditLimitCents: input.creditLimitCents,
      plannedPaymentCents: input.plannedPaymentCents,
      transferOffer: input.transferOffer,
      fixedPayment: false,
      state: 'open',
    },
  }
}

/**
 * A debt's link as typed (D60): blank is none; an address with no scheme
 * ("chase.com/login") is taken as https; only a web address is kept, so a
 * stored link can never run anything when it is opened.
 */
export function parseDebtLink(raw: string): { ok: true; url: string | null } | { ok: false; message: string } {
  const typed = raw.trim()
  if (typed === '') return { ok: true, url: null }
  const bad = { ok: false as const, message: 'Enter the web address, like https://www.chase.com, or leave it blank.' }
  if (typed.length > 2000 || /\s/.test(typed)) return bad
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return bad
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return bad
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return bad
  return { ok: true, url: url.href }
}

/** How a debt's link is said on screen: its site, without "www.", like "chase.com". */
export function debtLinkSite(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** A stored debt, as the boxes would show it: the inverse of parseDebtForm. */
export function debtFormValuesOf(debt: {
  name: string
  category: DebtCategory
  balanceCents: Cents
  aprBasisPoints: number
  minPaymentRule: MinPaymentRule
  promoRules: readonly PromoRule[]
  creditLimitCents?: Cents | null
  plannedPaymentCents?: Cents | null
  paymentDay?: number | null
  linkUrl?: string | null
  transferOffer?: TransferOffer | null
}): DebtFormValues {
  const dollars = (cents: Cents) => (cents / 100).toFixed(2)
  const percent = (basisPoints: number) => (basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')
  const rule = debt.minPaymentRule
  const promo = debt.promoRules[0]
  return {
    name: debt.name,
    category: debt.category,
    balance: dollars(debt.balanceCents),
    apr: percent(debt.aprBasisPoints),
    credit_limit: debt.creditLimitCents ? dollars(debt.creditLimitCents) : '',
    monthly_payment: debt.plannedPaymentCents ? dollars(debt.plannedPaymentCents) : '',
    payment_day: debt.paymentDay ? String(debt.paymentDay) : '',
    min_type: rule.type,
    min_amount: rule.type === 'fixed' ? dollars(rule.amountCents) : '',
    min_percent: rule.type === 'fixed' ? '' : percent(rule.basisPoints),
    min_floor: rule.type === 'percent_with_floor' ? dollars(rule.floorCents) : '',
    has_promo: promo !== undefined,
    promo_rate: promo ? percent(promo.rateBasisPoints) : '',
    promo_until: promo?.untilDate ?? '',
    promo_charged_back: promo?.chargedBack === true ? 'yes' : promo?.chargedBack === false ? 'no' : promo ? '' : 'yes',
    promo_started: promo?.startDate ?? '',
    link: debt.linkUrl ?? '',
    ...offerValuesOf(debt.transferOffer ?? null),
  }
}

function offerValuesOf(offer: TransferOffer | null): Pick<
  DebtFormValues,
  'has_offer' | 'offer_ends' | 'offer_rate' | 'offer_months' | 'offer_until' | 'offer_fee' | 'offer_fee_min' | 'offer_by' | 'offer_charged_back'
> {
  const percent = (basisPoints: number) => (basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')
  if (!offer) {
    const { has_offer, offer_ends, offer_rate, offer_months, offer_until, offer_fee, offer_fee_min, offer_by, offer_charged_back } =
      EMPTY_DEBT_FORM
    return { has_offer, offer_ends, offer_rate, offer_months, offer_until, offer_fee, offer_fee_min, offer_by, offer_charged_back }
  }
  return {
    has_offer: true,
    offer_ends: offer.months !== undefined ? 'months' : offer.untilDate !== undefined ? 'until' : 'never',
    offer_rate: offer.rateBasisPoints !== undefined ? percent(offer.rateBasisPoints) : '',
    offer_months: offer.months !== undefined ? String(offer.months) : '',
    offer_until: offer.untilDate ?? '',
    offer_fee: percent(offer.feeBasisPoints),
    offer_fee_min: offer.feeMinCents ? (offer.feeMinCents / 100).toFixed(2) : '',
    offer_by: offer.transferBy ?? '',
    offer_charged_back: offer.chargedBack ? 'yes' : 'no',
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
    monthly_payment: text('monthly_payment'),
    payment_day: text('payment_day'),
    min_type: text('min_type') || 'fixed',
    min_amount: text('min_amount'),
    min_percent: text('min_percent'),
    min_floor: text('min_floor'),
    has_promo: flag('has_promo'),
    promo_rate: text('promo_rate'),
    promo_until: text('promo_until'),
    promo_charged_back: text('promo_charged_back'),
    promo_started: text('promo_started'),
    link: text('link'),
    has_offer: flag('has_offer'),
    offer_ends: text('offer_ends') || 'months',
    offer_rate: text('offer_rate'),
    offer_months: text('offer_months'),
    offer_until: text('offer_until'),
    offer_fee: text('offer_fee'),
    offer_fee_min: text('offer_fee_min'),
    offer_by: text('offer_by'),
    offer_charged_back: text('offer_charged_back') || 'no',
  }
}
