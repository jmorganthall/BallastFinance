import { describe, expect, it } from 'vitest'
import {
  bonusFigure,
  householdIncome,
  incomeSourceProblem,
  paycheckOf,
  paymentView,
  sourceView,
  type IncomePayment,
  type IncomeSource,
} from '@/domain'

/**
 * Made-up figures in the shape of the household's income sheet: a salaried
 * job paid every two weeks with its paystub lines, one paid twice a month
 * given only as take-home, and a log of bonuses.
 */
const salaried: IncomeSource = {
  id: 'a',
  person: 'Alex',
  name: 'Acme',
  frequency: 'biweekly',
  startedOn: '2025-01-01',
  annualSalaryCents: 13_000_000, // $130,000
  grossPerCheckCents: null,
  pretax: [
    { label: 'Benefits', cents: 40_000 },
    { label: '401k', percentBasisPoints: 600 },
    { label: 'Other', cents: 500 },
  ],
  taxes: [
    { label: 'Additional withholding', cents: 10_000 },
    { label: 'Federal / State / SS', cents: 120_000 },
  ],
  netPerCheckCents: null,
  spendingShareBasisPoints: 2000,
  state: 'active',
  simplifiNames: [],
}

const netOnly: IncomeSource = {
  ...salaried,
  id: 'b',
  person: 'Sam',
  name: 'Beta',
  frequency: 'semimonthly',
  annualSalaryCents: null,
  pretax: [],
  taxes: [],
  netPerCheckCents: 250_000,
}

describe('one paycheck', () => {
  it('works down from gross to take-home line by line', () => {
    const check = paycheckOf(salaried)
    // $130,000 / 26 = $5,000.00; 6% of it is $300.00.
    expect(check.grossCents).toBe(500_000)
    expect(check.pretax.map((l) => l.cents)).toEqual([40_000, 30_000, 500])
    expect(check.afterPretaxCents).toBe(500_000 - 70_500)
    expect(check.netCents).toBe(500_000 - 70_500 - 130_000)
  })

  it('rounds the salary divided down, unless the stub says otherwise', () => {
    // $100,000 / 26 = $3,846.1538...
    const odd = { ...salaried, annualSalaryCents: 10_000_000, pretax: [], taxes: [] }
    expect(paycheckOf(odd).grossCents).toBe(384_615)
    expect(paycheckOf({ ...odd, grossPerCheckCents: 384_616 }).grossCents).toBe(384_616)
    // The columns follow the stub's check, not the salary, once it is typed.
    expect(sourceView({ ...odd, grossPerCheckCents: 384_616 }, [], '2026-10-19').gross!.biweekly).toBe(384_616)
    expect(sourceView(odd, [], '2026-10-19').gross!.yearly).toBe(10_000_000)
  })

  it('rounds a percent line to the nearest cent, as payroll does', () => {
    const odd = { ...salaried, annualSalaryCents: 10_000_000, pretax: [{ label: '401k', percentBasisPoints: 600 }], taxes: [] }
    // 6% of $3,846.15 is $230.769.
    expect(paycheckOf(odd).pretax[0]!.cents).toBe(23_077)
  })

  it('takes a take-home-only source at its word', () => {
    expect(paycheckOf(netOnly)).toEqual({ grossCents: null, pretax: [], afterPretaxCents: null, taxes: [], netCents: 250_000 })
  })
})

describe('the columns', () => {
  it("are the year's figure divided down, rounded down", () => {
    const view = sourceView(salaried, [], '2026-10-19')
    expect(view.gross).toEqual({ yearly: 13_000_000, monthly: 1_083_333, semimonthly: 541_666, biweekly: 500_000, weekly: 250_000 })
    const net = 299_500 * 26
    expect(view.net).toEqual({
      yearly: net,
      monthly: Math.floor(net / 12),
      semimonthly: Math.floor(net / 24),
      biweekly: 299_500,
      weekly: Math.floor(net / 52),
    })
  })
})

describe('bonuses', () => {
  const payments: IncomePayment[] = [
    { id: 'p1', incomeSourceId: 'a', paidOn: '2025-05-30', landedCents: 400_000, pretaxEstimateCents: 650_000, note: '' },
    { id: 'p2', incomeSourceId: 'a', paidOn: '2025-08-22', landedCents: 450_000, pretaxEstimateCents: 700_000, note: 'Q2' },
  ]

  it('works out the yearly figure as the sheet does: per day since the start, times 365', () => {
    // 2025-01-01 to 2026-10-18 is 655 days.
    const figure = bonusFigure(payments, '2025-01-01', '2026-10-18')!
    expect(figure.days).toBe(655)
    expect(figure.pretaxYearlyCents).toBe(Math.floor((1_350_000 * 365) / 655))
    expect(figure.landedYearlyCents).toBe(Math.floor((850_000 * 365) / 655))
    expect(bonusFigure(payments, null, '2026-10-18')).toBeNull()
    expect(bonusFigure([], '2025-01-01', '2026-10-18')).toBeNull()
  })

  it('splits each payment into its spending share and what is left', () => {
    // 20% of $4,000.03 is $800.006.
    expect(paymentView({ ...payments[0]!, landedCents: 400_003 }, 2000)).toMatchObject({ spendingCents: 80_001, keptCents: 320_002 })
  })

  it("adds both spouses' take-home, with and without the bonuses", () => {
    const income = householdIncome([salaried, netOnly, { ...netOnly, id: 'c', state: 'ended' }], payments, '2026-10-18')
    expect(income.people.map((p) => p.person)).toEqual(['Alex', 'Sam'])
    const base = 299_500 * 26 + 250_000 * 24
    expect(income.net.yearly).toBe(base)
    expect(income.netWithBonus.yearly).toBe(base + Math.floor((850_000 * 365) / 655))
  })
})

describe('checking a source before it is saved', () => {
  it('asks for a salary or a take-home, in plain words', () => {
    expect(incomeSourceProblem(salaried)).toBeNull()
    expect(incomeSourceProblem({ ...netOnly, netPerCheckCents: null })).toContain('annual salary')
    expect(incomeSourceProblem({ ...salaried, person: ' ' })).toBe('Say whose income this is.')
    expect(incomeSourceProblem({ ...salaried, spendingShareBasisPoints: 12_000 })).toContain('0 to 100')
  })
})
