import { describe, expect, it } from 'vitest'
import {
  accountViews,
  aheadOptions,
  assignExtraToPlans,
  currentCycle,
  catchUpOptions,
  computeDrift,
  packageViews,
  progressOf,
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
    recurrence: null,
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

  it('rounds only the account transfer up to the household step, and says what it really is', () => {
    const exact = accountViews(input)
    const rounded = accountViews({ ...input, transferRoundUpCents: 1000 })
    for (const [e, r] of exact.map((v, i) => [v, rounded[i]!] as const)) {
      // The exact figure and its parts are untouched; only the bank figure moves.
      expect(r.weekly.totalPerWeekCents).toBe(e.weekly.totalPerWeekCents)
      expect(r.weekly.ongoingPerWeekCents).toBe(e.weekly.ongoingPerWeekCents)
      expect(e.weekly.transferPerWeekCents).toBe(e.weekly.totalPerWeekCents)
      expect(r.weekly.transferPerWeekCents % 1000).toBe(0)
      expect(r.weekly.transferPerWeekCents).toBeGreaterThanOrEqual(r.weekly.totalPerWeekCents)
      expect(r.weekly.transferPerWeekCents - r.weekly.totalPerWeekCents).toBeLessThan(1000)
      // A part's weekly figure is never rounded: the parts still add up.
      for (const item of r.items) {
        expect(item.weekly.transferPerWeekCents).toBe(item.weekly.totalPerWeekCents)
      }
    }
  })

  it('lets the later record win a same-day tie between two cycle starts', () => {
    // Committed this morning with $18.37 already set aside; counted toward
    // this afternoon at a check-in, to $45.00. The afternoon is the truth.
    const cycles = [
      { lineItemId: 'li-x', startDate: '2026-09-20', openingCents: 1837, recordedOrder: 3 },
      { lineItemId: 'li-x', startDate: '2026-09-20', openingCents: 4500, recordedOrder: 7 },
      { lineItemId: 'li-x', startDate: '2026-09-21', openingCents: 1, recordedOrder: 8 },
      { lineItemId: 'li-y', startDate: '2026-09-20', openingCents: 999, recordedOrder: 9 },
    ]
    expect(currentCycle('li-x', cycles, '2026-09-20')!.openingCents).toBe(4500)
    // And the order they are handed over in does not matter.
    expect(currentCycle('li-x', [...cycles].reverse(), '2026-09-20')!.openingCents).toBe(4500)
    // A later day still wins over any same-day ordering.
    expect(currentCycle('li-x', cycles, '2026-09-21')!.openingCents).toBe(1)
  })

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

  it('prices an offered bump as what the number becomes, without moving anything live', () => {
    const offered: DerivationInput = {
      ...input,
      transferRoundUpCents: 1000,
      pendingDriftAdjustments: [
        {
          id: 'ask-1',
          reserveAccountId: annual.id,
          amountCents: 14832, // $18.54 a week over 8 transfer weeks
          startDate: '2026-11-21',
          endDate: '2027-01-16',
        },
      ],
    }
    const before = accountViews({ ...input, transferRoundUpCents: 1000 })[0]!
    const after = accountViews(offered)[0]!

    // Nothing a human has not confirmed touches the live figures.
    expect(before.pendingWeekly).toBeNull()
    expect(after.weekly).toEqual(before.weekly)
    expect(after.shouldHaveSavedCents).toBe(before.shouldHaveSavedCents)
    expect(after.outstandingCents).toBe(before.outstandingCents)

    // But the screen can say what "done" turns the transfer into.
    expect(after.pendingWeekly).not.toBeNull()
    expect(after.pendingWeekly!.ongoingPerWeekCents).toBe(before.weekly.ongoingPerWeekCents)
    expect(after.pendingWeekly!.catchUp).toContainEqual({ endDate: '2027-01-16', perWeekCents: 1854 })
    expect(after.pendingWeekly!.totalPerWeekCents).toBe(before.weekly.totalPerWeekCents + 1854)
    expect(after.pendingWeekly!.transferPerWeekCents % 1000).toBe(0)
  })

  it('ignores an offered bump whose window has already closed', () => {
    const stale: DerivationInput = {
      ...input,
      pendingDriftAdjustments: [
        { id: 'old', reserveAccountId: annual.id, amountCents: 5000, startDate: '2026-06-01', endDate: '2026-08-01' },
      ],
    }
    expect(accountViews(stale)[0]!.pendingWeekly).toBeNull()
  })
})

describe('cycles and opening balances', () => {
  // $600 committed 2026-09-19, due 2027-01-16: 17 transfer weeks.
  const input: DerivationInput = {
    today: TODAY,
    accounts: [annual],
    packages: [pkg()],
    lineItems: [li({ id: 'li-ins', unitAmountCents: 60000 })],
  }

  it('starts from the commit at $0 when no cycle is recorded', () => {
    const [view] = packageViews(input)
    expect(view!.items[0]!.shouldHaveSavedCents).toBe(0)
    expect(view!.weekly.totalPerWeekCents).toBe(3530)
  })

  it('counts an opening balance as already delivered and spreads only the rest', () => {
    const withOpening: DerivationInput = {
      ...input,
      cycleStarts: [{ lineItemId: 'li-ins', startDate: TODAY, openingCents: 26000 }],
    }
    const [view] = packageViews(withOpening)
    // $260 already there, $340 over 17 weeks.
    expect(view!.items[0]!.shouldHaveSavedCents).toBe(26000)
    expect(view!.weekly.totalPerWeekCents).toBe(2000)
    expect(view!.items[0]!.remainingCents).toBe(34000)
  })

  it('never lets an opening balance exceed what the item costs', () => {
    const [view] = packageViews({
      ...input,
      cycleStarts: [{ lineItemId: 'li-ins', startDate: TODAY, openingCents: 99999999 }],
    })
    expect(view!.items[0]!.shouldHaveSavedCents).toBe(60000)
    expect(view!.weekly.totalPerWeekCents).toBe(0)
  })

  it('uses the latest cycle start on or before today, ignoring one still ahead', () => {
    const later: DerivationInput = {
      ...input,
      today: '2026-11-21',
      lineItems: [li({ id: 'li-ins', unitAmountCents: 60000, dueDate: '2027-11-20', recurrence: { every: 1, unit: 'year' } })],
      cycleStarts: [
        { lineItemId: 'li-ins', startDate: TODAY, openingCents: 26000 },
        // Confirmed spent and rolled forward on 2026-11-20: a fresh cycle at $0.
        { lineItemId: 'li-ins', startDate: '2026-11-20', openingCents: 0 },
        { lineItemId: 'li-ins', startDate: '2027-01-01', openingCents: 50000 },
      ],
    }
    const [view] = packageViews(later)
    // One transfer (Saturday 2026-11-21) into a cycle from Friday 2026-11-20 to
    // Saturday 2027-11-20, which holds 53 transfer days, at $0 saved.
    expect(view!.items[0]!.components[0]!.startDate).toBe('2026-11-20')
    expect(view!.items[0]!.components).toHaveLength(1)
    expect(view!.items[0]!.shouldHaveSavedCents).toBe(1133) // ceil(60000 / 53)
  })

  it('keeps an edit made during a settled cycle out of the new one', () => {
    const rolled: DerivationInput = {
      ...input,
      today: '2026-12-05',
      lineItems: [li({ id: 'li-ins', unitAmountCents: 60000, dueDate: '2027-11-20', recurrence: { every: 1, unit: 'year' } })],
      changes: [
        {
          lineItemId: 'li-ins',
          occurredAt: '2026-10-10',
          before: { unitAmountCents: 50000, quantity: 1, dueDate: '2026-11-20', reserveAccountId: annual.id },
          after: { unitAmountCents: 60000, quantity: 1, dueDate: '2026-11-20', reserveAccountId: annual.id },
        },
      ],
      cycleStarts: [{ lineItemId: 'li-ins', startDate: '2026-11-20', openingCents: 0 }],
    }
    const [view] = packageViews(rolled)
    expect(view!.items[0]!.components.map((c) => c.kind)).toEqual(['base'])
  })
})

describe('counting an overage toward the plans', () => {
  // One-offs with no pace yet unless said otherwise: their window has just opened.
  const item = (
    id: string,
    label: string,
    dueDate: string,
    totalCents: number,
    saved: number,
    paceCents = 0,
    recurrence: LineItem['recurrence'] = null,
  ) => ({
    lineItem: li({ id, label, dueDate, unitAmountCents: totalCents, recurrence }),
    totalCents,
    shouldHaveSavedCents: saved,
    paceCents,
  })

  it('counts toward a repeating part only up to its pace, and puts the rest on the one-offs', () => {
    const result = assignExtraToPlans({
      extraCents: 80000,
      items: [
        item('ins', 'Insurance', '2026-11-01', 60000, 10000, 30000, { every: 6, unit: 'month' }),
        item('trip', 'Trip', '2027-06-01', 300000, 0),
      ],
    })
    expect(result.assignments.map((a) => [a.label, a.addedCents, a.openingCents, a.atPace, a.fullyFunded])).toEqual([
      ['Insurance', 20000, 30000, true, false],
      ['Trip', 60000, 60000, true, false],
    ])
    expect(result.assignments[0]!.shortCents).toBe(20000)
    expect(result.stillShort).toEqual([])
    expect(result.leftoverCents).toBe(0)
  })

  it('leaves what no part should count as extra, rather than parking it on a repeating part', () => {
    const result = assignExtraToPlans({
      extraCents: 500000,
      items: [
        item('ins', 'Insurance', '2026-11-01', 60000, 10000, 30000, { every: 6, unit: 'month' }),
        item('trip', 'Trip', '2027-06-01', 300000, 0),
      ],
    })
    expect(result.assignments.map((a) => [a.label, a.openingCents, a.fullyFunded])).toEqual([
      ['Insurance', 30000, false],
      ['Trip', 300000, true],
    ])
    expect(result.leftoverCents).toBe(500000 - 20000 - 300000)
  })

  it('skips a repeating part already at or above its pace', () => {
    const result = assignExtraToPlans({
      extraCents: 1000,
      items: [
        item('ins', 'Insurance', '2026-11-01', 60000, 50000, 30000, { every: 6, unit: 'month' }),
        item('trip', 'Trip', '2027-06-01', 300000, 0),
      ],
    })
    expect(result.assignments.map((a) => a.label)).toEqual(['Trip'])
    expect(result.nothingToAddCount).toBe(1)
  })

  it('funds the soonest-due part first, then the next, and stops when the extra runs out', () => {
    const { assignments, leftoverCents } = assignExtraToPlans({
      extraCents: 80000,
      items: [
        item('xmas', 'Christmas', '2026-12-19', 100000, 20000),
        item('ins', 'Insurance', '2026-11-01', 60000, 10000),
        item('trip', 'Trip', '2027-06-01', 300000, 0),
      ],
    })
    expect(assignments.map((a) => a.label)).toEqual(['Insurance', 'Christmas'])
    expect(assignments[0]).toMatchObject({ addedCents: 50000, openingCents: 60000, fullyFunded: true })
    expect(assignments[1]).toMatchObject({ addedCents: 30000, openingCents: 50000, fullyFunded: false })
    expect(leftoverCents).toBe(0)
  })

  it('reports what is left once every part is fully funded', () => {
    const { assignments, leftoverCents } = assignExtraToPlans({
      extraCents: 492510,
      items: [item('ins', 'Insurance', '2026-11-01', 60000, 10000)],
    })
    expect(assignments).toHaveLength(1)
    expect(assignments[0]!.openingCents).toBe(60000)
    expect(leftoverCents).toBe(492510 - 50000)
  })

  it('skips a part that already holds everything it needs', () => {
    const { assignments } = assignExtraToPlans({
      extraCents: 1000,
      items: [item('done', 'Done', '2026-11-01', 60000, 60000), item('open', 'Open', '2026-12-01', 5000, 0)],
    })
    expect(assignments.map((a) => a.label)).toEqual(['Open'])
  })

  it('has nothing to say with no extra or no plans', () => {
    expect(assignExtraToPlans({ extraCents: 0, items: [item('a', 'A', '2026-11-01', 100, 0)] })).toEqual({
      assignments: [],
      leftoverCents: 0,
      stillShort: [{ lineItemId: 'a', label: 'A', dueDate: '2026-11-01', shortCents: 100 }],
      nothingToAddCount: 0,
    })
    expect(assignExtraToPlans({ extraCents: 500, items: [] })).toEqual({
      assignments: [],
      leftoverCents: 500,
      stillShort: [],
      nothingToAddCount: 0,
    })
  })

  it('never lists a part that is already fully funded, and says how many were skipped', () => {
    const result = assignExtraToPlans({
      extraCents: 1000,
      items: [
        item('done1', 'HOA', '2026-10-03', 5000, 5000),
        item('done2', 'Prime', '2026-12-01', 13900, 13900),
        item('open', 'Christmas', '2026-12-19', 100000, 20000),
      ],
    })
    expect(result.assignments.map((a) => a.label)).toEqual(['Christmas'])
    expect(result.assignments[0]).toMatchObject({ shortCents: 80000, addedCents: 1000, fullyFunded: false })
    expect(result.nothingToAddCount).toBe(2)
    expect(result.stillShort).toEqual([])
  })

  it('names the parts the extra could not reach, so the list is not mistaken for a top few', () => {
    const result = assignExtraToPlans({
      extraCents: 6000,
      items: [
        item('a', 'HOA', '2026-10-03', 5000, 0),
        item('b', 'Thanksgiving', '2026-11-01', 20000, 10000),
        item('c', 'Christmas', '2026-12-19', 100000, 20000),
        item('d', 'Insurance', '2027-02-15', 60000, 60000),
      ],
    })
    // $50 finishes the HOA, the last $10 dents Thanksgiving, Christmas gets nothing.
    expect(result.assignments.map((a) => [a.label, a.addedCents, a.fullyFunded])).toEqual([
      ['HOA', 5000, true],
      ['Thanksgiving', 1000, false],
    ])
    expect(result.stillShort).toEqual([
      { lineItemId: 'c', label: 'Christmas', dueDate: '2026-12-19', shortCents: 80000 },
    ])
    expect(result.nothingToAddCount).toBe(1)
    expect(result.leftoverCents).toBe(0)
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

describe('progress against the pace', () => {
  const view = (cents: { total: number; held: number; pace: number }) =>
    progressOf({ totalCents: cents.total, shouldHaveSavedCents: cents.held, paceCents: cents.pace })

  it('is fully funded when nothing more is to be set aside, with no tick', () => {
    expect(view({ total: 84400, held: 84400, pace: 34386 })).toEqual({
      status: 'funded',
      fillPercent: 100,
      pacePercent: 41,
      behindByCents: 0,
    })
  })

  it('is on track at or above the pace, behind below it', () => {
    expect(view({ total: 33000, held: 17100, pace: 17100 }).status).toBe('on_track')
    expect(view({ total: 33000, held: 0, pace: 17100 })).toEqual({
      status: 'behind',
      fillPercent: 0,
      pacePercent: 52,
      behindByCents: 17100,
    })
  })

  it('measures a repeating part from the last time it came round', () => {
    // Progressive, every 6 months, next 9 Jan: last came round 9 July. Saved
    // evenly since, 11 of 27 Saturdays would be in: ceil(84400 × 11 / 27).
    const views = accountViews({
      today: TODAY,
      accounts: [annual],
      packages: [pkg()],
      lineItems: [
        li({
          id: 'li-progressive',
          label: 'Progressive',
          unitAmountCents: 84400,
          dueDate: '2027-01-09',
          recurrence: { every: 6, unit: 'month' },
        }),
      ],
    })
    const item = views[0]!.items[0]!
    expect(item.paceSince).toBe('2026-07-09')
    expect(item.paceCents).toBe(34386)
    expect(item.shouldHaveSavedCents).toBe(0)
    expect(progressOf(item).status).toBe('behind')
  })

  it('measures a one-off from the day it existed in a live plan, and a count never moves that', () => {
    const items = [li({ id: 'li-a', label: 'A' }), li({ id: 'li-b', label: 'B' })]
    const views = accountViews({
      today: '2026-10-03',
      accounts: [annual],
      packages: [pkg()],
      lineItems: items,
      cycleStarts: [
        // B was added to the live plan a week after commit; A was counted toward at a check-in.
        { lineItemId: 'li-b', startDate: '2026-09-26', openingCents: 0, recordedOrder: 0, origin: 'added' },
        { lineItemId: 'li-a', startDate: '2026-10-03', openingCents: 20000, recordedOrder: 1, origin: 'counted' },
      ],
    })
    const [a, b] = views[0]!.items
    expect(a!.paceSince).toBe(TODAY)
    expect(b!.paceSince).toBe('2026-09-26')
    expect(progressOf(a!).status).toBe('on_track')
    expect(progressOf(b!).status).toBe('on_track')
  })

  it('measures a repeating part from the day it was confirmed spent, when that came after it was due', () => {
    // Due 9 Jan, every 6 months; the July one was confirmed spent on the 15th.
    const views = accountViews({
      today: TODAY,
      accounts: [annual],
      packages: [pkg({ committedAt: '2026-01-10' })],
      lineItems: [
        li({
          id: 'li-p',
          label: 'Progressive',
          unitAmountCents: 84400,
          dueDate: '2027-01-09',
          recurrence: { every: 6, unit: 'month' },
        }),
      ],
      cycleStarts: [{ lineItemId: 'li-p', startDate: '2026-07-15', openingCents: 0, recordedOrder: 0, origin: 'rolled' }],
    })
    const item = views[0]!.items[0]!
    expect(item.paceSince).toBe('2026-07-15')
    // Saving started the day it was confirmed, so it is exactly on its pace.
    expect(item.paceCents).toBe(item.shouldHaveSavedCents)
    expect(progressOf(item).status).toBe('on_track')
  })
})
