/**
 * Recurrence as an interval: every N days, weeks, months or years. The
 * calendar cases matter most -- a yearly bill keeps its date across leap
 * years, a quarterly one keeps its day of month -- and the roll-forward is
 * what makes a past date mean "the last one was then".
 */

import { describe, expect, it } from 'vitest'
import {
  describeRecurrence,
  nextOccurrence,
  occurrencesBetween,
  previousOccurrence,
  recurrenceOf,
  rollToFuture,
} from '../recurrence'

describe('building one from what a form or a sheet sends', () => {
  it('takes a count and a unit', () => {
    expect(recurrenceOf(3, 'week')).toEqual({ every: 3, unit: 'week' })
    expect(recurrenceOf('18', 'month')).toEqual({ every: 18, unit: 'month' })
  })

  it('is a one-off for "none", a blank, or nothing usable', () => {
    expect(recurrenceOf(1, 'none')).toBeNull()
    expect(recurrenceOf(1, '')).toBeNull()
    expect(recurrenceOf(0, 'month')).toBeNull()
    expect(recurrenceOf(-2, 'month')).toBeNull()
    expect(recurrenceOf('lots', 'month')).toBeNull()
    expect(recurrenceOf(1.5, 'month')).toBeNull()
    expect(recurrenceOf(1, 'fortnight')).toBeNull()
    expect(recurrenceOf(1, 42)).toBeNull()
  })

  it('still reads the four names the first version used', () => {
    expect(recurrenceOf(1, 'monthly')).toEqual({ every: 1, unit: 'month' })
    expect(recurrenceOf(1, 'quarterly')).toEqual({ every: 3, unit: 'month' })
    expect(recurrenceOf(1, 'semiannual')).toEqual({ every: 6, unit: 'month' })
    expect(recurrenceOf(1, 'annual')).toEqual({ every: 1, unit: 'year' })
  })
})

describe('plain words', () => {
  it('says the interval the way a person would', () => {
    expect(describeRecurrence(null)).toBe('Just once')
    expect(describeRecurrence({ every: 1, unit: 'week' })).toBe('Every week')
    expect(describeRecurrence({ every: 2, unit: 'week' })).toBe('Every 2 weeks')
    expect(describeRecurrence({ every: 1, unit: 'month' })).toBe('Every month')
    expect(describeRecurrence({ every: 3, unit: 'month' })).toBe('Every 3 months')
    expect(describeRecurrence({ every: 1, unit: 'year' })).toBe('Every year')
    expect(describeRecurrence({ every: 45, unit: 'day' })).toBe('Every 45 days')
  })
})

describe('stepping through the series', () => {
  it('counts days and weeks in days', () => {
    expect(nextOccurrence('2026-09-19', { every: 10, unit: 'day' })).toBe('2026-09-29')
    expect(nextOccurrence('2026-09-19', { every: 3, unit: 'week' })).toBe('2026-10-10')
    expect(previousOccurrence('2026-10-10', { every: 3, unit: 'week' })).toBe('2026-09-19')
  })

  it('counts months and years on the calendar, keeping the day where it can', () => {
    expect(nextOccurrence('2026-01-31', { every: 1, unit: 'month' })).toBe('2026-02-28')
    expect(nextOccurrence('2026-11-15', { every: 3, unit: 'month' })).toBe('2027-02-15')
    // A leap-day bill lands on the 28th in a common year, not 1 March.
    expect(nextOccurrence('2028-02-29', { every: 1, unit: 'year' })).toBe('2029-02-28')
    expect(nextOccurrence('2026-02-15', { every: 2, unit: 'year' })).toBe('2028-02-15')
    expect(previousOccurrence('2027-02-15', { every: 1, unit: 'year' })).toBe('2026-02-15')
  })

  it('has no next or previous for a one-off', () => {
    expect(nextOccurrence('2026-09-19', null)).toBeNull()
    expect(previousOccurrence('2026-09-19', null)).toBeNull()
  })
})

describe('a past date means the last one was then', () => {
  it('rolls forward to the first occurrence after today', () => {
    expect(rollToFuture('2025-09-01', { every: 1, unit: 'year' }, '2026-09-19')).toBe('2027-09-01')
    expect(rollToFuture('2026-09-01', { every: 2, unit: 'week' }, '2026-09-19')).toBe('2026-09-29')
    // 2,449 days have passed: 55 steps of 45 land 26 days past today.
    expect(rollToFuture('2020-01-05', { every: 45, unit: 'day' }, '2026-09-19')).toBe('2026-10-15')
  })

  it('leaves a future date, and a one-off, alone', () => {
    expect(rollToFuture('2027-03-01', { every: 1, unit: 'month' }, '2026-09-19')).toBe('2027-03-01')
    expect(rollToFuture('2025-03-01', null, '2026-09-19')).toBe('2025-03-01')
  })

  it('treats today itself as past: the next one is what gets planned', () => {
    expect(rollToFuture('2026-09-19', { every: 1, unit: 'month' }, '2026-09-19')).toBe('2026-10-19')
  })
})

describe('how many times it comes round', () => {
  it('counts occurrences after the start up to and including the end', () => {
    expect(occurrencesBetween('2026-01-01', '2026-12-31', { every: 1, unit: 'month' })).toBe(11)
    expect(occurrencesBetween('2026-01-01', '2027-01-01', { every: 1, unit: 'month' })).toBe(12)
    expect(occurrencesBetween('2026-01-01', '2026-03-01', { every: 2, unit: 'week' })).toBe(4)
    expect(occurrencesBetween('2026-01-01', '2026-03-01', null)).toBe(1)
  })
})
