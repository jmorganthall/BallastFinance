/**
 * When to go (PRD §16 D25-D26): the holidays with their observed days, the
 * windows a day off opens, the candidates and how they score, the iCal
 * reader on real-shaped feeds and on garbage, and the DVC listing parser on
 * each page shape it accepts. None of this reaches a network: the broker's
 * page is unreachable from here, so a page that changes shape must fail as
 * nothing, not as a crash.
 */

import { describe, expect, it } from 'vitest'
import {
  candidateWindows,
  DEFAULT_WEEK_WEIGHTS,
  diffDaysOff,
  DVC_LISTING_SOURCES,
  federalHolidays,
  federalHolidaysBetween,
  icalDate,
  isSchoolDay,
  listingDate,
  listingPriceCents,
  listingsForTrip,
  listingWindow,
  longWeekends,
  measureCandidates,
  observedDay,
  parseIcal,
  parseListingPage,
  schoolDaysMissed,
  schoolYearOf,
  scoreCandidates,
  validateDayOff,
  validateSchoolCalendarSources,
  validateWeekWeights,
  weekday,
  type Candidate,
  type MeasuredCandidate,
} from '../trip-when'
import { TripPlanError } from '../trip-plan'
import type { CrowdLevel } from '../trip-plan'

const TODAY = '2026-09-25'

describe('federal holidays', () => {
  it('lists 2026 with the Saturday Fourth observed on Friday the 3rd', () => {
    const dates = Object.fromEntries(federalHolidays(2026).map((h) => [h.name, h.date]))
    expect(dates).toEqual({
      "New Year's Day": '2026-01-01',
      'Martin Luther King Jr. Day': '2026-01-19',
      "Presidents' Day": '2026-02-16',
      'Memorial Day': '2026-05-25',
      Juneteenth: '2026-06-19',
      'Independence Day': '2026-07-03',
      'Labor Day': '2026-09-07',
      'Columbus Day': '2026-10-12',
      'Veterans Day': '2026-11-11',
      'Thanksgiving Day': '2026-11-26',
      'Christmas Day': '2026-12-25',
    })
  })

  it('shifts 2027: Juneteenth on a Saturday to the 18th, the Fourth on a Sunday to the 5th, Christmas to the 24th, and New Year 2028 to the 31st', () => {
    const list = federalHolidays(2027)
    const dates = list.map((h) => `${h.date} ${h.name}`)
    expect(dates).toContain('2027-06-18 Juneteenth')
    expect(dates).toContain('2027-07-05 Independence Day')
    expect(dates).toContain('2027-12-24 Christmas Day')
    expect(dates).toContain("2027-12-31 New Year's Day")
    expect(dates).toContain("2027-01-01 New Year's Day")
    expect(dates).toContain('2027-01-18 Martin Luther King Jr. Day')
    expect(dates).toContain("2027-02-15 Presidents' Day")
    expect(dates).toContain('2027-05-31 Memorial Day')
    expect(dates).toContain('2027-09-06 Labor Day')
    expect(dates).toContain('2027-10-11 Columbus Day')
    expect(dates).toContain('2027-11-25 Thanksgiving Day')
    expect(list).toHaveLength(12)
    // 2028's own New Year's Day was observed in 2027, so 2028 does not list it.
    expect(federalHolidays(2028).filter((h) => h.name === "New Year's Day")).toEqual([])
  })

  it('observes a Saturday on the Friday before and a Sunday on the Monday after', () => {
    expect(observedDay('2026-07-04')).toBe('2026-07-03')
    expect(observedDay('2027-07-04')).toBe('2027-07-05')
    expect(observedDay('2026-11-11')).toBe('2026-11-11')
    expect(weekday('2026-09-26')).toBe(6)
  })

  it('finds the holidays between two dates across a year end', () => {
    expect(federalHolidaysBetween('2026-12-20', '2027-01-20').map((h) => h.date)).toEqual(['2026-12-25', '2027-01-01', '2027-01-18'])
  })
})

describe('long weekends', () => {
  it('opens Friday-Monday and Thursday-Monday for a Monday holiday, and names two days off that open the same window once', () => {
    const w = longWeekends({
      daysOff: [
        { date: '2026-11-26', label: 'Thanksgiving break' },
        { date: '2026-11-27', label: 'Thanksgiving break' },
      ],
      holidays: federalHolidaysBetween('2026-11-01', '2027-03-01'),
      horizonFrom: '2026-11-01',
      horizonTo: '2027-03-01',
    })
    const keys = w.map((x) => `${x.startDate}..${x.endDate} ${x.nights}n ${x.anchor}`)
    expect(keys).toContain("2027-02-12..2027-02-15 3n Presidents' Day")
    expect(keys).toContain("2027-02-11..2027-02-15 4n Presidents' Day")
    expect(keys).toContain('2027-01-15..2027-01-18 3n Martin Luther King Jr. Day')
    // Thursday off opens Thu-Sun and Thu-Mon; the Friday off opens Thu-Sun too, and Fri-Mon.
    expect(keys).toContain('2026-11-26..2026-11-29 3n Thanksgiving Day and Thanksgiving break')
    expect(keys).toContain('2026-11-26..2026-11-30 4n Thanksgiving Day and Thanksgiving break')
    expect(keys).toContain('2026-11-27..2026-11-30 3n Thanksgiving break')
    expect(keys.filter((k) => k.startsWith('2026-11-26..2026-11-29'))).toHaveLength(1)
    // Outside the horizon: nothing.
    expect(keys.some((k) => k.startsWith('2026-10'))).toBe(false)
  })

  it('opens Friday-Tuesday for a Tuesday off and nothing for a Wednesday', () => {
    const w = longWeekends({
      daysOff: [
        { date: '2027-03-09', label: 'Teacher day' }, // Tuesday
        { date: '2027-03-17', label: 'Midweek' }, // Wednesday
      ],
      holidays: [],
      horizonFrom: '2027-03-01',
      horizonTo: '2027-04-01',
    })
    expect(w).toEqual([{ startDate: '2027-03-05', endDate: '2027-03-09', nights: 4, anchor: 'Teacher day' }])
  })
})

describe('candidates', () => {
  const trip = { startDate: '2027-06-12', endDate: '2027-06-19' }

  it('is every window of the trip length from tomorrow to the horizon, the trip itself, and the long weekends', () => {
    const c = candidateWindows({ trip, horizonMonths: 12, daysOff: [], holidays: federalHolidays(2027), today: TODAY })
    expect(c[0]).toMatchObject({ startDate: '2026-09-26', endDate: '2026-10-03', nights: 7, kind: 'week', current: false })
    expect(c.find((x) => x.current)).toMatchObject({ startDate: '2027-06-12', endDate: '2027-06-19', nights: 7 })
    expect(c.filter((x) => x.current)).toHaveLength(1)
    expect(c.filter((x) => x.kind === 'long_weekend').map((x) => x.anchor)).toContain("Presidents' Day")
    const weeks = c.filter((x) => x.kind === 'week')
    expect(weeks[weeks.length - 1]!.startDate).toBe('2027-09-25')
    expect(new Set(c.map((x) => `${x.startDate}|${x.endDate}`)).size).toBe(c.length)
  })

  it('keeps the trip window when it lies past the horizon', () => {
    const c = candidateWindows({ trip, horizonMonths: 1, daysOff: [], holidays: [], today: TODAY })
    expect(c.filter((x) => x.current)).toHaveLength(1)
    expect(c.filter((x) => x.kind === 'week' && !x.current)).toHaveLength(30)
  })
})

describe('school days', () => {
  const daysOff = [
    { date: '2026-08-31', label: 'First day off', schoolYear: '2026-27' },
    { date: '2027-01-18', label: 'MLK Day', schoolYear: '2026-27' },
    { date: '2027-05-28', label: 'Last day', schoolYear: '2026-27' },
  ]

  it('is a weekday inside the school year that is not a day off or a holiday', () => {
    const holidays = federalHolidays(2027)
    expect(isSchoolDay('2027-01-19', daysOff, holidays)).toBe(true)
    expect(isSchoolDay('2027-01-18', daysOff, holidays)).toBe(false)
    expect(isSchoolDay('2027-02-15', daysOff, holidays)).toBe(false) // Presidents' Day
    expect(isSchoolDay('2027-01-16', daysOff, holidays)).toBe(false) // Saturday
    expect(isSchoolDay('2027-07-06', daysOff, holidays)).toBe(false) // summer, outside the year's span
    expect(isSchoolDay('2027-07-06', [], holidays)).toBe(true) // no calendar: every weekday counts
    expect(schoolDaysMissed({ startDate: '2027-02-12', endDate: '2027-02-16' }, daysOff, holidays)).toBe(2) // Fri 12th, Tue 16th
  })

  it('names the school year from a date', () => {
    expect(schoolYearOf('2026-09-25')).toBe('2026-27')
    expect(schoolYearOf('2027-03-01')).toBe('2026-27')
    expect(schoolYearOf('2027-08-15')).toBe('2027-28')
  })
})

describe('scoring', () => {
  const level = (date: string, level: number): CrowdLevel => ({ destination: 'wdw', date, park: 'other', level, source: 'typed', fetchedOn: TODAY })
  const window = (startDate: string, nights: number, extra: Partial<Candidate> = {}): Candidate => ({
    startDate,
    endDate: addDays(startDate, nights),
    nights,
    kind: 'week',
    anchor: null,
    current: false,
    ...extra,
  })
  function addDays(d: string, n: number): string {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number]
    return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10)
  }

  it('measures how busy on the park days shifted with the window, the price, school missed and blackouts', () => {
    const trip = { startDate: '2027-03-06', endDate: '2027-03-13' }
    const days = [
      { id: 'd', tripId: 't', date: '2027-03-08', park: 'magic_kingdom' as const, plan: { notes: '', ropeDrop: false }, sort: 2 },
      { id: 'e', tripId: 't', date: '2027-03-09', park: 'epcot' as const, plan: { notes: '', ropeDrop: false }, sort: 3 },
    ]
    const candidates = [window('2027-03-06', 7, { current: true }), window('2027-03-13', 7), window('2027-03-12', 3, { kind: 'long_weekend', anchor: 'Teacher day' })]
    const measured = measureCandidates({
      candidates,
      trip,
      days,
      crowdLevels: [level('2027-03-08', 4), level('2027-03-09', 6), level('2027-03-15', 2), level('2027-03-16', 2), level('2027-03-13', 8)],
      priceOf: (w) => (w.startDate === '2027-03-13' ? 500_00 : 700_00),
      daysOff: [
        { date: '2027-01-04', label: 'Start', schoolYear: '2026-27' },
        { date: '2027-03-12', label: 'Teacher day', schoolYear: '2026-27' },
        { date: '2027-05-28', label: 'End', schoolYear: '2026-27' },
      ],
      holidays: [],
      blackoutDates: [{ from: '2027-03-15', to: '2027-03-15', label: 'Recital' }],
    })
    expect(measured[0]).toMatchObject({ crowdAverage: 5, daysWithData: 2, daysCounted: 2, priceCents: 700_00, schoolDaysMissed: 4, blackouts: [] })
    expect(measured[1]).toMatchObject({ crowdAverage: 2, daysWithData: 2, daysCounted: 2, priceCents: 500_00, schoolDaysMissed: 5, blackouts: ['Recital'] })
    // A long weekend of another length counts every day; Fri 12th is off, Mon 15th is school and the recital.
    expect(measured[2]).toMatchObject({ crowdAverage: 5, daysWithData: 2, daysCounted: 4, priceCents: 700_00, schoolDaysMissed: 1, blackouts: ['Recital'] })
  })

  const measured = (over: Partial<MeasuredCandidate> & { startDate: string }): MeasuredCandidate => ({
    ...window(over.startDate, 7),
    crowdAverage: 5,
    daysWithData: 8,
    daysCounted: 8,
    priceCents: 600_00,
    schoolDaysMissed: 0,
    blackouts: [],
    ...over,
  })

  it('ranks quiet over cheap over school with the plain weights, drops blackouts, and says why', () => {
    const top = scoreCandidates({
      candidates: [
        measured({ startDate: '2027-01-02', current: true, crowdAverage: 6, priceCents: 700_00 }),
        measured({ startDate: '2027-01-09', crowdAverage: 2.5, priceCents: 800_00, schoolDaysMissed: 5 }),
        measured({ startDate: '2027-01-16', crowdAverage: 8, priceCents: 300_00 }),
        measured({ startDate: '2027-01-23', crowdAverage: 1, priceCents: 300_00, blackouts: ['Recital'] }),
        measured({ startDate: '2027-01-30', crowdAverage: null, priceCents: 700_00 }),
      ],
    })
    // Scores by hand (busy over 2.5..8, price over 300..800, school over 0..5): the quiet week 3.0, the busy
    // cheap one 3.0 (a tie, earlier start first), no data 3.1, the current dates 3.509. The blackout is out.
    expect(top.map((c) => c.startDate)).toEqual(['2027-01-09', '2027-01-16', '2027-01-30', '2027-01-02'])
    expect(top[0]!.reasons).toEqual(['quiet (2.5 avg)', '$100.00 over your current dates', '5 school days missed'])
    expect(top[1]!.reasons).toEqual(['busy (8 avg)', '$400.00 under your current dates', 'no school missed'])
    expect(top[2]!.reasons).toEqual(['no crowd data', 'same price as your current dates', 'no school missed'])
    expect(top[3]!.reasons).toEqual(['moderate (6 avg)', 'your current dates', 'no school missed'])
    expect(top[0]!.score).toBe(3)
    expect(top[1]!.score).toBe(3)
    expect(top[2]!.score).toBe(3.1)
    expect(top[3]!.score).toBe(3.509)
    expect(DEFAULT_WEEK_WEIGHTS).toEqual({ busy: 3, price: 2, school: 1 })
  })

  it('breaks a tie on the earlier start, keeps ten, and puts the long weekend reason first', () => {
    const many = Array.from({ length: 14 }, (_, i) => measured({ startDate: `2027-04-${String(i + 1).padStart(2, '0')}` }))
    many[5] = { ...many[5]!, kind: 'long_weekend', anchor: "Presidents' Day", nights: 3 }
    const top = scoreCandidates({ candidates: many })
    expect(top).toHaveLength(10)
    expect(top.map((c) => c.startDate)).toEqual(many.slice(0, 10).map((c) => c.startDate))
    expect(top.every((c) => c.score === 0)).toBe(true)
    expect(top[5]!.reasons[0]).toBe("long weekend: Presidents' Day")
  })

  it('prices a long weekend against other long weekends, not against a week, and says when only some days are known', () => {
    const top = scoreCandidates({
      candidates: [
        measured({ startDate: '2027-05-01', priceCents: 900_00 }),
        measured({ startDate: '2027-05-08', priceCents: 900_00, daysWithData: 3 }),
        measured({ startDate: '2027-05-14', nights: 3, kind: 'long_weekend', anchor: 'Teacher day', priceCents: 400_00 }),
        measured({ startDate: '2027-05-21', nights: 3, kind: 'long_weekend', anchor: 'Teacher day', priceCents: 500_00 }),
      ],
    })
    // Every week costs the same, so price is 0 for each; the dearer weekend is 1 among weekends.
    expect(top.map((c) => `${c.startDate} ${c.score}`)).toEqual(['2027-05-01 0', '2027-05-08 0', '2027-05-14 0', '2027-05-21 2'])
    expect(top[1]!.reasons[0]).toBe('moderate (5 avg, 3 of 8 days known)')
  })

  it('weights can silence a part: price only ranks the cheapest first', () => {
    const top = scoreCandidates({
      candidates: [measured({ startDate: '2027-05-01', crowdAverage: 1, priceCents: 900_00 }), measured({ startDate: '2027-05-08', crowdAverage: 9, priceCents: 100_00 })],
      weights: { busy: 0, price: 1, school: 0 },
    })
    expect(top[0]!.startDate).toBe('2027-05-08')
    expect(scoreCandidates({ candidates: [measured({ startDate: '2027-05-01', blackouts: ['x'] })] })).toEqual([])
  })
})

describe('iCal', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//District//Calendar//EN',
    'BEGIN:VEVENT',
    'UID:1',
    'DTSTART;VALUE=DATE:20270118',
    'DTEND;VALUE=DATE:20270119',
    'SUMMARY:Martin Luther King Jr. Day - No School',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'SUMMARY:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:2',
    'DTSTART;VALUE=DATE:20270315',
    'DTEND;VALUE=DATE:20270320',
    'SUMMARY:Spring Break\\, no',
    '  school',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:3',
    'DTSTART;TZID=America/Chicago:20270405T080000',
    'DTEND;TZID=America/Chicago:20270405T090000',
    'SUMMARY:Teacher Institute',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:4',
    'SUMMARY:No date at all',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('reads all-day events, expands a multi-day one with an exclusive end, unfolds lines, and skips alarms', () => {
    expect(parseIcal(feed)).toEqual([
      { date: '2027-01-18', label: 'Martin Luther King Jr. Day - No School' },
      { date: '2027-03-15', label: 'Spring Break, no school' },
      { date: '2027-03-16', label: 'Spring Break, no school' },
      { date: '2027-03-17', label: 'Spring Break, no school' },
      { date: '2027-03-18', label: 'Spring Break, no school' },
      { date: '2027-03-19', label: 'Spring Break, no school' },
      { date: '2027-04-05', label: 'Teacher Institute' },
    ])
  })

  it('is nothing for garbage, an HTML page, or an empty calendar', () => {
    expect(parseIcal('<html>login</html>')).toEqual([])
    expect(parseIcal('')).toEqual([])
    expect(parseIcal('BEGIN:VCALENDAR\nEND:VCALENDAR')).toEqual([])
    expect(parseIcal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20279999\nSUMMARY:Bad\nEND:VEVENT\nEND:VCALENDAR')).toEqual([])
    expect(icalDate('20270230')).toBeNull()
    expect(icalDate('2027-01-18')).toBe('2027-01-18')
  })

  it('diffs an import against what is there, case-blind on the label', () => {
    const diff = diffDaysOff(
      [
        { date: '2027-01-18', label: 'MLK Day' },
        { date: '2027-02-15', label: 'Old entry' },
      ],
      [
        { date: '2027-01-18', label: 'mlk day' },
        { date: '2027-03-15', label: 'Spring Break' },
        { date: '2027-03-15', label: 'Spring Break' },
      ],
    )
    expect(diff).toEqual({ add: [{ date: '2027-03-15', label: 'Spring Break' }], remove: [{ date: '2027-02-15', label: 'Old entry' }] })
  })
})

describe('validation', () => {
  it('refuses a day off without a date, a label or a year', () => {
    expect(() => validateDayOff({ date: 'soon', label: 'x', schoolYear: '2026-27' })).toThrow(TripPlanError)
    expect(() => validateDayOff({ date: '2027-01-18', label: ' ', schoolYear: '2026-27' })).toThrow(TripPlanError)
    expect(() => validateDayOff({ date: '2027-01-18', label: 'x', schoolYear: '' })).toThrow(TripPlanError)
    expect(() => validateDayOff({ date: '2027-01-18', label: 'x', schoolYear: '2026-27' })).not.toThrow()
  })

  it('refuses a calendar source without a link or a kind, and weights that rank nothing', () => {
    expect(() => validateSchoolCalendarSources([{ label: 'District', url: 'ftp://x', kind: 'ical' }])).toThrow(TripPlanError)
    expect(() => validateSchoolCalendarSources([{ label: 'District', url: 'https://x', kind: 'feed' as 'ical' }])).toThrow(TripPlanError)
    expect(() => validateSchoolCalendarSources([{ label: 'District', url: 'https://x/cal.ics', kind: 'ical' }])).not.toThrow()
    expect(() => validateWeekWeights({ busy: 0, price: 0, school: 0 })).toThrow(TripPlanError)
    expect(() => validateWeekWeights({ busy: -1, price: 1, school: 0 })).toThrow(TripPlanError)
    expect(() => validateWeekWeights({ busy: 3, price: 2, school: 1 })).not.toThrow()
  })
})

describe('DVC listings', () => {
  it('reads JSON in a script tag, keeping the dates asked for', () => {
    const page = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        availability: [
          { resort: "Disney's Polynesian Villas", roomType: 'Deluxe Studio', checkIn: '2027-06-12', checkOut: '2027-06-17', points: 118, price: '$2,242.00' },
          { resort: 'Copper Creek', roomType: 'One-Bedroom Villa', checkIn: '06/13/2027', nights: 4, points: 140, price: 2660 },
          { resort: 'Far away', roomType: 'Studio', checkIn: '2027-09-01', nights: 3, points: 50, price: 950 },
        ],
      },
    })}</script></html>`
    const got = parseListingPage(page, { from: '2027-06-10', to: '2027-06-21' })
    expect(got.reason).toBeNull()
    expect(got.listings).toEqual([
      { resort: "Disney's Polynesian Villas", room: 'Deluxe Studio', checkIn: '2027-06-12', nights: 5, points: 118, priceCents: 224_200 },
      { resort: 'Copper Creek', room: 'One-Bedroom Villa', checkIn: '2027-06-13', nights: 4, points: 140, priceCents: 266_000 },
    ])
  })

  it('reads a table by its headers', () => {
    const page = `<table><tr><th>Resort</th><th>Room</th><th>Check-In</th><th>Check-Out</th><th>Points</th><th>Total Price</th></tr>
      <tr><td>Bay Lake Tower</td><td>Studio, Lake View</td><td>Jun 12, 2027</td><td>Jun 19, 2027</td><td>152</td><td>$2,888</td></tr>
      <tr><td>Bay Lake Tower</td><td>Studio, Lake View</td><td>Jun 12, 2027</td><td>Jun 19, 2027</td><td>152</td><td>$2,888</td></tr>
      <tr><td>Broken</td><td>Studio</td><td>someday</td><td></td><td></td><td></td></tr></table>`
    expect(parseListingPage(page)).toEqual({
      listings: [{ resort: 'Bay Lake Tower', room: 'Studio, Lake View', checkIn: '2027-06-12', nights: 7, points: 152, priceCents: 288_800 }],
      reason: null,
    })
  })

  it('reads cards', () => {
    const page = `<div class="availability-card"><h3>Resort: Beach Club Villas</h3><p>Room: Deluxe Studio</p><p>Check-in: 2027-06-14</p><p>5 nights · 96 points · $1,824.00</p></div>
      <div class="listing"><p>Resort: Saratoga Springs</p><p>Room: Studio</p><p>Check-in: 2027-06-15</p><p>3 nights</p></div>`
    expect(parseListingPage(page).listings).toEqual([
      { resort: 'Beach Club Villas', room: 'Deluxe Studio', checkIn: '2027-06-14', nights: 5, points: 96, priceCents: 182_400 },
      { resort: 'Saratoga Springs', room: 'Studio', checkIn: '2027-06-15', nights: 3, points: null, priceCents: null },
    ])
  })

  it('is nothing with a reason for an empty page, a login page, or dates with no rows', () => {
    expect(parseListingPage('')).toEqual({ listings: [], reason: 'The page was empty.' })
    expect(parseListingPage('<html><body><form>Sign in</form></body></html>')).toEqual({ listings: [], reason: 'Nothing on the page read as a list of DVC rooms.' })
    const page = `<script>[{"resort":"X","room":"Studio","checkIn":"2027-01-01","nights":2}]</script>`
    expect(parseListingPage(page, { from: '2027-06-01', to: '2027-06-30' }).reason).toBe('The page had listings, but none for those dates.')
  })

  it('reads dates and prices as a page writes them', () => {
    expect(listingDate('June 12, 2027')).toBe('2027-06-12')
    expect(listingDate('6/1/2027')).toBe('2027-06-01')
    expect(listingDate('2027-06-12T00:00:00Z')).toBe('2027-06-12')
    expect(listingDate('soon')).toBeNull()
    expect(listingPriceCents('$2,242.50')).toBe(224_250)
    expect(listingPriceCents(1824)).toBe(182_400)
    expect(listingPriceCents('call')).toBeNull()
  })

  it('has the broker source first, asks about the trip dates two days either side, and sorts listings for a trip', () => {
    expect(DVC_LISTING_SOURCES[0]!.key).toBe('dvc_rental_store')
    expect(DVC_LISTING_SOURCES[0]!.url({ from: '2027-06-10', to: '2027-06-21' })).toBe('https://dvcrentalstore.com/guests/check-dvc-availability/?check_in=2027-06-10&check_out=2027-06-21')
    const trip = { startDate: '2027-06-12', endDate: '2027-06-19' }
    expect(listingWindow(trip)).toEqual({ from: '2027-06-10', to: '2027-06-21' })
    const l = (checkIn: string, priceCents: number | null, resort = 'R') => ({ resort, room: 'Studio', checkIn, nights: 5, points: null, priceCents, source: 'dvc_rental_store', sourceUrl: 'https://x', seenOn: TODAY })
    expect(listingsForTrip([l('2027-06-14', 900), l('2027-06-12', null), l('2027-06-12', 500), l('2027-05-01', 100)], trip).map((x) => `${x.checkIn} ${x.priceCents}`)).toEqual([
      '2027-06-12 500',
      '2027-06-12 null',
      '2027-06-14 900',
    ])
  })
})
