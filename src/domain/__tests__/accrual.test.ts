import { describe, expect, it } from 'vitest'
import {
  componentDeliveredBy,
  componentRatePerWeekCents,
  componentsForLineItem,
  isComponentActive,
  respreadEquivalentPerWeekCents,
  shouldHaveSavedForItem,
  weeklyBreakdown,
  type RateComponent,
} from '../accrual'
import { transferWeeksBetween, type CivilDate } from '../dates'
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
function deliveredByDueDate(components: readonly RateComponent[], dueDate: CivilDate): number {
  return components.reduce((sum, c) => sum + componentDeliveredBy(c, dueDate), 0)
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

describe('invariant: components always deliver exactly the total by the due date', () => {
  // A small deterministic PRNG so a failure is reproducible.
  function rng(seed: number) {
    let s = seed
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  it('holds across randomised edit histories', () => {
    const random = rng(20260919)

    for (let trial = 0; trial < 400; trial += 1) {
      const startDue = 30 + Math.floor(random() * 400)
      let current: LineItemSnapshot = {
        unitAmountCents: 1 + Math.floor(random() * 500000),
        quantity: 1 + Math.floor(random() * 5),
        dueDate: addDaysUTC(COMMIT, startDue),
        reserveAccountId: ACCOUNT,
      }

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

      const finalItem = item({
        unitAmountCents: current.unitAmountCents,
        quantity: current.quantity,
        dueDate: current.dueDate,
      })
      const components = componentsForLineItem({
        lineItem: finalItem,
        commitDate: COMMIT,
        changes,
      })

      expect(
        deliveredByDueDate(components, current.dueDate),
        `trial ${trial}: ${JSON.stringify({ changes, final: current })}`,
      ).toBe(lineItemTotalCents(finalItem))
    }
  })

  it('never under-funds when the rounded-up weekly rates are actually transferred', () => {
    const random = rng(1)
    for (let trial = 0; trial < 200; trial += 1) {
      const total = 1 + Math.floor(random() * 500000)
      const days = 7 + Math.floor(random() * 500)
      const due = addDaysUTC(COMMIT, days)
      const [base] = componentsForLineItem({
        lineItem: item({ unitAmountCents: total, quantity: 1, dueDate: due }),
        commitDate: COMMIT,
      })
      const transferred = componentRatePerWeekCents(base!) * base!.weeks
      expect(transferred).toBeGreaterThanOrEqual(total)
    }
  })
})

function addDaysUTC(d: CivilDate, days: number): CivilDate {
  const base = new Date(`${d}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}
