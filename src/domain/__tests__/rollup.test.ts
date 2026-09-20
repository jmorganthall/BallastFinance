import { describe, expect, it } from 'vitest'
import {
  accountViews,
  aheadOptions,
  catchUpOptions,
  computeDrift,
  packageViews,
  whatIfCommit,
  type DerivationInput,
} from '../rollup'
import type { CivilDate } from '../dates'
import type { LineItem, Package, ReserveAccount } from '../types'

const TODAY: CivilDate = '2026-09-19'

const annual: ReserveAccount = {
  id: 'acct-annual',
  householdId: 'hh-1',
  name: 'Annual Expenses',
  institutionLabel: 'Capital One 360 — Annual Expenses',
  scope: 'household',
  ownerUserId: null,
  active: true,
}
const longTerm: ReserveAccount = {
  id: 'acct-lt',
  householdId: 'hh-1',
  name: 'Long Term Savings',
  institutionLabel: 'Capital One 360 — Long Term Savings',
  scope: 'household',
  ownerUserId: null,
  active: true,
}

function pkg(over: Partial<Package> = {}): Package {
  return {
    id: 'pkg-disney',
    householdId: 'hh-1',
    name: 'Disney Feb 2027',
    state: 'active',
    module: 'manual',
    detail: null,
    createdAt: TODAY,
    committedAt: TODAY,
    ...over,
  }
}

function li(over: Partial<LineItem> & Pick<LineItem, 'id'>): LineItem {
  return {
    packageId: 'pkg-disney',
    label: 'Item',
    unitAmountCents: 60000,
    quantity: 1,
    dueDate: '2027-01-16',
    reserveAccountId: annual.id,
    state: 'accruing',
    recurrence: 'none',
    ...over,
  }
}

describe('the Disney package rolls up to a Capital One instruction (Phase A acceptance)', () => {
  const input: DerivationInput = {
    today: TODAY,
    accounts: [annual, longTerm],
    packages: [pkg()],
    lineItems: [
      li({ id: 'li-tickets', label: 'Park tickets', unitAmountCents: 60000, quantity: 3 }),
      li({
        id: 'li-airfare',
        label: 'Airfare',
        unitAmountCents: 45000,
        quantity: 3,
        dueDate: '2026-11-21', // bought early to beat price increases
      }),
      li({
        id: 'li-lodging',
        label: 'Lodging',
        unitAmountCents: 120000,
        quantity: 1,
        dueDate: '2027-01-16',
        reserveAccountId: longTerm.id,
      }),
    ],
  }

  it('gives each account its own weekly number', () => {
    const [annualView, ltView] = accountViews(input)

    expect(annualView!.account.name).toBe('Annual Expenses')
    expect(annualView!.weekly.totalPerWeekCents).toBeGreaterThan(0)
    expect(ltView!.weekly.totalPerWeekCents).toBeGreaterThan(0)

    // The two accounts are independent; lodging never lands in Annual Expenses.
    expect(annualView!.items.map((v) => v.lineItem.id).sort()).toEqual(['li-airfare', 'li-tickets'])
    expect(ltView!.items.map((v) => v.lineItem.id)).toEqual(['li-lodging'])
  })

  it("an account's weekly number is the sum of its items' weekly numbers", () => {
    const [annualView] = accountViews(input)
    const sumOfItems = annualView!.items.reduce((s, v) => s + v.weekly.totalPerWeekCents, 0)
    expect(annualView!.weekly.totalPerWeekCents).toBe(sumOfItems)
  })

  it('funds every item in full by its due date', () => {
    for (const view of packageViews(input)[0]!.items) {
      const delivered = view.components.reduce(
        (s, c) => s + (c.amountCents > 0 || c.amountCents < 0 ? c.amountCents : 0),
        0,
      )
      expect(delivered).toBe(view.totalCents)
    }
  })

  it('starts at zero saved on the commit date', () => {
    const views = accountViews(input)
    expect(views.every((v) => v.shouldHaveSavedCents === 0)).toBe(true)
    // Everything is still outstanding.
    const [annualView] = views
    expect(annualView!.outstandingCents).toBe(60000 * 3 + 45000 * 3)
  })

  it('has set aside the full amount once every due date has passed', () => {
    const later = { ...input, today: '2027-06-01' as CivilDate }
    const [annualView, ltView] = accountViews(later)
    expect(annualView!.shouldHaveSavedCents).toBe(60000 * 3 + 45000 * 3)
    expect(ltView!.shouldHaveSavedCents).toBe(120000)
    // Nothing left to move.
    expect(annualView!.weekly.totalPerWeekCents).toBe(0)
    expect(annualView!.outstandingCents).toBe(0)
  })

  it('flags a passed due date as overdue so it keeps nagging', () => {
    const later = { ...input, today: '2026-12-01' as CivilDate }
    const airfare = packageViews(later)[0]!.items.find((v) => v.lineItem.id === 'li-airfare')
    expect(airfare!.isOverdue).toBe(true)
    const tickets = packageViews(later)[0]!.items.find((v) => v.lineItem.id === 'li-tickets')
    expect(tickets!.isOverdue).toBe(false)
  })
})

describe('simulated packages stay out of live totals', () => {
  const simulated = pkg({ id: 'pkg-what-if', name: 'Disney 2028', state: 'simulated', committedAt: null })
  const input: DerivationInput = {
    today: TODAY,
    accounts: [annual],
    packages: [pkg(), simulated],
    lineItems: [
      li({ id: 'li-live', unitAmountCents: 60000 }),
      li({ id: 'li-draft', packageId: 'pkg-what-if', unitAmountCents: 100000 }),
    ],
  }

  it('excludes a draft from the account instruction', () => {
    const [view] = accountViews(input)
    expect(view!.items.map((v) => v.lineItem.id)).toEqual(['li-live'])
  })

  it('prices what committing it would add, without changing the live number', () => {
    const before = accountViews(input)[0]!.weekly.totalPerWeekCents
    const [line] = whatIfCommit(input, 'pkg-what-if')

    expect(line!.currentPerWeekCents).toBe(before)
    expect(line!.addedPerWeekCents).toBeGreaterThan(0)
    expect(line!.projectedPerWeekCents).toBe(before + line!.addedPerWeekCents)

    // The live view is untouched by asking the question.
    expect(accountViews(input)[0]!.weekly.totalPerWeekCents).toBe(before)
  })
})

describe('retired items leave the math', () => {
  it('drops a confirmed-spent item from totals', () => {
    const input: DerivationInput = {
      today: '2027-02-01',
      accounts: [annual],
      packages: [pkg()],
      lineItems: [
        li({ id: 'li-a', unitAmountCents: 60000, state: 'retired' }),
        li({ id: 'li-b', unitAmountCents: 30000, state: 'accruing' }),
      ],
    }
    const [view] = accountViews(input)
    expect(view!.items.map((v) => v.lineItem.id)).toEqual(['li-b'])
    expect(view!.shouldHaveSavedCents).toBe(30000)
  })
})

describe('drift and catch-up', () => {
  const input: DerivationInput = {
    today: '2026-11-21',
    accounts: [annual],
    packages: [pkg()],
    lineItems: [li({ id: 'li-tickets', unitAmountCents: 60000, quantity: 3 })],
  }

  it('reports behind pace as a negative drift', () => {
    const [view] = accountViews(input)
    const drift = computeDrift({ account: view!, confirmedCents: view!.shouldHaveSavedCents - 19000 })
    expect(drift.driftCents).toBe(-19000)
  })

  it('reports ahead of pace as a positive drift', () => {
    const [view] = accountViews(input)
    const drift = computeDrift({ account: view!, confirmedCents: view!.shouldHaveSavedCents + 5000 })
    expect(drift.driftCents).toBe(5000)
  })

  it('offers both a one-time move and a dated rate bump', () => {
    const options = catchUpOptions({ shortfallCents: 19000, today: '2026-11-21', overWeeks: 8 })
    expect(options).toHaveLength(2)

    const [oneTime, bump] = options
    expect(oneTime!.kind).toBe('one_time')
    expect(oneTime!.amountCents).toBe(19000)

    expect(bump!.kind).toBe('rate_bump')
    expect(bump!.perWeekCents).toBe(2375) // $190 over 8 weeks, rounded up
    expect(bump!.weeks).toBe(8)
    expect(bump!.endDate).toBe('2027-01-16')
    // The bump clears the whole shortfall.
    expect(bump!.perWeekCents! * bump!.weeks!).toBeGreaterThanOrEqual(19000)
  })

  it('offers nothing when the account is ahead', () => {
    expect(catchUpOptions({ shortfallCents: -500, today: TODAY, overWeeks: 8 })).toEqual([])
  })

  it('folds an accepted rate bump into the account weekly number', () => {
    const withAdjustment: DerivationInput = {
      ...input,
      driftAdjustments: [
        {
          id: 'adj-1',
          reserveAccountId: annual.id,
          amountCents: 19000,
          startDate: '2026-11-21',
          endDate: '2027-01-16',
        },
      ],
    }
    const before = accountViews(input)[0]!.weekly.totalPerWeekCents
    const after = accountViews(withAdjustment)[0]!.weekly.totalPerWeekCents
    expect(after).toBeGreaterThan(before)
    expect(accountViews(withAdjustment)[0]!.weekly.catchUp).toHaveLength(1)
  })
})

describe('ahead of the plan', () => {
  const today = '2026-11-21'

  it('offers moving the extra out, and easing off the weekly set-aside', () => {
    const options = aheadOptions({ extraCents: 19000, weeklyCents: 5000, today, overWeeks: 8 })
    expect(options).toHaveLength(2)

    const [out, cut] = options
    expect(out).toEqual({ kind: 'one_time_out', amountCents: 19000 })

    expect(cut!.kind).toBe('rate_cut')
    expect(cut!.perWeekCents).toBe(2375) // $190 over 8 weeks
    expect(cut!.weeks).toBe(8)
    expect(cut!.endDate).toBe('2027-01-16')
    expect(cut!.amountCents).toBe(19000) // the cut and its weekly figure agree exactly
    expect(cut!.pauses).toBe(false)
    expect(cut!.leftoverCents).toBe(0)
  })

  it('rounds a cut DOWN, so the account ends a few cents ahead rather than behind', () => {
    const cut = aheadOptions({ extraCents: 100, weeklyCents: 5000, today, overWeeks: 3 })[1]!
    expect(cut.perWeekCents).toBe(33)
    expect(cut.amountCents).toBe(99)
    expect(cut.leftoverCents).toBe(1)
  })

  it('never cuts more than is being set aside: a big extra becomes a pause', () => {
    // $4,925.10 extra against $50/week: 98 whole weeks would do it, capped at a year.
    const cut = aheadOptions({ extraCents: 492510, weeklyCents: 5000, today, overWeeks: 8 })[1]!
    expect(cut.pauses).toBe(true)
    expect(cut.perWeekCents).toBe(5000)
    expect(cut.weeks).toBe(52)
    expect(cut.amountCents).toBe(260000)
    expect(cut.leftoverCents).toBe(232510)
    expect(cut.endDate).toBe('2027-11-20')
  })

  it('pauses for whole weeks only, leaving the odd cents as cushion', () => {
    // $1,250 extra at $100/week over a 4-week window: too much to trim, 12 whole weeks to pause.
    const cut = aheadOptions({ extraCents: 125000, weeklyCents: 10000, today, overWeeks: 4 })[1]!
    expect(cut.pauses).toBe(true)
    expect(cut.weeks).toBe(12)
    expect(cut.amountCents).toBe(120000)
    expect(cut.leftoverCents).toBe(5000)
  })

  it('only offers the move-out when nothing is being set aside', () => {
    const options = aheadOptions({ extraCents: 492510, weeklyCents: 0, today, overWeeks: 8 })
    expect(options.map((o) => o.kind)).toEqual(['one_time_out'])
  })

  it('offers nothing when the account is not ahead', () => {
    expect(aheadOptions({ extraCents: 0, weeklyCents: 5000, today, overWeeks: 8 })).toEqual([])
    expect(aheadOptions({ extraCents: -500, weeklyCents: 5000, today, overWeeks: 8 })).toEqual([])
  })

  it('folds an accepted cut into the account weekly number, never below zero', () => {
    const input: DerivationInput = {
      today,
      accounts: [annual],
      packages: [pkg()],
      lineItems: [li({ id: 'li-tickets', unitAmountCents: 60000 })],
    }
    const withCut: DerivationInput = {
      ...input,
      driftAdjustments: [
        {
          id: 'cut-1',
          reserveAccountId: annual.id,
          amountCents: -19000,
          startDate: today,
          endDate: '2027-01-16',
        },
      ],
    }
    const before = accountViews(input)[0]!
    const after = accountViews(withCut)[0]!
    expect(before.weekly.totalPerWeekCents).toBe(3530) // $600 over 17 weeks, rounded up
    expect(after.weekly.catchUp).toEqual([{ endDate: '2027-01-16', perWeekCents: -2375 }])
    expect(after.weekly.totalPerWeekCents).toBe(3530 - 2375)
    expect(after.weekly.ongoingPerWeekCents).toBe(before.weekly.ongoingPerWeekCents)
    // A cut changes what goes in each week, not what the plan says should be there.
    expect(after.shouldHaveSavedCents).toBe(before.shouldHaveSavedCents)
  })
})
