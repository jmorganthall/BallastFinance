import { describe, expect, it } from 'vitest'
import {
  billsAccountOf,
  creditTodos,
  creditTodoSentence,
  debtWithCharges,
  type CreditCharge,
  type CreditNames,
} from '../credit'
import { ledgerOf, type RecordedEvent } from '../ledger'
import { householdView } from '../household-view'
import type { DebtStatuses } from '../debt-status'
import type { HouseholdPosition } from '../position'

/** Events recorded one microsecond apart, in the order given. */
function log(rows: (Omit<RecordedEvent, 'recordedAtMicros' | 'on'> & { on?: string })[]): RecordedEvent[] {
  return rows.map((r, i) => ({
    id: r.id,
    kind: r.kind,
    on: r.on ?? '2026-11-27',
    recordedAtMicros: String(1_795_000_000_000_000 + i),
    payload: r.payload,
  }))
}

const items = [
  { id: 'tickets', reserveAccountId: 'disney' },
  { id: 'hotel', reserveAccountId: 'disney' },
  { id: 'tires', reserveAccountId: 'car' },
  { id: 'water', reserveAccountId: 'bills' },
]
const debts = [
  { id: 'delta', balanceRecordedAtMicros: '1794999999999999' },
  { id: 'amex', balanceRecordedAtMicros: '1794999999999999' },
]
const names: CreditNames = {
  accounts: new Map([
    ['disney', 'Disney'],
    ['car', 'Car upkeep'],
    ['bills', 'Joint checking'],
  ]),
  debts: new Map([
    ['delta', 'Delta Reserve'],
    ['amex', 'Amex'],
  ]),
  parts: new Map([
    ['tickets', 'Disney 2027 · Park tickets'],
    ['hotel', 'Disney 2027 · Hotel deposit'],
    ['tires', 'Car · Tires'],
    ['water', 'House · Water'],
  ]),
}

const spend = (id: string, part: string, account: string, cents: number, debtId?: string) => ({
  id,
  kind: 'spend_recorded',
  payload: {
    line_item_id: part,
    reserve_account_id: account,
    round_due: '2026-12-01',
    amount_cents: cents,
    ...(debtId ? { debt_id: debtId } : {}),
  },
})

describe('paid on credit: the ledger', () => {
  it('keeps a charge as a spend and as a charge on its card', () => {
    const ledger = ledgerOf({
      events: log([spend('s1', 'tickets', 'disney', 12000, 'delta'), spend('s2', 'hotel', 'disney', 5000)]),
      lineItems: items,
      debts,
    })
    expect(ledger.spendsSinceCount).toEqual([{ accountId: 'disney', amountCents: 17000 }])
    expect(ledger.creditCharges.map((c) => [c.chargeId, c.debtId, c.amountCents])).toEqual([['s1', 'delta', 12000]])
    expect(ledger.roundLog.map((e) => e.debtId)).toEqual(['delta', undefined])
    expect(ledger.creditSinceStated.get('delta')).toEqual({ chargedCents: 12000, paidCents: 0 })
  })

  it('leaves a charge out once it is taken back', () => {
    const ledger = ledgerOf({
      events: log([
        spend('s1', 'tickets', 'disney', 12000, 'delta'),
        { id: 'u1', kind: 'event_undone', payload: { event_id: 's1' } },
      ]),
      lineItems: items,
      debts,
    })
    expect(ledger.creditCharges).toEqual([])
    expect(ledger.spendsSinceCount).toEqual([])
  })

  it('keeps a count from giving back money still promised to a card', () => {
    const ledger = ledgerOf({
      events: log([
        spend('s1', 'tickets', 'disney', 12000, 'delta'),
        // Counted before the move: the $120 is still in the account, and on its way out.
        { id: 'c1', kind: 'balance_confirmed', payload: { reserve_account_id: 'disney', amount_cents: 50000 } },
      ]),
      lineItems: items,
      debts,
    })
    expect(ledger.spendsSinceCount).toEqual([{ accountId: 'disney', amountCents: 12000 }])
  })

  it('follows the money: moved into the bills account, then paid', () => {
    const moved = ledgerOf({
      events: log([
        spend('s1', 'tickets', 'disney', 12000, 'delta'),
        {
          id: 'm1',
          kind: 'credit_moved',
          on: '2026-11-28',
          payload: { from_reserve_account_id: 'disney', to_reserve_account_id: 'bills', charge_ids: ['s1'], amount_cents: 12000 },
        },
        { id: 'c1', kind: 'balance_confirmed', payload: { reserve_account_id: 'disney', amount_cents: 38000 } },
        { id: 'c2', kind: 'balance_confirmed', payload: { reserve_account_id: 'bills', amount_cents: 90000 } },
      ]),
      lineItems: items,
      debts,
    })
    // Gone from Disney (the count is the truth); in the bills account until the card is paid.
    expect(moved.spendsSinceCount).toEqual([{ accountId: 'bills', amountCents: 12000 }])
    expect(moved.creditCharges[0]!.moved).toEqual({ on: '2026-11-28', toAccountId: 'bills' })

    const paid = ledgerOf({
      events: [
        ...log([
          spend('s1', 'tickets', 'disney', 12000, 'delta'),
          {
            id: 'm1',
            kind: 'credit_moved',
            payload: { from_reserve_account_id: 'disney', to_reserve_account_id: 'bills', charge_ids: ['s1'], amount_cents: 12000 },
          },
          { id: 'p1', kind: 'credit_paid', on: '2026-11-29', payload: { debt_id: 'delta', charge_ids: ['s1'], amount_cents: 12000 } },
          // A second press of Done counts once.
          { id: 'p2', kind: 'credit_paid', payload: { debt_id: 'delta', charge_ids: ['s1'], amount_cents: 12000 } },
          { id: 'c2', kind: 'balance_confirmed', payload: { reserve_account_id: 'bills', amount_cents: 78000 } },
        ]),
      ],
      lineItems: items,
      debts,
    })
    expect(paid.spendsSinceCount).toEqual([{ accountId: 'disney', amountCents: 12000 }])
    expect(paid.creditCharges[0]!.paidOn).toBe('2026-11-29')
    expect(paid.creditSinceStated.get('delta')).toEqual({ chargedCents: 12000, paidCents: 12000 })
    expect(paid.debtHistory.get('delta')).toEqual([
      { on: '2026-11-27', kind: 'charged_from_plan', amountCents: 12000 },
      { on: '2026-11-29', kind: 'paid_from_plans', amountCents: 12000 },
    ])
  })
})

const charge = (over: Partial<CreditCharge> & Pick<CreditCharge, 'chargeId' | 'lineItemId' | 'accountId' | 'debtId' | 'amountCents'>): CreditCharge => ({
  roundDue: '2026-12-01',
  on: '2026-11-27',
  recordedAtMicros: '1795000000000001',
  moved: null,
  paidOn: null,
  paidAtMicros: null,
  ...over,
})

describe('paid on credit: the to-dos', () => {
  const bills = { kind: 'reserve_account' as const, accountId: 'bills' }

  it('asks for one move per account, however many charges, before any payment', () => {
    const todos = creditTodos({
      charges: [
        charge({ chargeId: 'a', lineItemId: 'tickets', accountId: 'disney', debtId: 'delta', amountCents: 12000 }),
        charge({ chargeId: 'b', lineItemId: 'hotel', accountId: 'disney', debtId: 'delta', amountCents: 5000 }),
        charge({ chargeId: 'c', lineItemId: 'hotel', accountId: 'disney', debtId: 'amex', amountCents: 2500 }),
      ],
      bills,
      names,
    })
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ kind: 'move_to_bills', fromAccountId: 'disney', amountCents: 19500 })
    expect(creditTodoSentence(todos[0]!)).toBe(
      'Move $195.00 from Disney into Joint checking to pay off what went on Delta Reserve and Amex.',
    )
  })

  it('asks for one payment per card once its moves are done', () => {
    const moved = { on: '2026-11-28', toAccountId: 'bills' }
    const todos = creditTodos({
      charges: [
        charge({ chargeId: 'a', lineItemId: 'tickets', accountId: 'disney', debtId: 'delta', amountCents: 12000, moved }),
        charge({ chargeId: 'b', lineItemId: 'tires', accountId: 'car', debtId: 'delta', amountCents: 40000, moved }),
        charge({ chargeId: 'c', lineItemId: 'hotel', accountId: 'disney', debtId: 'amex', amountCents: 2500 }),
      ],
      bills,
      names,
    })
    expect(todos.map((t) => [t.kind, t.amountCents])).toEqual([
      ['move_to_bills', 2500],
      ['pay_card', 52000],
    ])
    expect(creditTodoSentence(todos[1]!)).toBe('Pay $520.00 to Delta Reserve from Joint checking, for what went on it from plans.')
  })

  it('holds a card\'s payment while any charge on it still waits to be moved', () => {
    const todos = creditTodos({
      charges: [
        charge({ chargeId: 'a', lineItemId: 'tickets', accountId: 'disney', debtId: 'delta', amountCents: 12000, moved: { on: '2026-11-28', toAccountId: 'bills' } }),
        charge({ chargeId: 'b', lineItemId: 'tires', accountId: 'car', debtId: 'delta', amountCents: 40000 }),
      ],
      bills,
      names,
    })
    expect(todos.map((t) => t.kind)).toEqual(['move_to_bills'])
  })

  it('skips the move for a plan held in the bills account', () => {
    const todos = creditTodos({
      charges: [charge({ chargeId: 'a', lineItemId: 'water', accountId: 'bills', debtId: 'amex', amountCents: 6000 })],
      bills,
      names,
    })
    expect(todos).toEqual([
      expect.objectContaining({ kind: 'pay_card', debtId: 'amex', amountCents: 6000, fromName: 'Joint checking' }),
    ])
  })

  it('asks nothing for what is paid, and names the bills account in words until it is said', () => {
    const todos = creditTodos({
      charges: [
        charge({ chargeId: 'a', lineItemId: 'tickets', accountId: 'disney', debtId: 'delta', amountCents: 12000, paidOn: '2026-11-29', paidAtMicros: '1' }),
        charge({ chargeId: 'b', lineItemId: 'tires', accountId: 'car', debtId: 'delta', amountCents: 40000 }),
      ],
      bills: null,
      names,
    })
    expect(todos).toHaveLength(1)
    expect(creditTodoSentence(todos[0]!)).toBe(
      'Move $400.00 from Car upkeep into the account you pay bills from to pay off what went on Delta Reserve.',
    )
  })

  it('reads the bills account setting, and nothing else, as one', () => {
    expect(billsAccountOf({ kind: 'reserve_account', accountId: 'bills' })).toEqual(bills)
    expect(billsAccountOf({ kind: 'named', name: ' Joint checking ' })).toEqual({ kind: 'named', name: 'Joint checking' })
    expect(billsAccountOf(null)).toBeNull()
    expect(billsAccountOf({ kind: 'named', name: '' })).toBeNull()
    expect(billsAccountOf('bills')).toBeNull()
  })

  it('blocks All caught up and counts as money to do', () => {
    // Everything else caught up: only the payment is left.
    const position = { accounts: [], todos: [], plans: [], allCaughtUp: true } as unknown as HouseholdPosition
    const debtState = { debts: [], todos: [], caughtUp: true } as unknown as DebtStatuses
    const credit = creditTodos({
      charges: [charge({ chargeId: 'a', lineItemId: 'water', accountId: 'bills', debtId: 'amex', amountCents: 6000 })],
      bills,
      names,
    })
    const view = householdView({ position, debts: debtState, open: [], credit })
    expect(view.todos.map((t) => [t.from, t.key, t.blocking])).toEqual([['credit', 'credit_pay:amex', true]])
    expect(view.caughtUp).toBe(false)
    expect(view.moneyToDo).toBe(true)
  })
})

describe('paid on credit: the card', () => {
  it('shows a charge on the card at once and keeps it out of the payoff', () => {
    expect(debtWithCharges({ likelyCents: 100000, chargedSinceStatedCents: 12000, paidSinceStatedCents: 0, onCardCents: 12000 })).toEqual({
      balanceCents: 100000,
      onCardFromPlansCents: 12000,
    })
  })

  it('drops it from the card once paid', () => {
    expect(debtWithCharges({ likelyCents: 100000, chargedSinceStatedCents: 12000, paidSinceStatedCents: 12000, onCardCents: 0 })).toEqual({
      balanceCents: 100000,
      onCardFromPlansCents: 0,
    })
  })

  it('keeps a charge already on a statement out of the payoff until it is paid', () => {
    // The statement (100,000) includes the 12,000 charged before it.
    const before = debtWithCharges({ likelyCents: 100000, chargedSinceStatedCents: 0, paidSinceStatedCents: 0, onCardCents: 12000 })
    expect(before).toEqual({ balanceCents: 88000, onCardFromPlansCents: 12000 })
    const after = debtWithCharges({ likelyCents: 100000, chargedSinceStatedCents: 0, paidSinceStatedCents: 12000, onCardCents: 0 })
    expect(after).toEqual({ balanceCents: 88000, onCardFromPlansCents: 0 })
  })
})
