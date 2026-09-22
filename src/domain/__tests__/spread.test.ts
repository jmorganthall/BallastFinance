/**
 * Where money is counted (PRD §6): every part to its pace soonest first, the
 * rest onto the one-offs, and never above pace on a part that comes round
 * again. The aim is a weekly figure that stays put, not one that sits low for
 * a while and then climbs.
 */

import { describe, expect, it } from 'vitest'
import { ceilingCents, placeMoney, roomCents, type SpreadPart } from '../spread'

function part(over: Partial<SpreadPart> & Pick<SpreadPart, 'id' | 'dueDate' | 'totalCents'>): SpreadPart {
  return { label: over.id, paceCents: 0, heldCents: 0, oneOff: true, ...over }
}

// A yearly bill four months in, a one-off due next month, a one-off due next summer.
const yearly = part({ id: 'yearly', dueDate: '2027-05-15', totalCents: 120000, paceCents: 40000, oneOff: false })
const soon = part({ id: 'soon', dueDate: '2026-10-17', totalCents: 40000 })
const far = part({ id: 'far', dueDate: '2027-06-26', totalCents: 400000, paceCents: 5000 })

const holdings = (spread: ReturnType<typeof placeMoney>, ids: string[]) => ids.map((id) => spread.holdingsById.get(id))

describe('placeMoney', () => {
  it('brings every part to its pace, soonest due first, before anything else', () => {
    // Enough for the two soonest paces and part of the last.
    const spread = placeMoney([yearly, soon, far], 42000)
    // soon has no pace yet (window just opened), yearly takes 40000, far gets the last 2000.
    expect(holdings(spread, ['soon', 'yearly', 'far'])).toEqual([0, 40000, 2000])
    expect(spread.uncountedCents).toBe(0)
  })

  it('puts what is left onto the one-offs, soonest first, up to each total', () => {
    const spread = placeMoney([yearly, soon, far], 45000 + 40000 + 1000)
    expect(holdings(spread, ['soon', 'yearly', 'far'])).toEqual([40000, 40000, 6000])
    expect(spread.uncountedCents).toBe(0)
  })

  it('never counts above pace on a part that comes round again, and leaves the rest uncounted', () => {
    const spread = placeMoney([yearly, soon, far], 1_000_000)
    expect(holdings(spread, ['soon', 'yearly', 'far'])).toEqual([40000, 40000, 400000])
    expect(spread.uncountedCents).toBe(1_000_000 - 480000)
  })

  it('only ever adds when it starts from what the parts already hold', () => {
    const before = [
      { ...yearly, heldCents: 90000 }, // well above its pace
      { ...soon, heldCents: 10000 },
      { ...far, heldCents: 0 },
    ]
    const spread = placeMoney(before, 20000)
    // yearly is left where it is; far comes up to its pace first; soon takes the rest.
    expect(holdings(spread, ['soon', 'yearly', 'far'])).toEqual([25000, 90000, 5000])
    for (const p of before) expect(spread.holdingsById.get(p.id)!).toBeGreaterThanOrEqual(p.heldCents)
  })

  it('caps what a part starts with at its total', () => {
    const spread = placeMoney([{ ...soon, heldCents: 99999 }], 0)
    expect(spread.holdingsById.get('soon')).toBe(40000)
  })

  it('handles nothing to place and no parts', () => {
    expect(placeMoney([], 500)).toEqual({ holdingsById: new Map(), uncountedCents: 500 })
    expect(placeMoney([soon], 0).holdingsById.get('soon')).toBe(0)
  })
})

describe('ceiling and room', () => {
  it('lets a one-off take its whole total and a repeating part only its pace', () => {
    expect(ceilingCents(soon)).toBe(40000)
    expect(ceilingCents(yearly)).toBe(40000)
    expect(ceilingCents({ ...yearly, paceCents: 500000 })).toBe(120000)
  })

  it('measures room from what is held, never below zero', () => {
    expect(roomCents({ ...yearly, heldCents: 15000 })).toBe(25000)
    expect(roomCents({ ...yearly, heldCents: 90000 })).toBe(0)
    expect(roomCents({ ...far, heldCents: 100 })).toBe(399900)
  })
})
