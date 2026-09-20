import { describe, expect, it } from 'vitest'
import {
  apportion,
  DEFAULT_ALLOCATION_RULES,
  planAllocation,
  validateRules,
} from '../allocation'

const TODAY = '2026-09-19'

describe('apportionment', () => {
  it('always sums to exactly the total -- never more, never less', () => {
    for (const total of [215000, 1, 7, 99, 100003, 333333]) {
      const parts = apportion(total, [50, 25, 15, 10])
      expect(parts.reduce((s, p) => s + p, 0), `total ${total}`).toBe(total)
    }
  })

  it('never hands out more than was put in, unlike rounding each share up', () => {
    // $100.03 at 50/25/15/10: rounding each up would distribute $100.06.
    const parts = apportion(10003, [50, 25, 15, 10])
    expect(parts.reduce((s, p) => s + p, 0)).toBe(10003)
  })

  it('gives the odd cents to the largest fractional share', () => {
    // 100 cents across three equal ways: 34/33/33, not 33/33/33 losing a cent.
    const parts = apportion(100, [1, 1, 1])
    expect(parts.reduce((s, p) => s + p, 0)).toBe(100)
    expect(parts.filter((p) => p === 34)).toHaveLength(1)
  })

  it('is stable: ties go to the earlier rule, not to sort order', () => {
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(apportion(10, [1, 1, 1, 1])).toEqual([3, 3, 2, 2])
  })

  it('handles zero', () => {
    expect(apportion(0, [50, 50])).toEqual([0, 0])
  })

  it('refuses weights that cannot divide anything', () => {
    expect(() => apportion(100, [0, 0])).toThrow(/more than zero/)
  })
})

describe('allocation rules', () => {
  it('accepts the household default', () => {
    expect(() => validateRules(DEFAULT_ALLOCATION_RULES)).not.toThrow()
    expect(DEFAULT_ALLOCATION_RULES.reduce((s, r) => s + r.percent, 0)).toBe(100)
  })

  it('refuses a set that does not add to 100', () => {
    expect(() =>
      validateRules([
        { destination: 'debt', percent: 60, label: 'x' },
        { destination: 'lifestyle', percent: 30, label: 'y' },
      ]),
    ).toThrow(/not 100%/)
  })

  it('refuses a negative share', () => {
    expect(() =>
      validateRules([
        { destination: 'debt', percent: 110, label: 'x' },
        { destination: 'lifestyle', percent: -10, label: 'y' },
      ]),
    ).toThrow(/cannot be negative/)
  })
})

describe('the PRD §6 worked example', () => {
  // "$2,500 lowest unclaimed cash - $350 buffer = $2,150"
  const plan = planAllocation({ floorCents: 250000, bufferCents: 35000, today: TODAY })

  it('takes the buffer off the top', () => {
    expect(plan.netCents).toBe(215000)
  })

  it('splits by the standing rules', () => {
    const byDestination = Object.fromEntries(plan.shares.map((s) => [s.destination, s.amountCents]))
    expect(byDestination.debt).toBe(107500) // 50%
    expect(byDestination.lifestyle).toBe(53750) // 25%
    expect(byDestination.long_term_savings).toBe(32250) // 15%
    expect(byDestination.emergency).toBe(21500) // 10%
  })

  it('distributes every cent of the net and no more', () => {
    expect(plan.shares.reduce((s, x) => s + x.amountCents, 0)).toBe(plan.netCents)
  })

  it('releases the fun money in two halves, a pay period apart', () => {
    expect(plan.lifestyleReleases).toHaveLength(2)
    expect(plan.lifestyleReleases[0]!.releaseOn).toBe(TODAY)
    expect(plan.lifestyleReleases[1]!.releaseOn).toBe('2026-10-03')
    const halves = plan.lifestyleReleases.reduce((s, r) => s + r.amountCents, 0)
    expect(halves).toBe(53750)
  })
})

describe('edge cases that must not produce nonsense', () => {
  it('allocates nothing when the floor does not clear the buffer', () => {
    const plan = planAllocation({ floorCents: 30000, bufferCents: 35000, today: TODAY })
    expect(plan.netCents).toBe(0)
    expect(plan.shares.every((s) => s.amountCents === 0)).toBe(true)
    expect(plan.lifestyleReleases).toEqual([])
  })

  it('allocates nothing when the floor exactly equals the buffer', () => {
    const plan = planAllocation({ floorCents: 35000, bufferCents: 35000, today: TODAY })
    expect(plan.netCents).toBe(0)
  })

  it('handles an odd single cent without losing it', () => {
    const plan = planAllocation({ floorCents: 35001, bufferCents: 35000, today: TODAY })
    expect(plan.netCents).toBe(1)
    expect(plan.shares.reduce((s, x) => s + x.amountCents, 0)).toBe(1)
  })

  it('honours percentages changed for a single run', () => {
    const plan = planAllocation({
      floorCents: 135000,
      bufferCents: 35000,
      today: TODAY,
      rules: [
        { destination: 'debt', percent: 100, label: 'All of it at the debt' },
        { destination: 'lifestyle', percent: 0, label: 'Fun money' },
      ],
    })
    expect(plan.shares[0]!.amountCents).toBe(100000)
    expect(plan.shares[1]!.amountCents).toBe(0)
    expect(plan.lifestyleReleases).toEqual([])
  })
})
