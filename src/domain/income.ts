/**
 * Income (PRD §14, D10-D11, D52): what each job brings home, worked out from
 * the lines on a real paystub. There is no tax engine: every deduction and
 * every tax is a figure a person read off a stub, and Ballast only adds and
 * subtracts them (D10).
 *
 * It follows the household's income sheet:
 *
 *   gross per check            annual salary / checks a year, or as typed off the stub
 *   - taken out before taxes   benefits, 401k (a percent of the check or dollars), other
 *   = after pre-tax deductions
 *   - taxes                    additional withholding, federal / state / Social Security
 *   = take-home per check
 *
 * and every column the sheet has (a year, a month, twice a month, every two
 * weeks, a week) is the year's figure divided down. A source can instead state
 * only its take-home per check, as the sheet does for one spouse.
 *
 * Bonuses and commission are not planned income (D11): they are a log of what
 * landed. The yearly bonus figure is the sheet's: the log's estimates before
 * tax / the days since the job started x 365. Each payment shows its spending
 * share (a household rule, 20%) and what is left after it.
 *
 * Income rounds down everywhere, so take-home is never overstated.
 */

import { toDayNumber, type CivilDate } from './dates'
import type { Cents } from './money'
import { PERIODS_PER_YEAR, type Frequency } from './recurring'
import type { Id } from './types'

/** One line off a paystub: dollars a check, or a percent of the check's gross in basis points (600 = 6%). */
export interface PaystubLine {
  label: string
  cents?: Cents | null
  percentBasisPoints?: number | null
}

export interface IncomeSource {
  id: Id
  /** Whose income: a household member, or null for someone outside it. */
  personUserId: Id | null
  /** The name shown: the member's first name, or the name typed for someone outside the household. */
  person: string
  name: string
  frequency: Frequency
  /** The day the job started: where the bonus figure counts its days from. */
  startedOn: CivilDate | null
  annualSalaryCents: Cents | null
  /** Gross per check as the stub says, when it differs by a cent from the salary divided down. */
  grossPerCheckCents: Cents | null
  pretax: PaystubLine[]
  taxes: PaystubLine[]
  /** Take-home per check as stated, for a source that gives no stub lines. */
  netPerCheckCents: Cents | null
  /** Of each bonus, the share that goes to spending, basis points (2000 = 20%). */
  spendingShareBasisPoints: number
  state: 'active' | 'ended'
  simplifiNames: string[]
}

/** A bonus or commission payment that landed (an `income_received` fact). */
export interface IncomePayment {
  id: Id
  incomeSourceId: Id
  paidOn: CivilDate
  landedCents: Cents
  /** What it was before tax, as estimated: what the yearly bonus figure adds up. */
  pretaxEstimateCents: Cents | null
  note: string
}

export interface PaycheckLine {
  label: string
  cents: Cents
}

export interface Paycheck {
  /** Null for a source that states only its take-home. */
  grossCents: Cents | null
  pretax: PaycheckLine[]
  afterPretaxCents: Cents | null
  taxes: PaycheckLine[]
  netCents: Cents
}

/** A percent line rounds to the nearest cent, as payroll does; a dollar line is as typed. */
function lineCents(line: PaystubLine, grossCents: Cents): Cents {
  if (line.cents !== null && line.cents !== undefined) return line.cents
  const bp = line.percentBasisPoints ?? 0
  return Math.round((grossCents * bp) / 10000)
}

export function grossPerCheckCents(source: Pick<IncomeSource, 'annualSalaryCents' | 'grossPerCheckCents' | 'frequency'>): Cents | null {
  if (source.grossPerCheckCents !== null) return source.grossPerCheckCents
  if (source.annualSalaryCents === null) return null
  return Math.floor(source.annualSalaryCents / PERIODS_PER_YEAR[source.frequency])
}

/** One check, line by line. */
export function paycheckOf(source: IncomeSource): Paycheck {
  const gross = grossPerCheckCents(source)
  if (gross === null) {
    return { grossCents: null, pretax: [], afterPretaxCents: null, taxes: [], netCents: source.netPerCheckCents ?? 0 }
  }
  const pretax = source.pretax.map((l) => ({ label: l.label, cents: lineCents(l, gross) }))
  const afterPretax = gross - pretax.reduce((s, l) => s + l.cents, 0)
  const taxes = source.taxes.map((l) => ({ label: l.label, cents: lineCents(l, gross) }))
  return {
    grossCents: gross,
    pretax,
    afterPretaxCents: afterPretax,
    taxes,
    netCents: afterPretax - taxes.reduce((s, l) => s + l.cents, 0),
  }
}

/** The sheet's columns, in its order. */
export const INCOME_COLUMNS = ['yearly', 'monthly', 'semimonthly', 'biweekly', 'weekly'] as const
export type IncomeColumn = (typeof INCOME_COLUMNS)[number]

export const INCOME_COLUMN_WORDS: Record<IncomeColumn, string> = {
  yearly: 'A year',
  monthly: 'A month',
  semimonthly: 'Twice a month',
  biweekly: 'Every 2 weeks',
  weekly: 'A week',
}

export type IncomeColumns = Record<IncomeColumn, Cents>

/** A year's figure in every column, each rounded down. */
export function columnsOfYear(yearlyCents: Cents): IncomeColumns {
  return {
    yearly: yearlyCents,
    monthly: Math.floor(yearlyCents / 12),
    semimonthly: Math.floor(yearlyCents / 24),
    biweekly: Math.floor(yearlyCents / 26),
    weekly: Math.floor(yearlyCents / 52),
  }
}

/** The paycheck's lines, each in every column. */
export interface PaycheckColumns {
  pretax: { label: string; cols: IncomeColumns }[]
  afterPretax: IncomeColumns | null
  taxes: { label: string; cols: IncomeColumns }[]
}

export interface SourceView {
  source: IncomeSource
  paycheck: Paycheck
  lines: PaycheckColumns
  /** Gross in every column: the annual salary itself, or the stub's gross per check times the checks when typed. */
  gross: IncomeColumns | null
  /** Take-home in every column: the check times the checks a year, divided down. */
  net: IncomeColumns
  payments: PaymentView[]
  bonus: BonusFigure | null
}

export interface PaymentView {
  payment: IncomePayment
  /** The share that goes to spending, to the nearest cent. */
  spendingCents: Cents
  /** What is left after it. */
  keptCents: Cents
}

export interface BonusFigure {
  /** Days since the job started: what the per-day rate is over. */
  days: number
  /** What the log adds up to: estimates before tax, and what landed. */
  pretaxTotalCents: Cents
  landedTotalCents: Cents
  /** The log's estimates before tax, a year at the rate so far (the sheet's "Comm. / Bonus"). */
  pretaxYearlyCents: Cents
  /** What landed, a year at the same rate: the take-home the bonuses add. */
  landedYearlyCents: Cents
}

export function paymentView(payment: IncomePayment, shareBasisPoints: number): PaymentView {
  const spendingCents = Math.round((payment.landedCents * shareBasisPoints) / 10000)
  return { payment, spendingCents, keptCents: payment.landedCents - spendingCents }
}

/**
 * The bonus figure as the sheet works it out: everything the log adds up to,
 * per day since the job started, times 365. Null with no start date, no
 * payments, or a start date not yet passed.
 */
export function bonusFigure(
  payments: readonly IncomePayment[],
  startedOn: CivilDate | null,
  today: CivilDate,
): BonusFigure | null {
  if (!startedOn || payments.length === 0) return null
  const days = toDayNumber(today) - toDayNumber(startedOn)
  if (days <= 0) return null
  const pretax = payments.reduce((s, p) => s + (p.pretaxEstimateCents ?? 0), 0)
  const landed = payments.reduce((s, p) => s + p.landedCents, 0)
  return {
    days,
    pretaxTotalCents: pretax,
    landedTotalCents: landed,
    pretaxYearlyCents: Math.floor((pretax * 365) / days),
    landedYearlyCents: Math.floor((landed * 365) / days),
  }
}

export function sourceView(source: IncomeSource, payments: readonly IncomePayment[], today: CivilDate): SourceView {
  const paycheck = paycheckOf(source)
  const n = PERIODS_PER_YEAR[source.frequency]
  const mine = payments
    .filter((p) => p.incomeSourceId === source.id)
    .sort((a, b) => (a.paidOn < b.paidOn ? 1 : a.paidOn > b.paidOn ? -1 : 0))
  const year = (cents: Cents) => columnsOfYear(cents * n)
  return {
    source,
    paycheck,
    lines: {
      // A line that comes to nothing is not shown; the paycheck's own sums still count every line.
      pretax: paycheck.pretax.filter((l) => l.cents !== 0).map((l) => ({ label: l.label, cols: year(l.cents) })),
      afterPretax: paycheck.afterPretaxCents === null ? null : year(paycheck.afterPretaxCents),
      taxes: paycheck.taxes.filter((l) => l.cents !== 0).map((l) => ({ label: l.label, cols: year(l.cents) })),
    },
    // The salary as a year, unless the stub's own gross per check was typed: then the checks are the truth.
    gross:
      paycheck.grossCents === null
        ? null
        : columnsOfYear(
            source.grossPerCheckCents === null && source.annualSalaryCents !== null
              ? source.annualSalaryCents
              : paycheck.grossCents * n,
          ),
    net: columnsOfYear(paycheck.netCents * n),
    payments: mine.map((p) => paymentView(p, source.spendingShareBasisPoints)),
    bonus: bonusFigure(mine, source.startedOn, today),
  }
}

export interface PersonIncome {
  person: string
  sources: SourceView[]
  net: IncomeColumns
  /** Take-home plus the bonuses at the rate so far. */
  netWithBonus: IncomeColumns
}

export interface HouseholdIncome {
  people: PersonIncome[]
  net: IncomeColumns
  netWithBonus: IncomeColumns
  /** Whether any bonus is counted in `netWithBonus`. */
  hasBonus: boolean
}

/** Every live source, grouped by person, with the combined take-home with and without bonuses. */
export function householdIncome(
  sources: readonly IncomeSource[],
  payments: readonly IncomePayment[],
  today: CivilDate,
): HouseholdIncome {
  const views = sources.filter((s) => s.state === 'active').map((s) => sourceView(s, payments, today))
  const people = new Map<string, SourceView[]>()
  for (const v of views) people.set(v.source.person, [...(people.get(v.source.person) ?? []), v])

  const yearly = (vs: readonly SourceView[], withBonus: boolean) =>
    vs.reduce((sum, v) => sum + v.net.yearly + (withBonus ? (v.bonus?.landedYearlyCents ?? 0) : 0), 0)

  const personList: PersonIncome[] = [...people.entries()].map(([person, vs]) => ({
    person,
    sources: vs,
    net: columnsOfYear(yearly(vs, false)),
    netWithBonus: columnsOfYear(yearly(vs, true)),
  }))
  return {
    people: personList,
    net: columnsOfYear(yearly(views, false)),
    netWithBonus: columnsOfYear(yearly(views, true)),
    hasBonus: views.some((v) => (v.bonus?.landedYearlyCents ?? 0) > 0),
  }
}

/** How a household member is named on Income: the first word of their name, else their email before the "@". */
export function memberFirstName(member: { displayName: string | null; email: string }): string {
  const first = member.displayName?.trim().split(/\s+/)[0]
  return first || member.email.split('@')[0] || member.email
}

/** Plain-words check of a source a person is saving, or null when it is fine. */
export function incomeSourceProblem(
  source: Pick<IncomeSource, 'person' | 'personUserId' | 'name' | 'annualSalaryCents' | 'grossPerCheckCents' | 'netPerCheckCents' | 'spendingShareBasisPoints' | 'pretax' | 'taxes'>,
): string | null {
  if (source.personUserId === null && !source.person.trim()) {
    return 'Say whose income this is: pick one of us, or type their name.'
  }
  if (!source.name.trim()) return 'Give it a name, such as the employer.'
  const hasGross = source.annualSalaryCents !== null || source.grossPerCheckCents !== null
  if (!hasGross && source.netPerCheckCents === null) {
    return 'Give the annual salary (with the paystub lines), or just the take-home per check.'
  }
  for (const v of [source.annualSalaryCents, source.grossPerCheckCents, source.netPerCheckCents]) {
    if (v !== null && v < 0) return 'Amounts cannot be below zero.'
  }
  for (const line of [...source.pretax, ...source.taxes]) {
    if ((line.cents ?? 0) < 0 || (line.percentBasisPoints ?? 0) < 0) return 'Paystub lines are amounts taken out, so never below zero.'
  }
  if (source.spendingShareBasisPoints < 0 || source.spendingShareBasisPoints > 10000) {
    return 'The spending share is a percent from 0 to 100.'
  }
  return null
}
