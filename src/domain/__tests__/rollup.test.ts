import { describe, expect, it } from 'vitest'
import {
  accountViews,
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
