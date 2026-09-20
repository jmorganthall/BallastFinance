import { describe, expect, it } from 'vitest'
import { parseDueEvery, parseSheet, parseSheetDate } from '../sheet-import'

const TODAY = '2026-09-20'
const context = { today: TODAY, existingAccounts: ['Annual Expenses'] }

const EXPENSES = [
  'Account\tIn Simplifi\tExpense\tBracket\tDue Every\tNext Due\tReserved Now\tAmount\tMonthly\tWeekly',
  'Annual Expenses\tYes\tCar insurance\tA\t6 months\t2/15/2027\t$410.00\t$1,230.00\t$205.00\t$47.31',
  'Annual Expenses\tNo\tAmazon Prime\tB\tYear\t8/1/2026\t\t$139.00\t$11.58\t$2.67',
  'Gifts & Giving\tYes\tChristmas\tA\tYear\tDec 19, 2026\t$250\t$1,000\t$83.33\t$19.23',
  'Annual Expenses\tYes\tPassport\tC\tOnce\t2027-03-01\t$0\t$165\t\t',
].join('\n')

const DEBTS = [
  'Loan\tCategory\tFreed Up\tMonthly\tAPR\t%\t$\tPrincipal/Month\tInt/Month\tInterest at Min Pmt\tMonths @ Min\tBalance\tLimit\tUtil\tAs of\tFixed Pmt.\tLong Term\tShort Term\tPriority',
  'US Bank Altitude Reserve (Josh)\tCredit Card\t$72.00\t$72.00\t20.49%\t1%\t$30\t$0.00\t$122.93\t$1,475\t99\t$7,199.66\t$15,000\t48%\t8/1/2026\tN\t0.68\t0.12\t3',
  'Lightstream (Debt Consolidation)\tPersonal Loan\t$526.33\t$526.33\t9.99%\t\t\t$349.12\t$177.21\t$3,401\t46\t$21,283.49\t\t\t9/1/2026\tY\t0.33\t0.41\t1',
  'Honda CR-V\tAuto Loan\t$412.00\t$412.00\t5.99%\t\t$412\t\t\t\t\t$18,400.00\t\t\t\tY\t\t\t2',
].join('\n')

describe('reading the sheet', () => {
  it('reads the dates people actually type', () => {
    expect(parseSheetDate('2027-02-15')).toBe('2027-02-15')
    expect(parseSheetDate('2/15/2027')).toBe('2027-02-15')
    expect(parseSheetDate('2/15/27')).toBe('2027-02-15')
    expect(parseSheetDate('Feb 15, 2027')).toBe('2027-02-15')
    expect(parseSheetDate('15 Feb 2027')).toBe('2027-02-15')
    expect(parseSheetDate('2/30/2027')).toBeNull()
    expect(parseSheetDate('soon')).toBeNull()
    expect(parseSheetDate('')).toBeNull()
  })

  it('reads how often something comes round', () => {
    expect(parseDueEvery('Year')).toEqual({ every: 1, unit: 'year' })
    expect(parseDueEvery('annually')).toEqual({ every: 1, unit: 'year' })
    expect(parseDueEvery('12 months')).toEqual({ every: 12, unit: 'month' })
    expect(parseDueEvery('6 months')).toEqual({ every: 6, unit: 'month' })
    expect(parseDueEvery('Semi-Annual')).toEqual({ every: 6, unit: 'month' })
    expect(parseDueEvery('Quarter')).toEqual({ every: 3, unit: 'month' })
    expect(parseDueEvery('Month')).toEqual({ every: 1, unit: 'month' })
    expect(parseDueEvery('Once')).toBe('once')
    expect(parseDueEvery('')).toBe('once')
    expect(parseDueEvery('every 3 weeks')).toEqual({ every: 3, unit: 'week' })
    expect(parseDueEvery('18 months')).toEqual({ every: 18, unit: 'month' })
    expect(parseDueEvery('2 yrs')).toEqual({ every: 2, unit: 'year' })
    expect(parseDueEvery('when I feel like it')).toBeNull()
  })

  it('reads the sheet\'s day counts as the periods they are', () => {
    // The real column holds days: 7, 14, 90, 183, 365, 730, 1825 -- and one
    // 203 that is nothing in particular.
    expect(parseDueEvery('7')).toEqual({ every: 1, unit: 'week' })
    expect(parseDueEvery('14')).toEqual({ every: 2, unit: 'week' })
    expect(parseDueEvery('21')).toEqual({ every: 3, unit: 'week' })
    expect(parseDueEvery('90')).toEqual({ every: 3, unit: 'month' })
    expect(parseDueEvery('183')).toEqual({ every: 6, unit: 'month' })
    // A year as 365 days would drift a day every leap year; it is a year.
    expect(parseDueEvery('365')).toEqual({ every: 1, unit: 'year' })
    expect(parseDueEvery('730')).toEqual({ every: 2, unit: 'year' })
    expect(parseDueEvery('1825')).toEqual({ every: 5, unit: 'year' })
    expect(parseDueEvery('203')).toEqual({ every: 203, unit: 'day' })
  })

  it('keeps the raw inputs of an expense row and throws the sheet’s own arithmetic away', () => {
    const result = parseSheet(EXPENSES, context)
    expect(result.problems).toEqual([])
    expect(result.ignoredColumns).toEqual(['in simplifi', 'bracket', 'monthly', 'weekly'])
    expect(result.accountsToCreate).toEqual(['Gifts & Giving'])

    const car = result.expenses.find((e) => e.label === 'Car insurance')!
    expect(car).toMatchObject({
      account: 'Annual Expenses',
      amountCents: 123000,
      dueDate: '2027-02-15',
      recurrence: { every: 6, unit: 'month' },
      openingCents: 41000,
      notes: [],
    })

    // A recurring bill whose last date has passed rolls to the next one.
    const prime = result.expenses.find((e) => e.label === 'Amazon Prime')!
    expect(prime.dueDate).toBe('2027-08-01')
    expect(prime.openingCents).toBe(0)
    expect(prime.notes[0]).toMatch(/has passed/)

    const passport = result.expenses.find((e) => e.label === 'Passport')!
    expect(passport.recurrence).toBeNull()
    expect(passport.openingCents).toBe(0)
  })

  it('keeps the raw inputs of a debt row: name, kind, rate, minimum rule, balance, limit, as-of', () => {
    const result = parseSheet(DEBTS, context)
    expect(result.problems).toEqual([])
    expect(result.ignoredColumns).toEqual([
      'freed up',
      'principal/month',
      'int/month',
      'interest at min pmt',
      'months @ min',
      'util',
      'fixed pmt.',
      'long term',
      'short term',
      'priority',
    ])

    const [card, loan, auto] = result.debts
    expect(card).toMatchObject({
      name: 'US Bank Altitude Reserve (Josh)',
      category: 'consumer',
      balanceCents: 719966,
      balanceAsOf: '2026-08-01',
      aprBasisPoints: 2049,
      minPaymentRule: { type: 'percent_with_floor', basisPoints: 100, floorCents: 3000 },
      creditLimitCents: 1500000,
    })
    // No % or $: the Monthly figure is the set payment, and it says so.
    expect(loan).toMatchObject({
      category: 'consumer',
      minPaymentRule: { type: 'fixed', amountCents: 52633 },
      creditLimitCents: null,
      balanceAsOf: '2026-09-01',
    })
    expect(loan!.notes[0]).toMatch(/Monthly figure/)
    expect(auto).toMatchObject({
      category: 'auto',
      minPaymentRule: { type: 'fixed', amountCents: 41200 },
      balanceAsOf: null,
    })
    expect(auto!.notes).toContain('No "As of" date; today will be used.')
  })

  it('takes both tabs in one paste, in either order', () => {
    const result = parseSheet(`${DEBTS}\n\n${EXPENSES}`, context)
    expect(result.expenses).toHaveLength(4)
    expect(result.debts).toHaveLength(3)
  })

  it('accepts commas as well as tabs', () => {
    const csv = [
      'Account,In Simplifi,Expense,Bracket,Due Every,Next Due,Reserved Now,Amount,Monthly,Weekly',
      'Annual Expenses,Yes,"Car insurance, full","A",6 months,2/15/2027,"$410.00","$1,230.00","$205.00","$47.31"',
    ].join('\n')
    const result = parseSheet(csv, context)
    expect(result.problems).toEqual([])
    expect(result.expenses[0]).toMatchObject({ label: 'Car insurance, full', amountCents: 123000 })
  })

  it('names each problem by its line and keeps the good rows', () => {
    const text = [
      'Account\tIn Simplifi\tExpense\tBracket\tDue Every\tNext Due\tReserved Now\tAmount\tMonthly\tWeekly',
      'Annual Expenses\tYes\tGood one\tA\tYear\t3/1/2027\t\t$100\t\t',
      'Annual Expenses\tYes\tUnreadable\tA\twhenever\t3/1/2027\t\t$100\t\t',
      'Annual Expenses\tYes\tPast one-off\tA\tOnce\t3/1/2026\t\t$100\t\t',
      'Annual Expenses\tYes\tNo amount\tA\tYear\t3/1/2027\t\t\t\t',
    ].join('\n')
    const result = parseSheet(text, context)
    expect(result.expenses.map((e) => e.label)).toEqual(['Good one'])
    expect(result.problems.map((p) => p.row)).toEqual([3, 4, 5])
    expect(result.problems[0]!.message).toMatch(/Due Every/)
    expect(result.problems[1]!.message).toMatch(/has passed/)
    expect(result.problems[2]!.message).toMatch(/Amount/)
  })

  it('says so when there is no header at all', () => {
    const result = parseSheet('just some words\nand more', context)
    expect(result.expenses).toEqual([])
    expect(result.problems[0]!.message).toMatch(/before any header/)
  })
})
