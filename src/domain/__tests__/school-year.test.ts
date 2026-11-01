import { describe, expect, it } from 'vitest'
import {
  isSchoolDay,
  outOfSchool,
  schoolDaysMissed,
  schoolYearBoundOf,
  schoolYearOfBound,
  schoolYearRows,
  schoolYearSpans,
  splitSchoolYearDays,
  validateSchoolYearDay,
  validateSchoolYearSpan,
  type SchoolYearDay,
} from '..'

// A school year as a district lists it: the first day off is Labor Day, the last is Memorial Day.
const daysOff = [
  { date: '2026-09-07', label: 'Labor Day' },
  { date: '2026-11-25', label: 'Thanksgiving break' },
  { date: '2027-05-31', label: 'Memorial Day' },
]
const stated: SchoolYearDay[] = [
  { schoolYear: '2026-27', which: 'first', date: '2026-08-12', source: 'typed' },
  { schoolYear: '2026-27', which: 'last', date: '2027-06-04', source: 'ical' },
]

describe('the first and last day of school (D59)', () => {
  it('belongs to the year it starts or ends, even a start in July', () => {
    expect(schoolYearOfBound('first', '2026-07-28')).toBe('2026-27')
    expect(schoolYearOfBound('first', '2026-08-12')).toBe('2026-27')
    expect(schoolYearOfBound('last', '2027-06-04')).toBe('2026-27')
  })

  it('says in plain words when a day cannot be one', () => {
    expect(() => validateSchoolYearDay({ which: 'first', date: '2026-03-01' })).toThrow(/July, August, September or October/)
    expect(() => validateSchoolYearDay({ which: 'last', date: '2026-12-18' })).toThrow(/April, May, June or July/)
    expect(() => validateSchoolYearDay({ which: 'first', date: 'soon' })).toThrow(/a date/)
    expect(() => validateSchoolYearSpan('2027-07-30', '2027-07-01')).toThrow(/before the last/)
    expect(() => validateSchoolYearDay({ which: 'first', date: '2026-08-12' })).not.toThrow()
  })

  it('a stated day wins, and an end nobody stated is still the first or last day off', () => {
    expect(schoolYearSpans(daysOff, stated).get('2026-27')).toEqual({ from: '2026-08-12', to: '2027-06-04' })
    expect(schoolYearSpans(daysOff, [stated[0]!]).get('2026-27')).toEqual({ from: '2026-08-12', to: '2027-05-31' })
    expect(schoolYearSpans(daysOff).get('2026-27')).toEqual({ from: '2026-09-07', to: '2027-05-31' })
    // One end and no days off: the year is not known yet.
    expect(schoolYearSpans([], [stated[0]!]).has('2026-27')).toBe(false)
  })

  it('makes the weeks before Labor Day and after Memorial Day school, and summer not', () => {
    // Before D59 the year began at its first day off, so the first weeks read as summer.
    expect(isSchoolDay('2026-08-20', daysOff, [])).toBe(false)
    expect(isSchoolDay('2026-08-20', daysOff, [], stated)).toBe(true)
    expect(isSchoolDay('2027-06-02', daysOff, [], stated)).toBe(true)
    expect(isSchoolDay('2026-08-11', daysOff, [], stated)).toBe(false)
    expect(isSchoolDay('2027-07-14', daysOff, [], stated)).toBe(false)
    expect(isSchoolDay('2026-09-07', daysOff, [], stated)).toBe(false)
    // No calendar at all: every weekday is school, as before.
    expect(isSchoolDay('2027-07-14', [], [])).toBe(true)
  })

  it('tints summer on the calendar, and a federal holiday alone stays untinted', () => {
    expect(outOfSchool('2027-07-14', daysOff, stated)).toBe(true)
    expect(outOfSchool('2026-08-20', daysOff, stated)).toBe(false)
    expect(outOfSchool('2026-10-12', daysOff, stated)).toBe(false) // Columbus Day, school is open
    expect(isSchoolDay('2026-10-12', daysOff, [{ date: '2026-10-12', name: 'Columbus Day' }], stated)).toBe(false)
    expect(outOfSchool('2027-07-14', [], [])).toBe(false)
    expect(outOfSchool('2027-07-17', [], [])).toBe(true) // a Saturday
  })

  it('counts school missed from the stated first day', () => {
    const week = { startDate: '2026-08-15', endDate: '2026-08-21' }
    expect(schoolDaysMissed(week, daysOff, [])).toBe(0)
    expect(schoolDaysMissed(week, daysOff, [], stated)).toBe(5)
  })
})

describe('reading the first and last day from a feed (D59 (4))', () => {
  it('knows the titles districts use, and not a teachers’ day', () => {
    expect(schoolYearBoundOf('First Day of School')).toBe('first')
    expect(schoolYearBoundOf('First day for students')).toBe('first')
    expect(schoolYearBoundOf('First Day of the School Year - Grades 1-12')).toBe('first')
    expect(schoolYearBoundOf('Last Day of School (Early Release)')).toBe('last')
    expect(schoolYearBoundOf('Last day for students')).toBe('last')
    expect(schoolYearBoundOf('First Day for Teachers')).toBeNull()
    expect(schoolYearBoundOf('Last Day of School for Staff')).toBeNull()
    expect(schoolYearBoundOf('Last day of 1st semester')).toBeNull()
    expect(schoolYearBoundOf('Winter Break')).toBeNull()
  })

  it('takes those days out of the days off, the earliest start and the latest end of each year', () => {
    const split = splitSchoolYearDays([
      { date: '2026-08-12', label: 'First Day of School - Grades 1-12' },
      { date: '2026-08-14', label: 'First Day of School - Kindergarten' },
      { date: '2026-08-05', label: 'First Day for Teachers' },
      { date: '2026-09-07', label: 'Labor Day' },
      { date: '2027-06-04', label: 'Last Day of School' },
      { date: '2027-08-11', label: 'First Day of School' },
    ])
    expect(split.yearDays).toEqual([
      { schoolYear: '2026-27', which: 'first', date: '2026-08-12', label: 'First Day of School - Grades 1-12' },
      { schoolYear: '2026-27', which: 'last', date: '2027-06-04', label: 'Last Day of School' },
      { schoolYear: '2027-28', which: 'first', date: '2027-08-11', label: 'First Day of School' },
    ])
    expect(split.daysOff.map((d) => d.label)).toEqual(['First Day for Teachers', 'Labor Day'])
  })

  it('leaves a matching title in a month no first or last day can be as the feed gave it', () => {
    const split = splitSchoolYearDays([
      { date: '2027-01-05', label: 'First Day of School - Second Semester' },
      { date: '2026-12-18', label: 'Last day of school before break' },
    ])
    expect(split.yearDays).toEqual([])
    expect(split.daysOff).toHaveLength(2)
  })
})

describe('the school years in the next 365 days (D59 (1))', () => {
  it('lists this year and the next, each end as stated or what it is counted from', () => {
    expect(schoolYearRows('2026-11-01', daysOff, [stated[0]!])).toEqual([
      { schoolYear: '2026-27', first: { date: '2026-08-12', source: 'typed' }, last: null, guessFirst: null, guessLast: '2027-05-31' },
      { schoolYear: '2027-28', first: null, last: null, guessFirst: null, guessLast: null },
    ])
  })

  it('includes a year whose stated start in late July falls inside the window', () => {
    const july: SchoolYearDay = { schoolYear: '2027-28', which: 'first', date: '2027-07-28', source: 'typed' }
    expect(schoolYearRows('2026-07-30', [], [july]).map((r) => r.schoolYear)).toEqual(['2025-26', '2026-27', '2027-28'])
    expect(schoolYearRows('2026-07-30', [], []).map((r) => r.schoolYear)).toEqual(['2025-26', '2026-27'])
  })
})
