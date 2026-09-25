/**
 * Equity and the next home (PRD §15).
 *
 * Two questions, both answered from facts the household states: what would
 * selling leave us with, and what house does that buy? The answers are
 * planning figures, not a loan approval -- a lender decides on income and
 * debt-to-income, which nothing here models.
 *
 * Rounding always understates what the household can afford (PRD §15): every
 * monthly cost rounds up, selling and buying costs round up (so what is left
 * rounds down), and the price a payment covers rounds down to $1,000. A figure
 * that tells a family they can afford a house they cannot is the costly error.
 */

import { compareDates, type CivilDate } from './dates'
import { monthlyPaymentCents, type Debt } from './debt'
import { ceilDiv, parseAmountOrNull, parsePercentOrNull, type Cents } from './money'
import type { Id } from './types'

export type AssetKind = 'home' | 'vehicle'
export type AssetState = 'owned' | 'sold'

export interface Asset {
  id: Id
  householdId: Id
  name: string
  kind: AssetKind
  /** What it would sell for, as read off Zillow, KBB or an appraisal. */
  valueCents: Cents
  valueAsOf: CivilDate
  /** What selling takes off the top: agent, closing, fees. 700 = 7%. */
  sellingCostBasisPoints: number
  state: AssetState
}

export class AssetDataError extends Error {}

const BASIS_POINTS = 10_000

/** What the form offers for a new asset. A stated fact once saved, not a rule. */
export const DEFAULT_SELLING_COST_BASIS_POINTS: Record<AssetKind, number> = {
  home: 700,
  // A KBB trade-in or private-party figure is already what the car would fetch.
  vehicle: 0,
}

/**
 * A home value moves slowly and a car's a little faster, but neither needs a
 * monthly check the way a card balance does. A quarter is long enough to be a
 * nudge rather than a nag.
 */
export const VALUE_STALE_AFTER_DAYS = 90

export function validateAssetInputs(input: { valueCents: Cents; sellingCostBasisPoints: number }): void {
  if (!Number.isInteger(input.valueCents) || input.valueCents < 0) {
    throw new AssetDataError('What it is worth must be zero or more.')
  }
  if (
    !Number.isInteger(input.sellingCostBasisPoints) ||
    input.sellingCostBasisPoints < 0 ||
    input.sellingCostBasisPoints > 5000
  ) {
    throw new AssetDataError('The cost of selling must be between 0% and 50%.')
  }
}

export function valueFreshness(
  asset: Pick<Asset, 'valueAsOf' | 'state'>,
  today: CivilDate,
  staleAfterDays: number = VALUE_STALE_AFTER_DAYS,
): { ageDays: number; stale: boolean } {
  const ageDays = Math.max(0, compareDates(today, asset.valueAsOf))
  return { ageDays, stale: asset.state === 'owned' && ageDays > staleAfterDays }
}

// ---------------------------------------------------------------- equity

export interface AssetEquity {
  asset: Asset
  /** Open debts secured on this asset. */
  debts: Debt[]
  sellingCostCents: Cents
  owedCents: Cents
  /** Value, less selling costs, less what is owed. Negative = underwater. */
  walkAwayCents: Cents
  /** Positive equity on an owned asset counts toward a down payment (PRD D15). */
  counted: boolean
}

export interface EquityPosition {
  assets: AssetEquity[]
  /** What selling every counted asset would leave: the down-payment pot. */
  countedCents: Cents
  /**
   * Home and car loans not linked to anything. Each one is a debt that SHOULD
   * be subtracted from some asset and is not, so the pot above is too big by
   * up to its balance. The screen must say so rather than show a confident,
   * inflated figure.
   */
  unlinkedSecuredDebts: Debt[]
}

export function sellingCostCents(asset: Pick<Asset, 'valueCents' | 'sellingCostBasisPoints'>): Cents {
  return ceilDiv(asset.valueCents * asset.sellingCostBasisPoints, BASIS_POINTS)
}

export function assetEquity(asset: Asset, debts: readonly Debt[]): AssetEquity {
  const secured = debts.filter((d) => d.state === 'open' && d.assetId === asset.id)
  const owedCents = secured.reduce((sum, d) => sum + d.balanceCents, 0)
  const selling = sellingCostCents(asset)
  const walkAwayCents = asset.valueCents - selling - owedCents
  return {
    asset,
    debts: secured,
    sellingCostCents: selling,
    owedCents,
    walkAwayCents,
    counted: asset.state === 'owned' && walkAwayCents > 0,
  }
}

export function equityPosition(assets: readonly Asset[], debts: readonly Debt[]): EquityPosition {
  const owned = assets.filter((a) => a.state === 'owned')
  const rows = owned
    .map((asset) => assetEquity(asset, debts))
    .sort((a, b) => b.walkAwayCents - a.walkAwayCents || a.asset.name.localeCompare(b.asset.name))
  const ownedIds = new Set(owned.map((a) => a.id))
  return {
    assets: rows,
    countedCents: rows.filter((r) => r.counted).reduce((sum, r) => sum + r.walkAwayCents, 0),
    unlinkedSecuredDebts: debts.filter(
      (d) =>
        d.state === 'open' &&
        d.balanceCents > 0 &&
        (d.category === 'mortgage' || d.category === 'auto') &&
        (d.assetId == null || !ownedIds.has(d.assetId)),
    ),
  }
}

// ---------------------------------------------------------------- the next home

export interface HomeBuyingAssumptions {
  /** The full monthly housing payment now. Null: use what the mortgages say. */
  currentHousingPaymentCents: Cents | null
  /** Per year, of the price. 110 = 1.10%. */
  propertyTaxBasisPoints: number
  insuranceCentsPerYear: Cents
  /** Per year, of the loan, only while the loan is over 80% of the price. */
  mortgageInsuranceBasisPoints: number
  hoaCentsPerMonth: Cents
  /** Closing costs on the purchase, of the price, paid from equity first. */
  buyingCostBasisPoints: number
  termMonths: number
}

/**
 * Starting estimates, each shown on screen as an estimate to replace. Property
 * tax in particular varies several-fold by county, and is the assumption most
 * likely to move the answer.
 */
export const DEFAULT_HOME_BUYING: HomeBuyingAssumptions = {
  currentHousingPaymentCents: null,
  propertyTaxBasisPoints: 110,
  insuranceCentsPerYear: 240_000,
  mortgageInsuranceBasisPoints: 50,
  hoaCentsPerMonth: 0,
  buyingCostBasisPoints: 300,
  termMonths: 360,
}

export function validateHomeBuying(a: HomeBuyingAssumptions): void {
  const bp = (n: number, max: number, what: string) => {
    if (!Number.isInteger(n) || n < 0 || n > max) {
      throw new AssetDataError(`${what} must be between 0% and ${max / 100}%.`)
    }
  }
  const cents = (n: number, what: string) => {
    if (!Number.isInteger(n) || n < 0) throw new AssetDataError(`${what} cannot be negative.`)
  }
  bp(a.propertyTaxBasisPoints, 1000, 'Property tax')
  bp(a.mortgageInsuranceBasisPoints, 500, 'Mortgage insurance')
  bp(a.buyingCostBasisPoints, 2000, 'Buying costs')
  cents(a.insuranceCentsPerYear, 'Home insurance')
  cents(a.hoaCentsPerMonth, 'HOA')
  if (a.currentHousingPaymentCents !== null) cents(a.currentHousingPaymentCents, 'The housing payment')
  if (!Number.isInteger(a.termMonths) || a.termMonths < 12 || a.termMonths > 480) {
    throw new AssetDataError('The loan term must be between 1 and 40 years.')
  }
}

/**
 * What the household pays for housing now, when it has not said: every open
 * mortgage's monthly payment (planned, else minimum), the same figure the
 * payoff order uses. Whether that includes tax and insurance depends on how
 * the mortgage was entered, which is why the screen asks.
 */
export function mortgagePaymentsCents(debts: readonly Debt[]): Cents {
  return debts
    .filter((d) => d.state === 'open' && d.category === 'mortgage' && d.balanceCents > 0)
    .reduce((sum, d) => sum + monthlyPaymentCents(d), 0)
}

/**
 * Principal and interest on a level-payment loan, rounded up to the cent:
 * L * r / (1 - (1 + r)^-n). The power has no integer form, so this is the one
 * floating-point step; rounding its result up means any float error can only
 * make the payment a cent high, never low.
 */
export function principalAndInterestCents(loanCents: Cents, rateBasisPoints: number, termMonths: number): Cents {
  if (loanCents <= 0) return 0
  if (termMonths <= 0) throw new AssetDataError('A loan needs a term.')
  if (rateBasisPoints <= 0) return ceilDiv(loanCents, termMonths)
  const r = rateBasisPoints / BASIS_POINTS / 12
  return Math.ceil((loanCents * r) / (1 - Math.pow(1 + r, -termMonths)))
}

export interface HomeCost {
  priceCents: Cents
  /** Closing costs on the purchase, paid from equity before the down payment. */
  buyingCostsCents: Cents
  downPaymentCents: Cents
  /** Down payment as a share of the price, basis points. 2000 = 20%. */
  downPaymentBasisPoints: number
  loanCents: Cents
  principalAndInterestCents: Cents
  propertyTaxCents: Cents
  insuranceCents: Cents
  mortgageInsuranceCents: Cents
  hoaCents: Cents
  /** The full monthly housing payment. */
  totalCents: Cents
  /** Buying costs the equity does not cover: cash the household must find. */
  buyingCostsShortCents: Cents
  /** Equity left after buying outright. Zero unless the loan is zero. */
  leftOverCents: Cents
}

/** What a house at this price would likely cost a month, with the equity as the down payment. */
export function homeCost(args: {
  priceCents: Cents
  equityCents: Cents
  rateBasisPoints: number
  assumptions: HomeBuyingAssumptions
}): HomeCost {
  const { priceCents: price, assumptions: a } = args
  if (!Number.isInteger(price) || price < 0) throw new AssetDataError('A price must be zero or more.')
  const equity = Math.max(0, args.equityCents)

  const buyingCostsCents = ceilDiv(price * a.buyingCostBasisPoints, BASIS_POINTS)
  const afterCosts = equity - buyingCostsCents
  const downPaymentCents = Math.min(price, Math.max(0, afterCosts))
  const loanCents = price - downPaymentCents

  const pi = principalAndInterestCents(loanCents, args.rateBasisPoints, a.termMonths)
  const propertyTaxCents = ceilDiv(price * a.propertyTaxBasisPoints, BASIS_POINTS * 12)
  const insuranceCents = ceilDiv(a.insuranceCentsPerYear, 12)
  // Over 80% of the price, compared in integers: loan / price > 0.8.
  const needsMortgageInsurance = loanCents > 0 && loanCents * 10 > price * 8
  const mortgageInsuranceCents = needsMortgageInsurance
    ? ceilDiv(loanCents * a.mortgageInsuranceBasisPoints, BASIS_POINTS * 12)
    : 0

  return {
    priceCents: price,
    buyingCostsCents,
    downPaymentCents,
    downPaymentBasisPoints: price > 0 ? Math.floor((downPaymentCents * BASIS_POINTS) / price) : 0,
    loanCents,
    principalAndInterestCents: pi,
    propertyTaxCents,
    insuranceCents,
    mortgageInsuranceCents,
    hoaCents: a.hoaCentsPerMonth,
    totalCents: pi + propertyTaxCents + insuranceCents + mortgageInsuranceCents + a.hoaCentsPerMonth,
    buyingCostsShortCents: Math.max(0, -afterCosts),
    leftOverCents: Math.max(0, afterCosts - price),
  }
}

const DOLLAR = 100
const PRICE_STEP_CENTS = 100_000 // $1,000
const PRICE_CAP_CENTS = 10_000_000_000 // $100 million: past any family's search

/**
 * The most house a monthly payment covers, rounded down to $1,000.
 *
 * The monthly cost never falls as the price rises (more tax, a smaller share
 * down, so a bigger loan and, past 80%, mortgage insurance), so the answer is
 * the largest price whose cost fits, found by bisection. Null when even a $0
 * house costs more than the payment -- insurance and HOA alone exceed it.
 */
export function mostHouseForPayment(args: {
  targetMonthlyCents: Cents
  equityCents: Cents
  rateBasisPoints: number
  assumptions: HomeBuyingAssumptions
}): HomeCost | null {
  const cost = (priceCents: Cents) =>
    homeCost({
      priceCents,
      equityCents: args.equityCents,
      rateBasisPoints: args.rateBasisPoints,
      assumptions: args.assumptions,
    })
  const fits = (dollars: number) => cost(dollars * DOLLAR).totalCents <= args.targetMonthlyCents

  if (!fits(0)) return null

  // Whole dollars. Grow the ceiling until it no longer fits, then close in.
  let lo = 0
  let hi = 100_000
  while (fits(hi)) {
    lo = hi
    if (hi * DOLLAR >= PRICE_CAP_CENTS) return cost(PRICE_CAP_CENTS)
    hi = Math.min(hi * 2, PRICE_CAP_CENTS / DOLLAR)
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid
  }

  const rounded = Math.floor((lo * DOLLAR) / PRICE_STEP_CENTS) * PRICE_STEP_CENTS
  return cost(rounded)
}

// ---------------------------------------------------------------- the assumptions form

/** The assumptions as a person types them: dollars, percents and years. */
export interface HomeBuyingFormValues {
  currentHousingPayment: string
  propertyTaxPercent: string
  insurancePerYear: string
  mortgageInsurancePercent: string
  hoaPerMonth: string
  buyingCostPercent: string
  termYears: string
}

/** Cents as a person would type them back into a box: "2400", "2650.5" is never shown, "2650.50" is. */
export const dollarsForInput = (cents: Cents): string => (cents / 100).toFixed(2).replace(/\.00$/, '')
/** Basis points as a typed percent: 110 is "1.1", 700 is "7". */
export const percentForInput = (basisPoints: number): string =>
  (basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')
const dollars = dollarsForInput
const percent = percentForInput

export function homeBuyingFormValuesOf(a: HomeBuyingAssumptions): HomeBuyingFormValues {
  return {
    currentHousingPayment: a.currentHousingPaymentCents === null ? '' : dollars(a.currentHousingPaymentCents),
    propertyTaxPercent: percent(a.propertyTaxBasisPoints),
    insurancePerYear: dollars(a.insuranceCentsPerYear),
    mortgageInsurancePercent: percent(a.mortgageInsuranceBasisPoints),
    hoaPerMonth: dollars(a.hoaCentsPerMonth),
    buyingCostPercent: percent(a.buyingCostBasisPoints),
    termYears: String(a.termMonths / 12),
  }
}

/**
 * Read the form. A blank housing payment means "use what the mortgages say";
 * every other box must hold a number, and says which one when it does not.
 */
export function parseHomeBuyingForm(
  v: HomeBuyingFormValues,
): { ok: true; assumptions: HomeBuyingAssumptions } | { ok: false; message: string } {
  const need = <T>(value: T | null, what: string): T => {
    if (value === null) throw new AssetDataError(`${what} needs a number.`)
    return value
  }
  try {
    const years = v.termYears.trim()
    if (!/^\d{1,2}$/.test(years)) throw new AssetDataError('The loan term needs a whole number of years, like 30.')
    const assumptions: HomeBuyingAssumptions = {
      currentHousingPaymentCents:
        v.currentHousingPayment.trim() === '' ? null : need(parseAmountOrNull(v.currentHousingPayment), 'The housing payment'),
      propertyTaxBasisPoints: need(parsePercentOrNull(v.propertyTaxPercent), 'Property tax'),
      insuranceCentsPerYear: need(parseAmountOrNull(v.insurancePerYear), 'Home insurance'),
      mortgageInsuranceBasisPoints: need(parsePercentOrNull(v.mortgageInsurancePercent), 'Mortgage insurance'),
      hoaCentsPerMonth: v.hoaPerMonth.trim() === '' ? 0 : need(parseAmountOrNull(v.hoaPerMonth), 'HOA'),
      buyingCostBasisPoints: need(parsePercentOrNull(v.buyingCostPercent), 'Buying costs'),
      termMonths: Number(years) * 12,
    }
    validateHomeBuying(assumptions)
    return { ok: true, assumptions }
  } catch (error) {
    if (error instanceof AssetDataError) return { ok: false, message: error.message }
    throw error
  }
}
