/**
 * The helpers that moved into the domain during the layering work, each
 * tested on its own: the plans list's rows, a debt's current deal and its
 * mark on the payoff chart, the opening a commit shares across parts, what a
 * share-out tops debts up by, and the optimizer seeing debts after it.
 */

import { describe, expect, it } from 'vitest'
import { commitOpenings, debtTopUps } from '../allocation'
import { currentDeal, dealEndMark, type Debt } from '../debt'
import { optimiseLumpSum } from '../optimizer'
import { planRows } from '../plan-order'
import type { PlanPosition } from '../position'
import type { PackageView } from '../rollup'
import type { LineItem, Package } from '../types'

const TODAY = '2026-10-01'

const pkg = (id: string, state: Package['state']): Package => ({
  id,
  householdId: 'hh',
  name: id,
  state,
  module: 'manual',
  detail: null,
  createdAt: '2026-09-01',
  committedAt: state === 'active' ? '2026-09-01' : null,
})
const item = (id: string, packageId: string, dueDate: string, cents: number): LineItem => ({
  id,
  packageId,
  label: id,
  unitAmountCents: cents,
  quantity: 1,
  dueDate,
  reserveAccountId: 'acct',
  state: 'accruing',
  recurrence: null,
  timelineStart: 'commit',
  timelineStartDate: null,
})
const view = (p: Package, items: LineItem[]): PackageView => ({
  package: p,
  items: items.map((lineItem) => ({ lineItem, totalCents: lineItem.unitAmountCents, isOverdue: false })),
  totalCents: items.reduce((t, i) => t + i.unitAmountCents, 0),
})

describe('planRows', () => {
  it("reads a live plan's figures from the position, its next date from the rounds ahead", () => {
    const live = pkg('live', 'active')
    const past = { lineItem: item('old', 'live', '2026-09-20', 5000), round: { past: true }, totalCents: 5000 }
    const ahead = { lineItem: item('next', 'live', '2026-12-01', 8000), round: { past: false }, totalCents: 8000 }
    const plan = {
      package: live,
      parts: [past, ahead],
      totalCents: 8000,
      steadyPerWeekCents: 900,
      shortByCents: 0,
    } as unknown as PlanPosition
    const [row] = planRows({ views: [view(live, [past.lineItem, ahead.lineItem])], plans: [plan], today: TODAY })
    // The round still open past its date never holds the plan back.
    expect(row).toMatchObject({ nextDue: '2026-12-01', perWeekCents: 900, totalCents: 8000, shortByCents: 0 })
  })

  it('gives a draft its own cost and no weekly figure, and a done plan no date', () => {
    const draft = pkg('draft', 'simulated')
    const done = pkg('done', 'retired')
    const rows = planRows({
      views: [view(draft, [item('a', 'draft', '2026-11-01', 3000)]), view(done, [item('b', 'done', '2026-11-01', 4000)])],
      plans: [],
      today: TODAY,
    })
    expect(rows.map((r) => [r.name, r.nextDue, r.perWeekCents, r.totalCents])).toEqual([
      ['draft', '2026-11-01', null, 3000],
      ['done', null, null, 4000],
    ])
  })
})

const debt = (over: Partial<Debt> = {}): Debt => ({
  id: 'card',
  householdId: 'hh',
  name: 'Card',
  category: 'consumer',
  balanceCents: 300000,
  balanceAsOf: TODAY,
  aprBasisPoints: 2499,
  promoRules: [],
  minPaymentRule: { type: 'fixed', amountCents: 10000 },
  fixedPayment: false,
  state: 'open',
  ...over,
})

describe("a debt's current deal and its mark", () => {
  const deals = debt({
    promoRules: [
      { rateBasisPoints: 0, appliesTo: 'full', untilDate: '2026-09-01' },
      { rateBasisPoints: 499, appliesTo: 'full', untilDate: '2027-06-01' },
      { rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-02-01' },
    ],
  })

  it('is the soonest deal still running', () => {
    expect(currentDeal(deals, TODAY)?.untilDate).toBe('2027-02-01')
    expect(currentDeal(debt(), TODAY)).toBeNull()
  })

  it('marks its end only when it comes before the debt is paid off', () => {
    expect(dealEndMark(deals, '2028-01-01', TODAY)).toEqual({ on: '2027-02-01', label: '0% ends' })
    expect(dealEndMark(deals, null, TODAY)).toEqual({ on: '2027-02-01', label: '0% ends' })
    expect(dealEndMark(deals, '2027-01-01', TODAY)).toBeNull()
    const notZero = debt({ promoRules: [{ rateBasisPoints: 499, appliesTo: 'full', untilDate: '2027-06-01' }] })
    expect(dealEndMark(notZero, null, TODAY)).toEqual({ on: '2027-06-01', label: 'Deal ends' })
  })
})

describe('commitOpenings', () => {
  const items = [
    { id: 'a', unitAmountCents: 30000, quantity: 1, timelineStart: 'commit' },
    { id: 'b', unitAmountCents: 10000, quantity: 1, timelineStart: 'commit' },
    { id: 'c', unitAmountCents: 50000, quantity: 1, timelineStart: 'last_occurrence' },
  ]

  it('shares one figure by cost across the parts that start at the commit, to the cent', () => {
    expect(commitOpenings({ items, openingCents: 10001 })).toEqual({ openingCents: 10001, shares: [7501, 2500, 0] })
  })

  it('shares across every part when none starts at the commit', () => {
    const none = items.map((i) => ({ ...i, timelineStart: 'last_occurrence' }))
    const { shares } = commitOpenings({ items: none, openingCents: 9000 })
    expect(shares.reduce((t, x) => t + x, 0)).toBe(9000)
    expect(shares).toEqual([3000, 1000, 5000])
  })

  it('takes what was said per part, never above its cost or below zero', () => {
    expect(commitOpenings({ items, perItem: { a: 99999, b: -5, c: 2000 } })).toEqual({
      openingCents: 99999 + 2000,
      shares: [30000, 0, 2000],
    })
  })
})

describe('what a share-out tops debts up by, and the optimizer after it', () => {
  it('adds up the debt top-ups by debt, leaving plans out', () => {
    expect(
      debtTopUps({
        topUps: [
          { kind: 'debt', targetId: 'card', label: 'Card', shortCents: 0, amountCents: 1000 },
          { kind: 'debt', targetId: 'card', label: 'Card', shortCents: 0, amountCents: 500 },
          { kind: 'plan', targetId: 'acct', label: 'Gifts', shortCents: 0, amountCents: 700 },
        ],
      }),
    ).toEqual({ card: 1500 })
  })

  it('sees each debt as it will be after the top-ups, never below zero', () => {
    const cleared = optimiseLumpSum({ debts: [debt()], amountCents: 50000, today: TODAY, lessPaid: { card: 999999 } })
    expect(cleared.allocations).toEqual([])
    const after = optimiseLumpSum({ debts: [debt()], amountCents: 50000, today: TODAY, lessPaid: { card: 280000 } })
    // $3,000 less $2,800 already put toward it leaves $200 to clear.
    expect(after.allocations[0]).toMatchObject({ debtId: 'card', amountCents: 20000, clearsIt: true })
  })
})
