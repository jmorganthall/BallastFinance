import { describe, expect, it } from 'vitest'
import {
  accrualCurve,
  componentDeliveredBy,
  componentRatePerWeekCents,
  componentsForLineItem,
  isComponentActive,
  respreadEquivalentPerWeekCents,
  shouldHaveSavedForItem,
  weeklyBreakdown,
  type RateComponent,
  openingSinceLastOccurrence,
  evenPaceCents,
  baseStartDate,
  savingSince,
  savingSinceWords,
} from '../accrual'
import {
  DEFAULT_TRANSFER_WEEKDAY,
  accrualWeeksBetween,
  transferWeeksBetween,
  type CivilDate,
  type Weekday,
} from '../dates'
import { resolveTimelineStart, timelineStartRecord } from '../types'
import type { LineItem, LineItemChange, LineItemSnapshot } from '../types'
import { lineItemTotalCents } from '../types'

const COMMIT: CivilDate = '2026-09-19' // a Saturday
const DUE: CivilDate = '2027-01-16'
const ACCOUNT = 'acct-annual'

function item(over: Partial<LineItem> = {}): LineItem {
  return {
    id: 'li-tickets',
    packageId: 'pkg-disney',
    label: 'Park tickets',
    unitAmountCents: 60000, // $600
    quantity: 1,
    dueDate: DUE,
    reserveAccountId: ACCOUNT,
    state: 'accruing',
    recurrence: null,
    timelineStart: 'commit',
    timelineStartDate: null,
    ...over,
  }
}

function snap(over: Partial<LineItemSnapshot> = {}): LineItemSnapshot {
  return {
    unitAmountCents: 60000,
    quantity: 1,
    dueDate: DUE,
    reserveAccountId: ACCOUNT,
    ...over,
  }
}

/** The invariant everything else rests on. */
function deliveredByDueDate(
  components: readonly RateComponent[],
  dueDate: CivilDate,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): number {
  return components.reduce((sum, c) => sum + componentDeliveredBy(c, dueDate, transferWeekday), 0)
}

describe('base component at commit', () => {
  it('spreads the whole amount from commit to due', () => {
    const [base, ...rest] = componentsForLineItem({ lineItem: item(), commitDate: COMMIT })
    expect(rest).toHaveLength(0)
    expect(base!.kind).toBe('base')
    expect(base!.amountCents).toBe(60000)
    expect(base!.weeks).toBe(17)
    expect(componentRatePerWeekCents(base!)).toBe(3530) // $35.30/wk, rounded up
  })

  it('funds the full amount by the due date despite rounding', () => {
    const components = componentsForLineItem({ lineItem: item(), commitDate: COMMIT })
    expect(deliveredByDueDate(components, DUE)).toBe(60000)
    // And the rounded-up instruction over-delivers rather than falling short.
    expect(componentRatePerWeekCents(components[0]!) * 17).toBeGreaterThanOrEqual(60000)
  })

  it('collapses to a single move when the item is due inside a week', () => {
    const soon = componentsForLineItem({
      lineItem: item({ dueDate: '2026-09-22' }),
      commitDate: COMMIT,
    })
    expect(soon[0]!.weeks).toBe(1)
    expect(componentRatePerWeekCents(soon[0]!)).toBe(60000)
  })
})

describe('the add-two-travelers scenario (PRD §12 acceptance)', () => {
  const EDIT: CivilDate = '2026-10-17'
  const changes: LineItemChange[] = [
    {
      lineItemId: 'li-tickets',
      occurredAt: EDIT,
      before: snap({ quantity: 1 }),
      after: snap({ quantity: 3 }),
    },
  ]

  it('leaves the base component untouched and adds a dated catch-up', () => {
    const components = componentsForLineItem({
      lineItem: item({ quantity: 3 }),
      commitDate: COMMIT,
      changes,
    })
    expect(components).toHaveLength(2)

    const [base, catchUp] = components
    expect(base!.kind).toBe('base')
    expect(base!.amountCents).toBe(60000) // unchanged by the edit
    expect(componentRatePerWeekCents(base!)).toBe(3530)

    expect(catchUp!.kind).toBe('catch_up')
    expect(catchUp!.amountCents).toBe(120000) // only the delta: two more travelers
    expect(catchUp!.startDate).toBe(EDIT)
    expect(catchUp!.endDate).toBe(DUE)
    expect(catchUp!.weeks).toBe(13)
    expect(componentRatePerWeekCents(catchUp!)).toBe(9231)
  })

  it('still lands exactly on the new total by the due date', () => {
    const components = componentsForLineItem({
      lineItem: item({ quantity: 3 }),
      commitDate: COMMIT,
      changes,
    })
    expect(deliveredByDueDate(components, DUE)).toBe(180000)
  })

  it('decomposes the weekly number the way the UI must show it', () => {
    const components = componentsForLineItem({
      lineItem: item({ quantity: 3 }),
      commitDate: COMMIT,
      changes,
    })
    const b = weeklyBreakdown(components, EDIT)

    expect(b.ongoingPerWeekCents).toBe(3530)
    expect(b.catchUp).toEqual([{ endDate: DUE, perWeekCents: 9231 }])
    expect(b.totalPerWeekCents).toBe(12761)
    // The parts a reader adds up equal the headline number.
    expect(b.ongoingPerWeekCents + b.catchUp[0]!.perWeekCents).toBe(b.totalPerWeekCents)
  })

  it('agrees with the re-spread tooltip on the total, while keeping it legible', () => {
    const components = componentsForLineItem({
      lineItem: item({ quantity: 3 }),
      commitDate: COMMIT,
      changes,
    })
    const delivered = shouldHaveSavedForItem(components, EDIT, 180000)
    const respread = respreadEquivalentPerWeekCents({
      remainingCents: 180000 - delivered,
      asOf: EDIT,
      dueDate: DUE,
    })
    // Same money either way; the decomposition only changes how it reads.
    expect(Math.abs(respread - weeklyBreakdown(components, EDIT).totalPerWeekCents)).toBeLessThanOrEqual(2)
  })
})

describe('reductions and date moves', () => {
  const EDIT: CivilDate = '2026-10-17'

  it('produces a negative catch-up when the item shrinks', () => {
    const components = componentsForLineItem({
      lineItem: item({ quantity: 1, unitAmountCents: 30000 }),
      commitDate: COMMIT,
      changes: [
        {
          lineItemId: 'li-tickets',
          occurredAt: EDIT,
          before: snap(),
          after: snap({ unitAmountCents: 30000 }),
        },
      ],
    })
    const catchUp = components[1]!
    expect(catchUp.amountCents).toBeLessThan(0)
    expect(componentRatePerWeekCents(catchUp)).toBeLessThan(0)
    expect(deliveredByDueDate(components, DUE)).toBe(30000)
  })

  it('shows a reduction in the breakdown rather than hiding it in a blend', () => {
    const components = componentsForLineItem({
      lineItem: item({ unitAmountCents: 30000 }),
      commitDate: COMMIT,
      changes: [
        {
          lineItemId: 'li-tickets',
          occurredAt: EDIT,
          before: snap(),
          after: snap({ unitAmountCents: 30000 }),
        },
      ],
    })
    const b = weeklyBreakdown(components, EDIT)
    expect(b.ongoingPerWeekCents).toBe(3530)
    expect(b.catchUp[0]!.perWeekCents).toBeLessThan(0)
    expect(b.totalPerWeekCents).toBeLessThan(b.ongoingPerWeekCents)
  })

  it('needs no adjustment when the due date is pushed out -- the plan simply finishes early', () => {
    const later: CivilDate = '2027-04-17'
    const components = componentsForLineItem({
      lineItem: item({ dueDate: later }),
      commitDate: COMMIT,
      changes: [
        {
          lineItemId: 'li-tickets',
          occurredAt: EDIT,
          before: snap(),
          after: snap({ dueDate: later }),
        },
      ],
    })
    expect(components).toHaveLength(1) // no catch-up component at all
    expect(deliveredByDueDate(components, later)).toBe(60000)
  })

  it('adds a catch-up when the due date is pulled in', () => {
    const sooner: CivilDate = '2026-11-21'
    const components = componentsForLineItem({
      lineItem: item({ dueDate: sooner }),
      commitDate: COMMIT,
      changes: [
        {
          lineItemId: 'li-tickets',
          occurredAt: EDIT,
          before: snap(),
          after: snap({ dueDate: sooner }),
        },
      ],
    })
    expect(components).toHaveLength(2)
    expect(components[1]!.amountCents).toBeGreaterThan(0)
    expect(components[1]!.endDate).toBe(sooner)
    expect(deliveredByDueDate(components, sooner)).toBe(60000)
  })

  it('records no component for an edit that does not move money', () => {
    const components = componentsForLineItem({
      lineItem: item(),
      commitDate: COMMIT,
      changes: [
        { lineItemId: 'li-tickets', occurredAt: EDIT, before: snap(), after: snap() },
      ],
    })
    expect(components).toHaveLength(1)
  })

  it('zeroes out a cancelled item', () => {
    const components = componentsForLineItem({
      lineItem: item({ quantity: 0 }),
      commitDate: COMMIT,
      changes: [
        {
          lineItemId: 'li-tickets',
          occurredAt: EDIT,
          before: snap(),
          after: snap({ quantity: 0 }),
        },
      ],
    })
    expect(deliveredByDueDate(components, DUE)).toBe(0)
  })
})

describe('should-have-saved curve', () => {
  const components = componentsForLineItem({ lineItem: item(), commitDate: COMMIT })

  it('is zero on the commit date and exact on the due date', () => {
    expect(shouldHaveSavedForItem(components, COMMIT, 60000)).toBe(0)
    expect(shouldHaveSavedForItem(components, DUE, 60000)).toBe(60000)
  })

  it('never exceeds the item total, even long after the due date', () => {
    expect(shouldHaveSavedForItem(components, '2030-01-01', 60000)).toBe(60000)
  })

  it('rises monotonically, one step per Saturday', () => {
    // Starts at zero on the commit date, then steps once per transfer.
    let previous = shouldHaveSavedForItem(components, COMMIT, 60000)
    expect(previous).toBe(0)

    let steps = 0
    const cursor = new Date(`${COMMIT}T00:00:00Z`)
    const end = new Date(`${DUE}T00:00:00Z`)
    while (cursor < end) {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      const asOf = cursor.toISOString().slice(0, 10)
      const value = shouldHaveSavedForItem(components, asOf, 60000)
      expect(value).toBeGreaterThanOrEqual(previous)
      if (value > previous) steps += 1
      previous = value
    }
    expect(steps).toBe(transferWeeksBetween(COMMIT, DUE))
    expect(previous).toBe(60000)
  })

  it('errs high on partial progress, so drift flags early rather than late', () => {
    // One transfer in: exact share would be $35.294..., we claim $35.30.
    expect(shouldHaveSavedForItem(components, '2026-09-26', 60000)).toBe(3530)
  })
})

describe('component activity', () => {
  it('stops counting a component once its window has passed', () => {
    const [base] = componentsForLineItem({ lineItem: item(), commitDate: COMMIT })
    expect(isComponentActive(base!, COMMIT)).toBe(true)
    expect(isComponentActive(base!, DUE)).toBe(false)
    expect(isComponentActive(base!, '2030-01-01')).toBe(false)
  })

  it('drops finished components out of the weekly number', () => {
    const components = componentsForLineItem({ lineItem: item(), commitDate: COMMIT })
    expect(weeklyBreakdown(components, DUE).totalPerWeekCents).toBe(0)
  })
})

describe('a repeating part starts its timeline at its last occurrence (PRD D30)', () => {
  // $1,200 every year, next due 15 Nov 2026, committed 26 Sep 2026 (a Saturday).
  // The last one was 15 Nov 2025: 52 Saturday transfers in the cycle, 45 of
  // them already gone by the commit.
  const TODAY: CivilDate = '2026-09-26'
  const NOV: CivilDate = '2026-11-15'
  const yearly = (timelineStart: LineItem['timelineStart']) =>
    item({
      unitAmountCents: 120000,
      dueDate: NOV,
      recurrence: { every: 1, unit: 'year' },
      timelineStart,
    })

  it('runs the base component from the last occurrence at the steady rate', () => {
    const [base, ...rest] = componentsForLineItem({ lineItem: yearly('last_occurrence'), commitDate: TODAY })
    expect(rest).toHaveLength(0)
    expect(base!.startDate).toBe('2025-11-15')
    expect(base!.endDate).toBe(NOV)
    expect(base!.weeks).toBe(52)
    expect(componentRatePerWeekCents(base!)).toBe(2308) // $1,200 ÷ 52, rounded up
    expect(weeklyBreakdown([base!], TODAY).totalPerWeekCents).toBe(2308)
  })

  it('should-hold on the commit day is the elapsed share -- the pace itself -- and the rest is still to set aside', () => {
    const components = componentsForLineItem({ lineItem: yearly('last_occurrence'), commitDate: TODAY })
    const shouldHold = shouldHaveSavedForItem(components, TODAY, 120000)
    expect(shouldHold).toBe(
      evenPaceCents({ totalCents: 120000, fromDate: '2025-11-15', dueDate: NOV, today: TODAY }),
    )
    expect(shouldHold).toBe(103847) // ceil(120000 × 45 / 52)
    expect(120000 - shouldHold).toBe(16153)
    expect(deliveredByDueDate(components, NOV)).toBe(120000)
  })

  it('behaves exactly as before when set to start at the commit', () => {
    const [base] = componentsForLineItem({ lineItem: yearly('commit'), commitDate: TODAY })
    expect(base!.startDate).toBe(TODAY)
    expect(base!.weeks).toBe(7)
    expect(componentRatePerWeekCents(base!)).toBe(17143)
    expect(shouldHaveSavedForItem([base!], TODAY, 120000)).toBe(0)
  })

  it('leaves a one-off unchanged: it has no last time', () => {
    const [base] = componentsForLineItem({
      lineItem: item({ unitAmountCents: 120000, dueDate: NOV, timelineStart: 'commit' }),
      commitDate: TODAY,
    })
    expect(base!.startDate).toBe(TODAY)
  })

  it('starts the next cycle at the spend date under both settings, once confirmed spent and rolled', () => {
    // Confirmed on 20 Nov 2026, rolled to 15 Nov 2027; the last occurrence
    // of the new due date (15 Nov 2026) is before the spend, and the spend wins.
    for (const timelineStart of ['last_occurrence', 'commit'] as const) {
      const [base, ...rest] = componentsForLineItem({
        lineItem: yearly(timelineStart) && item({ ...yearly(timelineStart), dueDate: '2027-11-15' }),
        commitDate: TODAY,
        cycleStartDate: '2026-11-20',
        cycleOrigin: 'rolled',
      })
      expect(rest).toHaveLength(0)
      expect(base!.startDate).toBe('2026-11-20')
      expect(base!.endDate).toBe('2027-11-15')
      expect(shouldHaveSavedForItem([base!], '2026-11-20', 120000)).toBe(0)
    }
  })

  it('runs from the cycle start, not the last occurrence, once the cycle opens with money', () => {
    // Money a person said is there is where the timeline begins: should-hold
    // is exactly that money, never that money plus an elapsed share on top.
    const components = componentsForLineItem({
      lineItem: yearly('last_occurrence'),
      commitDate: TODAY,
      cycleStartDate: TODAY,
      cycleOrigin: 'counted',
      openingCents: 103847,
    })
    expect(components.map((c) => c.kind)).toEqual(['opening', 'base'])
    expect(components[1]!.startDate).toBe(TODAY)
    expect(shouldHaveSavedForItem(components, TODAY, 120000)).toBe(103847)
    // Counted to the pace, the weekly figure is the steady one.
    expect(weeklyBreakdown(components, TODAY).totalPerWeekCents).toBe(2308)
    expect(deliveredByDueDate(components, NOV)).toBe(120000)
  })

  it('keeps an edit working from the edit date on top of the longer base', () => {
    const EDIT: CivilDate = '2026-10-17'
    const components = componentsForLineItem({
      lineItem: item({ ...yearly('last_occurrence'), unitAmountCents: 150000 }),
      commitDate: TODAY,
      changes: [
        {
          lineItemId: 'li-tickets',
          occurredAt: EDIT,
          before: snap({ unitAmountCents: 120000, dueDate: NOV }),
          after: snap({ unitAmountCents: 150000, dueDate: NOV }),
        },
      ],
    })
    expect(components.map((c) => [c.kind, c.startDate])).toEqual([
      ['base', '2025-11-15'],
      ['catch_up', EDIT],
    ])
    expect(components[1]!.amountCents).toBe(30000)
    expect(deliveredByDueDate(components, NOV)).toBe(150000)
  })

  it('offers no opening for a part that already starts at its last occurrence', () => {
    const args = {
      totalCents: 120000,
      dueDate: NOV,
      recurrence: { every: 1, unit: 'year' } as const,
      today: TODAY,
    }
    expect(openingSinceLastOccurrence({ ...args, timelineStart: 'last_occurrence' })).toBeNull()
    expect(openingSinceLastOccurrence({ ...args, timelineStart: 'commit' })).toEqual({
      lastOccurrence: '2025-11-15',
      cents: 103847,
    })
    expect(openingSinceLastOccurrence(args)).toEqual({ lastOccurrence: '2025-11-15', cents: 103847 })
  })
})

describe('"Saving since" is a day a person can give (PRD D33)', () => {
  // The same $1,200 a year, next due 15 Nov 2026, committed 26 Sep 2026.
  const TODAY: CivilDate = '2026-09-26'
  const NOV: CivilDate = '2026-11-15'
  const LAST: CivilDate = '2025-11-15'
  const yearly = (timelineStartDate: CivilDate | null, timelineStart: LineItem['timelineStart'] = 'typed') =>
    item({
      unitAmountCents: 120000,
      dueDate: NOV,
      recurrence: { every: 1, unit: 'year' },
      timelineStart,
      timelineStartDate,
    })
  const steady = componentRatePerWeekCents(
    componentsForLineItem({ lineItem: yearly(null, 'last_occurrence'), commitDate: TODAY })[0]!,
  )

  it('runs the base from the day given at total ÷ the weeks between, so should-hold is the elapsed share from that day', () => {
    const GIVEN: CivilDate = '2026-03-15'
    const [base, ...rest] = componentsForLineItem({ lineItem: yearly(GIVEN), commitDate: TODAY })
    expect(rest).toHaveLength(0)
    expect(base!.startDate).toBe(GIVEN)
    expect(base!.endDate).toBe(NOV)
    expect(base!.weeks).toBe(accrualWeeksBetween(GIVEN, NOV))
    expect(shouldHaveSavedForItem([base!], TODAY, 120000)).toBe(
      evenPaceCents({ totalCents: 120000, fromDate: GIVEN, dueDate: NOV, today: TODAY }),
    )
    expect(deliveredByDueDate([base!], NOV)).toBe(120000)
  })

  it('a day earlier than the last occurrence lowers the weekly figure; a later one raises it', () => {
    const earlier = componentsForLineItem({ lineItem: yearly('2025-06-15'), commitDate: TODAY })
    const later = componentsForLineItem({ lineItem: yearly('2026-03-15'), commitDate: TODAY })
    expect(weeklyBreakdown(earlier, TODAY).totalPerWeekCents).toBeLessThan(steady)
    expect(weeklyBreakdown(later, TODAY).totalPerWeekCents).toBeGreaterThan(steady)
    // And the earlier day already accounts for more of the total.
    expect(shouldHaveSavedForItem(earlier, TODAY, 120000)).toBeGreaterThan(
      shouldHaveSavedForItem(later, TODAY, 120000),
    )
  })

  it('is inert on a cycle a count, a roll or money began: such a cycle runs from the cycle date', () => {
    const GIVEN: CivilDate = '2026-03-15'
    for (const cycle of [
      { cycleStartDate: TODAY, cycleOrigin: 'counted' as const, openingCents: 0 },
      { cycleStartDate: TODAY, cycleOrigin: 'rolled' as const, openingCents: 0 },
      { cycleStartDate: TODAY, cycleOrigin: 'commit' as const, openingCents: 50000 },
    ]) {
      const components = componentsForLineItem({ lineItem: yearly(GIVEN), commitDate: TODAY, ...cycle })
      const base = components.find((c) => c.kind === 'base')!
      expect(base.startDate, JSON.stringify(cycle)).toBe(TODAY)
      expect(deliveredByDueDate(components, NOV)).toBe(120000)
    }
  })

  it('reads a day on or after the cycle start as the cycle start', () => {
    const [base] = componentsForLineItem({
      lineItem: yearly('2026-10-03'),
      commitDate: TODAY,
      cycleStartDate: '2026-10-01',
      cycleOrigin: 'added',
    })
    expect(base!.startDate).toBe('2026-10-01')
    expect(
      baseStartDate({
        timelineStart: 'typed',
        timelineStartDate: TODAY,
        recurrence: { every: 1, unit: 'year' },
        dueDate: NOV,
        cycleStartDate: TODAY,
      }),
    ).toBe(TODAY)
  })

  it('offers no opening for a part that starts at a day given, like one at its last occurrence', () => {
    expect(
      openingSinceLastOccurrence({
        totalCents: 120000,
        dueDate: NOV,
        recurrence: { every: 1, unit: 'year' },
        today: TODAY,
        timelineStart: 'typed',
      }),
    ).toBeNull()
  })

  describe('the date and the reason a screen shows are one decision', () => {
    const args = { recurrence: { every: 1, unit: 'year' } as const, dueDate: NOV, cycleStartDate: TODAY }

    it('names the last occurrence, the plan start, or the day given', () => {
      expect(savingSince({ ...args, timelineStart: 'last_occurrence' })).toEqual({
        date: LAST,
        reason: { kind: 'last_occurrence' },
        chosenDate: null,
      })
      expect(savingSince({ ...args, timelineStart: 'commit' })).toEqual({
        date: TODAY,
        reason: { kind: 'commit' },
        chosenDate: null,
      })
      expect(savingSince({ ...args, timelineStart: 'typed', timelineStartDate: '2026-03-15' })).toEqual({
        date: '2026-03-15',
        reason: { kind: 'typed' },
        chosenDate: null,
      })
    })

    it('says why a cycle runs from its own date, and keeps the day the setting named beside it', () => {
      expect(
        savingSince({ ...args, timelineStart: 'typed', timelineStartDate: '2026-03-15', cycleOrigin: 'counted' }),
      ).toEqual({ date: TODAY, reason: { kind: 'counted', on: TODAY }, chosenDate: '2026-03-15' })
      expect(
        savingSince({ ...args, timelineStart: 'last_occurrence', cycleOrigin: 'rolled' }),
      ).toEqual({ date: TODAY, reason: { kind: 'spent', on: TODAY }, chosenDate: LAST })
      expect(
        savingSince({ ...args, timelineStart: 'last_occurrence', openingCents: 1 }),
      ).toEqual({ date: TODAY, reason: { kind: 'opened', on: TODAY }, chosenDate: LAST })
      // A day given on or after the cycle start: the cycle start, and the reason says which.
      expect(
        savingSince({ ...args, timelineStart: 'typed', timelineStartDate: '2026-10-01', cycleStartDate: '2026-09-30', cycleOrigin: 'added' }),
      ).toEqual({ date: '2026-09-30', reason: { kind: 'added', on: '2026-09-30' }, chosenDate: '2026-10-01' })
      // A one-off names no day.
      expect(savingSince({ ...args, recurrence: null, timelineStart: 'commit', openingCents: 5 })).toEqual({
        date: TODAY,
        reason: { kind: 'commit' },
        chosenDate: null,
      })
    })

    it('always agrees with baseStartDate', () => {
      for (const timelineStart of ['last_occurrence', 'commit', 'typed'] as const) {
        for (const cycleOrigin of ['commit', 'added', 'rolled', 'counted'] as const) {
          for (const openingCents of [0, 100]) {
            const full = { ...args, timelineStart, timelineStartDate: '2026-01-10', cycleOrigin, openingCents }
            expect(savingSince(full).date).toBe(baseStartDate(full))
          }
        }
      }
    })

    it('puts the reason in plain words', () => {
      const f = (d: CivilDate) => `<${d}>`
      expect(savingSinceWords({ kind: 'last_occurrence' })).toBe('the last time this came round')
      expect(savingSinceWords({ kind: 'commit' })).toBe('the day the plan started')
      expect(savingSinceWords({ kind: 'typed' })).toBe('the day you gave')
      expect(savingSinceWords({ kind: 'counted', on: TODAY }, f)).toBe(`this cycle began when it was counted on <${TODAY}>`)
      expect(savingSinceWords({ kind: 'spent', on: TODAY }, f)).toBe(`this cycle began when it was confirmed spent on <${TODAY}>`)
      expect(savingSinceWords({ kind: 'opened', on: TODAY }, f)).toBe(`this cycle opened with money on <${TODAY}>`)
      expect(savingSinceWords({ kind: 'added', on: TODAY }, f)).toBe(`the day it was added to the plan, <${TODAY}>`)
    })
  })

  describe('what a choice may be', () => {
    const recurrence = { every: 1, unit: 'year' } as const

    it('keeps a day on or before today and before the due date, and clears the day under any other kind', () => {
      expect(
        resolveTimelineStart({ recurrence, choice: { kind: 'typed', date: '2026-03-15' }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: true, timelineStart: 'typed', timelineStartDate: '2026-03-15' })
      expect(
        resolveTimelineStart({ recurrence, choice: { kind: 'typed', date: TODAY }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: true, timelineStart: 'typed', timelineStartDate: TODAY })
      expect(
        resolveTimelineStart({ recurrence, choice: { kind: 'last_occurrence', date: '2026-03-15' }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: true, timelineStart: 'last_occurrence', timelineStartDate: null })
      expect(resolveTimelineStart({ recurrence, choice: 'commit', dueDate: NOV, today: TODAY })).toEqual({
        ok: true,
        timelineStart: 'commit',
        timelineStartDate: null,
      })
    })

    it('refuses a missing day, a day after today, or a day not before the due date, in plain words', () => {
      const refused = (choice: { kind: 'typed'; date: CivilDate | null }) =>
        resolveTimelineStart({ recurrence, choice, dueDate: NOV, today: TODAY })
      expect(refused({ kind: 'typed', date: null })).toEqual({ ok: false, problem: 'Pick the day you have been saving for this since.' })
      expect(refused({ kind: 'typed', date: '2026-09-27' })).toEqual({ ok: false, problem: 'The day you have been saving since cannot be after today.' })
      expect(
        resolveTimelineStart({ recurrence, choice: { kind: 'typed', date: '2026-09-20' }, dueDate: '2026-09-20', today: '2026-09-26' }),
      ).toEqual({ ok: false, problem: 'The day you have been saving since has to be before the day it is needed.' })
    })

    it('makes a one-off start at the commit whatever was asked', () => {
      expect(
        resolveTimelineStart({ recurrence: null, choice: { kind: 'typed', date: '2026-03-15' }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: true, timelineStart: 'commit', timelineStartDate: null })
    })

    it('records the D30 kinds as before and a day given with its date', () => {
      expect(timelineStartRecord('last_occurrence', null)).toBe('last_occurrence')
      expect(timelineStartRecord('commit', null)).toBe('commit')
      expect(timelineStartRecord('typed', '2026-03-15')).toEqual({ kind: 'typed', date: '2026-03-15' })
    })
  })
})

describe('invariant: components always deliver exactly the total by the due date', () => {
  // A small deterministic PRNG so a failure is reproducible.
  function rng(seed: number) {
    let s = seed
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  const UNITS = ['day', 'week', 'month', 'year'] as const

  it('holds across randomised edit histories, timeline starts, recurrences and transfer days', () => {
    const random = rng(20260919)
    const trials = Number(process.env.ACCRUAL_INVARIANT_TRIALS ?? 400)

    for (let trial = 0; trial < trials; trial += 1) {
      // The household's transfer day (PRD D31): any of the seven, drawn first
      // so the rest of the history is the same whichever day it lands on.
      const transferWeekday = Math.floor(random() * 7) as Weekday
      const startDue = 30 + Math.floor(random() * 400)
      let current: LineItemSnapshot = {
        unitAmountCents: 1 + Math.floor(random() * 500000),
        quantity: 1 + Math.floor(random() * 5),
        dueDate: addDaysUTC(COMMIT, startDue),
        reserveAccountId: ACCOUNT,
      }
      // Half the trials repeat, on any interval; those start at the last
      // occurrence, the commit, or a day a person gave (D33) at random --
      // any day up to two years before the commit, and sometimes after it --
      // and half of them sit in a cycle that a spend, an add or a count
      // began, with or without money.
      const recurrence =
        random() < 0.5
          ? null
          : { every: 1 + Math.floor(random() * 12), unit: UNITS[Math.floor(random() * UNITS.length)]! }
      const startDraw = random()
      const timelineStart = !recurrence
        ? 'commit'
        : startDraw < 1 / 3
          ? 'last_occurrence'
          : startDraw < 2 / 3
            ? 'commit'
            : 'typed'
      const timelineStartDate =
        timelineStart === 'typed' ? addDaysUTC(COMMIT, Math.floor(random() * 760) - 730) : null
      const cycleDraw = [random(), random(), random(), random()] as const

      const changes: LineItemChange[] = []
      let editOffset = 0
      const editCount = Math.floor(random() * 5)

      for (let e = 0; e < editCount; e += 1) {
        editOffset += 1 + Math.floor(random() * 40)
        const before = current
        const after: LineItemSnapshot = {
          unitAmountCents: 1 + Math.floor(random() * 500000),
          quantity: Math.floor(random() * 6), // 0 = cancellation
          // Due date may move either direction, but stays after the edit.
          dueDate: addDaysUTC(COMMIT, editOffset + 1 + Math.floor(random() * 400)),
          reserveAccountId: ACCOUNT,
        }
        changes.push({
          lineItemId: 'li-tickets',
          occurredAt: addDaysUTC(COMMIT, editOffset),
          before,
          after,
        })
        current = after
      }

      // A cycle can only begin before the part is due: a roll moves the due
      // date with it, and nothing else starts a cycle on a part that is over.
      const daysToFinalDue = Math.round(
        (Date.parse(`${current.dueDate}T00:00:00Z`) - Date.parse(`${COMMIT}T00:00:00Z`)) / 86_400_000,
      )
      const cycle =
        cycleDraw[0] < 0.5
          ? undefined
          : {
              cycleStartDate: addDaysUTC(COMMIT, Math.floor(cycleDraw[1] * Math.min(20, daysToFinalDue))),
              cycleOrigin: (['added', 'rolled', 'counted', 'commit'] as const)[Math.floor(cycleDraw[2] * 4)],
              openingCents: cycleDraw[3] < 0.5 ? 0 : Math.floor(cycleDraw[3] * 300000),
            }

      const finalItem = item({
        unitAmountCents: current.unitAmountCents,
        quantity: current.quantity,
        dueDate: current.dueDate,
        recurrence,
        timelineStart,
        timelineStartDate,
      })
      const components = componentsForLineItem({
        lineItem: finalItem,
        commitDate: COMMIT,
        changes,
        ...cycle,
        transferWeekday,
      })

      expect(
        deliveredByDueDate(components, current.dueDate, transferWeekday),
        `trial ${trial}: ${JSON.stringify({ transferWeekday, changes, final: current, recurrence, timelineStart, timelineStartDate, cycle })}`,
      ).toBe(lineItemTotalCents(finalItem))

      // Every component's week count is the transfer count of its own window
      // on this household's day; a Saturday count would read one off at the edges.
      for (const c of components) {
        if (c.kind === 'opening') continue
        expect(c.weeks, `trial ${trial}: weeks of ${JSON.stringify(c)}`).toBe(
          Math.max(1, transferWeeksBetween(c.startDate, c.endDate, transferWeekday)),
        )
      }
    }
  })

  it('never under-funds when the rounded-up weekly rates are actually transferred', () => {
    const random = rng(1)
    for (let trial = 0; trial < 200; trial += 1) {
      const transferWeekday = Math.floor(random() * 7) as Weekday
      const total = 1 + Math.floor(random() * 500000)
      const days = 7 + Math.floor(random() * 500)
      const due = addDaysUTC(COMMIT, days)
      const [base] = componentsForLineItem({
        lineItem: item({ unitAmountCents: total, quantity: 1, dueDate: due }),
        commitDate: COMMIT,
        transferWeekday,
      })
      const transferred = componentRatePerWeekCents(base!) * base!.weeks
      expect(transferred).toBeGreaterThanOrEqual(total)
    }
  })
})

describe('a Friday household (the transfer day is a setting, PRD D31)', () => {
  const FRIDAY: Weekday = 5

  it('divides by the count of Fridays, and reads one more week than Saturday counting at the edge', () => {
    // Due Friday 15 Jan 2027, committed Saturday 19 Sep 2026: 17 Fridays land
    // before the money is needed, where Saturday counting saw 16.
    const friday = componentsForLineItem({
      lineItem: item({ dueDate: '2027-01-15' }),
      commitDate: COMMIT,
      transferWeekday: FRIDAY,
    })[0]!
    const saturday = componentsForLineItem({ lineItem: item({ dueDate: '2027-01-15' }), commitDate: COMMIT })[0]!
    expect(friday.weeks).toBe(17)
    expect(saturday.weeks).toBe(16)
    expect(componentRatePerWeekCents(friday)).toBe(Math.ceil(60000 / 17))
    expect(weeklyBreakdown([friday], COMMIT, 0, FRIDAY).totalPerWeekCents).toBe(Math.ceil(60000 / 17))
  })

  it('steps on Fridays: delivered rises the day money moves, not the day after', () => {
    const [base] = componentsForLineItem({ lineItem: item(), commitDate: COMMIT, transferWeekday: FRIDAY })
    // Thu 24 Sep: nothing has moved. Fri 25 Sep: one transfer. Sat 26 Sep: still one.
    expect(componentDeliveredBy(base!, '2026-09-24', FRIDAY)).toBe(0)
    expect(componentDeliveredBy(base!, '2026-09-25', FRIDAY)).toBe(Math.ceil(60000 / 17))
    expect(componentDeliveredBy(base!, '2026-09-26', FRIDAY)).toBe(Math.ceil(60000 / 17))
    // Read with the wrong day, the same component would claim nothing on the Friday.
    expect(componentDeliveredBy(base!, '2026-09-25')).toBe(0)
  })

  it('agrees between the pace and the plan on a Friday, as it does on a Saturday', () => {
    const [base] = componentsForLineItem({
      lineItem: item({ dueDate: '2027-01-15' }),
      commitDate: COMMIT,
      transferWeekday: FRIDAY,
    })
    for (const day of ['2026-09-25', '2026-10-30', '2026-12-31', '2027-01-15']) {
      expect(
        evenPaceCents({ totalCents: 60000, fromDate: COMMIT, dueDate: '2027-01-15', today: day, transferWeekday: FRIDAY }),
      ).toBe(componentDeliveredBy(base!, day, FRIDAY))
    }
  })

  it('prices an edit on the Friday count, and still lands on the total', () => {
    const changes: LineItemChange[] = [
      {
        lineItemId: 'li-tickets',
        occurredAt: '2026-11-04', // a Wednesday
        before: snap({ dueDate: '2027-01-15' }),
        after: snap({ dueDate: '2027-01-15', quantity: 2 }),
      },
    ]
    const components = componentsForLineItem({
      lineItem: item({ dueDate: '2027-01-15', quantity: 2 }),
      commitDate: COMMIT,
      changes,
      transferWeekday: FRIDAY,
    })
    const catchUp = components.find((c) => c.kind === 'catch_up')!
    // Wed 4 Nov -> Fri 15 Jan: Fridays Nov 6 .. Jan 15, eleven of them.
    expect(catchUp.weeks).toBe(11)
    expect(catchUp.amountCents).toBe(60000)
    expect(deliveredByDueDate(components, '2027-01-15', FRIDAY)).toBe(120000)
    expect(respreadEquivalentPerWeekCents({ remainingCents: 1100, asOf: '2026-11-04', dueDate: '2027-01-15', transferWeekday: FRIDAY })).toBe(100)
  })

  it('samples the curve one point per Friday transfer', () => {
    const [base] = componentsForLineItem({ lineItem: item(), commitDate: COMMIT, transferWeekday: FRIDAY })
    const points = accrualCurve({ components: [base!], from: COMMIT, to: DUE, transferWeekday: FRIDAY })
    expect(points).toHaveLength(transferWeeksBetween(COMMIT, DUE, FRIDAY) + 1)
    expect(points.at(-1)).toEqual({ date: DUE, cents: 60000 })
  })
})

function addDaysUTC(d: CivilDate, days: number): CivilDate {
  const base = new Date(`${d}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

describe('the should-have-saved curve', () => {
  const components = componentsForLineItem({ lineItem: item(), commitDate: COMMIT })

  it('starts at zero and ends exactly on the total', () => {
    const points = accrualCurve({ components, from: COMMIT, to: DUE, capCents: 60000 })
    expect(points[0]).toEqual({ date: COMMIT, cents: 0 })
    expect(points.at(-1)).toEqual({ date: DUE, cents: 60000 })
  })

  it('never goes down', () => {
    const points = accrualCurve({ components, from: COMMIT, to: DUE, capCents: 60000 })
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.cents).toBeGreaterThanOrEqual(points[i - 1]!.cents)
    }
  })

  it('samples one point per transfer week over a short horizon', () => {
    const points = accrualCurve({ components, from: COMMIT, to: DUE, capCents: 60000 })
    // 17 transfer weeks plus the starting point.
    expect(points).toHaveLength(18)
  })

  it('thins the sampling over a long horizon rather than returning hundreds of points', () => {
    const long = componentsForLineItem({
      lineItem: item({ dueDate: '2031-09-19' }),
      commitDate: COMMIT,
    })
    const points = accrualCurve({
      components: long,
      from: COMMIT,
      to: '2031-09-19',
      capCents: 60000,
      maxPoints: 40,
    })
    expect(points.length).toBeLessThanOrEqual(42)
    expect(points.at(-1)!.date).toBe('2031-09-19')
    expect(points.at(-1)!.cents).toBe(60000)
  })

  it('degrades to a single point when there is no time to plot', () => {
    expect(accrualCurve({ components, from: DUE, to: DUE, capCents: 60000 })).toHaveLength(1)
  })
})

describe('what a recurring item would already have set aside', () => {
  // $1,200 due 15 Feb 2027, every year: the last one was 15 Feb 2026, and
  // saving since then would be 31 Saturday transfers into a 52-week cycle.
  it('prices the elapsed part of the cycle exactly as a committed item would', () => {
    const suggestion = openingSinceLastOccurrence({
      totalCents: 120000,
      dueDate: '2027-02-15',
      recurrence: { every: 1, unit: 'year' },
      today: '2026-09-19',
    })
    expect(suggestion).toEqual({ lastOccurrence: '2026-02-15', cents: 71539 })
  })

  it('has nothing to say for a one-off, or a cycle that has not started', () => {
    expect(
      openingSinceLastOccurrence({ totalCents: 120000, dueDate: '2027-02-15', recurrence: null, today: '2026-09-19' }),
    ).toBeNull()
    // Due in three weeks, every 2 weeks: the previous one is still ahead of us.
    expect(
      openingSinceLastOccurrence({
        totalCents: 5000,
        dueDate: '2026-10-10',
        recurrence: { every: 2, unit: 'week' },
        today: '2026-09-19',
      }),
    ).toBeNull()
  })

  it('never suggests more than the item costs', () => {
    // Due tomorrow, every month: nearly the whole cycle has elapsed.
    const suggestion = openingSinceLastOccurrence({
      totalCents: 9900,
      dueDate: '2026-09-20',
      recurrence: { every: 1, unit: 'month' },
      today: '2026-09-19',
    })
    expect(suggestion!.cents).toBeLessThanOrEqual(9900)
    expect(suggestion!.cents).toBeGreaterThan(0)
  })
})

describe('the even pace', () => {
  it('is nothing before the window opens, everything once the date is here, and never more than the total', () => {
    const window = { totalCents: 84400, fromDate: '2026-07-09', dueDate: '2027-01-09' } as const
    expect(evenPaceCents({ ...window, today: '2026-07-09' })).toBe(0)
    expect(evenPaceCents({ ...window, today: '2026-07-01' })).toBe(0)
    expect(evenPaceCents({ ...window, today: '2027-01-09' })).toBe(84400)
    expect(evenPaceCents({ ...window, today: '2027-03-01' })).toBe(84400)
    expect(evenPaceCents({ ...window, totalCents: 0, today: '2026-09-19' })).toBe(0)
  })

  it('is the same arithmetic as the opening suggested for a repeating part', () => {
    const suggestion = openingSinceLastOccurrence({
      totalCents: 120000,
      dueDate: '2027-02-15',
      recurrence: { every: 1, unit: 'year' },
      today: '2026-09-19',
    })!
    expect(
      evenPaceCents({ totalCents: 120000, fromDate: suggestion.lastOccurrence, dueDate: '2027-02-15', today: '2026-09-19' }),
    ).toBe(suggestion.cents)
  })
})
