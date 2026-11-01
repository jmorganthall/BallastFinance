import { describe, expect, it } from 'vitest'
import {
  bankTransfersBetween,
  barOf,
  countTowardParts,
  dueMarksOf,
  levelWeekly,
  moneySinceParts,
  moneySinceSentence,
  NEAR_TRANSFERS,
  PHASE_MIN_RISE_CENTS,
  planChart,
  position,
  requirementsFor,
  shortReasons,
  slotTicks,
  smartSaving,
  steadyLineStart,
  type PositionInput,
} from '../position'
import { formatCents } from '../money'
import { addDays, compareDates, transferWeeksBetween, type CivilDate, type Weekday } from '../dates'
import { lineItemTotalCents, type LineItem, type LineItemCycle, type Package, type ReserveAccount } from '../types'
import { nextOccurrence } from '../recurrence'
import type { RoundEvent } from '../rounds'

// Monday. The household's money moves on Fridays.
const TODAY: CivilDate = '2026-09-28'
const FRIDAY: Weekday = 5

const gifts: ReserveAccount = {
  id: 'acct-gifts',
  householdId: 'hh-1',
  name: 'Gifts & Giving',
  institutionLabel: 'Capital One 360 — Gifts & Giving',
  scope: 'household',
  ownerUserId: null,
  active: true,
}

function pkg(over: Partial<Package> = {}): Package {
  return {
    id: 'pkg-1',
    householdId: 'hh-1',
    name: 'Gifts',
    state: 'active',
    module: 'manual',
    detail: null,
    createdAt: '2026-09-01',
    committedAt: '2026-09-01',
    ...over,
  }
}

function li(over: Partial<LineItem> & Pick<LineItem, 'id'>): LineItem {
  return {
    packageId: 'pkg-1',
    label: over.id,
    unitAmountCents: 100000,
    quantity: 1,
    dueDate: '2027-09-24',
    reserveAccountId: gifts.id,
    state: 'accruing',
    recurrence: null,
    timelineStart: 'commit',
    timelineStartDate: null,
    ...over,
  }
}

const yearly = { every: 1, unit: 'year' as const }

function input(over: Partial<PositionInput>): PositionInput {
  return {
    today: TODAY,
    accounts: [gifts],
    packages: [pkg()],
    lineItems: [],
    transferWeekday: FRIDAY,
    ...over,
  }
}

describe('the Disney plan becomes one transfer per account (Phase A acceptance)', () => {
  // Committed Saturday 19 Sep 2026, counted at $0, the default Saturday
  // transfer. 17 Saturdays to 16 Jan, 9 to 21 Nov.
  const annual = { ...gifts, id: 'annual', name: 'Annual Expenses' }
  const longTerm = { ...gifts, id: 'long-term', name: 'Long Term Savings' }
  const disney = pkg({ committedAt: '2026-09-19' })
  const p = position({
    today: '2026-09-19',
    accounts: [annual, longTerm],
    packages: [disney],
    lineItems: [
      li({ id: 'tickets', unitAmountCents: 60000, quantity: 3, dueDate: '2027-01-16', reserveAccountId: 'annual' }),
      li({ id: 'airfare', unitAmountCents: 45000, quantity: 3, dueDate: '2026-11-21', reserveAccountId: 'annual' }),
      li({ id: 'food', unitAmountCents: 9000, quantity: 5, dueDate: '2027-01-16', reserveAccountId: 'annual' }),
      li({ id: 'lodging', unitAmountCents: 120000, dueDate: '2027-01-16', reserveAccountId: 'long-term' }),
    ],
    counts: [
      { accountId: 'annual', amountCents: 0, on: '2026-09-19' },
      { accountId: 'long-term', amountCents: 0, on: '2026-09-19' },
    ],
  })

  it('asks each account for the smallest level transfer that has everything there on its date', () => {
    const [a, lt] = p.accounts
    // Annual: $3,600 by 16 Jan over 17 transfers = $211.7647 -> $211.77. The
    // $1,350 airfare on 21 Nov is covered on the way: 9 x $211.77 = $1,905.93.
    expect(a!.weeklyExactCents).toBe(21177)
    // Long Term: $1,200 over 17 = $70.588 -> $70.59.
    expect(lt!.weeklyExactCents).toBe(7059)
    // Saving each part on its own would be more: the airfare alone is $150 a week.
    expect(a!.steadyPerWeekCents).toBe(15000 + Math.ceil(180000 / 17) + Math.ceil(45000 / 17))
  })

  it('has nothing to judge until the transfers are confirmed', () => {
    expect(p.accounts.map((a) => a.status)).toEqual(['unconfirmed', 'unconfirmed'])
    expect(p.todos.map((t) => t.kind === 'set_transfer' && t.toCents)).toEqual([21177, 7059])
  })
})

describe('smart saving (D50)', () => {
  it('sets what Ballast needs a week against every plan saving on its own', () => {
    const annual = { ...gifts, id: 'annual', name: 'Annual Expenses' }
    const longTerm = { ...gifts, id: 'long-term', name: 'Long Term Savings' }
    const facts: PositionInput = {
      today: '2026-09-19',
      accounts: [annual, longTerm, { ...gifts, id: 'empty', name: 'Nothing in it' }],
      packages: [pkg({ committedAt: '2026-09-19' })],
      lineItems: [
        li({ id: 'tickets', unitAmountCents: 60000, quantity: 3, dueDate: '2027-01-16', reserveAccountId: 'annual' }),
        li({ id: 'airfare', unitAmountCents: 45000, quantity: 3, dueDate: '2026-11-21', reserveAccountId: 'annual' }),
        li({ id: 'food', unitAmountCents: 9000, quantity: 5, dueDate: '2027-01-16', reserveAccountId: 'annual' }),
        li({ id: 'lodging', unitAmountCents: 120000, dueDate: '2027-01-16', reserveAccountId: 'long-term' }),
      ],
      counts: [
        { accountId: 'annual', amountCents: 0, on: '2026-09-19' },
        { accountId: 'long-term', amountCents: 0, on: '2026-09-19' },
      ],
    }
    const p = position(facts)
    // Nobody has set the transfers up yet: the figure covers the plans
    // once that is done, and nothing is claimed until then.
    const asked = smartSaving(p)!
    expect(asked.withBallastPerWeekCents).toBe(21177 + 7059)
    expect(asked.coversOnItsOwn).toBe(false)
    expect(asked.lessPerWeekCents).toBe(0)
    // Each part on its own: the airfare alone is $150 a week.
    expect(asked.onItsOwnPerWeekCents).toBe(15000 + Math.ceil(180000 / 17) + Math.ceil(45000 / 17) + Math.ceil(120000 / 17))

    const set = position({
      ...facts,
      transfers: [
        { accountId: 'annual', perWeekCents: 21177, confirmedOn: '2026-09-19' },
        { accountId: 'long-term', perWeekCents: 7059, confirmedOn: '2026-09-19' },
      ],
    })
    const s = smartSaving(set)!
    expect(s.coversOnItsOwn).toBe(true)
    expect(s.withBallastPerWeekCents).toBe(set.accounts.reduce((t, a) => t + a.neededPerWeekCents, 0))
    expect(s.onItsOwnPerWeekCents).toBe(asked.onItsOwnPerWeekCents)
    expect(s.lessPerWeekCents).toBe(s.onItsOwnPerWeekCents - s.withBallastPerWeekCents)
    expect(s.lessPerWeekCents).toBeGreaterThan(0)
    expect(s.lessPerYearCents).toBe(s.lessPerWeekCents * 52)
    // A month is a twelfth of the year, rounded down so it never claims more.
    expect(s.lessPerMonthCents).toBe(Math.floor((s.lessPerWeekCents * 52) / 12))
    expect(s.lessPerMonthCents * 12).toBeLessThanOrEqual(s.lessPerYearCents)
    // Each account's weekly figure, adding up to the headline; the bank moves what it asks.
    expect(s.accounts.map((a) => [a.name, a.perWeekCents, a.bankPerWeekCents])).toEqual([
      ['Annual Expenses', set.accounts[0]!.neededPerWeekCents, null],
      ['Long Term Savings', set.accounts[1]!.neededPerWeekCents, null],
    ])
    expect(s.accounts.reduce((t, a) => t + a.perWeekCents, 0)).toBe(s.withBallastPerWeekCents)
    // Before the transfers are set up there is no bank figure to set beside it.
    expect(asked.accounts.every((a) => a.bankPerWeekCents === null)).toBe(true)
    expect(s.withBallastShare).toBeCloseTo(s.withBallastPerWeekCents / s.onItsOwnPerWeekCents, 4)
    expect(s.planCount).toBe(1)
  })

  it('never counts a one-time move as saving', () => {
    // $1,000 due in eleven days with nothing there and $10 a week at the
    // bank: a one-time move is asked, so the weekly figure covers nothing yet.
    const p = position(
      input({
        lineItems: [li({ id: 'soon', dueDate: '2026-10-09' })],
        counts: [{ accountId: gifts.id, amountCents: 0, on: TODAY }],
        transfers: [{ accountId: gifts.id, perWeekCents: 1000, confirmedOn: TODAY }],
      }),
    )
    expect(p.accounts[0]!.oneTimeMove).not.toBeNull()
    const s = smartSaving(p)!
    expect(s.coversOnItsOwn).toBe(false)
    expect(s.lessPerWeekCents).toBe(0)
  })

  it('leaves a part on or past its date out of saving on its own', () => {
    const p = position(
      input({
        lineItems: [li({ id: 'party', unitAmountCents: 50000, dueDate: '2026-09-26' }), li({ id: 'roof' })],
        counts: [{ accountId: gifts.id, amountCents: 150000, on: TODAY }],
        transfers: [{ accountId: gifts.id, perWeekCents: 0, confirmedOn: TODAY }],
      }),
    )
    const roof = p.accounts[0]!.parts.find((x) => x.lineItem.id === 'roof')!
    expect(smartSaving(p)!.onItsOwnPerWeekCents).toBe(roof.steadyPerWeekCents)
  })

  it('claims nothing when Ballast needs as much as the plans on their own', () => {
    // Saving since 1 Sep, but counted at $0 today: the 52 transfers left
    // need more than the 56-transfer even share.
    const p = position(input({ lineItems: [li({ id: 'roof' })], counts: [{ accountId: gifts.id, amountCents: 0, on: TODAY }] }))
    const s = smartSaving(p)!
    expect(s.withBallastPerWeekCents).toBe(1924)
    expect(s.onItsOwnPerWeekCents).toBeLessThan(1924)
    expect(s.lessPerWeekCents).toBe(0)
    expect(s.lessPerYearCents).toBe(0)
    expect(s.withBallastShare).toBe(1)
  })

  it('has no headline without a live plan', () => {
    expect(smartSaving(position(input({})))).toBeNull()
  })
})

describe('the weekly amount is the smallest level transfer that keeps the account afloat', () => {
  it('spreads a one-off over the transfers before it is due', () => {
    // $1,000 due in exactly 52 Fridays, nothing held: $19.24 a week, rounded up.
    const p = position(input({ lineItems: [li({ id: 'roof' })] }))
    const a = p.accounts[0]!
    expect(transferWeeksBetween(TODAY, '2027-09-24', FRIDAY)).toBe(52)
    expect(a.weeklyExactCents).toBe(1924)
    expect(a.weeklyCents).toBe(1924)
  })

  it('rounds the transfer up to the household step, never the move', () => {
    const p = position(input({ lineItems: [li({ id: 'roof' })], transferRoundUpCents: 1000 }))
    expect(p.accounts[0]!.weeklyCents).toBe(2000)
  })

  it('turns a gap it cannot close within four transfers into a one-time move, not a spike', () => {
    // $500 due in 2 transfers and $5,200 in 52, nothing held. Spreading the
    // near one would put the transfer at $250 for two weeks. Instead:
    //   W = (5,700 − M) ÷ 52 and 500 − M − 2W = 0  =>  M = $292, W = $104.
    const p = position(
      input({
        lineItems: [
          li({ id: 'soon', unitAmountCents: 50000, dueDate: '2026-10-09' }),
          li({ id: 'later', unitAmountCents: 520000, dueDate: '2027-09-24' }),
        ],
        counts: [{ accountId: gifts.id, amountCents: 0, on: TODAY }],
        transfers: [{ accountId: gifts.id, perWeekCents: 10400, confirmedOn: '2026-09-01' }],
      }),
    )
    const a = p.accounts[0]!
    expect(a.weeklyExactCents).toBe(10400)
    expect(a.oneTimeMove).toEqual({ amountCents: 29200, byDate: '2026-10-09' })
    // At the bank's $104 the move is not made yet, so the account is Short on the 9th.
    expect(a.status).toBe('short')
    expect(a.short).toEqual({ on: '2026-10-09', byCents: 29200 })
    expect(p.todos).toEqual([
      {
        kind: 'move_in',
        accountId: gifts.id,
        accountName: gifts.name,
        amountCents: 29200,
        byDate: '2026-10-09',
        blocking: true,
      },
    ])
    expect(p.allCaughtUp).toBe(false)
  })

  it('never goes below the steady run-rate of what comes round again', () => {
    // A yearly $1,200 bill already fully held and due next week needs no
    // transfer to reach its date, but the next year does: the run-rate.
    const p = position(
      input({
        lineItems: [li({ id: 'insurance', unitAmountCents: 120000, dueDate: '2026-10-02', recurrence: yearly })],
        counts: [{ accountId: gifts.id, amountCents: 120000, on: TODAY }],
      }),
    )
    const weeks = transferWeeksBetween('2026-10-02', '2027-10-02', FRIDAY)
    expect(p.accounts[0]!.weeklyExactCents).toBe(Math.ceil(120000 / weeks))
  })

  it('nets across parts: money for a later plan may cover an earlier one', () => {
    // Nothing held for the $300 due in 10 weeks, but $2,000 held that the
    // $2,000 due in a year does not need yet. No move, no spike.
    const p = position(
      input({
        lineItems: [
          li({ id: 'soon', unitAmountCents: 30000, dueDate: addDays(TODAY, 70) }),
          li({ id: 'later', unitAmountCents: 200000, dueDate: '2027-09-24' }),
        ],
        counts: [{ accountId: gifts.id, amountCents: 200000, on: TODAY }],
        transfers: [{ accountId: gifts.id, perWeekCents: 600, confirmedOn: '2026-09-01' }],
      }),
    )
    const a = p.accounts[0]!
    expect(a.oneTimeMove).toBeNull()
    expect(a.weeklyExactCents).toBe(Math.ceil(30000 / 52))
    expect(a.status).toBe('on_track')
  })
})

describe('the account and its parts cannot disagree (the screenshot that started D35)', () => {
  // Gifts & Giving: a count of $1,100 on Sunday, $60 a week confirmed.
  // Birthdays is due Thursday and takes its money first; Mother's Day and the
  // anniversary are below an even save since they last came round, but the
  // account covers every date on the transfer it already has, so each is at
  // or above its tick -- what the account must hold for it today (D40).
  const facts = input({
    lineItems: [
      li({ id: 'birthday', label: 'Birthday party', dueDate: '2026-10-01', recurrence: yearly, timelineStart: 'last_occurrence' }),
      li({ id: 'mothers-day', label: "Mother's Day", unitAmountCents: 75000, dueDate: '2027-05-01', recurrence: yearly, timelineStart: 'last_occurrence' }),
      li({ id: 'anniversary', label: 'Anniversary', dueDate: '2027-09-01', recurrence: yearly, timelineStart: 'last_occurrence' }),
    ],
    counts: [{ accountId: gifts.id, amountCents: 110000, on: '2026-09-27' }],
    transfers: [{ accountId: gifts.id, perWeekCents: 6000, confirmedOn: '2026-09-01' }],
    transferRoundUpCents: 1000,
  })
  const p = position(facts)
  const a = p.accounts[0]!
  const part = (id: string) => a.parts.find((x) => x.lineItem.id === id)!

  it('the account is on track, and so no part of it is Short', () => {
    expect(a.status).toBe('on_track')
    expect(a.parts.every((x) => x.status !== 'short')).toBe(true)
    expect(p.allCaughtUp).toBe(true)
  })

  it("Mother's Day is below an even save but at its tick, so it is On track (D40)", () => {
    const md = part('mothers-day')
    expect(md.savingSince).toEqual({ date: '2026-05-01', reason: 'last_occurrence' })
    expect(md.countedCents).toBeLessThan(md.savedForCents)
    expect(md.countedCents).toBeGreaterThanOrEqual(md.tickCents)
    expect(md.status).toBe('on_track')
    expect(part('birthday').status).toBe('on_track')
  })

  it('the parts count the money the account has, less what it holds for a later round (D40)', () => {
    const later = a.projection.slots.filter((x) => !x.current).reduce((s, x) => s + x.heldCents, 0)
    expect(a.parts.reduce((s, x) => s + x.countedCents, 0) + later).toBe(110000)
    expect(a.money.totalCents).toBe(110000)
  })

  it('the plan reads its worst part', () => {
    expect(p.plans[0]!.status).toBe('on_track')
  })

  it('a lower bank transfer makes the account Short, and its parts from that date on with it', () => {
    const low = position({
      ...facts,
      transfers: [{ accountId: gifts.id, perWeekCents: 1000, confirmedOn: '2026-09-01' }],
    })
    const la = low.accounts[0]!
    expect(la.status).toBe('short')
    expect(la.transferChange).toMatchObject({ fromCents: 1000, reason: 'raise' })
    // A part is Short where the money runs out before its tick (D40); one
    // the account can pay on the transfer it has is not.
    expect(la.parts.some((x) => x.status === 'short')).toBe(true)
    for (const x of la.parts) {
      if (x.countedCents < x.tickCents) expect(x.status).toBe('short')
      if (x.status === 'short') expect(x.outflowDate >= la.short!.on).toBe(true)
    }
    expect(low.allCaughtUp).toBe(false)
  })
})

describe('an account that is fine to its last date but not for ever', () => {
  // The screen that found this: Gifts & Giving read "On track, covers
  // everything through Sep 1, 2027" while a to-do asked to raise its
  // transfer from $60 to $90. The money it holds lasts past its last due
  // date, but $60 is below the $84.36 its yearly plans cost a week, so the
  // account drifts down every year after and runs dry some day.
  const facts = input({
    lineItems: [
      li({ id: 'party', dueDate: '2026-10-01', recurrence: yearly, timelineStart: 'last_occurrence' }),
      li({ id: 'shelby', unitAmountCents: 163500, dueDate: '2027-03-15', recurrence: yearly, timelineStart: 'last_occurrence' }),
      li({ id: 'mothers-day', unitAmountCents: 75000, dueDate: '2027-05-01', recurrence: yearly, timelineStart: 'last_occurrence' }),
      li({ id: 'anniversary', dueDate: '2027-09-01', recurrence: yearly, timelineStart: 'last_occurrence' }),
    ],
    counts: [{ accountId: gifts.id, amountCents: 363540, on: '2026-09-27' }],
    transfers: [{ accountId: gifts.id, perWeekCents: 6000, confirmedOn: TODAY }],
    transferRoundUpCents: 1000,
  })
  const a = position(facts).accounts[0]!

  it('is Running down: every bill now paid, the money there spent down, out on a later round (D39)', () => {
    expect(a.weeklyExactCents).toBeGreaterThan(6000)
    expect(a.status).toBe('running_down')
    // $1,000 + $1,635 + $750 + $1,000 = $4,385 a year: $83.62 a week at the
    // run-rate; the bank moves $60.
    expect(a.runRatePerWeekCents).toBe(8362)
    expect(a.short).toEqual({ on: '2029-03-15', byCents: 8960 })
    expect(a.short!.on > a.horizon!).toBe(true)
    // No plan it holds now is Short (D38 (6)): the account says what is
    // wrong, and This week asks for the fix.
    expect(a.parts.some((x) => x.status === 'short')).toBe(false)
    expect(a.transferChange).toEqual({ fromCents: 6000, toCents: a.weeklyCents, reason: 'keep_up' })
    expect(a.extraCents).toBe(0)
  })

  it('is On track, with nothing asked, once the bank moves what it needs', () => {
    const fixed = position({
      ...facts,
      transfers: [{ accountId: gifts.id, perWeekCents: a.weeklyCents, confirmedOn: TODAY }],
    }).accounts[0]!
    expect(fixed.status).toBe('on_track')
    expect(fixed.transferChange).toBeNull()
  })
})

describe('money today', () => {
  it('is the count plus transfers, moves and spends since', () => {
    const p = position(
      input({
        lineItems: [li({ id: 'roof', unitAmountCents: 10000000, dueDate: '2046-06-01' })],
        counts: [{ accountId: gifts.id, amountCents: 50000, on: '2026-09-01' }],
        // Confirmed on the 10th, taken as running since the count: four
        // Fridays in (Sep 1, Sep 28] at $25.
        transfers: [{ accountId: gifts.id, perWeekCents: 2500, confirmedOn: '2026-09-10' }],
        movesSinceCount: [{ accountId: gifts.id, amountCents: 3000 }],
        spendsSinceCount: [{ accountId: gifts.id, amountCents: 1000 }],
      }),
    )
    expect(p.accounts[0]!.money).toMatchObject({
      from: 'count',
      startCents: 50000,
      transfersSinceCents: 10000,
      movesSinceCents: 3000,
      spendsSinceCents: 1000,
      totalCents: 62000,
    })
  })

  it('starts from the openings stated at commit when the account was never counted', () => {
    const cycles: LineItemCycle[] = [
      { lineItemId: 'roof', startDate: '2026-09-01', openingCents: 40000, origin: 'commit' },
    ]
    const p = position(
      input({ lineItems: [li({ id: 'roof' })], cycleStarts: cycles }),
    )
    expect(p.accounts[0]!.money).toMatchObject({ from: 'openings', on: '2026-09-01', totalCents: 40000 })
  })

  it('reads a transfer change from the transfer after the day it was confirmed', () => {
    const schedule = {
      confirmations: [
        { accountId: gifts.id, perWeekCents: 1000, confirmedOn: '2026-09-01' },
        { accountId: gifts.id, perWeekCents: 3000, confirmedOn: '2026-09-18' }, // a Friday
      ],
      adjustments: [],
      transferWeekday: FRIDAY,
    }
    // Fridays Sep 4, 11 and 18 at $10 -- the change was confirmed on the
    // 18th, after that day's transfer had run -- and Sep 25 at $30.
    expect(bankTransfersBetween(schedule, '2026-09-01', TODAY)).toBe(6000)
  })
})

describe('the to-dos', () => {
  const base = input({
    lineItems: [li({ id: 'roof' })],
    counts: [{ accountId: gifts.id, amountCents: 0, on: TODAY }],
  })

  it('asks for the transfer to be confirmed before it judges the account', () => {
    const p = position(base)
    expect(p.accounts[0]!.status).toBe('unconfirmed')
    expect(p.todos).toEqual([
      expect.objectContaining({ kind: 'set_transfer', fromCents: null, toCents: 1924, reason: 'confirm', blocking: true }),
    ])
    expect(p.allCaughtUp).toBe(false)
  })

  it('asks to lower it once the saving is a whole step, and that never holds up All caught up', () => {
    const p = position({
      ...base,
      transferRoundUpCents: 500,
      transfers: [{ accountId: gifts.id, perWeekCents: 3000, confirmedOn: '2026-09-01' }],
    })
    expect(p.accounts[0]!.weeklyCents).toBe(2000)
    expect(p.todos).toEqual([
      expect.objectContaining({ kind: 'set_transfer', fromCents: 3000, toCents: 2000, reason: 'lower', blocking: false }),
    ])
    expect(p.allCaughtUp).toBe(true)
  })

  it('asks for nothing when the bank already moves enough, within a step', () => {
    const p = position({
      ...base,
      transferRoundUpCents: 1000,
      transfers: [{ accountId: gifts.id, perWeekCents: 2000, confirmedOn: '2026-09-01' }],
    })
    expect(p.todos).toEqual([])
    expect(p.allCaughtUp).toBe(true)
    expect(p.coveredThrough).toBe('2027-09-24')
  })

  it('does not ask twice for a move still open (D56 (2))', () => {
    const p = position({
      ...base,
      lineItems: [li({ id: 'soon', unitAmountCents: 50000, dueDate: '2026-10-09' })],
      transfers: [{ accountId: gifts.id, perWeekCents: 0, confirmedOn: '2026-09-01' }],
      onItsWay: [{ accountId: gifts.id, amountCents: 50000 }],
    })
    expect(p.accounts[0]!.oneTimeMove).toBeNull()
    // Asked, not done: the account is still judged on what is there.
    expect(p.accounts[0]!.status).toBe('short')
  })
})

describe("a part's steady line starts where the person said", () => {
  const plan = pkg({ committedAt: '2026-09-01' })
  const due = '2027-05-01'
  it('at the last occurrence by default for a repeating part', () => {
    expect(
      steadyLineStart({ lineItem: li({ id: 'x', dueDate: due, recurrence: yearly, timelineStart: 'last_occurrence' }), pkg: plan, cycles: [], today: TODAY }),
    ).toEqual({ date: '2026-05-01', reason: 'last_occurrence' })
  })
  it('on a typed day', () => {
    expect(
      steadyLineStart({
        lineItem: li({ id: 'x', dueDate: due, recurrence: yearly, timelineStart: 'typed', timelineStartDate: '2026-09-27' }),
        pkg: plan,
        cycles: [],
        today: TODAY,
      }),
    ).toEqual({ date: '2026-09-27', reason: 'typed' })
  })
  it('on the day the plan started', () => {
    expect(
      steadyLineStart({ lineItem: li({ id: 'x', dueDate: due, recurrence: yearly, timelineStart: 'commit' }), pkg: plan, cycles: [], today: TODAY }),
    ).toEqual({ date: '2026-09-01', reason: 'plan_started' })
  })
  it('never at a count, and at the spend date after a spend', () => {
    const cycles: LineItemCycle[] = [
      { lineItemId: 'x', startDate: '2026-09-27', openingCents: 0, origin: 'counted' },
      { lineItemId: 'x', startDate: '2026-06-02', openingCents: 0, origin: 'rolled' },
    ]
    expect(
      steadyLineStart({ lineItem: li({ id: 'x', dueDate: due, recurrence: yearly, timelineStart: 'last_occurrence' }), pkg: plan, cycles, today: TODAY }),
    ).toEqual({ date: '2026-06-02', reason: 'spent' })
  })
})

describe('counting toward parts (D40)', () => {
  const slot = (id: string, cents: number, tickCents: number, current = true) => ({
    lineItemId: id,
    cents,
    tickCents,
    current,
  })
  it('fills every slot to its tick soonest first, then every current round to its total soonest first', () => {
    const slots = [slot('a', 1000, 900), slot('b', 1000, 300)]
    expect(countTowardParts(slots, 1000).counted).toEqual(new Map([['a', 900], ['b', 100]]))
    expect(countTowardParts(slots, 1000).belowTick).toEqual(new Set(['b']))
    expect(countTowardParts(slots, 1250).counted).toEqual(new Map([['a', 950], ['b', 300]]))
    expect(countTowardParts(slots, 5000).counted).toEqual(new Map([['a', 1000], ['b', 1000]]))
  })
  it('holds money for a later round without counting it to the part', () => {
    const slots = [slot('a', 1000, 0), slot('a', 1000, 400, false)]
    const c = countTowardParts(slots, 500)
    expect(c.counted).toEqual(new Map([['a', 100]]))
    expect(c.held).toEqual([100, 400])
    expect(c.belowTick.size).toBe(0)
  })
})

describe('the tick is what the account must hold today (D40)', () => {
  const s = (id: string, on: CivilDate, cents: number) => ({ lineItemId: id, on, cents, current: true, label: id })
  it('takes off the transfers that land before each date, a surplus carried on', () => {
    // $20 a week. A: $1,000 by the 10th transfer; B: $100 by the 15th; C: $1,000 by the 20th.
    const arrived = (on: CivilDate) => 2000 * transferWeeksBetween('2026-10-11', on, 6)
    const slots = [s('a', '2026-12-19', 100000), s('b', '2027-01-23', 10000), s('c', '2027-02-27', 100000)]
    // A: 1000 − 200 = 800. B: 100 is covered by the 100 that lands before it, nothing over.
    // C: 1000 − the 100 that lands after B = 900.
    expect(slotTicks(slots, arrived)).toEqual([80000, 0, 90000])
  })

  it('reads the screenshot right: a part at or past its tick is never Short', () => {
    // RunDisney: a pass due sooner and two parts due later, one account,
    // the bank moving too little. The two later parts are Short, below
    // their ticks; the pass, due first, is paid.
    const p = position(
      input({
        lineItems: [
          li({ id: 'pass', label: 'Premier Pass', unitAmountCents: 48333, quantity: 3, dueDate: '2027-01-08' }),
          li({ id: 'food', label: 'Food', unitAmountCents: 100000, dueDate: '2027-01-26' }),
          li({ id: 'room', label: 'Boardwalk Villas', unitAmountCents: 391606, dueDate: '2027-01-26' }),
        ],
        counts: [{ accountId: gifts.id, amountCents: 280377, on: TODAY }],
        transfers: [{ accountId: gifts.id, perWeekCents: 10000, confirmedOn: '2026-09-01' }],
      }),
    )
    const a = p.accounts[0]!
    expect(a.status).toBe('short')
    for (const x of a.parts) expect(x.status === 'short').toBe(x.countedCents < x.tickCents)
    expect(a.parts.find((x) => x.lineItem.id === 'pass')!.status).toBe('on_track')
    expect(a.missingTodayCents).toBe(a.mustHoldCents - a.money.totalCents)
  })
})

describe('an account with money to spare and one that is Short (D40)', () => {
  // The envelope case: $500 due next week in one account, $500 sitting in
  // another that is not needed for two years.
  const soon: ReserveAccount = { ...gifts, id: 'acct-soon', name: 'Soon' }
  const later: ReserveAccount = { ...gifts, id: 'acct-later', name: 'Later' }
  const facts = input({
    accounts: [soon, later],
    lineItems: [
      li({ id: 'soon', unitAmountCents: 50000, dueDate: '2026-10-09', reserveAccountId: soon.id }),
      li({ id: 'later', unitAmountCents: 50000, dueDate: '2028-09-29', reserveAccountId: later.id }),
    ],
    counts: [
      { accountId: soon.id, amountCents: 0, on: TODAY },
      { accountId: later.id, amountCents: 100000, on: TODAY },
    ],
    transfers: [
      { accountId: soon.id, perWeekCents: 0, confirmedOn: '2026-09-01' },
      { accountId: later.id, perWeekCents: 0, confirmedOn: '2026-09-01' },
    ],
  })

  it('in one account, money for the later plan already pays the sooner one', () => {
    const one = position({
      ...facts,
      accounts: [gifts],
      lineItems: facts.lineItems.map((x) => ({ ...x, reserveAccountId: gifts.id })),
      counts: [{ accountId: gifts.id, amountCents: 50000, on: TODAY }],
      transfers: [{ accountId: gifts.id, perWeekCents: 0, confirmedOn: '2026-09-01' }],
    })
    expect(one.todos.some((t) => t.kind === 'move_in')).toBe(false)
    expect(one.accounts[0]!.weeklyExactCents).toBeGreaterThan(0)
  })

  it('asks for the spare money to move across before any new money, as one to-do', () => {
    const p = position(facts)
    expect(p.accounts.find((a) => a.account.id === soon.id)!.status).toBe('short')
    expect(p.todos).toEqual([
      {
        kind: 'move_between',
        fromAccountId: later.id,
        fromAccountName: 'Later',
        accountId: soon.id,
        accountName: 'Soon',
        amountCents: 50000,
        byDate: '2026-10-09',
        blocking: true,
      },
    ])
    expect(p.allCaughtUp).toBe(false)
  })

  it('once it is marked done, every figure is worked out again and nothing more is asked', () => {
    const done = position({
      ...facts,
      movesSinceCount: [
        { accountId: later.id, amountCents: -50000 },
        { accountId: soon.id, amountCents: 50000 },
      ],
    })
    expect(done.accounts.map((a) => a.status)).toEqual(['on_track', 'on_track'])
    expect(done.todos.filter((t) => t.blocking)).toEqual([])
  })

  it('offers no move into an account an open ask already fills (D56 (2))', () => {
    const p = position({ ...facts, onItsWay: [{ accountId: soon.id, amountCents: 50000 }] })
    expect(p.todos.filter((t) => t.blocking)).toEqual([])
    // Still Short until the ask is done, and the fix it waits on is that money.
    expect(p.accounts.find((a) => a.account.id === soon.id)!.status).toBe('short')
    expect(p.fixes.get(soon.id)).toEqual({ nowCents: 50000, perWeekCents: null })
  })

  it('asks across only for what an open ask leaves missing (D56 (2))', () => {
    const p = position({ ...facts, onItsWay: [{ accountId: soon.id, amountCents: 20000 }] })
    expect(p.todos).toEqual([expect.objectContaining({ kind: 'move_between', amountCents: 30000 })])
    // The line under a Short bar names the money already asked for first.
    expect(shortReasons(p).get(soon.id)!.fixes).toEqual(['the $200.00 already asked for', 'move $300.00 from Later'])
  })

  it('lends only what a lender would have left after an open move out of it (D56 (2))', () => {
    const p = position({ ...facts, onItsWay: [{ accountId: later.id, amountCents: -50000 }] })
    expect(p.todos.some((t) => t.kind === 'move_between')).toBe(false)
    expect(p.todos.some((t) => t.kind === 'move_in' && t.accountId === soon.id)).toBe(true)
  })

  it('never lends: an account with nothing to spare is not asked', () => {
    const p = position({
      ...facts,
      counts: [
        { accountId: soon.id, amountCents: 0, on: TODAY },
        { accountId: later.id, amountCents: 50000, on: TODAY },
      ],
    })
    expect(p.todos.some((t) => t.kind === 'move_between')).toBe(false)
    expect(p.todos.some((t) => t.kind === 'move_in' && t.accountId === soon.id)).toBe(true)
  })
})

describe('the plan chart (D40)', () => {
  it('ends short of the total on the transfer set up now, and at it after the fix', () => {
    const facts = input({
      lineItems: [li({ id: 'trip', unitAmountCents: 200000, dueDate: '2027-03-26' })],
      counts: [{ accountId: gifts.id, amountCents: 50000, on: TODAY }],
      transfers: [{ accountId: gifts.id, perWeekCents: 2000, confirmedOn: '2026-09-01' }],
    })
    const p = position(facts)
    const plan = p.plans[0]!
    expect(plan.status).toBe('short')
    const chart = planChart({ plan, household: p, today: TODAY, transferWeekday: FRIDAY })!
    expect(chart.actual[0]).toEqual({ date: TODAY, cents: 50000 })
    expect(chart.actual.at(-1)!.cents).toBeLessThan(200000)
    expect(chart.afterFix!.at(-1)!.cents).toBe(200000)
    expect(chart.story.due.cents).toBeLessThan(chart.story.due.totalCents)
    const fine = position({ ...facts, transfers: [{ accountId: gifts.id, perWeekCents: 10000, confirmedOn: '2026-09-01' }] })
    const fineChart = planChart({ plan: fine.plans[0]!, household: fine, today: TODAY, transferWeekday: FRIDAY })!
    expect(fineChart.afterFix).toBeNull()
    expect(fineChart.actual.at(-1)!.cents).toBe(200000)
  })
})

describe('the plan chart beside saving it on its own (D50)', () => {
  // Christmas started last week, so its own pace is near nothing, but it is
  // due in twelve transfers: the account's money is paying it first. The
  // trip has been saving since January and holds less than its own pace.
  const christmas = pkg({ id: 'pkg-xmas', name: 'Christmas', committedAt: '2026-09-25' })
  const trip = pkg({ id: 'pkg-trip', name: 'Disney trip', committedAt: '2026-01-02' })
  const lineItems = [
    li({ id: 'gifts', packageId: christmas.id, unitAmountCents: 120000, dueDate: '2026-12-25' }),
    li({ id: 'trip', packageId: trip.id, unitAmountCents: 400000, dueDate: '2027-09-24' }),
  ]
  const facts = input({
    packages: [christmas, trip],
    lineItems,
    counts: [{ accountId: gifts.id, amountCents: 100000, on: TODAY }],
  })
  const asked = position(facts).accounts[0]!.weeklyCents
  const p = position({ ...facts, transfers: [{ accountId: gifts.id, perWeekCents: asked, confirmedOn: TODAY }] })
  const plan = p.plans.find((x) => x.package.id === trip.id)!
  const chart = planChart({ plan, household: p, today: TODAY, transferWeekday: FRIDAY })!

  it('draws saving it on its own on the same dates, reaching the total on the day', () => {
    expect(plan.status).toBe('on_track')
    expect(chart.onItsOwn.map((x) => x.date)).toEqual(chart.actual.map((x) => x.date))
    expect(chart.onItsOwn[0]!.cents).toBe(plan.savedForCents)
    expect(chart.onItsOwn.at(-1)!.cents).toBe(400000)
    expect(chart.actual.at(-1)!.cents).toBe(400000)
  })

  it('says what is below its own pace, and that Christmas is holding it', () => {
    const now = chart.story.now
    expect(now.cents).toBe(plan.countedCents)
    expect(now.onItsOwnCents).toBe(plan.savedForCents)
    expect(now.belowCents).toBe(plan.savedForCents - plan.countedCents)
    expect(now.belowCents).toBeGreaterThan(0)
    expect(now.heldBy.map((c) => [c.name, c.sooner])).toEqual([['Christmas', true]])
    expect(now.coveringCents).toBe(now.heldBy[0]!.cents)
    expect(now.coveringCents).toBeGreaterThan(0)
    expect(now.toComeCents).toBeGreaterThan(0)
    expect(now.coveringCents + now.toComeCents).toBe(now.belowCents)
  })

  it('tells the transfers ahead in stretches: Christmas first, then the trip', () => {
    const [first, second] = chart.story.phases
    expect(first!.kind).toBe('waiting')
    expect(first!.addedCents).toBeLessThan(PHASE_MIN_RISE_CENTS * first!.transfers)
    expect(first!.others.map((x) => x.name)).toEqual(['Christmas'])
    expect(first!.others[0]!.dueDate).toBe('2026-12-25')
    expect(compareDates(first!.to, '2026-12-25')).toBeLessThanOrEqual(0)
    expect(first!.rolledOff).toEqual([])
    expect(first!.othersMore).toBe(0)
    expect(second!.kind).toBe('filling')
    // Christmas is covered, so money starts coming here: that is the turn.
    expect(second!.rolledOff.map((x) => x.name)).toEqual(['Christmas'])
    expect(second!.others.map((x) => x.name)).not.toContain('Christmas')
    expect(second!.perWeekCents).toBeGreaterThan(0)
    expect(second!.perWeekCents).toBeLessThanOrEqual(asked)
    const last = chart.story.phases.at(-1)!
    expect(last.endCents).toBe(400000)
    expect(chart.story.full!.on).toBe(last.to)
    expect(chart.story.due).toEqual({ on: '2027-09-24', cents: 400000, totalCents: 400000, reachesTotal: true })
    expect(chart.story.onTrack).toBe(true)
  })

  it('counts the plans it does not name, so a plan said to be covered was said to be paid first', () => {
    // Five small plans due before Christmas, then a trip: the first stretch
    // pays all five, names three and counts the other two.
    const small = ['A', 'B', 'C', 'D', 'E'].map((n) => pkg({ id: `pkg-${n}`, name: `Plan ${n}`, committedAt: '2026-09-25' }))
    const trip2 = pkg({ id: 'pkg-trip2', name: 'Trip', committedAt: '2026-09-25' })
    const items = [
      ...small.map((x, i) => li({ id: `p-${x.id}`, packageId: x.id, unitAmountCents: 30000 + i * 1000, dueDate: '2026-12-11' })),
      li({ id: 'trip2', packageId: trip2.id, unitAmountCents: 300000, dueDate: '2027-09-24' }),
    ]
    const f = input({ packages: [...small, trip2], lineItems: items, counts: [{ accountId: gifts.id, amountCents: 0, on: TODAY }] })
    const w = position(f).accounts[0]!.weeklyCents
    const hh = position({ ...f, transfers: [{ accountId: gifts.id, perWeekCents: w, confirmedOn: TODAY }] })
    const c = planChart({ plan: hh.plans.find((x) => x.package.id === trip2.id)!, household: hh, today: TODAY, transferWeekday: FRIDAY })!
    const first = c.story.phases[0]!
    expect(first.kind).toBe('waiting')
    expect(first.others).toHaveLength(3)
    expect(first.othersMore).toBe(2)
    const turn = c.story.phases.find((x) => x.rolledOff.length > 0)!
    expect(turn.kind).toBe('filling')
    expect(turn.rolledOff).toHaveLength(3)
    expect(turn.rolledOffMore).toBe(2)
  })

  it('draws every stretch where it starts and ends, however coarsely the chart is drawn', () => {
    const coarse = planChart({ plan, household: p, today: TODAY, transferWeekday: FRIDAY, maxPoints: 5 })!
    const dates = new Set(coarse.actual.map((x) => x.date))
    for (const x of coarse.story.phases) {
      expect(dates.has(x.from)).toBe(true)
      expect(dates.has(x.to)).toBe(true)
    }
  })

  it('names a later plan holding the money today, while the plan due soonest rides the next transfers', () => {
    // The screenshot: $200 due in a fortnight, saving since a year ago,
    // holding only what is left over, because the money already here is
    // what a bigger plan due later must hold now.
    const soon = pkg({ id: 'pkg-soon', name: 'Anniversary', committedAt: '2025-10-10' })
    const later = pkg({ id: 'pkg-later', name: 'Property tax', committedAt: '2026-09-21' })
    const f = input({
      packages: [soon, later],
      lineItems: [
        li({ id: 'a', packageId: soon.id, unitAmountCents: 20000, dueDate: '2026-10-09' }),
        li({ id: 'b', packageId: later.id, unitAmountCents: 500000, dueDate: '2026-12-25' }),
      ],
      counts: [{ accountId: gifts.id, amountCents: 300000, on: TODAY }],
    })
    const w = position(f).accounts[0]!.weeklyCents
    const h = position({ ...f, transfers: [{ accountId: gifts.id, perWeekCents: w, confirmedOn: TODAY }] })
    const small = h.plans.find((x) => x.package.id === soon.id)!
    const c = planChart({ plan: small, household: h, today: TODAY, transferWeekday: FRIDAY })!
    expect(c.story.now.belowCents).toBeGreaterThan(0)
    expect(c.story.now.heldBy.map((x) => [x.name, x.sooner])).toEqual([['Property tax', false]])
    expect(c.story.now.toComeCents).toBe(0)
    expect(c.story.phases[0]!.kind).toBe('filling')
    expect(c.story.full).not.toBeNull()
    expect(c.story.onTrack).toBe(true)
  })

  it('never promises on a transfer nobody has set up', () => {
    const unset = position(facts)
    const c = planChart({ plan: unset.plans.find((x) => x.package.id === trip.id)!, household: unset, today: TODAY, transferWeekday: FRIDAY })!
    expect(unset.accounts[0]!.status).toBe('unconfirmed')
    expect(c.story.onTrack).toBe(false)
  })

  it('works out what is below its own pace account by account', () => {
    // The trip's lodging sits in a second account, well ahead of its pace;
    // its tickets, in the first, are behind theirs while Christmas is paid
    // first. Ahead in one account never hides below in the other.
    const other = { ...gifts, id: 'acct-other', name: 'Long Term' }
    const split = position({
      ...facts,
      accounts: [gifts, other],
      lineItems: [...lineItems, li({ id: 'lodging', packageId: trip.id, unitAmountCents: 400000, dueDate: '2027-09-24', reserveAccountId: other.id })],
      counts: [
        { accountId: gifts.id, amountCents: 100000, on: TODAY },
        { accountId: other.id, amountCents: 400000, on: TODAY },
      ],
    })
    const tripPlan = split.plans.find((x) => x.package.id === trip.id)!
    const c = planChart({ plan: tripPlan, household: split, today: TODAY, transferWeekday: FRIDAY })!
    const tickets = tripPlan.parts.find((x) => x.lineItem.id === 'trip')!
    expect(tripPlan.countedCents).toBeGreaterThan(tripPlan.savedForCents)
    expect(c.story.now.belowCents).toBe(tickets.savedForCents - tickets.countedCents)
    expect(c.story.now.heldBy.map((x) => x.name)).toEqual(['Christmas'])
  })

  it('claims nothing for a plan at or ahead of its own pace', () => {
    const alone = position({
      ...facts,
      packages: [trip],
      lineItems: [lineItems[1]!],
      counts: [{ accountId: gifts.id, amountCents: 300000, on: TODAY }],
      transfers: [{ accountId: gifts.id, perWeekCents: 10000, confirmedOn: TODAY }],
    })
    const c = planChart({ plan: alone.plans[0]!, household: alone, today: TODAY, transferWeekday: FRIDAY })!
    expect(c.story.now.belowCents).toBe(0)
    expect(c.story.now.heldBy).toEqual([])
    expect(c.story.phases.every((x) => x.kind === 'filling')).toBe(true)
  })
})

describe('the due pins on a plan timeline', () => {
  const part = (id: string, dueDate: string, cents: number) =>
    position(input({ lineItems: [li({ id, label: id, unitAmountCents: cents, dueDate })] })).accounts[0]!.parts[0]!
  const ian = part('Ian', '2027-10-01', 50000)
  const mia = part('Mia', '2027-03-12', 40000)
  const zoe = part('Zoe', '2027-03-12', 30000)
  const old = part('Old', '2027-01-01', 1000)
  const past = { ...old, lineItem: { ...old.lineItem, dueDate: '2026-09-01' } }

  it('draws none on a plan of one part: its date is the end of the chart', () => {
    expect(dueMarksOf([ian], TODAY)).toEqual([])
  })

  it('numbers the rest soonest first, one pin for parts due the same day, none already past', () => {
    expect(dueMarksOf([ian, zoe, past, mia], TODAY)).toEqual([
      { n: 1, date: '2027-03-12', parts: [{ label: 'Mia', cents: 40000 }, { label: 'Zoe', cents: 30000 }] },
      { n: 2, date: '2027-10-01', parts: [{ label: 'Ian', cents: 50000 }] },
    ])
  })
})

describe('what an account likely holds, in words (D34, D35)', () => {
  // Gifts & Giving: counted at $3,904.83 on Sunday; since then $95.44 moved
  // out and a $350 part confirmed spent. The sentence and the number come
  // from the same breakdown, so the spend is in both.
  const p = position(
    input({
      today: '2026-10-17',
      transferWeekday: 6,
      lineItems: [li({ id: 'xmas', unitAmountCents: 200000, dueDate: '2026-12-19', recurrence: yearly })],
      counts: [{ accountId: gifts.id, amountCents: 390483, on: '2026-10-11' }],
      movesSinceCount: [{ accountId: gifts.id, amountCents: -9544 }],
      spendsSinceCount: [{ accountId: gifts.id, amountCents: 35000 }],
    }),
  )
  const money = p.accounts[0]!.money

  it('carries the spend as well as the move, and asks for a count', () => {
    expect(money).toMatchObject({
      startCents: 390483,
      movesInCents: 0,
      movesOutCents: 9544,
      spendsSinceCents: 35000,
      totalCents: 390483 - 9544 - 35000,
      countOwed: true,
    })
  })

  it('says every piece of it, with the count as a date a screen can say as a distance', () => {
    const parts = moneySinceParts(money)
    expect(parts.filter((x) => x.date).map((x) => x.date)).toEqual([{ on: '2026-10-11', as: 'plain' }])
    expect(moneySinceSentence(money)).toBe(
      'Counted at $3,904.83 on 2026-10-11. Since then, $95.44 moved out and $350.00 spent. Likely holds $3,459.39.',
    )
  })

  it('does not ask for a count when only the transfer has run since', () => {
    const quiet = position(
      input({
        today: '2026-10-17',
        transferWeekday: 6,
        lineItems: [li({ id: 'xmas', unitAmountCents: 200000, dueDate: '2026-12-19' })],
        counts: [{ accountId: gifts.id, amountCents: 100000, on: '2026-10-11' }],
        transfers: [{ accountId: gifts.id, perWeekCents: 15000, confirmedOn: '2026-09-01' }],
      }),
    ).accounts[0]!.money
    expect(quiet).toMatchObject({ transfersSinceCents: 15000, countOwed: false })
    expect(moneySinceSentence(quiet)).toBe(
      'Counted at $1,000.00 on 2026-10-11. Since then, $150.00 transferred in. Likely holds $1,150.00.',
    )
  })
})

describe('a repeating plan moves on by itself, and money goes out a bit at a time (D53)', () => {
  // Ian's party, $500 every 4 October, three weeks gone and not answered.
  const party = li({ id: 'party', label: 'Ian Birthday Party', unitAmountCents: 50000, dueDate: '2026-10-04', recurrence: yearly, timelineStart: 'last_occurrence' })
  const facts = (roundEvents: PositionInput['roundEvents'] = [], spent = 0): PositionInput =>
    input({
      today: '2026-10-25',
      lineItems: [party],
      counts: [{ accountId: gifts.id, amountCents: 50000, on: '2026-10-01' }],
      transfers: [{ accountId: gifts.id, perWeekCents: 1000, confirmedOn: '2026-09-01' }],
      spendsSinceCount: spent ? [{ accountId: gifts.id, amountCents: spent }] : [],
      roundEvents,
    })
  const spend = (amountCents: number, roundDue = '2026-10-04') =>
    ({ eventId: `s${amountCents}`, kind: 'spend' as const, lineItemId: 'party', roundDue, amountCents, on: '2026-10-25' })

  it('starts saving for next year on the date, while this year stays open and held', () => {
    const p = position(facts())
    const [old, next] = p.plans[0]!.parts
    expect(old!.lineItem.label).toBe('Ian Birthday Party (2026)')
    expect(old!.round).toMatchObject({ lineItemId: 'party', dueDate: '2026-10-04', past: true, openRounds: 2 })
    expect(old!.totalCents).toBe(50000)
    expect(old!.status).toBe('ready_to_spend')
    expect(next!.lineItem.id).toBe('party')
    expect(next!.lineItem.label).toBe('Ian Birthday Party (2027)')
    expect(next!.lineItem.dueDate).toBe('2027-10-04')
    expect(next!.savingSince).toEqual({ date: '2026-10-04', reason: 'last_occurrence' })
  })

  it('takes a spend off what the round still holds, and leaves the weekly amount where it was', () => {
    const before = position(facts()).accounts[0]!
    const after = position(facts([spend(10000)], 10000))
    expect(after.plans[0]!.parts[0]!.totalCents).toBe(40000)
    expect(after.plans[0]!.parts[0]!.round.spentCents).toBe(10000)
    expect(after.accounts[0]!.weeklyExactCents).toBe(before.weeklyExactCents)
  })

  it('once the spends reach the total, only next year is left, under its own name', () => {
    const p = position(facts([spend(30000), spend(20000)], 50000))
    expect(p.plans[0]!.parts.map((x) => [x.lineItem.label, x.lineItem.dueDate])).toEqual([
      ['Ian Birthday Party', '2027-10-04'],
    ])
  })
})

describe('invariants over randomised households (D35)', () => {
  // A small deterministic PRNG so a failure is reproducible.
  function rng(seed: number) {
    let s = seed
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }
  const UNITS = ['day', 'week', 'month', 'year'] as const

  it('holds for every account, part, plan and the headline', () => {
    const random = rng(20260928)
    const int = (n: number) => Math.floor(random() * n)

    for (let run = 0; run < 300; run += 1) {
      const transferWeekday = int(7) as Weekday
      const today = addDays('2026-01-01', int(365))
      const accounts: ReserveAccount[] = [0, 1].map((i) => ({ ...gifts, id: `acct-${i}`, name: `Account ${i}` }))
      const packages: Package[] = [0, 1, 2].map((i) =>
        pkg({ id: `pkg-${i}`, committedAt: addDays(today, -int(400)), state: i === 2 && random() < 0.3 ? 'simulated' : 'active' }),
      )
      const lineItems: LineItem[] = Array.from({ length: 1 + int(7) }, (_, i) => {
        const recurring = random() < 0.6
        const kind = int(3)
        const dueDate = addDays(today, random() < 0.1 ? -int(20) : 1 + int(recurring ? 400 : 3000))
        return li({
          id: `li-${i}`,
          label: `Part ${i}`,
          packageId: `pkg-${int(3)}`,
          reserveAccountId: `acct-${int(2)}`,
          unitAmountCents: 1 + int(300000),
          quantity: 1 + int(3),
          dueDate,
          recurrence: recurring ? { every: 1 + int(3), unit: UNITS[1 + int(3)]! } : null,
          timelineStart: !recurring ? 'commit' : kind === 0 ? 'commit' : kind === 1 ? 'last_occurrence' : 'typed',
          timelineStartDate: recurring && kind === 2 ? addDays(today, -int(200)) : null,
        })
      })
      const facts: { -readonly [K in keyof PositionInput]: PositionInput[K] } = {
        today,
        accounts,
        packages,
        lineItems,
        transferWeekday,
        transferRoundUpCents: [0, 500, 1000][int(3)]!,
        counts: accounts
          .filter(() => random() < 0.8)
          .map((a) => ({ accountId: a.id, amountCents: int(800000), on: addDays(today, -int(60)) })),
        transfers: accounts
          .filter(() => random() < 0.8)
          .map((a) => ({ accountId: a.id, perWeekCents: int(60000), confirmedOn: addDays(today, -int(90)) })),
      }
      // Spends, finishes and saves back up against a part's rounds (D53):
      // its stored round or the one after, before or after its date.
      const roundEvents: RoundEvent[] = []
      for (const item of lineItems) {
        if (random() < 0.6) continue
        const dates = [item.dueDate, nextOccurrence(item.dueDate, item.recurrence)].filter((d): d is CivilDate => d !== null)
        for (let k = 1 + int(3); k > 0; k -= 1) {
          const r = random()
          roundEvents.push({
            eventId: `r-${roundEvents.length}`,
            kind: r < 0.6 ? 'spend' : r < 0.8 ? 'finish' : 'save_back_up',
            lineItemId: item.id,
            roundDue: dates[int(dates.length)]!,
            amountCents: r < 0.6 ? 1 + int(lineItemTotalCents(item)) : 0,
            on: today,
          })
        }
      }
      facts.roundEvents = roundEvents
      // Moves in and out and spends marked done since the count (D34), one
      // entry each. What goes out is bounded by what the account held before
      // it, as at a bank: a likely balance below zero is not generated here.
      const held = new Map(position(facts).accounts.map((a) => [a.account.id, Math.max(0, a.money.totalCents)]))
      const movesSinceCount: { accountId: string; amountCents: number }[] = []
      const spendsSinceCount: { accountId: string; amountCents: number }[] = []
      for (let k = int(4); k > 0; k -= 1) {
        const id = `acct-${int(2)}`
        const have = held.get(id) ?? 0
        const amount = random() < 0.5 ? -int(Math.min(have, 50000) + 1) : 1 + int(50000)
        if (amount === 0) continue
        movesSinceCount.push({ accountId: id, amountCents: amount })
        held.set(id, have + amount)
      }
      for (const a of accounts) {
        const have = held.get(a.id) ?? 0
        if (random() < 0.3) spendsSinceCount.push({ accountId: a.id, amountCents: int(have + 1) })
      }
      facts.movesSinceCount = movesSinceCount
      facts.spendsSinceCount = spendsSinceCount
      // Asks still open (D56): money on its way in, now and then out.
      const asked = position(facts)
      if (random() < 0.5) {
        facts.onItsWay = accounts.flatMap((a) =>
          random() < 0.5
            ? [{ accountId: a.id, amountCents: random() < 0.8 ? 1 + int(300000) : -int(Math.max(0, held.get(a.id) ?? 0) + 1) }]
            : [],
        )
      }
      const wayOf = (id: string) =>
        (facts.onItsWay ?? []).filter((m) => m.accountId === id).reduce((t, m) => t + m.amountCents, 0)
      const p = position(facts)

      // 10. An open ask is money on its way, never money there (D56 (2)):
      // it changes no balance and no status, and every to-do is worked out
      // as if it arrives, so the same money is never asked for twice.
      for (const a of p.accounts) {
        const without = asked.accounts.find((x) => x.account.id === a.account.id)!
        expect(a.money).toEqual(without.money)
        expect(a.status).toBe(without.status)
        expect(a.parts.map((x) => [x.status, x.countedCents])).toEqual(without.parts.map((x) => [x.status, x.countedCents]))
      }
      // ... and the to-dos with a move still asked for are the to-dos as if it
      // were done: nothing more, nothing less. (Only a transfer to lower is
      // held back while money is on its way in; and a lender never lends
      // money still on its way to it, so a lender with money on its way in
      // is left out of the comparison.)
      const coming = (facts.onItsWay ?? []).filter((m) => m.amountCents > 0)
      if (coming.length > 0) {
        const done = position({
          ...facts,
          onItsWay: (facts.onItsWay ?? []).filter((m) => m.amountCents <= 0),
          movesSinceCount: [...(facts.movesSinceCount ?? []), ...coming],
        })
        const lends = (q: typeof p, id: string) => q.todos.some((t) => t.kind === 'move_between' && t.fromAccountId === id)
        if (!coming.some((m) => lends(p, m.accountId) || lends(done, m.accountId))) {
          const asks = (q: typeof p, id: string) => {
            const x = q.accounts.find((y) => y.account.id === id)!
            return {
              move: x.oneTimeMove,
              transfer: x.transferChange?.reason === 'lower' ? null : x.transferChange,
              between: q.todos.filter((t) => t.kind === 'move_between' && t.accountId === id),
            }
          }
          for (const a of accounts) expect(asks(p, a.id)).toEqual(asks(done, a.id))
        }
      }

      for (const a of p.accounts) {
        // 0. What the account likely holds is said in the same pieces it is
        // added up from (D34, D35): the sentence on check-in and This week
        // can never disagree with the number, and a recount is owed exactly
        // when money went out since the count, a move out or a spend (D58).
        const mine = facts.movesSinceCount!.filter((m) => m.accountId === a.account.id)
        const spent = facts.spendsSinceCount!.filter((m) => m.accountId === a.account.id)
        expect(a.money.movesInCents).toBe(mine.filter((m) => m.amountCents > 0).reduce((t, m) => t + m.amountCents, 0))
        expect(a.money.movesOutCents).toBe(mine.filter((m) => m.amountCents < 0).reduce((t, m) => t - m.amountCents, 0))
        expect(a.money.movesSinceCents).toBe(a.money.openingsSinceCents + a.money.movesInCents - a.money.movesOutCents)
        expect(a.money.totalCents).toBe(
          a.money.startCents + a.money.transfersSinceCents + a.money.movesSinceCents - a.money.spendsSinceCents,
        )
        expect(a.money.countOwed).toBe(mine.some((m) => m.amountCents < 0) || spent.some((m) => m.amountCents > 0))
        expect(moneySinceSentence(a.money)).toContain(`Likely holds ${formatCents(a.money.totalCents)}.`)

        // 1. At W with M made, every date passes -- and W is the smallest that does.
        const { requirements, runRatePerWeekCents } = requirementsFor({
          parts: a.parts,
          today,
          transferWeekday,
        })
        const level = levelWeekly({ moneyCents: a.money.totalCents, requirements, runRatePerWeekCents })
        expect(level.weeklyExactCents).toBe(a.weeklyExactCents)
        for (const r of requirements) {
          expect(a.money.totalCents + level.moveCents + a.weeklyCents * r.transfers).toBeGreaterThanOrEqual(r.needCents)
        }
        if (a.weeklyExactCents > Math.max(0, runRatePerWeekCents)) {
          const lower = a.weeklyExactCents - 1
          const someFarFails = requirements.some(
            (r) => r.transfers > NEAR_TRANSFERS && a.money.totalCents + level.moveCents + lower * r.transfers < r.needCents,
          )
          expect(someFarFails).toBe(true)
        }
        expect(a.weeklyCents).toBeGreaterThanOrEqual(a.weeklyExactCents)

        // 2. The ticks (D40) add up to the least the account must hold
        // today for every date to pass on its transfer, and the account is
        // Short exactly when it holds less. A part is Short exactly when
        // some slot of it is below its tick on a Short account: a bar below
        // its tick on a Short account is Short, and a part is never Short
        // on an account that is not. Its own current date is never before
        // the day the account runs dry.
        if (a.bank) {
          const arrived = (on: CivilDate) => bankTransfersBetween(
            { confirmations: (facts.transfers ?? []).filter((t) => t.accountId === a.account.id), adjustments: [], transferWeekday },
            today,
            on,
          )
          const least = requirements.reduce((m, r) => Math.max(m, r.needCents - arrived(r.on)), 0)
          expect(a.mustHoldCents).toBe(least)
          if (a.status === 'short') expect(a.money.totalCents).toBeLessThan(a.mustHoldCents)
          if (a.status === 'on_track') expect(a.money.totalCents).toBeGreaterThanOrEqual(a.mustHoldCents)
        }
        for (const x of a.parts) {
          expect(x.status === 'short').toBe(a.status === 'short' && x.countedCents < x.tickCents)
          if (x.status === 'short') expect(compareDates(x.outflowDate, a.short!.on)).toBeGreaterThanOrEqual(0)
          expect(x.tickCents).toBeLessThanOrEqual(x.totalCents)
        }
        // A Short account cannot pay a current bill, so it always has a Short
        // part. Running down (D39) pays every current bill and runs out only
        // on a later round, because the bank moves less than the bills cost
        // a year: no Short part, and it is asked to keep up.
        if (a.status === 'short') {
          expect(compareDates(a.short!.on, a.horizon!)).toBeLessThanOrEqual(0)
          expect(a.parts.some((x) => x.status === 'short')).toBe(true)
        }
        // Running down: every current round is paid and a later round
        // runs out -- beyond the horizon, or within it after them (D40).
        if (a.status === 'running_down') {
          expect(a.parts.some((x) => x.status === 'short')).toBe(false)
          // ... unless money on its way in (D56) carries it, as it would once
          // done; with a move out of it still asked for, it would be Short, so
          // the ask is a raise.
          const way = wayOf(a.account.id)
          const fix = way < 0 ? ['keep_up', 'raise'] : ['keep_up']
          expect(fix.includes(a.transferChange?.reason ?? '') || a.oneTimeMove !== null || way > 0).toBe(true)
        }
        // 7. What a part is missing today (D41) is above zero exactly when it
        // is Short, and is never more than its tick: "+ $Y to make up" never
        // shows on a part that is not Short, and never asks for more than
        // the account must hold for it today.
        for (const x of a.parts) {
          expect(x.shortByCents > 0).toBe(x.status === 'short')
          expect(x.shortByCents).toBe(x.status === 'short' ? x.tickCents - x.countedCents : 0)
          expect(x.shortByCents).toBeLessThanOrEqual(x.tickCents)
        }
        for (const x of a.parts) {
          // 3. Counting never invents money and never over-fills a part.
          expect(x.countedCents).toBeGreaterThanOrEqual(0)
          expect(x.countedCents).toBeLessThanOrEqual(x.totalCents)
          if (x.status === 'on_track' && a.status !== 'unconfirmed') {
            expect(x.countedCents).toBeGreaterThanOrEqual(x.tickCents)
          }
          // 6. Ready to spend (D38) is a part on or past its date with all its
          // money there; and on an account whose transfer is known, a part on
          // or past its date is either that or Short, so a snoozed question
          // can never sit on a shortfall that reads as anything gentler.
          const dueByToday = compareDates(x.lineItem.dueDate, today) <= 0
          if (x.status === 'ready_to_spend') {
            expect(dueByToday).toBe(true)
            expect(x.countedCents).toBe(x.totalCents)
          }
          if (dueByToday && a.status !== 'unconfirmed') {
            expect(['ready_to_spend', 'short']).toContain(x.status)
          }
        }
        expect(a.parts.reduce((s, x) => s + x.countedCents, 0)).toBeLessThanOrEqual(Math.max(0, a.money.totalCents))

        // 4. The status and the asks can never disagree: an account that is
        // fine is asked for nothing it depends on, and a Short one is always
        // told what fixes it.
        // (An open move out of it, D56, is asked for and so may need covering.)
        const asksOut = wayOf(a.account.id) < 0
        if (a.status === 'on_track' && !asksOut) {
          expect(a.oneTimeMove).toBeNull()
          expect(a.transferChange?.reason).not.toBe('raise')
          expect(a.transferChange?.reason).not.toBe('keep_up')
        }
        if (a.transferChange?.reason === 'raise' && !asksOut) expect(a.status).toBe('short')
        // A Short account a surplus move puts right on its current dates may
        // still be asked to keep up (D40); otherwise keeping up is Running down's.
        if (a.transferChange?.reason === 'keep_up' && !asksOut) {
          const movedIn =
            p.todos.some((t) => t.kind === 'move_between' && t.accountId === a.account.id) || wayOf(a.account.id) > 0
          expect(a.status === 'running_down' || (a.status === 'short' && movedIn)).toBe(true)
        }
        // What could leave today is never more than is there today.
        expect(a.extraCents).toBeLessThanOrEqual(Math.max(0, a.money.totalCents))
        // Lowering is only ever offered to where the account is still fine,
        // with nothing else asked.
        if (a.transferChange?.reason === 'lower' && wayOf(a.account.id) === 0) {
          const lowered = position({
            ...facts,
            transfers: [
              ...(facts.transfers ?? []),
              { accountId: a.account.id, perWeekCents: a.transferChange.toCents, confirmedOn: today },
            ],
          }).accounts.find((x) => x.account.id === a.account.id)!
          expect(lowered.status).toBe('on_track')
          expect(lowered.oneTimeMove).toBeNull()
        }
        if (a.status === 'short') {
          // ... unless an open ask already brings what fixes it (D56).
          const movedIn =
            p.todos.some((t) => t.kind === 'move_between' && t.accountId === a.account.id) || wayOf(a.account.id) > 0
          expect(a.transferChange?.reason === 'raise' || a.oneTimeMove !== null || movedIn).toBe(true)
          expect(p.fixes.has(a.account.id)).toBe(true)
        }
      }

      // 7. Money moves between accounts only as a surplus (D40): from an
      // account On track on its own transfer, never more than its extra,
      // never more than the Short account is missing, and the lender is
      // still On track with it gone.
      const between = p.todos.filter((t) => t.kind === 'move_between')
      for (const t of between) {
        if (t.kind !== 'move_between') continue
        const from = p.accounts.find((x) => x.account.id === t.fromAccountId)!
        const to = p.accounts.find((x) => x.account.id === t.accountId)!
        expect(from.status).toBe('on_track')
        expect(to.status).toBe('short')
        expect(t.amountCents).toBeGreaterThan(0)
        expect(t.amountCents).toBeLessThanOrEqual(from.extraCents)
        // What it is missing with every open ask done (D56): more, by an open move out of it.
        expect(t.amountCents).toBeLessThanOrEqual(to.missingTodayCents + Math.max(0, -wayOf(to.account.id)))
      }
      if (between.length > 0) {
        const after = position({
          ...facts,
          movesSinceCount: [
            ...(facts.movesSinceCount ?? []),
            ...between.flatMap((t) =>
            t.kind === 'move_between'
              ? [
                  { accountId: t.fromAccountId, amountCents: -t.amountCents },
                  { accountId: t.accountId, amountCents: t.amountCents },
                ]
              : [],
            ),
          ],
        })
        for (const t of between) {
          if (t.kind !== 'move_between') continue
          expect(after.accounts.find((x) => x.account.id === t.fromAccountId)!.status).toBe('on_track')
          const was = p.accounts.find((x) => x.account.id === t.accountId)!
          const now = after.accounts.find((x) => x.account.id === t.accountId)!
          expect(now.missingTodayCents).toBeLessThanOrEqual(Math.max(0, was.missingTodayCents - t.amountCents))
        }
      }

      // 5. A plan is its worst part, Ready to spend only when every part is; All caught up means nothing is Short or unknown.
      for (const plan of p.plans) {
        const statuses = plan.parts.map((x) => x.status)
        const expected =
          statuses.length === 0
            ? 'on_track'
            : (['short', 'on_track', 'ready_to_spend'] as const).find((st) => statuses.includes(st))
        expect(plan.status).toBe(expected)
        // ... and what it is missing is its Short parts' shortfalls added up (D41).
        expect(plan.shortByCents).toBe(plan.parts.reduce((t, x) => t + x.shortByCents, 0))
        expect(plan.shortByCents > 0).toBe(plan.status === 'short')
      }
      // 8. The headline and the plan chart beside saving it on its own (D50)
      // never claim more than they can show: the saving is never negative,
      // the line runs on the plan's own dates and never past its total,
      // and what is below its own pace is exactly what other plans hold
      // beyond theirs plus what the transfers still bring.
      const saving = smartSaving(p)
      expect(saving === null).toBe(p.plans.every((x) => x.parts.length === 0))
      if (saving) {
        expect(saving.lessPerWeekCents).toBeGreaterThanOrEqual(0)
        expect(saving.lessPerYearCents).toBe(saving.lessPerWeekCents * 52)
        expect(saving.withBallastShare).toBeLessThanOrEqual(1)
      }
      // Charts run every slot forward week by week, so one run in five draws them.
      for (const plan of run % 5 === 0 ? p.plans : []) {
        const chart = planChart({ plan, household: p, today, transferWeekday, maxPoints: 1 + (run % 60) })
        if (!chart) continue
        expect(chart.onItsOwn.map((x) => x.date)).toEqual(chart.actual.map((x) => x.date))
        for (const x of chart.onItsOwn) expect(x.cents).toBeLessThanOrEqual(plan.totalCents)
        const now = chart.story.now
        expect(now.coveringCents).toBeGreaterThanOrEqual(0)
        expect(now.coveringCents).toBeLessThanOrEqual(now.belowCents)
        expect(now.coveringCents + now.toComeCents).toBe(now.belowCents)
        expect(now.heldBy.length > 0).toBe(now.coveringCents > 0)
        expect(now.heldBy.reduce((t, x) => t + x.cents, 0)).toBe(now.coveringCents)
        for (const x of now.heldBy) expect(x.cents).toBeGreaterThan(0)
        // The stretches run transfer by transfer with no gap, alternate,
        // and add up to what the plan holds when they end.
        const phases = chart.story.phases
        phases.forEach((x, i) => {
          if (i > 0) {
            expect(x.from).toBe(addDays(phases[i - 1]!.to, 7))
            expect(x.kind).not.toBe(phases[i - 1]!.kind)
          // A plan that rolled off was paid the stretch before and is not paid in this one.
          for (const r of x.rolledOff) expect(x.others.map((o) => o.packageId)).not.toContain(r.packageId)
          if (x.othersMore > 0) expect(x.others).toHaveLength(3)
          }
          expect(x.transfers).toBe(transferWeeksBetween(x.from, x.to, transferWeekday) + 1)
          if (x.kind === 'waiting') expect(x.transfers).toBeGreaterThanOrEqual(1)
        })
        if (phases.length > 0) {
          expect(now.cents + phases.reduce((t, x) => t + x.addedCents, 0)).toBe(phases.at(-1)!.endCents)
        }
        if (chart.story.full) {
          expect(phases.at(-1)!.endCents).toBeGreaterThanOrEqual(plan.totalCents)
          expect(chart.story.due.reachesTotal).toBe(true)
        }
        expect(chart.story.due.cents).toBe(chart.actual.at(-1)!.cents)
        if (chart.story.onTrack) {
          expect(chart.story.due.reachesTotal).toBe(true)
          expect(plan.status).toBe('on_track')
        }
        if (saving && saving.lessPerWeekCents > 0) {
          for (const a of p.accounts.filter((x) => x.parts.length > 0)) expect(a.oneTimeMove).toBeNull()
        }
      }
      // 9. Rounds (D53). A spend on a round on or past its date takes the
      // same money out of the account as it takes off what the round still
      // needs, so it moves no weekly amount, move or status. Finishing a
      // round, before its date or after, never asks for more a week than
      // leaving it open. Saving a round back up never asks for less.
      const accountOf = (id: string) => p.accounts.find((x) => x.account.id === id)!
      const with_ = (extra: RoundEvent[], spendCents = 0, accountId = '') =>
        position({
          ...facts,
          roundEvents: [...roundEvents, ...extra],
          spendsSinceCount: spendCents > 0 ? [...spendsSinceCount, { accountId, amountCents: spendCents }] : spendsSinceCount,
        })
      const parts = p.accounts.flatMap((a) => a.parts)
      for (const a of p.accounts) {
        for (const x of a.parts) {
          // A round is its own part with what it still needs, never more than the part's total.
          expect(x.totalCents).toBe(Math.max(0, x.round.fullCents - x.round.countedSpentCents))
          expect(x.round.openRounds).toBe(parts.filter((y) => y.round.lineItemId === x.round.lineItemId).length)
        }
      }
      const pastRound = parts.find((x) => x.round.past && x.totalCents > 0)
      if (pastRound) {
        const amount = 1 + int(pastRound.totalCents)
        const after = with_(
          [{ eventId: 'spend-now', kind: 'spend', lineItemId: pastRound.round.lineItemId, roundDue: pastRound.round.dueDate, amountCents: amount, on: today }],
          amount,
          pastRound.accountId,
        )
        const was = accountOf(pastRound.accountId)
        const now = after.accounts.find((x) => x.account.id === pastRound.accountId)!
        expect(now.weeklyExactCents).toBe(was.weeklyExactCents)
        expect(now.oneTimeMove?.amountCents ?? 0).toBe(was.oneTimeMove?.amountCents ?? 0)
        expect(now.status).toBe(was.status)
      }
      // A one-off finished before its date ends the plan, like taking the part
      // out; the promise is about a repeating part moving on, and any round past its date.
      const finishable = parts.filter((x) => x.round.past || x.lineItem.recurrence !== null)
      const anyRound = finishable.length > 0 ? finishable[int(finishable.length)]! : null
      if (anyRound) {
        const after = with_([
          { eventId: 'finish-now', kind: 'finish', lineItemId: anyRound.round.lineItemId, roundDue: anyRound.round.dueDate, amountCents: 0, on: today },
        ])
        const was = accountOf(anyRound.accountId)
        const now = after.accounts.find((x) => x.account.id === anyRound.accountId)!
        expect(now.weeklyExactCents).toBeLessThanOrEqual(was.weeklyExactCents)
      }
      const lowered = parts.find((x) => x.round.countedSpentCents > 0)
      if (lowered) {
        const after = with_([
          { eventId: 'save-now', kind: 'save_back_up', lineItemId: lowered.round.lineItemId, roundDue: lowered.round.dueDate, amountCents: 0, on: today },
        ])
        const was = accountOf(lowered.accountId)
        const now = after.accounts.find((x) => x.account.id === lowered.accountId)!
        expect(now.weeklyExactCents).toBeGreaterThanOrEqual(was.weeklyExactCents)
      }
      if (p.allCaughtUp) {
        for (const a of p.accounts.filter((x) => x.parts.length > 0)) expect(a.status).toBe('on_track')
        expect(p.todos.some((t) => t.blocking)).toBe(false)
      }
    }
  }, 20_000)
})

describe('barOf (D40, D41)', () => {
  it('puts the tick where the account must hold the money today', () => {
    expect(barOf({ totalCents: 10000, countedCents: 2500, tickCents: 6000 })).toEqual({
      fillPercent: 25,
      tickPercent: 60,
      savedPercent: 25,
      fullyFunded: false,
    })
    expect(barOf({ totalCents: 10000, countedCents: 10000, tickCents: 10000 }).fullyFunded).toBe(true)
  })

  it('draws a fill a few cents short of its tick below it, not on it (D41 (6))', () => {
    // The screenshot: $207.70 of $300 with the tick a few cents higher.
    const bar = barOf({ totalCents: 30000, countedCents: 20770, tickCents: 20800 })
    expect(bar.fillPercent).toBeLessThan(bar.tickPercent)
    expect(bar.fillPercent).toBeCloseTo(69.2333, 3)
  })

  it('prints a percentage rounded down, 100 only when every cent is there (D41 (3))', () => {
    expect(barOf({ totalCents: 30000, countedCents: 20770, tickCents: 0 }).savedPercent).toBe(69)
    expect(barOf({ totalCents: 30000, countedCents: 29999, tickCents: 0 }).savedPercent).toBe(99)
    expect(barOf({ totalCents: 30000, countedCents: 30000, tickCents: 0 }).savedPercent).toBe(100)
    expect(barOf({ totalCents: 0, countedCents: 0, tickCents: 0 }).savedPercent).toBe(100)
  })
})
