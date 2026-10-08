import { describe, expect, it } from 'vitest'
import { packageViews } from '../rollup'
import type { LineItem, Package } from '../types'

// Plans as a list (D35): each package with its parts and what they cost.
// How a plan stands is the one position's; see position.test.ts.

const TODAY = '2026-09-19'

const plan: Package = {
  id: 'pkg',
  householdId: 'hh',
  name: 'Disney Feb 2027',
  state: 'active',
  module: 'manual',
  detail: null,
  createdAt: TODAY,
  committedAt: TODAY,
}

function li(over: Partial<LineItem> & Pick<LineItem, 'id'>): LineItem {
  return {
    packageId: 'pkg',
    label: over.id,
    unitAmountCents: 60000,
    quantity: 3,
    dueDate: '2027-01-16',
    reserveAccountId: 'acct',
    state: 'accruing',
    recurrence: null,
    timelineStart: 'commit',
    timelineStartDate: null,
    ...over,
  }
}

describe('plans as a list', () => {
  it('groups parts under their plan and adds up what the live ones cost', () => {
    const [view] = packageViews({
      today: TODAY,
      packages: [plan],
      lineItems: [
        li({ id: 'tickets' }),
        li({ id: 'airfare', unitAmountCents: 45000, dueDate: '2026-11-21' }),
        li({ id: 'gone', state: 'retired' }),
        li({ id: 'elsewhere', packageId: 'other' }),
      ],
    })
    expect(view!.items.map((i) => i.lineItem.id)).toEqual(['tickets', 'airfare', 'gone'])
    // $1,800 + $1,350; the retired part is listed but not counted.
    expect(view!.totalCents).toBe(315000)
  })

  it('flags a part past its date and not yet confirmed spent', () => {
    const [view] = packageViews({
      today: '2027-01-17',
      packages: [plan],
      lineItems: [li({ id: 'late' }), li({ id: 'done', state: 'retired' })],
    })
    expect(view!.items.map((i) => i.isOverdue)).toEqual([true, false])
  })
})
