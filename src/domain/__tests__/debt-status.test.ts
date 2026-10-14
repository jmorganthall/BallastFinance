import { describe, expect, it } from 'vitest'
import type { Debt } from '../debt'
import { debtStatusLabel, debtStatusLine, debtStatuses, debtTodoSentence } from '../debt-status'
import { formatCents } from '../money'

// PRD D49 (4)-(6): one status per debt, its words and its to-dos.

const TODAY = '2026-10-14'

function card(over: Partial<Debt> & Pick<Debt, 'id' | 'name'>): Debt {
  return {
    householdId: 'hh',
    category: 'consumer',
    balanceCents: 670239,
    balanceAsOf: '2026-10-01',
    aprBasisPoints: 3049,
    promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2028-01-12', chargedBack: false }],
    minPaymentRule: { type: 'fixed', amountCents: 4000 },
    plannedPaymentCents: 47500,
    fixedPayment: false,
    state: 'open',
    ...over,
  }
}

describe('debtStatuses', () => {
  const misses = card({ id: '0568', name: 'Shield 0568' })
  const clears = card({
    id: '9795',
    name: 'Shield 9795',
    balanceCents: 482958,
    plannedPaymentCents: 30300,
    promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2028-02-15', chargedBack: false }],
  })

  it('a deal the payments will not clear in time Misses its 0%, with the cliff and the fix', () => {
    const { debts, todos, caughtUp } = debtStatuses({ debts: [misses, clears], today: TODAY })
    const [a, b] = debts
    // 14 whole months to Jan 12, 2028; 14 x $475 = $6,650 leaves $52.39 of $6,702.39.
    expect(a!.status).toBe('misses_deal')
    expect(a!.miss).toMatchObject({ monthsLeft: 14, owedAtEndCents: 5239, paymentNowCents: 47500 })
    // $6,702.39 / 14 = $478.742..., rounded up to the cent.
    expect(a!.miss!.clearPerMonthCents).toBe(47875)
    expect(debtStatusLabel(a!)).toBe('Misses its 0%')
    expect(debtStatusLine(a!).map((p) => p.text).join('')).toBe(
      'The 0% ends 2028-01-12 with $52.39 still owed, charged 30.49% from then. Pay $478.75 a month to clear it in time.',
    )
    // 16 months x $303 = $4,848 clears $4,829.58.
    expect(b!.status).toBe('on_track')
    expect(b!.miss).toBeNull()

    expect(todos).toEqual([
      expect.objectContaining({ kind: 'raise_debt_payment', debtId: '0568', fromCents: 47500, toCents: 47875, blocking: true }),
    ])
    expect(debtTodoSentence(todos[0]!)).toBe(
      'Raise the monthly payment on Shield 0568 to $478.75 (it is $475.00 now), so its deal is cleared before it ends 2028-01-12.',
    )
    expect(caughtUp).toBe(false)
  })

  it('inside the promo lead window, a miss is Short', () => {
    const soon = card({
      id: 's',
      name: 'Soon',
      balanceCents: 100000,
      plannedPaymentCents: null,
      promoRules: [{ rateBasisPoints: 299, appliesTo: 'full', untilDate: '2026-11-30', chargedBack: false }],
    })
    const [view] = debtStatuses({ debts: [soon], today: TODAY }).debts
    expect(view!.status).toBe('short')
    expect(debtStatusLabel(view!)).toBe('Short')
    expect(view!.miss!.owedAtEndCents).toBe(96000)
    expect(debtStatusLine(view!)[0]!.text).toBe('The 2.99% deal ends ')
    const later = debtStatuses({
      debts: [{ ...soon, promoRules: [{ rateBasisPoints: 299, appliesTo: 'full', untilDate: '2027-06-30', chargedBack: false }] }],
      today: TODAY,
    })
    expect(debtStatusLabel(later.debts[0]!)).toBe('Misses its deal')
  })

  it('raising the payment to the fix puts it on track', () => {
    const raised = { ...misses, plannedPaymentCents: 47875 }
    const { debts, todos, caughtUp } = debtStatuses({ debts: [raised], today: TODAY })
    expect(debts[0]!.status).toBe('on_track')
    expect(todos).toEqual([])
    expect(caughtUp).toBe(true)
  })

  it('a balance not checked for more than 30 days asks to be, without holding back "All caught up"', () => {
    const old = { ...clears, balanceAsOf: '2026-09-13' } // 31 days
    const fresh = { ...clears, id: 'f', balanceAsOf: '2026-09-14' } // 30 days
    const { todos, caughtUp } = debtStatuses({ debts: [old, fresh], today: TODAY })
    expect(todos).toEqual([
      expect.objectContaining({ kind: 'update_debt_balance', debtId: '9795', ageDays: 31, likelyCents: 482958, blocking: false }),
    ])
    expect(debtTodoSentence(todos[0]!)).toBe(
      'Check the balance on Shield 9795 against its statement: it was last checked 31 days ago.',
    )
    expect(caughtUp).toBe(true)
  })

  it('a paid-off debt has no status and asks nothing', () => {
    const done = { ...misses, balanceCents: 0, state: 'paid_off' as const, balanceAsOf: '2025-01-01' }
    expect(debtStatuses({ debts: [done], today: TODAY })).toEqual({ debts: [], todos: [], caughtUp: true })
  })
})

describe('a deal that charges its interest back (D49 (9))', () => {
  const shield: Debt = {
    id: '0568',
    householdId: 'hh',
    name: 'Shield 0568',
    category: 'consumer',
    balanceCents: 670239,
    balanceAsOf: '2026-10-01',
    aprBasisPoints: 3049,
    promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2028-01-12', chargedBack: true }],
    minPaymentRule: { type: 'fixed', amountCents: 4000 },
    plannedPaymentCents: 47500,
    fixedPayment: false,
    state: 'open',
    enteredOn: TODAY,
  }

  it('says how much interest missing it brings back', () => {
    const [view] = debtStatuses({ debts: [shield], today: TODAY }).debts
    // From today: the full rate on each month's deal balance before its
    // payment, $6,702.39 falling by $475 a month over 14 months.
    let expected = 0
    for (let k = 0; k < 14; k += 1) expected += Math.round(((670239 - k * 47500) * 3049) / 10000 / 12)
    expect(view!.miss!.chargedBackCents).toBe(expected)
    expect(debtStatusLine(view!).map((p) => p.text).join('')).toBe(
      `The 0% ends 2028-01-12 with $52.39 still owed, which brings back about ${formatCents(expected)} of interest. Pay $478.75 a month to clear it in time.`,
    )
  })

  it('a deal nobody has checked is taken as charged back, and asks once to be checked', () => {
    const unasked = { ...shield, promoRules: [{ ...shield.promoRules[0]!, chargedBack: undefined }] }
    const { debts, todos } = debtStatuses({ debts: [unasked], today: TODAY })
    expect(debts[0]!.miss!.chargedBackCents).not.toBeNull()
    expect(todos.map((t) => t.kind)).toEqual(['raise_debt_payment', 'check_deal_terms'])
    expect(debtTodoSentence(todos[1]!)).toBe(
      'Check the terms of the deal on Shield 0568: if it is not paid off by the time it ends, is the interest charged back to when it started?',
    )
    expect(todos[1]!.blocking).toBe(false)
  })
})

describe('the household headline', () => {
  it('counts what needs attention in plain words', async () => {
    const { attentionHeadline, householdCaughtUp } = await import('../debt-status')
    expect(attentionHeadline(1, 0)).toBe('One account needs you')
    expect(attentionHeadline(0, 1)).toBe('One debt needs you')
    expect(attentionHeadline(2, 1)).toBe('2 accounts and one debt need you')
    expect(householdCaughtUp({ allCaughtUp: true }, { caughtUp: false })).toBe(false)
    expect(householdCaughtUp({ allCaughtUp: true }, { caughtUp: true })).toBe(true)
  })
})
