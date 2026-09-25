/**
 * When to go, against a real database (PRD §16 D25-D27): the school
 * calendar is the household's own and another household sees none of it,
 * an import is safe to repeat and leaves typed days alone, the best weeks
 * for a trip respect a typed crowd level and a blackout, a calendar read
 * from a feed or by the reader waits to be kept, DVC listings are kept and
 * read back, and a pull that found nothing asks the reader only when told
 * to. No network: every fetch and the reader are fakes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, EngineError } from '@/server/engine'
import type { readStructured } from '@/server/reader'
import { type Traveler } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('when to go', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let otherHouseholdId: string
  let engine: Engine
  let other: Engine
  let tripId: string
  const TODAY = '2026-09-25'
  const travelers: Traveler[] = [
    { name: 'Josh', band: 'adult' },
    { name: 'Ada', band: 'child' },
  ]
  const readerEnv = { READER_API_KEY: 'k', READER_MODEL: 'test/model' }

  const events = (kind: 'school_calendar_changed' | 'trip_changed') =>
    db.select().from(schema.events).where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, kind)))

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `When ${crypto.randomUUID()}` }).returning()
    const [neighbour] = await db.insert(schema.households).values({ name: `Other ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    otherHouseholdId = neighbour!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    other = new Engine({ householdId: otherHouseholdId, actorUserId: null, db, today: TODAY })
    await db.delete(schema.crowdLevels).where(eq(schema.crowdLevels.destination, 'wdw'))
    await db.delete(schema.dvcListings)
    const trip = await engine.createTrip({ name: 'Disney', startDate: '2027-06-12', endDate: '2027-06-19', travelers, car: null })
    tripId = trip.id
    await engine.addVariant(tripId, { name: 'Drive and DVC', choices: { travel: 'drive', lodging: 'dvc_rental', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 4 } })
  })

  afterAll(async () => {
    for (const id of [householdId, otherHouseholdId].filter(Boolean)) {
      await db.delete(schema.trips).where(eq(schema.trips.householdId, id))
      await db.delete(schema.schoolDaysOff).where(eq(schema.schoolDaysOff.householdId, id))
    }
    await db.delete(schema.crowdLevels).where(eq(schema.crowdLevels.destination, 'wdw'))
    await db.delete(schema.dvcListings)
    await client?.end()
  })

  it('days off are typed, listed in date order with the school year worked out, removed, and each change is an event', async () => {
    const mlk = await engine.addSchoolDayOff({ date: '2027-01-18', label: 'MLK Day' })
    expect(mlk).toMatchObject({ householdId, date: '2027-01-18', label: 'MLK Day', schoolYear: '2026-27', source: 'typed', sourceUrl: null, recordedOn: TODAY })
    const teacher = await engine.addSchoolDayOff({ date: '2026-10-09', label: 'Teacher day', schoolYear: '2026-27' })
    // The same fact twice is one row.
    await engine.addSchoolDayOff({ date: '2027-01-18', label: 'MLK Day' })
    expect((await engine.schoolDaysOff()).map((d) => `${d.date} ${d.label}`)).toEqual(['2026-10-09 Teacher day', '2027-01-18 MLK Day'])
    expect((await engine.schoolDaysOff({ from: '2027-01-01', to: '2027-12-31' })).map((d) => d.id)).toEqual([mlk.id])
    await engine.removeSchoolDayOff(teacher.id)
    expect((await engine.schoolDaysOff()).map((d) => d.id)).toEqual([mlk.id])
    const log = await events('school_calendar_changed')
    expect(log).toHaveLength(3)
    expect(log[log.length - 1]!.payload).toEqual({ added: [], removed: [{ date: '2026-10-09', label: 'Teacher day' }], source: 'typed', source_url: null })
    await expect(engine.addSchoolDayOff({ date: '2027-01-18', label: '  ' })).rejects.toThrow(/name/)
  })

  it('an import adds what is new, is safe to repeat, drops only its own stale rows, and leaves typed days alone', async () => {
    const feed = 'https://district.example/calendar.ics'
    const items = [
      { date: '2027-01-18', label: 'MLK Day' }, // already typed: not added twice
      { date: '2027-03-15', label: 'Spring break' },
      { date: '2027-03-16', label: 'Spring break' },
    ]
    expect(await engine.importSchoolCalendar({ items, source: 'ical', sourceUrl: feed, schoolYear: '2026-27' })).toEqual({ added: 2, removed: 0 })
    const before = (await events('school_calendar_changed')).length
    expect(await engine.importSchoolCalendar({ items, source: 'ical', sourceUrl: feed, schoolYear: '2026-27' })).toEqual({ added: 0, removed: 0 })
    expect((await events('school_calendar_changed')).length).toBe(before)
    // The feed drops one day: that row goes; the typed MLK Day stays even though the feed no longer lists it.
    expect(await engine.importSchoolCalendar({ items: items.slice(1, 2), source: 'ical', sourceUrl: feed, schoolYear: '2026-27' })).toEqual({ added: 0, removed: 1 })
    const rows = await engine.schoolDaysOff()
    expect(rows.map((d) => `${d.date} ${d.label} ${d.source}`)).toEqual(['2027-01-18 MLK Day typed', '2027-03-15 Spring break ical'])
    expect(rows[1]).toMatchObject({ sourceUrl: feed, schoolYear: '2026-27' })
    const last = (await events('school_calendar_changed')).pop()!
    expect(last.payload).toEqual({ added: [], removed: [{ date: '2027-03-16', label: 'Spring break' }], source: 'ical', source_url: feed })
  })

  it('another household sees no days off, cannot remove one, and keeps its own calendar sources', async () => {
    expect(await other.schoolDaysOff()).toEqual([])
    const [mine] = await engine.schoolDaysOff()
    await expect(other.removeSchoolDayOff(mine!.id)).rejects.toThrow(EngineError)
    expect((await engine.schoolDaysOff()).length).toBe(2)
    await engine.setSchoolCalendarSources([{ label: 'District', url: 'https://district.example/calendar.ics', kind: 'ical' }])
    expect(await other.schoolCalendarSources()).toEqual([])
    expect(await engine.schoolCalendarSources()).toEqual([{ label: 'District', url: 'https://district.example/calendar.ics', kind: 'ical' }])
    await expect(engine.setSchoolCalendarSources([{ label: 'Bad', url: 'district.example', kind: 'pdf' }])).rejects.toThrow(/http/)
  })

  it('"Read it" on a feed holds what the feed listed until it is kept, and keeps it with the feed as its source', async () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20270405', 'DTEND;VALUE=DATE:20270406', 'SUMMARY:Teacher Institute', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    const fake = (async () => new Response(ics)) as unknown as typeof fetch
    expect(await engine.readSchoolCalendarSource(0, { fallbackToReader: false, fetchImpl: fake })).toEqual({ ok: true, count: 1 })
    const pending = await engine.pendingSchoolCalendar()
    expect(pending).toMatchObject({ label: 'District', source: 'ical', sourceUrl: 'https://district.example/calendar.ics', schoolYear: null, items: [{ date: '2027-04-05', label: 'Teacher Institute' }], readOn: TODAY })
    expect((await engine.schoolDaysOff()).some((d) => d.date === '2027-04-05')).toBe(false)
    // Kept: the feed's day is added, and the feed's earlier day it no longer lists goes; the typed day stays.
    expect(await engine.keepSchoolCalendar()).toEqual({ added: 1, removed: 1 })
    expect(await engine.pendingSchoolCalendar()).toBeNull()
    expect((await engine.schoolDaysOff()).map((d) => `${d.date} ${d.source}`)).toEqual(['2027-01-18 typed', '2027-04-05 ical'])
    expect((await engine.schoolDaysOff()).find((d) => d.date === '2027-04-05')).toMatchObject({ label: 'Teacher Institute', source: 'ical', schoolYear: '2026-27' })
    await expect(engine.keepSchoolCalendar()).rejects.toThrow(/nothing waiting/)
  })

  it('a feed that reads as nothing is nothing with a reason, and the reader is asked only when the action says so', async () => {
    const login = (async () => new Response('<html>Sign in</html>')) as unknown as typeof fetch
    let readerCalls = 0
    const read = (async () => {
      readerCalls += 1
      return { ok: true as const, value: { schoolYear: '2026-27', daysOff: [{ date: '2027-05-28', label: 'Last day' }] }, model: 'test/model', sourceUrl: null, chars: 1 }
    }) as unknown as typeof readStructured
    expect(await engine.readSchoolCalendarSource(0, { fallbackToReader: false, fetchImpl: login, read, env: readerEnv })).toEqual({ ok: false, notes: ['District: nothing in the feed read as a day off.'] })
    expect(readerCalls).toBe(0)
    // Told to fall back but the reader is off: a plain notice, no call.
    expect(await engine.readSchoolCalendarSource(0, { fallbackToReader: true, fetchImpl: login, read, env: {} })).toEqual({
      ok: false,
      notes: ['District: nothing in the feed read as a day off.', 'Add a reader key in the environment to read PDFs and pages.'],
    })
    expect(readerCalls).toBe(0)
    expect(await engine.readSchoolCalendarSource(0, { fallbackToReader: true, fetchImpl: login, read, env: readerEnv })).toEqual({ ok: true, count: 1 })
    expect(readerCalls).toBe(1)
    expect(await engine.pendingSchoolCalendar()).toMatchObject({ source: 'read:test/model', items: [{ date: '2027-05-28', label: 'Last day' }] })
    expect(await engine.keepSchoolCalendar()).toEqual({ added: 1, removed: 0 })
    expect((await engine.schoolDaysOff()).find((d) => d.date === '2027-05-28')).toMatchObject({ source: 'read:test/model', sourceUrl: 'https://district.example/calendar.ics' })
  })

  it('a PDF source has no parser: nothing without the fallback, the reader with it', async () => {
    await engine.setSchoolCalendarSources([{ label: 'District PDF', url: 'https://district.example/calendar.pdf', kind: 'pdf' }])
    let fetched = 0
    const fake = (async () => {
      fetched += 1
      return new Response('x')
    }) as unknown as typeof fetch
    const read = (async () => ({ ok: false as const, reason: "The reader's answer did not fit: daysOff.0.date: a real calendar date.", sourceUrl: null })) as unknown as typeof readStructured
    expect(await engine.readSchoolCalendarSource(0, { fallbackToReader: false, fetchImpl: fake, read, env: readerEnv })).toEqual({
      ok: false,
      notes: ['District PDF: a PDF has no fixed shape, so only the reader can read it.'],
    })
    expect(fetched).toBe(0)
    const got = await engine.readSchoolCalendarSource(0, { fallbackToReader: true, fetchImpl: fake, read, env: readerEnv })
    expect(got).toEqual({ ok: false, notes: ['District PDF: a PDF has no fixed shape, so only the reader can read it.', "The reader's answer did not fit: daysOff.0.date: a real calendar date."] })
    expect(await engine.pendingSchoolCalendar()).toBeNull()
    await expect(engine.readSchoolCalendarSource(3, { fallbackToReader: false })).rejects.toThrow(/No such calendar source/)
  })

  it('the best weeks for a trip: a typed quiet level lifts a week, a blackout drops one, and the reasons say why', async () => {
    await engine.setBlackoutDates([{ from: '2027-06-12', to: '2027-06-19', label: 'Recital' }])
    await engine.setHorizonMonths(10)
    // A quiet week in October 2026 (its resort-wide figure typed), packed days either side of it.
    for (let i = 0; i < 8; i += 1) {
      await engine.typeCrowdLevel(tripId, { date: `2026-10-${String(3 + i).padStart(2, '0')}`, park: 'other', level: 1 })
      await engine.typeCrowdLevel(tripId, { date: `2026-10-${String(11 + i).padStart(2, '0')}`, park: 'other', level: 10 })
    }
    for (const date of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) {
      await engine.typeCrowdLevel(tripId, { date, park: 'other', level: 10 })
    }
    const best = await engine.bestWeeks(tripId)
    expect(best.top).toHaveLength(10)
    expect(best.considered).toBeGreaterThan(300)
    expect(best.excludedByBlackout).toBeGreaterThanOrEqual(8)
    expect(best.daysOffKnown).toBe(true)
    expect(best.top[0]).toMatchObject({ startDate: '2026-10-03', endDate: '2026-10-10', crowdAverage: 1, blackouts: [] })
    expect(best.top[0]!.reasons[0]).toBe('quiet (1 avg)')
    expect(best.top[0]!.reasons.some((r) => /your current dates/.test(r))).toBe(true)
    expect(best.top.some((c) => c.startDate === '2027-06-12')).toBe(false)
    expect(best.top.some((c) => c.crowdAverage === 10)).toBe(false)
    expect(best.top.some((c) => c.kind === 'long_weekend')).toBe(true)
    // The whole view carries the same list and the settings behind it.
    const view = (await engine.tripPlanView(tripId))!
    expect(view.bestWeeks.top[0]!.startDate).toBe('2026-10-03')
    expect(view.horizonMonths).toBe(10)
    expect(view.weekWeights).toEqual({ busy: 3, price: 2, school: 1 })
    await engine.setWeekWeights({ busy: 0, price: 0, school: 5 })
    expect((await engine.tripPlanView(tripId))!.weekWeights).toEqual({ busy: 0, price: 0, school: 5 })
    await expect(engine.setWeekWeights({ busy: 0, price: 0, school: 0 })).rejects.toThrow(/above zero/)
    await engine.setWeekWeights({ busy: 3, price: 2, school: 1 })
    await engine.setBlackoutDates([])
  })

  it('"Use these dates" moves a same-length window whole and sets both ends for a long weekend', async () => {
    await engine.useDates(tripId, { startDate: '2026-10-03', endDate: '2026-10-10' })
    let trip = (await engine.listTrips()).find((t) => t.id === tripId)!
    expect([trip.startDate, trip.endDate]).toEqual(['2026-10-03', '2026-10-10'])
    await engine.useDates(tripId, { startDate: '2027-02-12', endDate: '2027-02-15' })
    trip = (await engine.listTrips()).find((t) => t.id === tripId)!
    expect([trip.startDate, trip.endDate]).toEqual(['2027-02-12', '2027-02-15'])
    expect((await engine.listTripDays(tripId)).map((d) => d.date)).toEqual(['2027-02-12', '2027-02-13', '2027-02-14', '2027-02-15'])
    await expect(other.useDates(tripId, { startDate: '2027-02-12', endDate: '2027-02-15' })).rejects.toThrow(EngineError)
  })

  it('DVC listings are held from a broker page, kept as dated facts, read back for the trip, and seen again update in place', async () => {
    const page = `<script type="application/json">${JSON.stringify([
      { resort: 'Bay Lake Tower', room: 'Deluxe Studio', checkIn: '2027-02-12', nights: 3, points: 60, price: '$1,140.00' },
      { resort: 'Polynesian', room: 'Deluxe Studio', checkIn: '2027-02-10', nights: 4, points: 90, price: 1710 },
      { resort: 'Elsewhere', room: 'Studio', checkIn: '2027-08-01', nights: 3, points: 50, price: 950 },
    ])}</script>`
    const fake = (async () => new Response(page)) as unknown as typeof fetch
    expect(await engine.checkDvcListings(tripId, { fallbackToReader: false, fetchImpl: fake })).toEqual({ ok: true, count: 2 })
    const pending = await engine.pendingDvcPull()
    expect(pending).toMatchObject({ source: 'dvc_rental_store', label: 'DVC Rental Store', from: '2027-02-10', to: '2027-02-17', seenOn: TODAY })
    expect(pending!.listings).toHaveLength(2)
    expect(await engine.dvcListings('2027-01-01', '2027-12-31')).toEqual([])
    expect(await engine.keepDvcPull()).toBe(2)
    expect(await engine.pendingDvcPull()).toBeNull()
    const view = (await engine.tripPlanView(tripId))!
    expect(view.dvcListings.map((l) => `${l.checkIn} ${l.resort} ${l.priceCents}`)).toEqual(['2027-02-10 Polynesian 171000', '2027-02-12 Bay Lake Tower 114000'])
    expect(view.dvcListings[0]).toMatchObject({ source: 'dvc_rental_store', sourceUrl: expect.stringContaining('dvcrentalstore.com'), seenOn: TODAY })
    // The same room seen again at a new price: one row, the new price.
    await engine.recordDvcListings([{ resort: 'Bay Lake Tower', room: 'Deluxe Studio', checkIn: '2027-02-12', nights: 3, points: 60, priceCents: 120000 }], { source: 'dvc_rental_store', sourceUrl: 'https://dvcrentalstore.com/x', seenOn: '2026-09-26' })
    const rows = await engine.dvcListings('2027-02-12', '2027-02-12')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ priceCents: 120000, seenOn: '2026-09-26' })
    // The lodging line is untouched: a listing is a fact beside it, never the line.
    const lodging = view.variant!.lines.find((l) => l.category === 'lodging')!
    expect(lodging.source).not.toBe('fetched')
    const log = (await events('trip_changed')).filter((e) => (e.payload as { dvc_listings?: unknown }).dvc_listings)
    expect(log.length).toBe(2)
    await expect(engine.recordDvcListings([{ resort: 'X', room: 'Y', checkIn: '2027-02-12', nights: 0, points: null, priceCents: null }], { source: 's', sourceUrl: 'https://x', seenOn: TODAY })).rejects.toThrow(/nights/)
  })

  it('a broker page that reads as nothing asks the reader only with the fallback, and what it read is kept with "read:<model>"', async () => {
    const login = (async () => new Response('<html>Please sign in</html>')) as unknown as typeof fetch
    let readerCalls = 0
    const read = (async () => {
      readerCalls += 1
      return {
        ok: true as const,
        value: { listings: [{ resort: 'Riviera', room: 'Tower Studio', checkIn: '2027-02-13', nights: 2, points: 40, priceCents: 76000 }, { resort: 'Far', room: 'Studio', checkIn: '2027-09-01', nights: 2, points: 40, priceCents: 76000 }] },
        model: 'test/model',
        sourceUrl: null,
        chars: 1,
      }
    }) as unknown as typeof readStructured
    const nothing = await engine.checkDvcListings(tripId, { fallbackToReader: false, fetchImpl: login, read, env: readerEnv })
    expect(nothing).toEqual({
      ok: false,
      notes: ['DVC Rental Store: Nothing on the page read as a list of DVC rooms.', 'DVC Rental Store confirmed reservations: Nothing on the page read as a list of DVC rooms.'],
    })
    expect(readerCalls).toBe(0)
    expect(await engine.checkDvcListings(tripId, { fallbackToReader: true, fetchImpl: login, read, env: {} })).toMatchObject({ ok: false, notes: expect.arrayContaining(['Add a reader key in the environment to read pages the app cannot.']) })
    expect(readerCalls).toBe(0)
    expect(await engine.checkDvcListings(tripId, { fallbackToReader: true, fetchImpl: login, read, env: readerEnv })).toEqual({ ok: true, count: 1 })
    expect(readerCalls).toBe(1)
    expect(await engine.pendingDvcPull()).toMatchObject({ source: 'read:test/model', listings: [{ resort: 'Riviera', checkIn: '2027-02-13' }] })
    expect(await engine.keepDvcPull()).toBe(1)
    expect((await engine.dvcListings('2027-02-13', '2027-02-13'))[0]).toMatchObject({ source: 'read:test/model', resort: 'Riviera' })
    await expect(other.checkDvcListings(tripId, { fallbackToReader: false, fetchImpl: login })).rejects.toThrow(EngineError)
  })
})
