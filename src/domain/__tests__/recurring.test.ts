import { describe, expect, it } from 'vitest'
import {
  atFrequency,
  cleanSimplifiNames,
  diffSimplifiPaste,
  parseFrequency,
  parseSimplifiDate,
  parseSimplifiRecurring,
  recurringView,
  type BallastFigures,
  type RecurringItem,
  type SimplifiTarget,
} from '@/domain'

/**
 * A paste in exactly the layout Simplifi's recurring page copies as, with
 * made-up names and figures: the household's real list stays out of the
 * repository. It keeps every shape the real one had -- a card charge, a
 * transfer, money coming in with "+$", a next amount that differs from the
 * usual one, a next date already gone, and every frequency seen.
 */
const PASTE = `Recurring
Bills & Subscriptions

Streaming Co

Next: $15.49 on Oct 26, 2026

Expenses (Joint)

Checking

Entertainment

Subscription

$15.49
Every month

$201.37
Yearly

Store Card (Payment Plan)

Next: $410.00 on Nov 5, 2026

Expenses (Joint)

Checking

Store Card

Transfer

$250.00
Every month

$2,250.00
Yearly

Card Membership

Next: $95.00 on Jan 12, 2027

Travel Card

Credit Card

Fees & Charges

Subscription

$95.00
Every year

$95.00
Yearly

Car Fund

Next: $40.00 on Oct 23, 2026

Expenses (Joint)

Checking

Auto Maintenance

Transfer

$40.00
Every week

$2,040.00
Yearly

Acme Payroll

Next: $2,000.00 on Oct 30, 2026

Expenses (Joint)

Checking

Personal Income

Income

+$2,000.00
Every 2 weeks

+$54,000.00
Yearly

Power Company

Next: $120.00 on Oct 13, 2026

Expenses (Joint)

Checking

Gas & Electric

Bill

$120.00
Every month

$1,440.00
Yearly

College Fund

Next: $50.00 on Nov 5, 2026

Expenses (Joint)

Checking

Kids

Subscription

$50.00
Twice a month

$1,100.00
Yearly
`

describe('reading the Simplifi paste', () => {
  const { rows, problems } = parseSimplifiRecurring(PASTE)

  it('reads every entry and skips the page headings', () => {
    expect(problems).toEqual([])
    expect(rows.map((r) => r.name)).toEqual([
      'Streaming Co',
      'Store Card (Payment Plan)',
      'Card Membership',
      'Car Fund',
      'Acme Payroll',
      'Power Company',
      'College Fund',
    ])
  })

  it('keeps the four attribute lines in their places', () => {
    expect(rows[0]).toEqual({
      name: 'Streaming Co',
      direction: 'out',
      amountCents: 1549,
      frequency: 'monthly',
      nextAmountCents: 1549,
      nextDate: '2026-10-26',
      account: 'Expenses (Joint)',
      accountType: 'Checking',
      category: 'Entertainment',
      kind: 'Subscription',
    })
    // A card charge: its account is the card, not checking.
    expect(rows[2]).toMatchObject({ account: 'Travel Card', accountType: 'Credit Card', category: 'Fees & Charges', frequency: 'yearly' })
  })

  it('keeps the usual amount and the next one apart', () => {
    expect(rows[1]).toMatchObject({ amountCents: 25000, nextAmountCents: 41000, kind: 'Transfer' })
  })

  it('reads "+$" as money coming in', () => {
    expect(rows[4]).toMatchObject({ direction: 'in', amountCents: 200000, frequency: 'biweekly', kind: 'Income' })
  })

  it('takes a next date that has already gone, as Simplifi shows a late bill', () => {
    expect(rows[5]!.nextDate).toBe('2026-10-13')
  })

  it('reads twice a month', () => {
    expect(rows[6]!.frequency).toBe('semimonthly')
  })

  it('says what it could not read, and never guesses', () => {
    const bad = parseSimplifiRecurring('Gym\nNext: $30.00 on Oct 1, 2026\nA\nChecking\nFitness\nBill\n$30.00\nEvery 5 weeks\n')
    expect(bad.rows).toEqual([])
    expect(bad.problems[0]!.message).toContain('Every 5 weeks')
    expect(parseSimplifiRecurring('just some text').problems).toHaveLength(1)
  })

  it('keeps the first of two entries with the same name', () => {
    const twice = parseSimplifiRecurring(PASTE + '\nstreaming co\nNext: $1.00 on Oct 1, 2026\nA\nChecking\nX\nBill\n$1.00\nEvery month\n')
    expect(twice.rows.filter((r) => r.name.toLowerCase() === 'streaming co')).toHaveLength(1)
    expect(twice.problems).toHaveLength(1)
  })

  it('reads dates and frequencies in the words Simplifi uses', () => {
    expect(parseSimplifiDate('Sep 3, 2026')).toBe('2026-09-03')
    expect(parseSimplifiDate('September 3, 2026')).toBe('2026-09-03')
    expect(parseSimplifiDate('Feb 30, 2026')).toBeNull()
    expect(parseFrequency('Every 2 weeks')).toBe('biweekly')
    expect(parseFrequency('Every 3 weeks')).toBeNull()
  })
})

describe('money at another frequency', () => {
  it('rounds money going out up and money coming in down', () => {
    // $40 a week is $173.333... a month.
    expect(atFrequency(4000, 'weekly', 'monthly', 'out')).toBe(17334)
    expect(atFrequency(4000, 'weekly', 'monthly', 'in')).toBe(17333)
    expect(atFrequency(5000, 'semimonthly', 'monthly', 'out')).toBe(10000)
    expect(atFrequency(9500, 'yearly', 'monthly', 'out')).toBe(792)
  })
})

function item(over: Partial<RecurringItem> & { name: string }): RecurringItem {
  return {
    id: over.name,
    source: 'simplifi',
    direction: 'out',
    amountCents: 1000,
    frequency: 'monthly',
    nextAmountCents: null,
    nextDate: null,
    account: 'Expenses (Joint)',
    accountType: 'Checking',
    category: '',
    kind: 'Bill',
    endedOn: null,
    ...over,
  }
}

describe('what a paste changes', () => {
  const { rows } = parseSimplifiRecurring(PASTE)

  it('sorts rows into new, changed, the same, and gone; never touching a hand-added item', () => {
    const items = [
      item({ name: 'streaming co', amountCents: 1549, category: 'Entertainment', kind: 'Subscription', nextDate: '2026-09-26' }),
      item({ name: 'Power Company', amountCents: 11000, category: 'Gas & Electric' }),
      item({ name: 'Old Gym' }),
      item({ name: 'Cash for the sitter', source: 'manual' }),
      item({ name: 'Ended Long Ago', endedOn: '2026-01-01' }),
    ]
    const diff = diffSimplifiPaste(items, rows)
    expect(diff.unchanged.map((u) => u.item.name)).toEqual(['streaming co'])
    expect(diff.changed.map((c) => [c.item.name, c.fields])).toEqual([['Power Company', ['amountCents']]])
    expect(diff.gone.map((g) => g.name)).toEqual(['Old Gym'])
    expect(diff.added.map((a) => a.name)).toEqual([
      'Store Card (Payment Plan)',
      'Card Membership',
      'Car Fund',
      'Acme Payroll',
      'College Fund',
    ])
  })
})

describe('links', () => {
  const targets: SimplifiTarget[] = [
    { kind: 'account', id: 'car', name: 'Auto Maintenance', simplifiNames: ['Car Fund'] },
    { kind: 'account', id: 'gifts', name: 'Gifts', simplifiNames: [] },
    { kind: 'debt', id: 'store', name: 'Store card', simplifiNames: ['Store Card (Payment Plan)'] },
    { kind: 'income', id: 'acme', name: 'Acme', simplifiNames: ['Acme Payroll', 'Acme Bonus Check'] },
  ]

  it('refuses a Simplifi name another target already has, and tidies the list', () => {
    expect(cleanSimplifiNames([' car fund '], { kind: 'account', id: 'gifts' }, targets)).toEqual({
      ok: false,
      problem: '"car fund" is already how Simplifi knows the reserve account "Auto Maintenance".',
    })
    expect(cleanSimplifiNames(['Gifts  And Giving', 'gifts and giving', ''], { kind: 'account', id: 'gifts' }, targets)).toEqual({
      ok: true,
      names: ['Gifts And Giving'],
    })
    // A target keeps its own names.
    expect(cleanSimplifiNames(['Car Fund'], { kind: 'account', id: 'car' }, targets)).toEqual({ ok: true, names: ['Car Fund'] })
  })

  const items = [
    item({ name: 'Car Fund', amountCents: 4000, frequency: 'weekly', kind: 'Transfer' }),
    item({ name: 'Store Card (Payment Plan)', amountCents: 25000, nextAmountCents: 41000 }),
    item({ name: 'Acme Payroll', direction: 'in', amountCents: 200000, frequency: 'biweekly' }),
    item({ name: 'Power Company', amountCents: 12000 }),
    item({ name: 'Gifts', amountCents: 2500, frequency: 'weekly' }),
    item({ name: 'Cash for the sitter', source: 'manual', amountCents: 6000, frequency: 'biweekly' }),
    item({ name: 'Old Gym', endedOn: '2026-10-01' }),
  ]
  const figures: BallastFigures = {
    accountPerWeekCents: new Map([
      ['car', 4500],
      ['gifts', null],
      ['holiday', 3000],
    ]),
    debtPerMonthCents: new Map([['store', 25000]]),
    incomePerCheck: new Map([['acme', { cents: 200000, frequency: 'biweekly' as const }]]),
  }
  const view = recurringView(items, [...targets, { kind: 'account', id: 'holiday', name: 'Holiday', simplifiNames: [] }], figures)

  it('links by Simplifi name, and offers an exact Ballast name', () => {
    const byName = new Map(view.rows.map((r) => [r.item.name, r]))
    expect(byName.get('Car Fund')!.link?.id).toBe('car')
    expect(byName.get('Gifts')!.link).toBeNull()
    expect(byName.get('Gifts')!.suggestion?.id).toBe('gifts')
    expect(byName.has('Old Gym')).toBe(false)
  })

  it("flags where Simplifi differs from Ballast and never on a card's next amount", () => {
    const checks = new Map(view.checks.map((c) => [c.target.id, c]))
    expect(checks.get('car')).toMatchObject({ simplifiYearlyCents: 4000 * 52, ballastYearlyCents: 4500 * 52, differs: true })
    expect(checks.get('store')!.differs).toBe(false)
    expect(checks.get('acme')!.differs).toBe(false)
  })

  it('names an account with a confirmed transfer that Simplifi does not have', () => {
    expect(view.notInSimplifi.map((t) => t.id)).toEqual(['holiday'])
  })

  it("counts every row going out, Ballast's figure for a linked one, and never income", () => {
    // Car Fund at Ballast's $45 a week, the store card at $250, power $120,
    // Gifts $25 a week (no confirmed transfer, so not linked yet: its own
    // figure), the sitter $60 every 2 weeks.
    const yearly = 4500 * 52 + 25000 * 12 + 12000 * 12 + 2500 * 52 + 6000 * 26
    expect(view.outPerMonthCents).toBe(Math.ceil(yearly / 12))
  })
})
