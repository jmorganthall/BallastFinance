import { describe, expect, it } from 'vitest'
import { orderPlans, planOrderAfterTap, readPlanOrder, type PlanOrderRow } from '../plan-order'

const row = (r: Partial<PlanOrderRow> & { name: string }): PlanOrderRow => ({
  state: 'active',
  nextDue: '2027-01-01',
  perWeekCents: 0,
  totalCents: 0,
  shortByCents: 0,
  ...r,
})

const names = (rows: PlanOrderRow[]) => rows.map((r) => r.name)

describe('the plans list order (D41 (5))', () => {
  const live = [
    row({ name: 'Tax prep', nextDue: '2027-02-01', perWeekCents: 577, totalCents: 30000, shortByCents: 80 }),
    row({ name: 'Disney', nextDue: '2027-06-01', perWeekCents: 9000, totalCents: 600000, shortByCents: 0 }),
    row({ name: 'Christmas', nextDue: '2026-12-20', perWeekCents: 2000, totalCents: 100000, shortByCents: 4000 }),
  ]

  it('defaults to Next due, soonest first', () => {
    expect(readPlanOrder({})).toEqual({ sort: 'due', dir: 'asc' })
    expect(readPlanOrder({ sort: 'nonsense', dir: 'sideways' })).toEqual({ sort: 'due', dir: 'asc' })
    expect(names(orderPlans(live, readPlanOrder({})))).toEqual(['Christmas', 'Tax prep', 'Disney'])
  })

  it('starts each sort in its own direction, and a second tap reverses it', () => {
    expect(readPlanOrder({ sort: 'week' })).toEqual({ sort: 'week', dir: 'desc' })
    expect(planOrderAfterTap({ sort: 'due', dir: 'asc' }, 'total')).toEqual({ sort: 'total', dir: 'desc' })
    expect(planOrderAfterTap({ sort: 'total', dir: 'desc' }, 'total')).toEqual({ sort: 'total', dir: 'asc' })
  })

  it('sorts by the weekly cost, the total and the dollars missing, largest first', () => {
    expect(names(orderPlans(live, { sort: 'week', dir: 'desc' }))).toEqual(['Disney', 'Christmas', 'Tax prep'])
    expect(names(orderPlans(live, { sort: 'total', dir: 'desc' }))).toEqual(['Disney', 'Christmas', 'Tax prep'])
    expect(names(orderPlans(live, { sort: 'short', dir: 'desc' }))).toEqual(['Christmas', 'Tax prep', 'Disney'])
    expect(names(orderPlans(live, { sort: 'short', dir: 'asc' }))).toEqual(['Disney', 'Tax prep', 'Christmas'])
  })

  it('puts live plans first, then drafts, then done plans, and drafts fall back to Next due', () => {
    const rows = [
      row({ name: 'Done', state: 'retired', nextDue: null, perWeekCents: null, shortByCents: null }),
      row({ name: 'Draft late', state: 'simulated', nextDue: '2027-09-01', perWeekCents: null, totalCents: 9, shortByCents: null }),
      row({ name: 'Draft soon', state: 'simulated', nextDue: '2027-03-01', perWeekCents: null, totalCents: 1, shortByCents: null }),
      ...live,
    ]
    expect(names(orderPlans(rows, { sort: 'short', dir: 'desc' }))).toEqual([
      'Christmas',
      'Tax prep',
      'Disney',
      'Draft soon',
      'Draft late',
      'Done',
    ])
    // Total still applies to drafts: theirs is the sum of their parts.
    expect(names(orderPlans(rows, { sort: 'total', dir: 'desc' })).slice(3, 5)).toEqual(['Draft late', 'Draft soon'])
  })

  it('puts a plan with no date last whatever the direction, and breaks ties by next due, then name', () => {
    const rows = [
      row({ name: 'Empty', nextDue: null, totalCents: 999999 }),
      row({ name: 'B', nextDue: '2027-01-01', totalCents: 500 }),
      row({ name: 'A', nextDue: '2027-01-01', totalCents: 500 }),
      row({ name: 'Sooner', nextDue: '2026-11-01', totalCents: 500 }),
    ]
    expect(names(orderPlans(rows, { sort: 'total', dir: 'desc' }))).toEqual(['Sooner', 'A', 'B', 'Empty'])
    expect(names(orderPlans(rows, { sort: 'total', dir: 'asc' }))).toEqual(['Sooner', 'A', 'B', 'Empty'])
    expect(names(orderPlans(rows, { sort: 'due', dir: 'desc' }))).toEqual(['A', 'B', 'Sooner', 'Empty'])
  })
})
