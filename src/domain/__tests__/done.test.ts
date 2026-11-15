import { describe, expect, it } from 'vitest'
import { doneAmountFromForm, donePressSentence, donePressesOf, todoKey, type DoneEventRow } from '../done'

const T0 = 1_790_000_000_000_000

/** Rows recorded one microsecond apart in the order given. */
function rows(list: (Omit<DoneEventRow, 'recordedAtMicros' | 'actorUserId'> & { actorUserId?: string | null })[]): DoneEventRow[] {
  return list.map((r, i) => ({ actorUserId: 'alex', ...r, recordedAtMicros: String(T0 + i) }))
}

const transferPress = (group: string, on: string, id = group) => [
  { id: `${id}-i`, kind: 'instruction_issued', on, payload: { instruction_id: id, type: 'set_weekly_transfer', amount_cents: 42000, target_id: 'annual', target_label: 'Annual Expenses', group_id: group } },
  { id: `${id}-c`, kind: 'instruction_confirmed', on, payload: { instruction_id: id, actual_amount_cents: null } },
]

// 2026-11-14 is a Saturday, the default transfer day.
describe('Done lately (D62)', () => {
  it('lists a press with who made it, undoable until the next transfer day', () => {
    const log = rows(transferPress('g1', '2026-11-14'))
    const [press] = donePressesOf({ rows: log, today: '2026-11-20' })
    expect(press).toMatchObject({ groupId: 'g1', actorUserId: 'alex', accountIds: ['annual'], undoable: true })
    expect(press!.lines).toEqual([
      { instructionId: 'g1', issuedEventId: 'g1-i', type: 'set_weekly_transfer', amountCents: 42000, targetId: 'annual', targetLabel: 'Annual Expenses' },
    ])
    // A week on, the next transfer day has come, and the press has left the list.
    expect(donePressesOf({ rows: log, today: '2026-11-21' })).toEqual([])
  })

  it('follows the household transfer day, not Saturday', () => {
    const log = rows(transferPress('g1', '2026-11-14'))
    // Transfer on Mondays (1): the 16th is the next one.
    expect(donePressesOf({ rows: log, today: '2026-11-15', transferWeekday: 1 })[0]!.undoable).toBe(true)
    expect(donePressesOf({ rows: log, today: '2026-11-16', transferWeekday: 1 })[0]!.undoable).toBe(false)
  })

  it('closes Undo once an account it touched is counted, and only then', () => {
    const counted = rows([
      ...transferPress('g1', '2026-11-14'),
      { id: 'c1', kind: 'balance_confirmed', on: '2026-11-14', payload: { reserve_account_id: 'annual', amount_cents: 100 } },
    ])
    expect(donePressesOf({ rows: counted, today: '2026-11-15' })[0]!.undoable).toBe(false)
    const countedBefore = rows([
      { id: 'c1', kind: 'balance_confirmed', on: '2026-11-14', payload: { reserve_account_id: 'annual', amount_cents: 100 } },
      ...transferPress('g1', '2026-11-14'),
    ])
    expect(donePressesOf({ rows: countedBefore, today: '2026-11-15' })[0]!.undoable).toBe(true)
    const otherAccount = rows([
      ...transferPress('g1', '2026-11-14'),
      { id: 'c1', kind: 'balance_confirmed', on: '2026-11-14', payload: { reserve_account_id: 'car', amount_cents: 100 } },
    ])
    expect(donePressesOf({ rows: otherAccount, today: '2026-11-15' })[0]!.undoable).toBe(true)
  })

  it('reads a move between accounts as one press, out then in, touching both', () => {
    const log = rows([
      { id: 'i-i', kind: 'instruction_issued', on: '2026-11-14', payload: { instruction_id: 'in', type: 'one_time_move', amount_cents: 4346, target_id: 'car', target_label: 'Car & Home', group_id: 'g2' } },
      { id: 'i-c', kind: 'instruction_confirmed', on: '2026-11-14', payload: { instruction_id: 'in', actual_amount_cents: null } },
      { id: 'o-i', kind: 'instruction_issued', on: '2026-11-14', payload: { instruction_id: 'out', type: 'one_time_move_out', amount_cents: 4346, target_id: 'annual', target_label: 'Annual Expenses', group_id: 'g2' } },
      { id: 'o-c', kind: 'instruction_confirmed', on: '2026-11-14', payload: { instruction_id: 'out', actual_amount_cents: null } },
    ])
    const presses = donePressesOf({ rows: log, today: '2026-11-14' })
    expect(presses).toHaveLength(1)
    expect(presses[0]!.lines.map((l) => l.type)).toEqual(['one_time_move_out', 'one_time_move'])
    expect(presses[0]!.accountIds.sort()).toEqual(['annual', 'car'])
  })

  it('leaves out undone presses, presses older than a week, asks never confirmed, and old Done without a group', () => {
    const log = rows([
      ...transferPress('undone', '2026-11-14'),
      { id: 'u', kind: 'event_undone', on: '2026-11-14', payload: { event_id: 'undone-i', instruction_id: 'undone', group_id: 'undone' } },
      ...transferPress('old', '2026-11-07'),
      { id: 'ask', kind: 'instruction_issued', on: '2026-11-14', payload: { instruction_id: 'ask', type: 'one_time_move', amount_cents: 1, target_id: 'annual', target_label: 'A', group_id: 'g9' } },
      { id: 'legacy-i', kind: 'instruction_issued', on: '2026-11-14', payload: { instruction_id: 'legacy', type: 'set_weekly_transfer', amount_cents: 1, target_id: 'annual', target_label: 'A' } },
      { id: 'legacy-c', kind: 'instruction_confirmed', on: '2026-11-14', payload: { instruction_id: 'legacy', actual_amount_cents: null } },
      ...transferPress('kept', '2026-11-08'),
    ])
    expect(donePressesOf({ rows: log, today: '2026-11-14' }).map((p) => p.groupId)).toEqual(['kept'])
  })

  it('lists the newest press first', () => {
    const log = rows([...transferPress('first', '2026-11-14'), ...transferPress('second', '2026-11-14')])
    expect(donePressesOf({ rows: log, today: '2026-11-14' }).map((p) => p.groupId)).toEqual(['second', 'first'])
  })
})

describe('what a to-do form records (D62)', () => {
  it('records the button figure when the button was pressed', () => {
    expect(doneAmountFromForm({ typed: null, its: '42000' })).toBe(42000)
  })
  it('records what was typed, which an empty box never is', () => {
    expect(doneAmountFromForm({ typed: '415.50', its: null })).toBe(41550)
    expect(doneAmountFromForm({ typed: '  ', its: null })).toBeNull()
    expect(doneAmountFromForm({ typed: null, its: null })).toBeNull()
  })
  it('records nothing for junk or a negative figure', () => {
    expect(doneAmountFromForm({ typed: 'lots', its: null })).toBeNull()
    expect(doneAmountFromForm({ typed: '-5', its: null })).toBeNull()
    expect(doneAmountFromForm({ typed: null, its: '4.20' })).toBeNull()
  })
})

describe('a to-do key', () => {
  it('names the kind and the accounts, not the amount', () => {
    expect(todoKey({ kind: 'set_transfer', accountId: 'a', accountName: 'A', fromCents: 100, toCents: 200, reason: 'raise', blocking: true } as never)).toBe('set_transfer:a')
    expect(todoKey({ kind: 'move_between', fromAccountId: 'a', fromAccountName: 'A', accountId: 'b', accountName: 'B', amountCents: 5, byDate: '2026-12-01', blocking: true })).toBe('move_between:a:b')
  })
})

describe('what a press says', () => {
  const line = (type: string, amountCents: number, targetLabel: string) => ({ instructionId: 'i', issuedEventId: 'e', type, amountCents, targetId: 't', targetLabel })
  it('says a transfer, a move in and a move between accounts in words', () => {
    expect(donePressSentence({ lines: [line('set_weekly_transfer', 42000, 'Annual Expenses')] })).toBe('Annual Expenses moves $420.00 a week')
    expect(donePressSentence({ lines: [line('one_time_move', 5000, 'Car & Home')] })).toBe('Moved $50.00 into Car & Home')
    expect(donePressSentence({ lines: [line('one_time_move_out', 4346, 'Annual Expenses'), line('one_time_move', 4346, 'Car & Home')] })).toBe(
      'Moved $43.46 from Annual Expenses into Car & Home',
    )
  })
})
