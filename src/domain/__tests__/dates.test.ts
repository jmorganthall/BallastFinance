import { describe, expect, it } from 'vitest'
import {
  accrualWeeksBetween,
  addDays,
  assertCivilDate,
  isSaturday,
  todayIn,
  toDayNumber,
  transferWeeksBetween,
} from '../dates'

describe('civil dates', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(() => assertCivilDate('2026-09-19')).not.toThrow()
    expect(() => assertCivilDate('2026-02-30')).toThrow()
    expect(() => assertCivilDate('2026-13-01')).toThrow()
    expect(() => assertCivilDate('9/19/2026')).toThrow()
  })

  it('handles leap years', () => {
    expect(() => assertCivilDate('2028-02-29')).not.toThrow()
    expect(() => assertCivilDate('2027-02-29')).toThrow()
  })

  it('is timezone-proof: a date is a date, not an instant', () => {
    // Same civil date whatever the host offset happens to be.
    expect(toDayNumber('2026-09-19')).toBe(20715)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('the household week (Saturday boundary, PRD §10)', () => {
  it('identifies Saturdays', () => {
    expect(isSaturday('2026-09-19')).toBe(true)
    expect(isSaturday('2026-09-18')).toBe(false)
    expect(isSaturday('2026-09-20')).toBe(false)
    expect(isSaturday('1970-01-03')).toBe(true) // the epoch's first Saturday
  })

  it('counts transfers in the half-open interval (from, to]', () => {
    // From one Saturday to the next is exactly one transfer.
    expect(transferWeeksBetween('2026-09-19', '2026-09-26')).toBe(1)
    // The starting Saturday itself does not count -- money has already moved.
    expect(transferWeeksBetween('2026-09-19', '2026-09-19')).toBe(0)
    // A Friday start catches the very next day's Saturday.
    expect(transferWeeksBetween('2026-09-18', '2026-09-19')).toBe(1)
    expect(transferWeeksBetween('2026-09-19', '2026-10-17')).toBe(4)
  })

  it('returns zero for a backwards or empty interval', () => {
    expect(transferWeeksBetween('2026-09-26', '2026-09-19')).toBe(0)
    expect(transferWeeksBetween('2026-09-20', '2026-09-25')).toBe(0) // Sun -> Fri, no Saturday
  })

  it('never lets an accrual divide by zero: minimum one week', () => {
    expect(accrualWeeksBetween('2026-09-20', '2026-09-25')).toBe(1)
    expect(accrualWeeksBetween('2026-09-26', '2026-09-19')).toBe(1)
    expect(accrualWeeksBetween('2026-09-19', '2026-09-26')).toBe(1)
  })

  it('counts a full year as 52 or 53 transfers', () => {
    const n = transferWeeksBetween('2026-09-19', '2027-09-19')
    expect(n).toBeGreaterThanOrEqual(52)
    expect(n).toBeLessThanOrEqual(53)
  })

  it('reads today in the household timezone', () => {
    // 01:30 UTC on the 20th is still the 19th in Chicago.
    const instant = new Date('2026-09-20T01:30:00Z')
    expect(todayIn('America/Chicago', instant)).toBe('2026-09-19')
    expect(todayIn('UTC', instant)).toBe('2026-09-20')
  })
})
