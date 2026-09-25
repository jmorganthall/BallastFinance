import { describe, expect, it } from 'vitest'
import {
  committedAfter,
  driftAdjustmentsFrom,
  instructionSentence,
  openCommitmentsFor,
  outstandingInstructions,
  runningAdjustments,
  stopCatchUpOffer,
  stopCatchUpSentence,
  type IssuedInstruction,
} from '../instructions'
import { closeOutDrift, closeOutPrompts, dueState } from '../closeout'
import type { DriftAdjustment, LineItem } from '../types'

const TODAY = '2026-11-21'

function issued(over: Partial<IssuedInstruction> & Pick<IssuedInstruction, 'instructionId'>): IssuedInstruction {
  return {
    type: 'set_weekly_transfer',
    issuedOn: '2026-11-01',
    amountCents: 21000,
    targetId: 'acct-annual',
    targetLabel: 'Annual Expenses',
    ...over,
  }
}

describe('outstanding instructions', () => {
  it('lists what has been asked but not confirmed', () => {
    const open = outstandingInstructions({
      issued: [issued({ instructionId: 'i1' })],
      confirmed: [],
      today: TODAY,
    })
    expect(open).toHaveLength(1)
    expect(open[0]!.ageInDays).toBe(20)
  })

  it('drops an instruction once it is confirmed', () => {
    const open = outstandingInstructions({
      issued: [issued({ instructionId: 'i1' })],
      confirmed: [{ instructionId: 'i1', confirmedOn: TODAY }],
      today: TODAY,
    })
    expect(open).toHaveLength(0)
  })

  it('supersedes an older transfer amount rather than stacking asks', () => {
    const open = outstandingInstructions({
      issued: [
        issued({ instructionId: 'i1', amountCents: 18000, issuedOn: '2026-11-01' }),
        issued({ instructionId: 'i2', amountCents: 21000, issuedOn: '2026-11-15' }),
      ],
      confirmed: [],
      today: TODAY,
    })
    expect(open).toHaveLength(1)
    expect(open[0]!.instructionId).toBe('i2')
    expect(open[0]!.amountCents).toBe(21000)
  })

  it('keeps separate accounts separate when superseding', () => {
    const open = outstandingInstructions({
      issued: [
        issued({ instructionId: 'i1', targetId: 'acct-annual' }),
        issued({ instructionId: 'i2', targetId: 'acct-lt', targetLabel: 'Long Term Savings' }),
      ],
      confirmed: [],
      today: TODAY,
    })
    expect(open).toHaveLength(2)
  })

  it('never supersedes a share-out move -- each is its own ask', () => {
    const open = outstandingInstructions({
      issued: [
        issued({ instructionId: 'i1', type: 'one_time_move', purpose: 'share_out', amountCents: 19000 }),
        issued({ instructionId: 'i2', type: 'one_time_move', purpose: 'share_out', amountCents: 5000 }),
        issued({ instructionId: 'i3', type: 'one_time_move', purpose: 'cover', amountCents: 5000 }),
      ],
      confirmed: [],
      today: TODAY,
    })
    expect(open).toHaveLength(3)
  })

  it('puts the oldest ask first, because that is the one being ignored', () => {
    const open = outstandingInstructions({
      issued: [
        issued({ instructionId: 'new', type: 'one_time_move', purpose: 'share_out', issuedOn: '2026-11-20' }),
        issued({ instructionId: 'old', type: 'one_time_move', purpose: 'share_out', issuedOn: '2026-10-01' }),
      ],
      confirmed: [],
      today: TODAY,
    })
    expect(open.map((i) => i.instructionId)).toEqual(['old', 'new'])
  })

  describe('the adjustment lifecycle (D18)', () => {
    const dated = { issuedOn: '2026-11-01', endsOn: '2026-12-26', amountCents: 16000 } // 8 weeks, $20/wk

    it.each([
      ['rate_bump', {}],
      ['rate_cut', {}],
      ['one_time_move', {}],
      ['one_time_move', { purpose: 'catch_up' as const }],
      ['one_time_move_out', {}],
    ] as const)('lets a newer open %s on the same account supersede the older one', (type, extra) => {
      const open = outstandingInstructions({
        issued: [
          issued({ instructionId: 'older', type, ...dated, ...extra }),
          issued({ instructionId: 'newer', type, ...dated, issuedOn: '2026-11-08', ...extra }),
        ],
        confirmed: [],
        today: TODAY,
      })
      expect(open.map((i) => i.instructionId)).toEqual(['newer'])
    })

    it('keeps kinds, accounts and purposes apart when superseding', () => {
      const open = outstandingInstructions({
        issued: [
          issued({ instructionId: 'bump', type: 'rate_bump', ...dated }),
          issued({ instructionId: 'cut', type: 'rate_cut', ...dated, issuedOn: '2026-11-08' }),
          issued({ instructionId: 'bump-lt', type: 'rate_bump', ...dated, issuedOn: '2026-11-08', targetId: 'acct-lt' }),
          // A catch-up move and a share-out move into the same account are different asks.
          issued({ instructionId: 'catch-up', type: 'one_time_move', amountCents: 5000 }),
          issued({ instructionId: 'share', type: 'one_time_move', purpose: 'share_out', amountCents: 7000, issuedOn: '2026-11-08' }),
        ],
        confirmed: [],
        today: TODAY,
      })
      expect(open.map((i) => i.instructionId).sort()).toEqual(['bump', 'bump-lt', 'catch-up', 'cut', 'share'])
    })

    it('does not bring a replaced ask back when its replacement is withdrawn', () => {
      const open = outstandingInstructions({
        issued: [
          issued({ instructionId: 'older', type: 'rate_bump', ...dated }),
          issued({ instructionId: 'newer', type: 'rate_bump', ...dated, issuedOn: '2026-11-08' }),
        ],
        confirmed: [],
        ended: [{ instructionId: 'newer', endedOn: '2026-11-10' }],
        today: TODAY,
      })
      expect(open).toEqual([])
    })

    it('takes a withdrawn ask off the list, whatever its kind', () => {
      const open = outstandingInstructions({
        issued: [
          issued({ instructionId: 'move', type: 'one_time_move', amountCents: 5000 }),
          issued({ instructionId: 'transfer' }),
        ],
        confirmed: [],
        ended: [{ instructionId: 'move', endedOn: '2026-11-10' }],
        today: TODAY,
      })
      expect(open.map((i) => i.instructionId)).toEqual(['transfer'])
    })

    it('drops a withdrawn or replaced bump from what the transfer would become', () => {
      const { pending } = driftAdjustmentsFrom({
        issued: [
          issued({ instructionId: 'withdrawn', type: 'rate_bump', ...dated, targetId: 'acct-lt' }),
          issued({ instructionId: 'older', type: 'rate_bump', ...dated }),
          issued({ instructionId: 'newer', type: 'rate_bump', ...dated, issuedOn: '2026-11-08' }),
        ],
        confirmed: [],
        ended: [{ instructionId: 'withdrawn', endedOn: '2026-11-10' }],
      })
      expect(pending.map((a) => a.id)).toEqual(['newer'])
    })

    it('shortens a running bump to the day it was stopped, keeping only what it delivered', () => {
      // $160 over 8 Saturdays from Nov 1. Stopped Wednesday Nov 18: two transfers (Nov 7, 14) done.
      const { accepted } = driftAdjustmentsFrom({
        issued: [issued({ instructionId: 'bump', type: 'rate_bump', ...dated })],
        confirmed: [{ instructionId: 'bump', confirmedOn: '2026-11-01' }],
        ended: [{ instructionId: 'bump', endedOn: '2026-11-18' }],
      })
      expect(accepted).toEqual([
        { id: 'bump', reserveAccountId: 'acct-annual', amountCents: 4000, startDate: '2026-11-01', endDate: '2026-11-18' },
      ])
      // It still reads at the same weekly figure for the weeks it ran, and asks for nothing more.
      const [shortened] = runningAdjustments({ running: accepted, today: '2026-11-10' })
      expect(shortened).toMatchObject({ perWeekCents: 2000, endDate: '2026-11-18', remainingCents: 2000 })
      expect(runningAdjustments({ running: accepted, today: '2026-11-18' })).toEqual([])
    })

    it('shortens a running cut the same way, and keeps its sign', () => {
      const { accepted } = driftAdjustmentsFrom({
        issued: [issued({ instructionId: 'cut', type: 'rate_cut', ...dated })],
        confirmed: [{ instructionId: 'cut', confirmedOn: '2026-11-01' }],
        ended: [{ instructionId: 'cut', endedOn: '2026-11-18' }],
      })
      expect(accepted[0]).toMatchObject({ amountCents: -4000, endDate: '2026-11-18' })
    })

    it('drops a bump stopped before its first transfer, and leaves one stopped after its end alone', () => {
      const early = driftAdjustmentsFrom({
        issued: [issued({ instructionId: 'bump', type: 'rate_bump', ...dated })],
        confirmed: [{ instructionId: 'bump', confirmedOn: '2026-11-01' }],
        ended: [{ instructionId: 'bump', endedOn: '2026-11-03' }],
      })
      expect(early.accepted).toEqual([])
      const late = driftAdjustmentsFrom({
        issued: [issued({ instructionId: 'bump', type: 'rate_bump', ...dated })],
        confirmed: [{ instructionId: 'bump', confirmedOn: '2026-11-01' }],
        ended: [{ instructionId: 'bump', endedOn: '2027-01-30' }],
      })
      expect(late.accepted[0]).toMatchObject({ amountCents: 16000, endDate: '2026-12-26' })
    })

    it('gathers what is still on the way into one account, and what it will deliver after a day', () => {
      const bump: DriftAdjustment = { id: 'bump', reserveAccountId: 'acct-annual', amountCents: 16000, startDate: '2026-11-01', endDate: '2026-12-26' }
      const cut: DriftAdjustment = { id: 'cut', reserveAccountId: 'acct-annual', amountCents: -8000, startDate: '2026-11-01', endDate: '2026-12-26' }
      const elsewhere: DriftAdjustment = { ...bump, id: 'other', reserveAccountId: 'acct-lt' }
      const outstanding = outstandingInstructions({
        issued: [
          issued({ instructionId: 'move', type: 'one_time_move', amountCents: 5000 }),
          issued({ instructionId: 'out', type: 'one_time_move_out', amountCents: 1200 }),
          issued({ instructionId: 'share', type: 'one_time_move', purpose: 'share_out', amountCents: 99999 }),
          issued({ instructionId: 'transfer' }),
        ],
        confirmed: [],
        today: TODAY,
      })
      const commitments = openCommitmentsFor({
        reserveAccountId: 'acct-annual',
        accepted: [bump, elsewhere],
        pending: [cut],
        outstanding,
      })
      expect(commitments.running.map((a) => a.id)).toEqual(['bump'])
      expect(commitments.pending.map((a) => a.id)).toEqual(['cut'])
      expect(commitments.pendingMoves).toEqual([
        { instructionId: 'move', amountCents: 5000 },
        { instructionId: 'out', amountCents: -1200 },
      ])
      // Half way (4 of 8 Saturdays done by Nov 28): $80 of the bump and $40 of the cut still to come.
      expect(committedAfter({ commitments, from: '2026-11-28' })).toBe(8000 - 4000 + 5000 - 1200)
      // Before its first transfer everything is still to come; after its end, nothing dated is.
      expect(committedAfter({ commitments, from: '2026-11-01' })).toBe(16000 - 8000 + 5000 - 1200)
      expect(committedAfter({ commitments, from: '2027-01-01' })).toBe(5000 - 1200)
    })

    it('offers to stop the running catch-up first when the account reads ahead', () => {
      const bump: DriftAdjustment = { id: 'bump', reserveAccountId: 'acct-annual', amountCents: 16000, startDate: '2026-11-01', endDate: '2026-12-26' }
      const cut: DriftAdjustment = { id: 'cut', reserveAccountId: 'acct-annual', amountCents: -8000, startDate: '2026-11-01', endDate: '2027-02-27' }
      // Nov 21: 3 of 8 transfers done, $100 still to come from the bump.
      const offer = stopCatchUpOffer({ running: [cut, bump], today: '2026-11-21', extraCents: 15000 })
      expect(offer).toMatchObject({ instructionId: 'bump', perWeekCents: 2000, endDate: '2026-12-26', remainingCents: 10000, leftCents: 5000, shortAfterCents: 0 })
      expect(stopCatchUpSentence(offer!)).toBe('Stop the $20.00 a week catch-up (it was going to run until 2026-12-26)')
      // Less extra than the bump still adds: stopping leaves it short by the difference.
      expect(stopCatchUpOffer({ running: [bump], today: '2026-11-21', extraCents: 3000 })).toMatchObject({ leftCents: 0, shortAfterCents: 7000 })
      // Nothing to stop: a cut is not a catch-up, a finished bump is history, and behind is not ahead.
      expect(stopCatchUpOffer({ running: [cut], today: '2026-11-21', extraCents: 15000 })).toBeNull()
      expect(stopCatchUpOffer({ running: [bump], today: '2027-01-01', extraCents: 15000 })).toBeNull()
      expect(stopCatchUpOffer({ running: [bump], today: '2026-11-21', extraCents: -100 })).toBeNull()
    })
  })

  it('reads as a sentence a person can act on', () => {
    expect(instructionSentence(issued({ instructionId: 'i1' }))).toBe(
      'In Capital One 360, set the recurring transfer into Annual Expenses to $210.00 per week.',
    )
    expect(
      instructionSentence(issued({ instructionId: 'i2', type: 'one_time_move', amountCents: 19000 })),
    ).toBe('Move $190.00 into Annual Expenses once, to catch up.')
    expect(
      instructionSentence(
        issued({ instructionId: 'i3', type: 'spend_confirmation', targetLabel: 'Park tickets' }),
      ),
    ).toBe('Did the Park tickets money get spent from your savings?')
  })

  it('tells a person the weekly figure for a dated bump or cut, not the total', () => {
    // Stored as the $190 total over 8 transfer weeks; the bank is set per week.
    const dated = { issuedOn: '2026-11-21', endsOn: '2027-01-16', amountCents: 19000 }
    expect(instructionSentence(issued({ instructionId: 'b', type: 'rate_bump', ...dated }))).toBe(
      'Add $23.75 a week to the Annual Expenses transfer until 2027-01-16, to catch up.',
    )
    expect(instructionSentence(issued({ instructionId: 'c', type: 'rate_cut', ...dated }))).toBe(
      'Take $23.75 a week off the Annual Expenses transfer until 2027-01-16; the extra you already hold covers it.',
    )
    // Rounding goes the safe way in each direction: a bump up, a cut down.
    const odd = { issuedOn: '2026-11-21', endsOn: '2026-12-12', amountCents: 100 } // 3 weeks
    expect(instructionSentence(issued({ instructionId: 'b2', type: 'rate_bump', ...odd }))).toContain('$0.34 a week')
    expect(instructionSentence(issued({ instructionId: 'c2', type: 'rate_cut', ...odd }))).toContain('$0.33 a week')
  })

  it('splits bumps and cuts into done and still waiting, and flips the sign of a cut', () => {
    const dated = { issuedOn: '2026-11-21', endsOn: '2027-01-16', amountCents: 19000 }
    const { accepted, pending } = driftAdjustmentsFrom({
      issued: [
        issued({ instructionId: 'bump-done', type: 'rate_bump', ...dated }),
        issued({ instructionId: 'bump-open', type: 'rate_bump', ...dated }),
        issued({ instructionId: 'cut-done', type: 'rate_cut', ...dated, targetId: 'acct-lt' }),
        // Not a dated change to the weekly figure: never an adjustment.
        issued({ instructionId: 'transfer' }),
        issued({ instructionId: 'move', type: 'one_time_move', amountCents: 500 }),
      ],
      confirmed: [
        { instructionId: 'bump-done', confirmedOn: '2026-11-22' },
        { instructionId: 'cut-done', confirmedOn: '2026-11-22' },
      ],
    })
    expect(accepted).toEqual([
      { id: 'bump-done', reserveAccountId: 'acct-annual', amountCents: 19000, startDate: '2026-11-21', endDate: '2027-01-16' },
      { id: 'cut-done', reserveAccountId: 'acct-lt', amountCents: -19000, startDate: '2026-11-21', endDate: '2027-01-16' },
    ])
    expect(pending).toEqual([
      { id: 'bump-open', reserveAccountId: 'acct-annual', amountCents: 19000, startDate: '2026-11-21', endDate: '2027-01-16' },
    ])
  })

  it('says what a share-out move is for, and names the day for one held back', () => {
    const share = { type: 'one_time_move' as const, purpose: 'share_out' as const, targetLabel: 'Fun money', amountCents: 50802 }
    expect(instructionSentence(issued({ instructionId: 'h1', issuedOn: '2026-09-20', availableOn: '2026-09-20', ...share }))).toBe(
      'Move $508.02 into Fun money, its share of what was spare.',
    )
    expect(instructionSentence(issued({ instructionId: 'h2', issuedOn: '2026-09-20', availableOn: '2026-10-04', ...share }))).toBe(
      'On 2026-10-04, move $508.02 into Fun money.',
    )
    expect(
      instructionSentence(issued({ instructionId: 'c', type: 'one_time_move', purpose: 'cover', amountCents: 30000 })),
    ).toBe('Move $300.00 into Annual Expenses once, to cover what it is behind.')
    expect(
      instructionSentence(issued({ instructionId: 'l', type: 'one_time_move', purpose: 'left_over', amountCents: 12345 })),
    ).toBe('Decide where $123.45 goes; it was the debt share with nowhere useful to go.')
  })

  it('holds a move back until its day, and only starts counting its age from then', () => {
    const halves = [
      issued({ instructionId: 'now', type: 'one_time_move', purpose: 'share_out', issuedOn: '2026-09-20', availableOn: '2026-09-20' }),
      issued({ instructionId: 'later', type: 'one_time_move', purpose: 'share_out', issuedOn: '2026-09-20', availableOn: '2026-10-04' }),
    ]
    const onTheDay = outstandingInstructions({ issued: halves, confirmed: [], today: '2026-09-27' })
    expect(onTheDay.map((i) => [i.instructionId, i.dueNow, i.ageInDays])).toEqual([
      ['now', true, 7],
      ['later', false, 0],
    ])
    const afterwards = outstandingInstructions({ issued: halves, confirmed: [], today: '2026-10-06' })
    expect(afterwards.find((i) => i.instructionId === 'later')).toMatchObject({ dueNow: true, ageInDays: 2 })
  })

  it('reads a move-out as what it is', () => {
    expect(
      instructionSentence(issued({ instructionId: 'o', type: 'one_time_move_out', amountCents: 492510 })),
    ).toBe('Move $4,925.10 out of Annual Expenses once; it holds more than the plan needs.')
  })
})

describe('close-out', () => {
  function item(over: Partial<LineItem> = {}): LineItem {
    return {
      id: 'li-1',
      packageId: 'pkg',
      label: 'Park tickets',
      unitAmountCents: 60000,
      quantity: 3,
      dueDate: '2026-11-21',
      reserveAccountId: 'acct-annual',
      state: 'accruing',
      recurrence: null,
      ...over,
    }
  }

  it('moves an item to due on its date, not before', () => {
    expect(dueState(item(), '2026-11-20')).toBe('accruing')
    expect(dueState(item(), '2026-11-21')).toBe('due')
    expect(dueState(item(), '2026-12-01')).toBe('due')
  })

  it('leaves a retired item alone', () => {
    expect(dueState(item({ state: 'retired' }), '2026-12-01')).toBe('retired')
  })

  it('keeps asking about a passed date -- no silent fall-off', () => {
    const prompts = closeOutPrompts({
      lineItems: [item()],
      today: '2026-12-01',
      isLive: () => true,
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.daysOverdue).toBe(10)
    expect(prompts[0]!.plannedCents).toBe(180000)
  })

  it('stops asking once confirmed spent', () => {
    const prompts = closeOutPrompts({
      lineItems: [item({ state: 'retired' })],
      today: '2026-12-01',
      isLive: () => true,
    })
    expect(prompts).toHaveLength(0)
  })

  it('does not ask about a draft', () => {
    const prompts = closeOutPrompts({
      lineItems: [item()],
      today: '2026-12-01',
      isLive: () => false,
    })
    expect(prompts).toHaveLength(0)
  })

  it('shows the longest-ignored prompt first', () => {
    const prompts = closeOutPrompts({
      lineItems: [
        item({ id: 'recent', dueDate: '2026-11-28' }),
        item({ id: 'ancient', dueDate: '2026-09-01' }),
      ],
      today: '2026-12-01',
      isLive: () => true,
    })
    expect(prompts.map((p) => p.lineItemId)).toEqual(['ancient', 'recent'])
  })

  it('turns an over- or under-spend into drift rather than losing it', () => {
    // Spent less than planned: the difference is still sitting in the account.
    expect(closeOutDrift({ plannedCents: 180000, actualCents: 165000 })).toBe(15000)
    // Spent more: it had to come from somewhere.
    expect(closeOutDrift({ plannedCents: 180000, actualCents: 195000 })).toBe(-15000)
    expect(closeOutDrift({ plannedCents: 180000, actualCents: 180000 })).toBe(0)
  })
})
