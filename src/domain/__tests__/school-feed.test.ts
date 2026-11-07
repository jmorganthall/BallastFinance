import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  namesSchoolDay,
  parseIcal,
  parseSchoolIcal,
  schoolDaysMissed,
  schoolLeftOutNote,
  schoolYearBoundOf,
  splitSchoolYearDays,
  SCHOOL_DAY_MINUTES,
} from '..'

// Baldwin County Public Schools' own feed, copied from bcbe.org on 2026-11-07: holidays and breaks
// beside board meetings, graduations, the ends of quarters and a Saturday festival, as districts publish them.
const bcbe = readFileSync(new URL('./fixtures/bcbe-2026-27.ics', import.meta.url), 'utf8')

const event = (start: string, end: string, title: string) => ['BEGIN:VEVENT', `DTSTART${start}`, `DTEND${end}`, `SUMMARY:${title}`, 'END:VEVENT']
const feed = (...events: string[][]) => ['BEGIN:VCALENDAR', ...events.flat(), 'END:VCALENDAR'].join('\r\n')

describe("a school's own feed (D59 (6))", () => {
  it('reads a real district feed into its true days off and nothing else', () => {
    const read = parseSchoolIcal(bcbe)
    const split = splitSchoolYearDays(read.items)
    // Every board meeting, graduation and the festival is timed and short.
    expect(read.shortEvents).toBe(27)
    expect(split.yearDays).toEqual([{ schoolYear: '2026-27', which: 'last', date: '2027-05-27', label: 'Last day of school' }])
    expect([...new Set(split.schoolDays.map((d) => d.label))]).toEqual(['End of 1st Qtr.', 'End of qtr.', 'End of semester', 'Students return', 'E-Learning Day'])
    expect([...new Set(split.daysOff.map((d) => d.label))]).toEqual([
      'Fall Break',
      'Variance Day',
      "Veteran's Day holiday",
      'Thanksgiving Break',
      'Christmas Break',
      'NY Holiday',
      'District PD',
      'Local PD',
      'MLK Holiday',
      'Mardi Gras break',
      'Easter',
      'Spring Break',
      'Teacher Workday',
      'Memorial Day holiday',
      'Juneteenth',
    ])
    // Read as every event, the same feed made a day off of each board meeting.
    expect(parseIcal(bcbe).some((d) => d.date === '2026-10-20' && /Work Session/.test(d.label))).toBe(true)
  })

  it('counts the week of two board meetings as five school days', () => {
    const split = splitSchoolYearDays(parseSchoolIcal(bcbe).items)
    // The district's PDF: the first day of school is Wednesday, August 12, 2026.
    const stated = [
      { schoolYear: '2026-27', which: 'first' as const, date: '2026-08-12' },
      ...split.yearDays,
    ]
    expect(schoolDaysMissed({ startDate: '2026-10-19', endDate: '2026-10-23' }, split.daysOff, [], stated)).toBe(5)
    expect(schoolDaysMissed({ startDate: '2026-10-19', endDate: '2026-10-23' }, splitSchoolYearDays(parseIcal(bcbe)).daysOff, [], stated)).toBe(3)
    // Fall break and the variance day are still off: Oct 12-14.
    expect(schoolDaysMissed({ startDate: '2026-10-12', endDate: '2026-10-16' }, split.daysOff, [], stated)).toBe(2)
  })

  it('keeps a timed event that runs a school day or more, and one with a long duration', () => {
    const read = parseSchoolIcal(
      feed(
        event(';TZID=America/Chicago:20270405T000000', ';TZID=America/Chicago:20270405T235900', 'Teacher Institute - No School'),
        ['BEGIN:VEVENT', 'DTSTART:20270406T070000', 'DURATION:PT9H', 'SUMMARY:Storm makeup closure', 'END:VEVENT'],
        event(':20270407T170000', ':20270407T190000', 'Board Meeting'),
        ['BEGIN:VEVENT', 'DTSTART:20270408T080000', 'SUMMARY:Picture day', 'END:VEVENT'],
      ),
    )
    expect(read.items.map((d) => d.label)).toEqual(['Teacher Institute - No School', 'Storm makeup closure'])
    expect(read.shortEvents).toBe(2)
    expect(SCHOOL_DAY_MINUTES).toBe(480)
  })

  it('knows the first day as "1st Day of School", and the titles that name a school day', () => {
    expect(schoolYearBoundOf('1st Day of School')).toBe('first')
    expect(schoolYearBoundOf('12 1st Day of School')).toBe('first')
    for (const title of ['End of 1st Quarter', 'End of qtr.', 'End of Semester', 'End of the grading period', 'Students return', 'E-Learning Day', 'Early Release', 'Report Cards']) {
      expect(namesSchoolDay(title)).toBe(true)
    }
    for (const title of ['Fall Break', 'Variance Day', 'District PD', 'Teacher Workday', 'Spring Break', 'Thanksgiving Break']) {
      expect(namesSchoolDay(title)).toBe(false)
    }
  })

  it('says in one sentence what it left out', () => {
    expect(schoolLeftOutNote(0, [])).toBeNull()
    expect(schoolLeftOutNote(1, [])).toBe('Left out: 1 short event with a time, like a board meeting.')
    expect(
      schoolLeftOutNote(27, [
        { date: '2026-10-09', label: 'End of 1st Qtr.' },
        { date: '2026-12-18', label: 'End of qtr.' },
        { date: '2026-12-18', label: 'End of semester' },
        { date: '2027-01-07', label: 'Students return' },
        { date: '2027-03-26', label: 'E-Learning Day' },
      ]),
    ).toBe('Left out: 27 short events with a time, like a board meeting, and 5 days that name a school day (End of 1st Qtr., End of qtr., End of semester and 2 more).')
  })
})
