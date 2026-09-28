import { describe, expect, it } from 'vitest'
import {
  componentDeliveredBetween,
  componentDeliveredBy,
  componentRatePerWeekCents,
  driftAdjustmentComponent,
  isComponentActive,
  openingSinceLastOccurrence,
  evenPaceCents,
  type RateComponent,
} from '../accrual'
import { accrualWeeksBetween, type CivilDate, type Weekday } from '../dates'
import { nextTimelineStart, resolveTimelineStart, timelineStartRecord } from '../types'

// What is left of the component arithmetic after D35: a sum delivered evenly
// over the transfer days in a window. The steady line and the bumps and cuts
// confirmed before D35 are built on it; nothing on screen reads a component.

const COMMIT: CivilDate = '2026-09-19' // a Saturday
const DUE: CivilDate = '2027-01-16'

function component(over: Partial<RateComponent> = {}, transferWeekday?: Weekday): RateComponent {
  const startDate = over.startDate ?? COMMIT
  const endDate = over.endDate ?? DUE
  return {
    kind: 'base',
    lineItemId: 'li',
    reserveAccountId: 'acct',
    startDate,
    endDate,
    amountCents: 60000,
    weeks: accrualWeeksBetween(startDate, endDate, transferWeekday),
    ...over,
  }
}

describe('a component delivers its total evenly over its transfer days', () => {
  it('is nothing on its first day, exactly its total on its last, and rounds up in between', () => {
    const c = component()
    expect(c.weeks).toBe(17)
    expect(componentDeliveredBy(c, COMMIT)).toBe(0)
    expect(componentDeliveredBy(c, DUE)).toBe(60000)
    expect(componentDeliveredBy(c, '2026-09-26')).toBe(Math.ceil(60000 / 17))
    expect(componentRatePerWeekCents(c)).toBe(Math.ceil(60000 / 17))
  })

  it('collapses to a single move when the window holds no transfer day', () => {
    const c = component({ endDate: '2026-09-24' })
    expect(c.weeks).toBe(1)
    expect(componentDeliveredBy(c, '2026-09-24')).toBe(60000)
  })

  it('delivers between two days exactly what the difference says', () => {
    const c = component()
    expect(componentDeliveredBetween(c, COMMIT, DUE)).toBe(60000)
    expect(componentDeliveredBetween(c, '2026-10-01', '2026-10-01')).toBe(0)
  })

  it('stops asking for transfers once its window has passed', () => {
    const c = component()
    expect(isComponentActive(c, COMMIT)).toBe(true)
    expect(isComponentActive(c, DUE)).toBe(false)
  })

  it('steps on the household transfer day (D31): Friday money moves on Friday', () => {
    const FRIDAY: Weekday = 5
    const c = component({}, FRIDAY)
    expect(componentDeliveredBy(c, '2026-09-24', FRIDAY)).toBe(0)
    expect(componentDeliveredBy(c, '2026-09-25', FRIDAY)).toBe(Math.ceil(60000 / c.weeks))
  })

  it('reads a cut confirmed before D35 as a negative delivery over its window', () => {
    const cut = driftAdjustmentComponent({
      id: 'cut',
      reserveAccountId: 'acct',
      amountCents: -1700,
      startDate: COMMIT,
      endDate: '2026-11-14',
    })
    expect(cut.kind).toBe('catch_up')
    expect(componentDeliveredBy(cut, '2026-11-14')).toBe(-1700)
  })
})

describe('"Saving since" is a day a person can give (PRD D33)', () => {
  const TODAY: CivilDate = '2026-09-26'
  const NOV: CivilDate = '2026-11-15'

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

    it('keeps a day given on a one-off by the same rules, and starts it at the commit when asked for a last time it never had (D36)', () => {
      expect(
        resolveTimelineStart({ recurrence: null, choice: { kind: 'typed', date: '2026-03-15' }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: true, timelineStart: 'typed', timelineStartDate: '2026-03-15' })
      expect(
        resolveTimelineStart({ recurrence: null, choice: { kind: 'typed', date: '2026-09-27' }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: false, problem: 'The day you have been saving since cannot be after today.' })
      expect(
        resolveTimelineStart({ recurrence: null, choice: { kind: 'typed', date: null }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: false, problem: 'Pick the day you have been saving for this since.' })
      expect(
        resolveTimelineStart({ recurrence: null, choice: { kind: 'last_occurrence', date: '2026-03-15' }, dueDate: NOV, today: TODAY }),
      ).toEqual({ ok: true, timelineStart: 'commit', timelineStartDate: null })
      expect(resolveTimelineStart({ recurrence: null, choice: 'commit', dueDate: NOV, today: TODAY })).toEqual({
        ok: true,
        timelineStart: 'commit',
        timelineStartDate: null,
      })
    })

    it('records the D30 kinds as before and a day given with its date', () => {
      expect(timelineStartRecord('last_occurrence', null)).toBe('last_occurrence')
      expect(timelineStartRecord('commit', null)).toBe('commit')
      expect(timelineStartRecord('typed', '2026-03-15')).toEqual({ kind: 'typed', date: '2026-03-15' })
    })
  })

  describe('where a part starts after a change to it (D36)', () => {
    const yearly = { every: 1, unit: 'year' } as const
    const oneOff = { recurrence: null, timelineStart: 'commit' as const, timelineStartDate: null }
    const typedOneOff = { recurrence: null, timelineStart: 'typed' as const, timelineStartDate: '2026-08-01' }
    const next = (args: Omit<Parameters<typeof nextTimelineStart>[0], 'today' | 'dueDate'> & { dueDate?: CivilDate }) =>
      nextTimelineStart({ dueDate: NOV, today: TODAY, ...args })

    it('keeps what the part has when nothing is said, and says it did not move', () => {
      expect(next({ current: typedOneOff, recurrence: null })).toEqual({
        ok: true,
        timelineStart: 'typed',
        timelineStartDate: '2026-08-01',
        changed: false,
      })
    })

    it('takes what was asked, and says whether it moved', () => {
      expect(next({ current: oneOff, asked: { kind: 'typed', date: '2026-08-01' }, recurrence: null })).toEqual({
        ok: true,
        timelineStart: 'typed',
        timelineStartDate: '2026-08-01',
        changed: true,
      })
      expect(next({ current: typedOneOff, asked: { kind: 'commit', date: null }, recurrence: null })).toEqual({
        ok: true,
        timelineStart: 'commit',
        timelineStartDate: null,
        changed: true,
      })
    })

    it('gives a part that starts repeating the default for one, unless it already had a day given', () => {
      expect(next({ current: oneOff, recurrence: yearly })).toMatchObject({ ok: true, timelineStart: 'last_occurrence', changed: true })
      expect(next({ current: typedOneOff, recurrence: yearly })).toMatchObject({
        ok: true,
        timelineStart: 'typed',
        timelineStartDate: '2026-08-01',
        changed: false,
      })
    })

    it('starts a part that stops repeating on "the last time it came round" where the plan does', () => {
      expect(
        next({ current: { recurrence: yearly, timelineStart: 'last_occurrence', timelineStartDate: null }, recurrence: null }),
      ).toEqual({ ok: true, timelineStart: 'commit', timelineStartDate: null, changed: true })
    })

    it('judges a day kept against the part as it will be, in the same plain words', () => {
      expect(next({ current: typedOneOff, recurrence: null, dueDate: '2026-07-31' })).toEqual({
        ok: false,
        problem: 'The day you have been saving since has to be before the day it is needed.',
      })
    })
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
