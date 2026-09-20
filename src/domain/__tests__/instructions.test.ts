import { describe, expect, it } from 'vitest'
import {
  instructionSentence,
  outstandingInstructions,
  type IssuedInstruction,
} from '../instructions'
import { closeOutDrift, closeOutPrompts, dueState } from '../closeout'
import type { LineItem } from '../types'

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

  it('never supersedes a one-time move -- each is its own ask', () => {
    const open = outstandingInstructions({
      issued: [
        issued({ instructionId: 'i1', type: 'one_time_move', amountCents: 19000 }),
        issued({ instructionId: 'i2', type: 'one_time_move', amountCents: 5000 }),
      ],
      confirmed: [],
      today: TODAY,
    })
    expect(open).toHaveLength(2)
  })

  it('puts the oldest ask first, because that is the one being ignored', () => {
    const open = outstandingInstructions({
      issued: [
        issued({ instructionId: 'new', type: 'one_time_move', issuedOn: '2026-11-20' }),
        issued({ instructionId: 'old', type: 'one_time_move', issuedOn: '2026-10-01' }),
      ],
      confirmed: [],
      today: TODAY,
    })
    expect(open.map((i) => i.instructionId)).toEqual(['old', 'new'])
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
