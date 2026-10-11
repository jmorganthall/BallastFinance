import { describe, expect, it } from 'vitest'
import {
  bankTransfersBetween,
  barOf,
  countTowardParts,
  levelWeekly,
  NEAR_TRANSFERS,
  planChart,
  position,
  requirementsFor,
  slotTicks,
  steadyLineStart,
  type PositionInput,
} from '../position'
import { addDays, compareDates, transferWeeksBetween, type CivilDate, type Weekday } from '../dates'
import type { LineItem, LineItemCycle, Package, ReserveAccount } from '../types'

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

  it('does not ask twice for a catch-up move still open from before D35', () => {
    const p = position({
      ...base,
      lineItems: [li({ id: 'soon', unitAmountCents: 50000, dueDate: '2026-10-09' })],
      transfers: [{ accountId: gifts.id, perWeekCents: 0, confirmedOn: '2026-09-01' }],
      openMovesIn: [{ accountId: gifts.id, amountCents: 50000 }],
    })
    expect(p.accounts[0]!.oneTimeMove).toBeNull()
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
    const fine = position({ ...facts, transfers: [{ accountId: gifts.id, perWeekCents: 10000, confirmedOn: '2026-09-01' }] })
    const fineChart = planChart({ plan: fine.plans[0]!, household: fine, today: TODAY, transferWeekday: FRIDAY })!
    expect(fineChart.afterFix).toBeNull()
    expect(fineChart.actual.at(-1)!.cents).toBe(200000)
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
      const facts: PositionInput = {
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
      const p = position(facts)

      for (const a of p.accounts) {
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
          expect(a.transferChange?.reason === 'keep_up' || a.oneTimeMove !== null).toBe(true)
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
        if (a.status === 'on_track') {
          expect(a.oneTimeMove).toBeNull()
          expect(a.transferChange?.reason).not.toBe('raise')
          expect(a.transferChange?.reason).not.toBe('keep_up')
        }
        if (a.transferChange?.reason === 'raise') expect(a.status).toBe('short')
        // A Short account a surplus move puts right on its current dates may
        // still be asked to keep up (D40); otherwise keeping up is Running down's.
        if (a.transferChange?.reason === 'keep_up') {
          const movedIn = p.todos.some((t) => t.kind === 'move_between' && t.accountId === a.account.id)
          expect(a.status === 'running_down' || (a.status === 'short' && movedIn)).toBe(true)
        }
        // What could leave today is never more than is there today.
        expect(a.extraCents).toBeLessThanOrEqual(Math.max(0, a.money.totalCents))
        // Lowering is only ever offered to where the account is still fine,
        // with nothing else asked.
        if (a.transferChange?.reason === 'lower') {
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
          const movedIn = p.todos.some((t) => t.kind === 'move_between' && t.accountId === a.account.id)
          expect(a.transferChange?.reason === 'raise' || a.oneTimeMove !== null || movedIn).toBe(true)
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
        expect(t.amountCents).toBeLessThanOrEqual(to.missingTodayCents)
      }
      if (between.length > 0) {
        const after = position({
          ...facts,
          movesSinceCount: between.flatMap((t) =>
            t.kind === 'move_between'
              ? [
                  { accountId: t.fromAccountId, amountCents: -t.amountCents },
                  { accountId: t.accountId, amountCents: t.amountCents },
                ]
              : [],
          ),
        })
        for (const t of between) {
          if (t.kind !== 'move_between') continue
          expect(after.accounts.find((x) => x.account.id === t.fromAccountId)!.status).toBe('on_track')
          const was = p.accounts.find((x) => x.account.id === t.accountId)!
          const now = after.accounts.find((x) => x.account.id === t.accountId)!
          expect(now.missingTodayCents).toBeLessThanOrEqual(was.missingTodayCents - t.amountCents)
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
      }
      if (p.allCaughtUp) {
        for (const a of p.accounts.filter((x) => x.parts.length > 0)) expect(a.status).toBe('on_track')
        expect(p.todos.some((t) => t.blocking)).toBe(false)
      }
    }
  })
})

describe('barOf (D40)', () => {
  it('puts the tick where the account must hold the money today', () => {
    expect(barOf({ totalCents: 10000, countedCents: 2500, tickCents: 6000 })).toEqual({
      fillPercent: 25,
      tickPercent: 60,
      fullyFunded: false,
    })
    expect(barOf({ totalCents: 10000, countedCents: 10000, tickCents: 10000 }).fullyFunded).toBe(true)
  })
})
