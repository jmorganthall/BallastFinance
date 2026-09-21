/**
 * Reshuffle: the same counted money, re-spread across an account's parts so
 * the weekly transfer is the household's steady rate and no more. Every part
 * up to its pace first, soonest due first; then whatever is left, soonest
 * first. Where money is counted changes; how much never does.
 */

import { describe, expect, it } from 'vitest'
import { reshuffleAccount } from '../reshuffle'
import { accountViews, type DerivationInput } from '../rollup'
import { evenPaceCents } from '../accrual'
import type { CivilDate } from '../dates'
import type { LineItem, LineItemCycle, Package, ReserveAccount } from '../types'

const TODAY: CivilDate = '2026-09-19' // a Saturday

const annual: ReserveAccount = {
  id: 'acct-annual',
  householdId: 'hh-1',
  name: 'Annual Expenses',
  institutionLabel: 'Capital One 360 — Annual Expenses',
  scope: 'household',
  ownerUserId: null,
  active: true,
}

const plan: Package = {
  id: 'pkg-annual',
  householdId: 'hh-1',
  name: 'Annual bills',
  state: 'active',
  module: 'manual',
  detail: null,
  createdAt: TODAY,
  committedAt: TODAY,
}

function li(over: Partial<LineItem> & Pick<LineItem, 'id' | 'label' | 'unitAmountCents' | 'dueDate'>): LineItem {
  return {
    packageId: plan.id,
    quantity: 1,
    reserveAccountId: annual.id,
    state: 'accruing',
    recurrence: null,
    ...over,
  }
}

// Four Saturdays away, sixteen, and forty.
const soon = li({ id: 'soon', label: 'Soon', unitAmountCents: 40000, dueDate: '2026-10-17' })
const progressive = li({
  id: 'progressive',
  label: 'Progressive Auto Insurance',
  unitAmountCents: 84400,
  dueDate: '2027-01-09',
  recurrence: { every: 6, unit: 'month' },
})
const far = li({ id: 'far', label: 'Far', unitAmountCents: 400000, dueDate: '2027-06-26' })

function input(cycleStarts: LineItemCycle[], lineItems = [soon, progressive, far]): DerivationInput {
  return { today: TODAY, accounts: [annual], packages: [plan], lineItems, cycleStarts }
}

// Progressive came round on 9 July; saved evenly since, it would hold 11 of
// the cycle's 27 Saturday transfers: ceil(84400 × 11 / 27) = 34386.
const PROGRESSIVE_PACE = 34386

describe('reshuffle', () => {
  it('prices the pace with the one shared definition', () => {
    expect(
      evenPaceCents({ totalCents: 84400, fromDate: '2026-07-09', dueDate: '2027-01-09', today: TODAY }),
    ).toBe(PROGRESSIVE_PACE)
  })

  it('takes a far-off part down to its pace and puts the rest on what is due soonest', () => {
    // The spreadsheet had the whole $844 reserved for a bill four months out.
    const before = input([
      { lineItemId: 'progressive', startDate: TODAY, openingCents: 84400, recordedOrder: 0, origin: 'commit' },
    ])
    const result = reshuffleAccount(before, annual.id)!

    expect(result.potCents).toBe(84400)
    expect(result.lines.map((l) => l.lineItemId)).toEqual(['soon', 'progressive', 'far'])
    // Pace first: Progressive keeps its 34386. Then soonest first: Soon fills
    // its $400, and the last 10014 goes back to Progressive, next in line.
    expect(result.openings).toEqual([
      { lineItemId: 'soon', openingCents: 40000 },
      { lineItemId: 'progressive', openingCents: 34386 + 10014 },
    ])
    expect(result.lines.map((l) => [l.holdsNowCents, l.holdsAfterCents])).toEqual([
      [0, 40000],
      [84400, 44400],
      [0, 0],
    ])
    // Soon stops costing $100 a week; Progressive's 40000 over 16 weeks is $25.
    expect(result.perWeekNowCents).toBe(10000 + 0 + 10000)
    expect(result.perWeekAfterCents).toBe(0 + 2500 + 10000)
    expect(result.lines.map((l) => l.perWeekAfterCents)).toEqual([0, 2500, 10000])
  })

  it('changes where the money is counted, never how much', () => {
    const result = reshuffleAccount(
      input([{ lineItemId: 'progressive', startDate: TODAY, openingCents: 84400, recordedOrder: 0, origin: 'commit' }]),
      annual.id,
    )!
    const now = result.lines.reduce((s, l) => s + l.holdsNowCents, 0)
    const after = result.lines.reduce((s, l) => s + l.holdsAfterCents, 0)
    expect(after).toBe(now)
    expect(after).toBe(result.potCents)
  })

  it('is what the screens will show once the openings are recorded', () => {
    const before = input([
      { lineItemId: 'progressive', startDate: TODAY, openingCents: 84400, recordedOrder: 0, origin: 'commit' },
    ])
    const result = reshuffleAccount(before, annual.id)!
    const recorded = input([
      ...(before.cycleStarts ?? []),
      ...result.openings.map((o, i) => ({ ...o, startDate: TODAY, recordedOrder: 1 + i, origin: 'counted' as const })),
    ])
    const view = accountViews(recorded).find((v) => v.account.id === annual.id)!
    expect(view.weekly.totalPerWeekCents).toBe(result.perWeekAfterCents)
    expect(view.shouldHaveSavedCents).toBe(result.potCents)
    for (const line of result.lines) {
      const item = view.items.find((v) => v.lineItem.id === line.lineItemId)!
      expect(item.shouldHaveSavedCents).toBe(line.holdsAfterCents)
      expect(item.weekly.totalPerWeekCents).toBe(line.perWeekAfterCents)
    }
    // And doing it again finds nothing to change.
    expect(reshuffleAccount(recorded, annual.id)!.openings).toEqual([])
  })

  it('brings a part to its pace even when that costs a little this week', () => {
    // One-off $400 due in four weeks holds the lot; a $5,200 yearly bill that
    // came round yesterday holds nothing. Its window holds 53 Saturday
    // transfers and one is in, so its pace is ceil(520000 / 53) = 9812.
    const yearly = li({
      id: 'yearly',
      label: 'Yearly',
      unitAmountCents: 520000,
      dueDate: '2027-09-18',
      recurrence: { every: 1, unit: 'year' },
    })
    const before = input(
      [{ lineItemId: 'soon', startDate: TODAY, openingCents: 40000, recordedOrder: 0, origin: 'commit' }],
      [soon, yearly],
    )
    const result = reshuffleAccount(before, annual.id)!
    expect(result.openings).toEqual([
      { lineItemId: 'soon', openingCents: 30188 },
      { lineItemId: 'yearly', openingCents: 9812 },
    ])
    expect(result.behindNowCount).toBe(1)
    expect(result.behindAfterCount).toBe(0)
    // The transfer rises this week (Soon has $98.12 to find over four weeks) so
    // that it does not climb by more when Soon comes off and Yearly stays short.
    expect(result.perWeekNowCents).toBe(10000)
    expect(result.perWeekAfterCents).toBe(2453 + 9812)
  })

  it('has nothing to say for an account with no live parts', () => {
    expect(reshuffleAccount(input([], []), annual.id)).toBeNull()
    expect(reshuffleAccount(input([]), 'no-such-account')).toBeNull()
  })
})
