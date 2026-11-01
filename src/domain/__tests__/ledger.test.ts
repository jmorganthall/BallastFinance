import { describe, expect, it } from 'vitest'
import { ledgerOf, type RecordedEvent } from '../ledger'

/** Events recorded one microsecond apart, in the order given, unless `at` says otherwise. */
function log(rows: (Omit<RecordedEvent, 'recordedAtMicros' | 'on'> & { at?: number; on?: string })[]): RecordedEvent[] {
  return rows.map((r, i) => ({
    id: r.id,
    kind: r.kind,
    on: r.on ?? '2026-10-24',
    recordedAtMicros: String(r.at ?? 1_790_000_000_000_000 + i),
    payload: r.payload,
  }))
}

const items = [{ id: 'part', reserveAccountId: 'gifts' }]

describe('the ledger', () => {
  it('counts moves and spends recorded after the latest count only', () => {
    const ledger = ledgerOf({
      events: log([
        { id: 'e1', kind: 'instruction_issued', payload: { instruction_id: 'm1', type: 'one_time_move', amount_cents: 500, target_id: 'gifts', target_label: 'Gifts' } },
        { id: 'e2', kind: 'instruction_confirmed', payload: { instruction_id: 'm1', actual_amount_cents: null } },
        { id: 'e3', kind: 'balance_confirmed', payload: { reserve_account_id: 'gifts', amount_cents: 10000 } },
        { id: 'e4', kind: 'spend_recorded', payload: { line_item_id: 'part', round_due: '2026-10-03', amount_cents: 700 } },
      ]),
      lineItems: items,
      debts: [],
    })
    expect(ledger.counts).toEqual([{ accountId: 'gifts', amountCents: 10000, on: '2026-10-24' }])
    expect(ledger.movesSinceCount).toEqual([])
    expect(ledger.spendsSinceCount).toEqual([{ accountId: 'gifts', amountCents: 700 }])
  })

  it('orders by when recorded, not by how the rows came back', () => {
    const rows = log([
      { id: 'e1', kind: 'spend_recorded', payload: { line_item_id: 'part', round_due: '2026-10-03', amount_cents: 700 } },
      { id: 'e2', kind: 'balance_confirmed', payload: { reserve_account_id: 'gifts', amount_cents: 10000 } },
    ])
    const ledger = ledgerOf({ events: [...rows].reverse(), lineItems: items, debts: [] })
    // The count came after the spend, so it includes it.
    expect(ledger.spendsSinceCount).toEqual([])
  })

  it('counts "Done" once, even when the confirmation sorts before its issue', () => {
    const same = 1_790_000_000_000_000
    const ledger = ledgerOf({
      events: log([
        // Written in one transaction: the same moment, so the ids decide.
        { id: 'a', kind: 'instruction_confirmed', at: same, payload: { instruction_id: 't1', actual_amount_cents: 1200 } },
        { id: 'b', kind: 'instruction_issued', at: same, payload: { instruction_id: 't1', type: 'set_weekly_transfer', amount_cents: 1000, target_id: 'gifts', target_label: 'Gifts' } },
        { id: 'c', kind: 'instruction_confirmed', at: same + 5, payload: { instruction_id: 't1', actual_amount_cents: 9900 } },
      ]),
      lineItems: items,
      debts: [],
    })
    expect(ledger.transfers).toEqual([{ accountId: 'gifts', perWeekCents: 1200, confirmedOn: '2026-10-24' }])
    expect(ledger.confirmed).toEqual([{ instructionId: 't1', confirmedOn: '2026-10-24', actualAmountCents: 1200 }])
  })

  it('leaves out what was taken back, except in the round log', () => {
    const ledger = ledgerOf({
      events: log([
        { id: 's1', kind: 'spend_recorded', payload: { line_item_id: 'part', round_due: '2026-10-03', amount_cents: 700 } },
        { id: 'u1', kind: 'event_undone', payload: { event_id: 's1' } },
      ]),
      lineItems: items,
      debts: [],
    })
    expect(ledger.spendsSinceCount).toEqual([])
    expect(ledger.roundEvents).toEqual([])
    expect(ledger.roundLog).toEqual([expect.objectContaining({ eventId: 's1', undone: true, amountCents: 700 })])
  })

  it('puts a spend in the account recorded on it, and an older one in its part’s account', () => {
    const ledger = ledgerOf({
      events: log([
        { id: 's1', kind: 'spend_recorded', payload: { line_item_id: 'part', reserve_account_id: 'fun', round_due: '2026-10-03', amount_cents: 700 } },
        { id: 's2', kind: 'spend_recorded', payload: { line_item_id: 'part', round_due: '2026-10-03', amount_cents: 100 } },
        // A part since deleted, with nothing recorded on the spend: no account to say.
        { id: 's3', kind: 'spend_recorded', payload: { line_item_id: 'gone', round_due: '2026-10-03', amount_cents: 50 } },
      ]),
      lineItems: items,
      debts: [],
    })
    expect(ledger.spendsSinceCount).toEqual([
      { accountId: 'fun', amountCents: 700 },
      { accountId: 'gifts', amountCents: 100 },
    ])
  })

  it('puts an old spend in the account its part was in when it was recorded', () => {
    const move = (id: string, from: string, to: string) => ({
      id,
      kind: 'line_item_changed',
      payload: {
        line_item_id: 'part',
        before: { unitAmountCents: 100, quantity: 1, dueDate: '2026-12-01', reserveAccountId: from },
        after: { unitAmountCents: 100, quantity: 1, dueDate: '2026-12-01', reserveAccountId: to },
      },
    })
    const spend = (id: string, cents: number, line = 'part') => ({
      id,
      kind: 'spend_recorded',
      payload: { line_item_id: line, round_due: '2026-12-01', amount_cents: cents },
    })
    const ledger = ledgerOf({
      events: log([
        spend('s1', 100), // before any move: in the account it was moved out of
        move('m1', 'annual', 'gifts'),
        spend('s2', 20), // between the moves: where the first move put it
        move('m2', 'gifts', 'fun'),
        spend('s3', 3), // after the last move: where it is now
        // A part deleted with its plan, never moved: where the deletion says it was.
        { id: 'd', kind: 'package_deleted', payload: { package_id: 'p', line_items: [{ line_item_id: 'gone', reserve_account_id: 'gifts' }] } },
        spend('s4', 4000, 'gone'),
      ]),
      lineItems: [{ id: 'part', reserveAccountId: 'fun' }],
      debts: [],
    })
    expect(ledger.spendsSinceCount).toEqual([
      { accountId: 'annual', amountCents: 100 },
      { accountId: 'gifts', amountCents: 4020 },
      { accountId: 'fun', amountCents: 3 },
    ])
  })

  it('takes a debt payment off only when recorded after the balance was stated, to the microsecond', () => {
    const stated = 1_790_000_000_000_000
    const ledger = ledgerOf({
      events: log([
        { id: 'p0', kind: 'payment_confirmed', at: stated, payload: { debt_id: 'card', amount_cents: 1000 } },
        { id: 'p1', kind: 'payment_confirmed', at: stated + 1, payload: { debt_id: 'card', amount_cents: 2000 } },
        { id: 'i1', kind: 'instruction_issued', at: stated + 2, payload: { instruction_id: 'd1', type: 'debt_payment', amount_cents: 5000, target_id: 'card', target_label: 'Card' } },
        { id: 'c1', kind: 'instruction_confirmed', at: stated + 3, payload: { instruction_id: 'd1', actual_amount_cents: null } },
        { id: 'c2', kind: 'instruction_confirmed', at: stated + 4, payload: { instruction_id: 'd1', actual_amount_cents: null } },
      ]),
      lineItems: [],
      debts: [{ id: 'card', balanceRecordedAtMicros: String(stated) }],
    })
    expect(ledger.debtPaymentsSinceStated.get('card')).toEqual([
      { on: '2026-10-24', amountCents: 2000, regular: true },
      { on: '2026-10-24', amountCents: 5000, regular: false },
    ])
    expect(ledger.debtHistory.get('card')!.map((e) => e.kind)).toEqual(['paid', 'paid', 'paid_todo'])
    // Every move asked of an account is none of these: a debt payment is no account move.
    expect(ledger.movesSinceCount).toEqual([])
  })

  it('numbers cycle starts in the order recorded', () => {
    const ledger = ledgerOf({
      events: log([
        { id: 'k', kind: 'package_committed', payload: { openings: [{ line_item_id: 'part', amount_cents: 300 }, { line_item_id: 'none', amount_cents: 0 }] } },
        { id: 'a', kind: 'line_item_added', payload: { line_item_id: 'part2' } },
      ]),
      lineItems: items,
      debts: [],
    })
    expect(ledger.cycleStarts.map((c) => [c.lineItemId, c.origin, c.recordedOrder])).toEqual([
      ['part', 'commit', 0],
      ['part2', 'added', 1],
    ])
  })
})
