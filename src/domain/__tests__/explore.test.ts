/**
 * Explore (PRD D42, D55): the candidates in the family's shape, how they
 * score, and the strip's shading. Busyness is typed levels so each case
 * says exactly which days are busy.
 */

import { describe, expect, it } from 'vitest'
import { explore, type ExploreInput } from '../explore'
import { scoresOf } from '../trip-when'
import type { CrowdLevel } from '../trip-plan'

const TODAY = '2026-10-31'

const level = (date: string, l: number): CrowdLevel => ({ destination: 'wdw', date, park: 'other', level: l, source: 'typed', fetchedOn: TODAY })

function run(over: Partial<ExploreInput> = {}) {
  return explore({
    today: TODAY,
    horizonMonths: 1,
    parkDays: { min: 3, max: 3 },
    stretchMinutes: 240,
    splitWhenFree: true,
    driveMinutes: 450,
    busyness: { crowdLevels: [] },
    daysOff: [],
    blackoutDates: [],
    ...over,
  })
}

describe('scoring with prices not known', () => {
  it('puts an unknown price at the midpoint and compares prices only within a group', () => {
    const scores = scoresOf(
      [
        { crowdAverage: 5, priceCents: 100_00, priceGroup: 3, schoolDaysMissed: 0 },
        { crowdAverage: 5, priceCents: 200_00, priceGroup: 3, schoolDaysMissed: 0 },
        { crowdAverage: 5, priceCents: null, priceGroup: 3, schoolDaysMissed: 0 },
        // Dear for a 4-day trip, but alone in its group, so not dear.
        { crowdAverage: 5, priceCents: 900_00, priceGroup: 4, schoolDaysMissed: 0 },
      ],
      { busy: 0, price: 2, school: 0 },
    )
    expect(scores).toEqual([0, 2, 1, 0])
  })
})

describe('explore', () => {
  it('lays every candidate out in the family shape and lists the best with its reasons', () => {
    const r = run()
    expect(r.considered).toBeGreaterThan(25)
    expect(r.top.length).toBeGreaterThan(0)
    for (const w of r.top) {
      expect(w.parkDays).toBe(3)
      expect(w.reasons).toContain('no price yet')
      expect(w.words).toMatch(/3 park days/)
    }
  })

  it('measures how busy over the park days only', () => {
    // Packed on the travel days around a quiet Sat-Mon, quiet everywhere else.
    const crowd = [level('2026-11-07', 2), level('2026-11-08', 2), level('2026-11-09', 2), level('2026-11-06', 10), level('2026-11-10', 10)]
    const r = run({ busyness: { crowdLevels: crowd }, priceOf: () => 0 })
    const w = r.top.find((t) => t.firstParkDate === '2026-11-07')!
    expect(w.crowdAverage).toBe(2)
    expect(w.daysWithData).toBe(3)
  })

  it('leaves out a window that touches a day we cannot go, the evening we leave included', () => {
    const r = run({ blackoutDates: [{ from: '2026-11-12', to: '2026-11-12', label: 'Recital' }] })
    expect(r.excludedByBlackout).toBeGreaterThan(0)
    expect(r.top.some((w) => w.days.some((d) => d.date === '2026-11-12'))).toBe(false)
  })

  it('names a holiday the window uses, and says when the evening drive saves a school day', () => {
    const r = run({ limit: 50 })
    const thanksgiving = r.top.find((w) => w.uses.includes('Thanksgiving Day'))
    expect(thanksgiving?.reasons.some((x) => x.startsWith('uses Thanksgiving Day'))).toBe(true)
    expect(r.top.some((w) => w.reasons.includes('the evening drive saves a school day'))).toBe(true)
  })

  it('never lists two windows that overlap: the same trip moved a day is not another choice', () => {
    const r = run({ limit: 10 })
    for (const a of r.top) for (const b of r.top) if (a !== b) expect(a.endDate < b.startDate || b.endDate < a.startDate).toBe(true)
  })

  it('ranks the cheaper of two same-length windows first when all else is equal', () => {
    const r = run({ daysOff: [{ date: '2026-12-31', label: 'Break' }], priceOf: (w) => (w.firstParkDate === '2026-11-14' ? 100_00 : 500_00), weights: { busy: 0, price: 1, school: 0 } })
    expect(r.top[0]!.firstParkDate).toBe('2026-11-14')
  })

  it('shades every start date in five steps, the best start in the first, equal scores in one step', () => {
    const r = run({ priceOf: (w) => (w.firstParkDate === '2026-11-21' ? 100_00 : 500_00) })
    const steps = Object.values(r.startSteps)
    expect(steps.every((s) => s >= 1 && s <= 5)).toBe(true)
    expect(r.startSteps[r.top[0]!.startDate]).toBe(1)
    const flat = run({ driveMinutes: null, daysOff: [{ date: '2026-12-31', label: 'Break' }], weights: { busy: 1, price: 0, school: 0 } })
    // Nothing known about crowds: every start scores the same, and every start reads the same.
    expect(new Set(Object.values(flat.startSteps))).toEqual(new Set([1]))
  })

  it('says when no drive has been looked up, and uses full travel days', () => {
    const r = run({ driveMinutes: null })
    expect(r.driveKnown).toBe(false)
    expect(r.top[0]!.reasons).toContain('drive not looked up yet')
    expect(r.top.every((w) => w.down === 'full' && w.home === 'full')).toBe(true)
  })
})
