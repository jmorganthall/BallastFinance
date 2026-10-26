import { describe, expect, it } from 'vitest'
import { oldestOpenRound, roundLabel, roundsOf, roundSuffix, type RoundEvent } from '../rounds'

// Ian's birthday party: $500 every year on 4 October; today is three weeks on.
const TODAY = '2026-10-25'
const party = {
  id: 'party',
  unitAmountCents: 50000,
  quantity: 1,
  dueDate: '2026-10-04',
  recurrence: { every: 1, unit: 'year' as const },
}

let n = 0
const ev = (over: Partial<RoundEvent> & Pick<RoundEvent, 'kind'>): RoundEvent => ({
  eventId: `e${(n += 1)}`,
  lineItemId: 'party',
  roundDue: '2026-10-04',
  amountCents: 0,
  on: TODAY,
  ...over,
})

describe('rounds of a repeating part (D53)', () => {
  it('moves on by itself on the due date: the old round stays open and the next one saves', () => {
    const r = roundsOf({ lineItem: party, events: [], today: TODAY })
    expect(r.past.map((x) => x.dueDate)).toEqual(['2026-10-04'])
    expect(r.past[0]!.needsCents).toBe(50000)
    expect(r.current?.dueDate).toBe('2027-10-04')
    // The next round saves from the old due date.
    expect(r.currentSavingFrom).toBe('2026-10-04')
    expect(r.oldestOpen).toBe('2026-10-04')
  })

  it('counts the round as past on its due date itself', () => {
    const r = roundsOf({ lineItem: party, events: [], today: '2026-10-04' })
    expect(r.past.map((x) => x.dueDate)).toEqual(['2026-10-04'])
    expect(r.current?.dueDate).toBe('2027-10-04')
  })

  it('takes each spend off what the round still needs, and finishes it when they reach the total', () => {
    const partly = roundsOf({
      lineItem: party,
      events: [ev({ kind: 'spend', amountCents: 10000 }), ev({ kind: 'spend', amountCents: 20000 })],
      today: TODAY,
    })
    expect(partly.past[0]).toMatchObject({ spentCents: 30000, needsCents: 20000, finished: false })

    const all = roundsOf({
      lineItem: party,
      events: [
        ev({ kind: 'spend', amountCents: 30000, on: '2026-10-10' }),
        ev({ kind: 'spend', amountCents: 25000, on: '2026-10-20' }),
      ],
      today: TODAY,
    })
    expect(all.past).toEqual([])
    expect(all.oldestOpen).toBe('2027-10-04')
  })

  it('finishes a round on Finish, whatever is left', () => {
    const r = roundsOf({
      lineItem: party,
      events: [ev({ kind: 'spend', amountCents: 10000 }), ev({ kind: 'finish' })],
      today: TODAY,
    })
    expect(r.past).toEqual([])
    expect(r.current?.dueDate).toBe('2027-10-04')
  })

  it('stacks rounds nobody answered, oldest first, and closes none of them on its own', () => {
    const r = roundsOf({ lineItem: { ...party, dueDate: '2025-10-04' }, events: [], today: TODAY })
    expect(r.past.map((x) => x.dueDate)).toEqual(['2025-10-04', '2026-10-04'])
    expect(r.current?.dueDate).toBe('2027-10-04')
  })

  it('moves on at once when the round is finished before its date, saving from that day', () => {
    const early = { ...party, dueDate: '2026-10-31' }
    const r = roundsOf({
      lineItem: early,
      events: [ev({ kind: 'finish', roundDue: '2026-10-31', on: '2026-10-25' })],
      today: TODAY,
    })
    expect(r.past).toEqual([])
    expect(r.current?.dueDate).toBe('2027-10-31')
    expect(r.currentSavingFrom).toBe('2026-10-25')
  })

  it('still starts the next round on the old date once the stored date has moved on to it', () => {
    const r = roundsOf({
      lineItem: { ...party, dueDate: '2027-10-04' },
      events: [ev({ kind: 'spend', amountCents: 50000, on: '2026-10-20' })],
      today: TODAY,
    })
    expect(r.current?.dueDate).toBe('2027-10-04')
    expect(r.currentSavingFrom).toBe('2026-10-04')
  })

  it('puts the target back to the full total on Save back up, keeping the spends spent', () => {
    const r = roundsOf({
      lineItem: { ...party, dueDate: '2026-11-08' },
      events: [
        ev({ kind: 'spend', roundDue: '2026-11-08', amountCents: 10000 }),
        ev({ kind: 'save_back_up', roundDue: '2026-11-08' }),
        ev({ kind: 'spend', roundDue: '2026-11-08', amountCents: 5000 }),
      ],
      today: TODAY,
    })
    expect(r.current).toMatchObject({ spentCents: 15000, countedSpentCents: 5000, needsCents: 45000 })
  })

  it('a one-off has one round: open before and after its date, gone once finished', () => {
    const once = { ...party, recurrence: null }
    expect(roundsOf({ lineItem: once, events: [], today: '2026-09-01' }).current?.dueDate).toBe('2026-10-04')
    expect(roundsOf({ lineItem: once, events: [], today: TODAY }).past.map((x) => x.dueDate)).toEqual([
      '2026-10-04',
    ])
    expect(
      roundsOf({ lineItem: once, events: [ev({ kind: 'spend', amountCents: 60000 })], today: TODAY }).oldestOpen,
    ).toBeNull()
  })

  it('finds the oldest open round again from a round an undo reopened', () => {
    const later = { ...party, dueDate: '2027-10-04' }
    expect(oldestOpenRound({ lineItem: later, from: '2026-10-04', events: [], today: TODAY })).toBe('2026-10-04')
  })
})

describe('telling two rounds apart (D53 (8))', () => {
  it('uses the year, the month and year, or the day, by how often it comes round', () => {
    expect(roundSuffix('2026-10-04', { every: 1, unit: 'year' }, TODAY)).toBe('2026')
    expect(roundSuffix('2026-10-04', { every: 1, unit: 'month' }, TODAY)).toBe('Oct 2026')
    expect(roundSuffix('2026-10-24', { every: 1, unit: 'week' }, TODAY)).toBe('Oct 24')
    expect(roundSuffix('2025-10-24', { every: 1, unit: 'week' }, TODAY)).toBe('Oct 24, 2025')
  })

  it('names a round as typed unless another round of it is open', () => {
    const base = { label: 'Ian Birthday Party', dueDate: '2026-10-04', recurrence: party.recurrence, today: TODAY }
    expect(roundLabel({ ...base, openRounds: 1 })).toBe('Ian Birthday Party')
    expect(roundLabel({ ...base, openRounds: 2 })).toBe('Ian Birthday Party (2026)')
  })
})
