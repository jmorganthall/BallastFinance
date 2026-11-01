/**
 * The first and last day of each school year against a real database (PRD
 * D59): typed, taken back, and refused in plain words; found in a feed and
 * kept apart from the days off; a feed never replaces a typed day; every
 * change is a school_calendar_changed event; another household sees none of
 * it; and the calendar and the best-weeks list read summer as no school. No
 * network: every fetch is a fake.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('the first and last day of school', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let otherHouseholdId: string
  let engine: Engine
  let other: Engine
  const TODAY = '2026-11-01'

  const changes = async () =>
    (
      await db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'school_calendar_changed')))
        .orderBy(schema.events.recordedAt)
    ).map((e) => e.payload as { source: string; added: unknown[]; year_days?: unknown[] })

  const feed = (events: [string, string][]) =>
    (async () =>
      new Response(
        [
          'BEGIN:VCALENDAR',
          ...events.flatMap(([day, title]) => ['BEGIN:VEVENT', `DTSTART;VALUE=DATE:${day}`, `SUMMARY:${title}`, 'END:VEVENT']),
          'END:VCALENDAR',
        ].join('\r\n'),
      )) as unknown as typeof fetch

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `School year ${crypto.randomUUID()}` }).returning()
    const [neighbour] = await db.insert(schema.households).values({ name: `Other ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    otherHouseholdId = neighbour!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    other = new Engine({ householdId: otherHouseholdId, actorUserId: null, db, today: TODAY })
  })

  afterAll(async () => {
    for (const id of [householdId, otherHouseholdId].filter(Boolean)) {
      await db.delete(schema.trips).where(eq(schema.trips.householdId, id))
      await db.delete(schema.schoolDaysOff).where(eq(schema.schoolDaysOff.householdId, id))
      await db.delete(schema.schoolYearDays).where(eq(schema.schoolYearDays.householdId, id))
    }
    await client?.end()
  })

  it('lists this school year and the next with nothing set, then the days as typed, each change an event', async () => {
    expect((await engine.schoolYearsAhead()).map((y) => y.schoolYear)).toEqual(['2026-27', '2027-28'])
    await engine.setSchoolYearDays({ schoolYear: '2026-27', first: '2026-08-12', last: '2027-06-04' })
    expect(await engine.schoolYearDays()).toEqual([
      { schoolYear: '2026-27', which: 'first', date: '2026-08-12', source: 'typed', sourceUrl: null },
      { schoolYear: '2026-27', which: 'last', date: '2027-06-04', source: 'typed', sourceUrl: null },
    ])
    // The same again changes nothing and records nothing; moving both later at once is fine.
    await engine.setSchoolYearDays({ schoolYear: '2026-27', first: '2026-08-12', last: '2027-06-04' })
    expect(await changes()).toHaveLength(1)
    await engine.setSchoolYearDays({ schoolYear: '2026-27', first: '2026-08-13', last: '2027-06-05' })
    expect((await changes()).at(-1)!.year_days).toEqual([
      { school_year: '2026-27', which: 'first', before: '2026-08-12', after: '2026-08-13' },
      { school_year: '2026-27', which: 'last', before: '2027-06-04', after: '2027-06-05' },
    ])
    // Left out stays; null takes it back.
    await engine.setSchoolYearDays({ schoolYear: '2026-27', last: null })
    expect((await engine.schoolYearDays()).map((d) => `${d.which} ${d.date}`)).toEqual(['first 2026-08-13'])
    expect(await other.schoolYearDays()).toEqual([])
  })

  it('refuses a day in the wrong school year or the wrong month, in plain words', async () => {
    await expect(engine.setSchoolYearDays({ schoolYear: '2026-27', first: '2027-08-11' })).rejects.toThrow(/belongs to the 2027-28 school year/)
    await expect(engine.setSchoolYearDays({ schoolYear: '2026-27', last: '2026-12-18' })).rejects.toThrow(/April, May, June or July/)
    // A last day in July 2027 ends 2026-27: the month rules already keep a first day before its last.
    await expect(engine.setSchoolYearDays({ schoolYear: '2027-28', first: '2027-07-30', last: '2027-07-01' })).rejects.toThrow(/last day on that date belongs to the 2026-27 school year/)
    await expect(engine.setSchoolYearDays({ schoolYear: 'next year', first: '2026-08-12' })).rejects.toThrow(/like 2026-27/)
  })

  it('a feed sets the days it names, keeps them out of the days off, and never replaces a typed day', async () => {
    await engine.setSchoolCalendarSources([{ label: 'District', url: 'https://district.example/calendar.ics', kind: 'ical' }])
    const fetchImpl = feed([
      ['20260812', 'First Day of School'],
      ['20260907', 'Labor Day'],
      ['20270604', 'Last Day of School (Early Release)'],
      ['20270811', 'First Day for Students'],
    ])
    expect(await engine.readSchoolCalendarSource(0, { fallbackToReader: false, fetchImpl })).toEqual({ ok: true, count: 4 })
    const held = (await engine.pendingSchoolCalendar())!
    expect(held.items).toEqual([{ date: '2026-09-07', label: 'Labor Day' }])
    expect(held.yearDays!.map((d) => `${d.schoolYear} ${d.which} ${d.date}`)).toEqual(['2026-27 first 2026-08-12', '2026-27 last 2027-06-04', '2027-28 first 2027-08-11'])
    expect(held.notes).toEqual(['District: 1 day off read from the feed, and the first and last day of school for 2026-27 and the first day of school for 2027-28.'])
    // Nothing is kept until a person says so.
    expect((await engine.schoolYearDays()).map((d) => `${d.which} ${d.date}`)).toEqual(['first 2026-08-13'])
    expect(await engine.keepSchoolCalendar()).toEqual({ added: 1, removed: 0, yearDays: 2 })
    expect((await engine.schoolYearDays()).map((d) => `${d.schoolYear} ${d.which} ${d.date} ${d.source}`)).toEqual([
      '2026-27 first 2026-08-13 typed', // typed, so the feed's Aug 12 does not replace it
      '2026-27 last 2027-06-04 ical',
      '2027-28 first 2027-08-11 ical',
    ])
    expect((await engine.schoolDaysOff()).map((d) => d.label)).toEqual(['Labor Day'])
    expect((await changes()).at(-1)).toMatchObject({ source: 'ical', added: [{ date: '2026-09-07', label: 'Labor Day' }] })
  })

  it('the calendar shades summer and the weeks before Labor Day are school', async () => {
    const august = await engine.calendarMonth('2026-08')
    const cell = (month: typeof august, date: string) => month.weeks.flat().find((c) => c?.date === date)!
    expect(cell(august, '2026-08-12').noSchool).toBe(true) // before the typed first day, Aug 13
    expect(cell(august, '2026-08-20').noSchool).toBe(false) // school, though the first day off is in September
    const june = await engine.calendarMonth('2027-06')
    expect(cell(june, '2027-06-04').noSchool).toBe(false) // the last day of school is a school day
    expect(cell(june, '2027-06-07').noSchool).toBe(true) // summer
    const sept = await engine.calendarMonth('2026-09')
    expect(cell(sept, '2026-09-07').noSchool).toBe(true) // Labor Day, a day off
  })
})
