import { describe, expect, it } from 'vitest'
import {
  accrualWeeksBetween,
  addDays,
  assertCivilDate,
  DEFAULT_TRANSFER_WEEKDAY,
  isTransferDay,
  isWeekday,
  nextTransferDay,
  nthTransferDayAfter,
  todayIn,
  toDayNumber,
  transferWeeksBetween,
  weekdayOf,
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

describe('the household week (the transfer day, PRD §10 and D31)', () => {
  it('defaults to Saturday until a household picks a day', () => {
    expect(DEFAULT_TRANSFER_WEEKDAY).toBe(6)
    expect(transferWeeksBetween('2026-09-19', '2026-09-26')).toBe(
      transferWeeksBetween('2026-09-19', '2026-09-26', 6),
    )
  })

  it('knows the weekday of a date, Sunday as 0', () => {
    expect(weekdayOf('2026-09-19')).toBe(6) // Saturday
    expect(weekdayOf('2026-09-20')).toBe(0) // Sunday
    expect(weekdayOf('2026-09-25')).toBe(5) // Friday
    expect(weekdayOf('1970-01-01')).toBe(4) // the epoch was a Thursday
    expect(weekdayOf('1969-12-28')).toBe(0) // and before it the arithmetic still lands right
  })

  it('identifies the transfer day, whichever day it is', () => {
    expect(isTransferDay('2026-09-19', 6)).toBe(true)
    expect(isTransferDay('2026-09-18', 6)).toBe(false)
    expect(isTransferDay('2026-09-18', 5)).toBe(true) // a Friday household
    expect(isTransferDay('2026-09-20', 0)).toBe(true) // a Sunday one
    expect(isTransferDay('1970-01-03', 6)).toBe(true) // the epoch's first Saturday
  })

  it('accepts only 0..6 as a weekday', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6]) expect(isWeekday(n)).toBe(true)
    for (const n of [-1, 7, 1.5, NaN, '5', null, undefined]) expect(isWeekday(n)).toBe(false)
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

  describe('a Friday household (the transfer day is a setting, PRD D31)', () => {
    const FRIDAY = 5

    it('counts Fridays, not Saturdays, between two dates', () => {
      // Fri 18 Sep -> Fri 25 Sep: one transfer. The starting Friday itself is done.
      expect(transferWeeksBetween('2026-09-18', '2026-09-25', FRIDAY)).toBe(1)
      expect(transferWeeksBetween('2026-09-18', '2026-09-18', FRIDAY)).toBe(0)
      // Sat 19 Sep -> Sat 26 Sep holds Friday the 25th: one transfer, same as before,
      // but Thu 17 -> Fri 18 holds one where Saturday counting would have had none.
      expect(transferWeeksBetween('2026-09-19', '2026-09-26', FRIDAY)).toBe(1)
      expect(transferWeeksBetween('2026-09-17', '2026-09-18', FRIDAY)).toBe(1)
      expect(transferWeeksBetween('2026-09-17', '2026-09-18', 6)).toBe(0)
      // Sat 19 Sep -> Sat 16 Jan: 17 Saturdays but only 17 Fridays too (Sep 25 .. Jan 15).
      expect(transferWeeksBetween('2026-09-19', '2027-01-16', FRIDAY)).toBe(17)
      // Sat 19 Sep -> Thu 14 Jan: 16 Saturdays, and 16 Fridays (the 15th is past).
      expect(transferWeeksBetween('2026-09-19', '2027-01-14', FRIDAY)).toBe(16)
    })

    it('is off by one at the week edge against Saturday counting', () => {
      // A part due on Friday 15 Jan 2027, planned on Saturday 19 Sep 2026: the
      // Friday household makes 17 transfers before the money is needed; counting
      // Saturdays would say 16 and set the weekly figure too high.
      expect(transferWeeksBetween('2026-09-19', '2027-01-15', FRIDAY)).toBe(17)
      expect(transferWeeksBetween('2026-09-19', '2027-01-15', 6)).toBe(16)
    })

    it('handles from and to landing on the transfer day', () => {
      expect(transferWeeksBetween('2026-09-25', '2026-10-02', FRIDAY)).toBe(1)
      expect(transferWeeksBetween('2026-09-25', '2026-10-01', FRIDAY)).toBe(0)
      expect(transferWeeksBetween('2026-09-24', '2026-09-25', FRIDAY)).toBe(1)
      expect(accrualWeeksBetween('2026-09-25', '2026-10-01', FRIDAY)).toBe(1)
    })

    it('counts a full year as 52 or 53 transfers on any day', () => {
      for (const day of [0, 1, 2, 3, 4, 5, 6] as const) {
        const n = transferWeeksBetween('2026-09-19', '2027-09-19', day)
        expect(n).toBeGreaterThanOrEqual(52)
        expect(n).toBeLessThanOrEqual(53)
      }
    })
  })

  it('wraps Sunday as 0 correctly, including across the epoch', () => {
    // Sun 20 Sep -> Sun 27 Sep: one Sunday transfer; -> Sat 26 Sep: none.
    expect(transferWeeksBetween('2026-09-20', '2026-09-27', 0)).toBe(1)
    expect(transferWeeksBetween('2026-09-20', '2026-09-26', 0)).toBe(0)
    // Thu 1 Jan 1970 -> Sun 4 Jan 1970 holds the epoch's first Sunday.
    expect(transferWeeksBetween('1970-01-01', '1970-01-04', 0)).toBe(1)
    // And a window before the epoch still counts its Sundays.
    expect(transferWeeksBetween('1969-12-20', '1970-01-04', 0)).toBe(3) // Dec 21, Dec 28, Jan 4
  })

  it('counts the same transfers whichever day of the week they run, over whole weeks', () => {
    for (const day of [0, 1, 2, 3, 4, 5, 6] as const) {
      // Any date to the same weekday eight weeks on holds exactly eight transfers.
      expect(transferWeeksBetween('2026-09-23', '2026-11-18', day)).toBe(8)
    }
  })

  it('finds the n-th transfer day after a date, so a window of n weeks ends on one', () => {
    expect(nextTransferDay('2026-09-23', 5)).toBe('2026-09-25') // Wed -> Fri
    expect(nextTransferDay('2026-09-25', 5)).toBe('2026-10-02') // Fri -> the next Fri, not itself
    expect(nextTransferDay('2026-09-26', 5)).toBe('2026-10-02') // Sat -> Fri
    expect(nextTransferDay('2026-09-19', 6)).toBe('2026-09-26')
    expect(nthTransferDayAfter('2026-09-23', 8, 5)).toBe('2026-11-13')
    expect(transferWeeksBetween('2026-09-23', nthTransferDayAfter('2026-09-23', 8, 5), 5)).toBe(8)
    for (const day of [0, 1, 2, 3, 4, 5, 6] as const) {
      const end = nthTransferDayAfter('2026-09-19', 8, day)
      expect(isTransferDay(end, day)).toBe(true)
      expect(transferWeeksBetween('2026-09-19', end, day)).toBe(8)
    }
  })

  it('reads today in the household timezone', () => {
    // 01:30 UTC on the 20th is still the 19th in Chicago.
    const instant = new Date('2026-09-20T01:30:00Z')
    expect(todayIn('America/Chicago', instant)).toBe('2026-09-19')
    expect(todayIn('UTC', instant)).toBe('2026-09-20')
  })
})
