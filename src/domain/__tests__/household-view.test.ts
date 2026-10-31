/**
 * The household view (D56): one list of what to do, whether the household
 * is caught up, and what needs attention, from the position, the debts and
 * the asks still open.
 */

import { describe, expect, it } from 'vitest'
import { position, type PositionInput } from '../position'
import { debtStatuses } from '../debt-status'
import { householdView } from '../household-view'
import type { OutstandingInstruction } from '../instructions'
import type { LineItem, Package, ReserveAccount } from '../types'

const TODAY = '2026-09-28'
const account = (id: string, name: string): ReserveAccount => ({
  id,
  householdId: 'hh',
  name,
  institutionLabel: name,
  scope: 'household',
  ownerUserId: null,
  active: true,
})
const soon = account('soon', 'Soon')
const fun = account('fun', 'Fun Money')
const plan: Package = {
  id: 'pkg',
  householdId: 'hh',
  name: 'Party',
  state: 'active',
  module: 'manual',
  detail: null,
  createdAt: '2026-09-01',
  committedAt: '2026-09-01',
}
const party: LineItem = {
  id: 'party',
  packageId: 'pkg',
  label: 'Party',
  unitAmountCents: 50000,
  quantity: 1,
  dueDate: '2026-10-09',
  reserveAccountId: soon.id,
  state: 'accruing',
  recurrence: null,
  timelineStart: 'commit',
  timelineStartDate: null,
}
const facts: PositionInput = {
  today: TODAY,
  accounts: [soon, fun],
  packages: [plan],
  lineItems: [party],
  counts: [
    { accountId: soon.id, amountCents: 0, on: TODAY },
    { accountId: fun.id, amountCents: 0, on: TODAY },
  ],
  transfers: [
    { accountId: soon.id, perWeekCents: 0, confirmedOn: '2026-09-01' },
    { accountId: fun.id, perWeekCents: 0, confirmedOn: '2026-09-01' },
  ],
}
const ask = (over: Partial<OutstandingInstruction> & Pick<OutstandingInstruction, 'instructionId' | 'targetId'>): OutstandingInstruction => ({
  type: 'one_time_move',
  issuedOn: TODAY,
  amountCents: 50000,
  targetLabel: over.targetId,
  purpose: 'cover',
  ageInDays: 0,
  dueNow: true,
  ...over,
})
const noDebts = debtStatuses({ debts: [], today: TODAY })
const viewOf = (open: OutstandingInstruction[]) =>
  householdView({
    position: position({ ...facts, onItsWay: open.map((i) => ({ accountId: i.targetId, amountCents: i.amountCents })) }),
    debts: noDebts,
    open,
  })

describe('the household view (D56)', () => {
  it('lists an open ask that fixes a Short account as one the household waits on', () => {
    const view = viewOf([ask({ instructionId: 'cover', targetId: soon.id })])
    // The derived move is the ask itself (D56 (2)): nothing is asked twice.
    expect(view.todos.map((t) => [t.from, t.blocking])).toEqual([['ask', true]])
    expect(view.caughtUp).toBe(false)
    expect(view.blockingCount).toBe(1)
    expect(view.headline).toBe('One account needs you')
    expect(view.moneyToDo).toBe(true)
  })

  it('calls an ask that lowers nothing optional, and says so while caught up', () => {
    const fine = householdView({
      position: position({ ...facts, lineItems: [] }),
      debts: noDebts,
      open: [ask({ instructionId: 'fun', targetId: fun.id, purpose: 'share_out' })],
    })
    expect(fine.todos.map((t) => [t.from, t.blocking])).toEqual([['ask', false]])
    expect(fine.caughtUp).toBe(true)
    expect(fine.optionalCount).toBe(1)
    expect(fine.headline).toBe('Nothing needs you')
  })

  it('lists asks not yet available apart, and never as blocking', () => {
    const view = viewOf([ask({ instructionId: 'later', targetId: fun.id, purpose: 'share_out', dueNow: false })])
    expect(view.todos.some((t) => t.from === 'ask')).toBe(false)
    expect(view.comingUp.map((i) => i.instructionId)).toEqual(['later'])
  })

  it('reads an ask open a week as waiting too long', () => {
    const view = viewOf([ask({ instructionId: 'old', targetId: soon.id, ageInDays: 7 })])
    expect(view.todos[0]).toMatchObject({ from: 'ask', stale: true })
  })

  it('puts the position’s to-dos first, and is not caught up while one blocks', () => {
    const view = viewOf([])
    expect(view.todos.map((t) => t.from)).toEqual(['position'])
    expect(view.caughtUp).toBe(false)
    expect(view.optionalCount).toBe(0)
  })
})
