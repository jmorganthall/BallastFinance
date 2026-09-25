/**
 * Planning a trip, against a real database (PRD §16 D22-D24): the days come
 * with the trip and follow its dates, the timeline is generated and never
 * overwrites what a person did, a reservation counts against a part of the
 * trip, crowd levels are kept and read, home is an address found on the map
 * once, another household sees none of it, and the home screen lists the
 * next to-dos.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, EngineError } from '@/server/engine'
import { geocodeAddress, resetGeocoder } from '@/server/trip-fetch'
import { type Traveler } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('planning a trip', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let otherHouseholdId: string
  let engine: Engine
  let other: Engine
  let tripId: string
  let variantId: string
  const TODAY = '2026-09-25'
  const travelers: Traveler[] = [
    { name: 'Josh', band: 'adult' },
    { name: 'Sam', band: 'adult' },
    { name: 'Ada', band: 'child' },
  ]

  const events = (kind: 'trip_changed') =>
    db.select().from(schema.events).where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, kind)))

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Plans ${crypto.randomUUID()}` }).returning()
    const [neighbour] = await db.insert(schema.households).values({ name: `Other ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    otherHouseholdId = neighbour!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    other = new Engine({ householdId: otherHouseholdId, actorUserId: null, db, today: TODAY })
    await db.delete(schema.crowdLevels).where(eq(schema.crowdLevels.destination, 'wdw'))
  })

  afterAll(async () => {
    for (const id of [householdId, otherHouseholdId].filter(Boolean)) {
      await db.delete(schema.trips).where(eq(schema.trips.householdId, id))
    }
    await db.delete(schema.crowdLevels).where(eq(schema.crowdLevels.destination, 'wdw'))
    await client?.end()
  })

  it('home is an address, found on the map once from the geocoder and stored with the point and name', async () => {
    resetGeocoder()
    const fake = (async () =>
      new Response(JSON.stringify([{ lat: '41.8781136', lon: '-87.6297982', display_name: 'Chicago, Cook County, Illinois, United States' }]))) as unknown as typeof fetch
    const geocode = await geocodeAddress('233 S Wacker Dr, Chicago, IL', fake, { now: () => 0, sleep: async () => {} })
    const home = await engine.setHomeAddress({ address: '233 S Wacker Dr, Chicago, IL', geocode, geocodedOn: TODAY })
    expect(home).toEqual({
      label: '233 S Wacker Dr',
      address: '233 S Wacker Dr, Chicago, IL',
      latitude: 41.8781136,
      longitude: -87.6297982,
      resolvedName: 'Chicago, Cook County, Illinois, United States',
      geocodedOn: TODAY,
    })
    expect(await engine.homeLocation()).toEqual(home)
  })

  it('a failed lookup keeps the address with no point, and a trip made then cannot measure the drive until it resolves', async () => {
    await engine.setHomeAddress({ address: 'Nowhere Lane', geocode: null, geocodedOn: TODAY })
    expect(await engine.homeLocation()).toMatchObject({ address: 'Nowhere Lane', latitude: null, longitude: null, resolvedName: null, geocodedOn: null })
    const trip = await engine.createTrip({ name: 'Disney 2027', startDate: '2027-06-12', endDate: '2027-06-18', travelers, car: { mpg: 25, seats: 7 } })
    tripId = trip.id
    expect(trip.home).toMatchObject({ address: 'Nowhere Lane', latitude: null })
    await expect(engine.recordDriveEstimate(tripId, { miles: 1_000, minutes: 900, fetchedOn: TODAY })).rejects.toThrow('not been found on the map')

    // A second try that works reaches the open trip.
    await engine.setHomeAddress({ address: '233 S Wacker Dr, Chicago, IL', geocode: { latitude: 41.8781136, longitude: -87.6297982, resolvedName: 'Chicago' }, geocodedOn: TODAY })
    expect((await engine.tripView(tripId))!.trip.home).toMatchObject({ latitude: 41.8781136, address: '233 S Wacker Dr, Chicago, IL' })
    await engine.recordDriveEstimate(tripId, { miles: 1_102, minutes: 1_000, fetchedOn: TODAY })
    expect((await engine.tripView(tripId))!.drive).toMatchObject({ miles: 1_102 })
  })

  it('the days come with the trip, one per date, and are re-cut when the dates change, keeping what remains', async () => {
    let days = await engine.listTripDays(tripId)
    expect(days.map((d) => d.date)).toEqual(['2027-06-12', '2027-06-13', '2027-06-14', '2027-06-15', '2027-06-16', '2027-06-17', '2027-06-18'])
    expect(days.map((d) => d.park)).toEqual(['travel', 'rest', 'rest', 'rest', 'rest', 'rest', 'travel'])

    const sunday = days[1]!
    await engine.updateTripDay(tripId, sunday.id, { park: 'magic_kingdom', plan: { notes: 'Rope drop Tron', ropeDrop: true } })
    await engine.updateTrip(tripId, { startDate: '2027-06-13', endDate: '2027-06-20' })
    days = await engine.listTripDays(tripId)
    expect(days.map((d) => d.date)).toEqual(['2027-06-13', '2027-06-14', '2027-06-15', '2027-06-16', '2027-06-17', '2027-06-18', '2027-06-19', '2027-06-20'])
    expect(days[0]).toMatchObject({ id: sunday.id, park: 'magic_kingdom', plan: { notes: 'Rope drop Tron', ropeDrop: true }, sort: 0 })
    expect(days[7]).toMatchObject({ park: 'travel', sort: 7 })
    // The old last day was a travel day and stays as it was: a re-cut keeps rows, it does not re-guess them.
    expect(days.find((d) => d.date === '2027-06-18')?.park).toBe('travel')

    const dayEvents = (await events('trip_changed')).filter((e) => (e.payload as { day_id?: string }).day_id)
    expect(dayEvents.length).toBeGreaterThanOrEqual(3) // the plan change, one removed, two added
  })

  it('a trip from before days existed gets them on first read, without an event', async () => {
    const [row] = await db
      .insert(schema.trips)
      .values({ householdId, name: 'Old trip', startDate: '2027-03-01', endDate: '2027-03-03', travelers, createdAt: TODAY })
      .returning()
    const before = (await events('trip_changed')).length
    const days = await engine.listTripDays(row!.id)
    expect(days.map((d) => d.date)).toEqual(['2027-03-01', '2027-03-02', '2027-03-03'])
    expect((await events('trip_changed')).length).toBe(before)
    expect(await engine.listTripDays(row!.id)).toEqual(days)
  })

  it('the timeline is generated for the way the plan follows; a ticked or edited to-do survives a rebuild', async () => {
    let tasks = await engine.listTasks(tripId)
    // No way priced yet: only what every trip needs.
    expect(tasks.filter((t) => !t.key?.startsWith('pack:')).map((t) => t.key)).toEqual(['dining', 'tickets', 'memory_maker'])
    expect(tasks.find((t) => t.key === 'pack:ponchos')).toMatchObject({ kind: 'pack', dueOn: '2027-06-12', generated: true })

    const v = await engine.addVariant(tripId, {
      name: 'Fly, stay at Pop',
      choices: { travel: 'fly', lodging: 'disney_resort', lightningLane: 'multi_pass', dining: 'out_of_pocket', parkDays: 4 },
    })
    variantId = v.id
    tasks = await engine.listTasks(tripId)
    expect(tasks.find((t) => t.key === 'flights')).toMatchObject({ dueOn: '2027-02-13', kind: 'book' })
    expect(tasks.find((t) => t.key === 'lightning_lane')).toMatchObject({ dueOn: '2027-06-06' })
    expect(tasks.find((t) => t.key === 'resort_balance')).toMatchObject({ dueOn: '2027-05-14' })
    const tickets = tasks.find((t) => t.key === 'tickets')!
    const lines = (await engine.tripView(tripId))!.variants[0]!.lines
    expect(tickets.lineId).toBe(lines.find((l) => l.label === 'Park tickets, adults')!.id)

    // Tick one, edit another, add one of our own.
    await engine.tickTask(tripId, tasks.find((t) => t.key === 'dining')!.id)
    await engine.updateTask(tripId, tasks.find((t) => t.key === 'flights')!.id, { label: 'Book Southwest when the schedule opens', dueOn: '2027-01-15' })
    const own = await engine.addTask(tripId, { kind: 'buy', label: 'Ears for Ada', dueOn: '2027-06-01', link: 'https://example.com' })

    // Change the way: a rental now, no Lightning Lane. The timeline follows.
    await engine.updateVariant(tripId, variantId, { choices: { travel: 'fly', lodging: 'rental', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 4 } })
    tasks = await engine.listTasks(tripId)
    expect(tasks.find((t) => t.key === 'lightning_lane')).toBeUndefined()
    expect(tasks.find((t) => t.key === 'resort_balance')).toBeUndefined()
    expect(tasks.find((t) => t.key === 'rental_balance')).toMatchObject({ dueOn: '2027-04-14' })
    expect(tasks.find((t) => t.key === 'dining')).toMatchObject({ doneOn: TODAY, generated: true })
    expect(tasks.find((t) => t.key === 'flights')).toMatchObject({ label: 'Book Southwest when the schedule opens', dueOn: '2027-01-15', generated: false })
    expect(tasks.find((t) => t.id === own.id)).toMatchObject({ label: 'Ears for Ada', generated: false, key: null })

    await engine.untickTask(tripId, tasks.find((t) => t.key === 'dining')!.id)
    await engine.rebuildTimeline(tripId)
    tasks = await engine.listTasks(tripId)
    expect(tasks.find((t) => t.key === 'dining')).toMatchObject({ doneOn: null })
    expect(tasks.filter((t) => t.key === 'flights')).toHaveLength(1)
    await engine.removeTask(tripId, own.id)
    expect((await engine.listTasks(tripId)).find((t) => t.id === own.id)).toBeUndefined()
  })

  it('a reservation with a cost counts against the part of the trip it points at, never twice', async () => {
    const lines = (await engine.tripView(tripId))!.variants[0]!.lines
    const food = lines.find((l) => l.label === 'Food out of pocket')!
    const ohana = await engine.addReservation(tripId, {
      date: '2027-06-14',
      time: '18:30',
      kind: 'dining',
      name: "'Ohana",
      park: 'other',
      confirmation: 'WDW123',
      party: 3,
      perPersonCents: 6_500,
      lineId: food.id,
      note: null,
    })
    await engine.addReservation(tripId, { date: '2027-06-14', time: null, kind: 'lightning_lane', name: 'Tron', park: 'magic_kingdom', confirmation: null, party: 3, perPersonCents: 3_000, lineId: null, note: null })
    const plan = (await engine.tripPlanView(tripId))!
    expect(plan.money).toEqual({ countedIn: [{ lineId: food.id, cents: 19_500 }], uncountedCents: 9_000 })
    expect(plan.dayViews.find((d) => d.date === '2027-06-14')!.reservations.map((r) => r.name)).toEqual(["'Ohana", 'Tron'])

    await engine.updateReservation(tripId, ohana.id, { party: 4, time: '19:00' })
    expect((await engine.listReservations(tripId)).find((r) => r.id === ohana.id)).toMatchObject({ party: 4, time: '19:00', confirmation: 'WDW123' })

    // The parts are rebuilt when the choices change; a part that is still there keeps its id, so the pointer holds.
    await engine.updateVariant(tripId, variantId, { choices: { travel: 'fly', lodging: 'rental', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 3 } })
    const after = (await engine.tripView(tripId))!.variants[0]!.lines.find((l) => l.label === 'Food out of pocket')!
    expect(after.id).toBe(food.id)
    expect((await engine.listReservations(tripId)).find((r) => r.id === ohana.id)?.lineId).toBe(food.id)
    expect((await engine.tripPlanView(tripId))!.money.countedIn).toEqual([{ lineId: food.id, cents: 26_000 }])
    await expect(engine.addReservation(tripId, { ...ohana, lineId: crypto.randomUUID() })).rejects.toThrow(EngineError)
    await expect(engine.updateReservation(tripId, ohana.id, { time: '25:00' })).rejects.toThrow('hours and minutes')
  })

  it('crowd levels are kept per date, park and source, read for a range, and a typed level shows over a fetched one', async () => {
    const kept = await engine.recordCrowdLevels(
      [
        { date: '2027-06-14', park: 'magic_kingdom', level: 8 },
        { date: '2027-06-14', park: 'epcot', level: 4 },
        { date: '2027-06-14', park: 'animal_kingdom', level: 3 },
        { date: '2027-06-21', park: 'other', level: 2 },
      ],
      { destination: 'wdw', source: 'thrill_data', fetchedOn: '2026-08-01' },
    )
    expect(kept).toBe(4)
    // The same source again for a day replaces its own figure.
    await engine.recordCrowdLevels([{ date: '2027-06-14', park: 'magic_kingdom', level: 9 }], { destination: 'wdw', source: 'thrill_data', fetchedOn: TODAY })
    expect(await engine.crowdLevels('wdw', '2027-06-14', '2027-06-14')).toHaveLength(3)
    await engine.typeCrowdLevel(tripId, { date: '2027-06-14', park: 'magic_kingdom', level: 6 })

    // The 14th is a rest day until it is planned, so it shows the resort as a whole; then Magic Kingdom's own level.
    let plan = (await engine.tripPlanView(tripId))!
    let monday = plan.dayViews.find((d) => d.date === '2027-06-14')!
    expect(monday.level).toBeNull()
    expect(monday.resortLevel).toBe(4) // (6 + 4 + 3) / 3 = 4.33
    await engine.updateTripDay(tripId, monday.day!.id, { park: 'magic_kingdom' })
    plan = (await engine.tripPlanView(tripId))!
    monday = plan.dayViews.find((d) => d.date === '2027-06-14')!
    expect(monday.level).toMatchObject({ level: 6, source: 'typed' })
    expect(monday.quietest).toEqual({ park: 'animal_kingdom', level: 3 })
    const current = plan.weeks.find((w) => w.current)!
    // Park days are the 13th (no data) and the 14th; every other day is rest or travel.
    expect(current.crowd).toEqual({ average: 4.3, worst: 5, daysWithData: 1, parkDays: 2 })
    const next = plan.weeks.find((w) => w.offsetWeeks === 1)!
    expect(next.crowd).toEqual({ average: 2, worst: 2, daysWithData: 1, parkDays: 2 })
    await expect(engine.recordCrowdLevels([{ date: '2027-06-14', park: 'epcot', level: 11 }], { destination: 'wdw', source: 'typed', fetchedOn: TODAY })).rejects.toThrow()
  })

  it('a pull is held for a look, then kept or dropped', async () => {
    await engine.stashCrowdPull({ source: 'undercover_tourist', label: 'Undercover Tourist', destination: 'wdw', months: ['2027-06'], levels: [{ date: '2027-06-15', park: 'epcot', level: 5 }], fetchedOn: TODAY, notes: [] })
    expect((await engine.tripPlanView(tripId))!.pendingPull?.levels).toHaveLength(1)
    expect(await engine.crowdLevels('wdw', '2027-06-15', '2027-06-15')).toEqual([])
    expect(await engine.keepCrowdPull()).toBe(1)
    expect(await engine.pendingCrowdPull()).toBeNull()
    expect(await engine.crowdLevels('wdw', '2027-06-15', '2027-06-15')).toMatchObject([{ park: 'epcot', level: 5, source: 'undercover_tourist' }])
    await expect(engine.keepCrowdPull()).rejects.toThrow(EngineError)
  })

  it('"use this week" moves the days and the unconfirmed reservations, and leaves a confirmed booking on its date', async () => {
    await engine.setBlackoutDates([{ from: '2027-06-20', to: '2027-06-26', label: 'Camp' }])
    let plan = (await engine.tripPlanView(tripId))!
    expect(plan.weeks.find((w) => w.offsetWeeks === 1)!.blackouts).toEqual(['Camp'])
    await engine.shiftTrip(tripId, '2027-06-06')
    plan = (await engine.tripPlanView(tripId))!
    expect(plan.trip).toMatchObject({ startDate: '2027-06-06', endDate: '2027-06-13' })
    expect(plan.days.map((d) => d.date)[0]).toBe('2027-06-06')
    expect(plan.days[0]).toMatchObject({ park: 'magic_kingdom', plan: { ropeDrop: true } })
    expect(plan.reservations.map((r) => [r.name, r.date])).toEqual([
      ['Tron', '2027-06-07'],
      ["'Ohana", '2027-06-14'],
    ])
    expect(plan.tasks.find((t) => t.key === 'rental_balance')).toMatchObject({ dueOn: '2027-04-07' })
    expect(plan.tasks.find((t) => t.key === 'pack:ponchos')).toMatchObject({ dueOn: '2027-06-05' })
  })

  it('the packing template is the household\'s, laid over the default, and reaches the to-dos on a rebuild', async () => {
    await engine.setPackTemplate(['Ponchos', 'Bubble wands'])
    await engine.rebuildTimeline(tripId)
    const pack = (await engine.listTasks(tripId)).filter((t) => t.kind === 'pack')
    expect(pack.map((t) => t.key).sort()).toEqual(['pack:bubble_wands', 'pack:ponchos'])
    await expect(engine.setPackTemplate([''])).resolves.toBeUndefined()
    expect(await engine.packTemplate()).toEqual([])
  })

  it('another household sees nothing and changes nothing', async () => {
    const day = (await engine.listTripDays(tripId))[0]!
    const task = (await engine.listTasks(tripId))[0]!
    const reservation = (await engine.listReservations(tripId))[0]!
    expect(await other.tripPlanView(tripId)).toBeNull()
    await expect(other.listTripDays(tripId)).rejects.toThrow(EngineError)
    await expect(other.listTasks(tripId)).rejects.toThrow(EngineError)
    await expect(other.listReservations(tripId)).rejects.toThrow(EngineError)
    await expect(other.updateTripDay(tripId, day.id, { park: 'epcot' })).rejects.toThrow(EngineError)
    await expect(other.tickTask(tripId, task.id)).rejects.toThrow(EngineError)
    await expect(other.removeReservation(tripId, reservation.id)).rejects.toThrow(EngineError)
    await expect(other.shiftTrip(tripId, '2027-07-03')).rejects.toThrow(EngineError)
    await expect(other.typeCrowdLevel(tripId, { date: '2027-06-14', park: 'epcot', level: 1 })).rejects.toThrow(EngineError)
    expect(await other.comingUpTripTasks()).toEqual([])
    // A day id from this trip under the other household's trip is refused too.
    const theirs = await other.createTrip({ name: 'Theirs', startDate: '2027-06-06', endDate: '2027-06-08', travelers, car: null })
    await expect(other.updateTripDay(theirs.id, day.id, { park: 'epcot' })).rejects.toThrow('No such day')
  })

  it('the home screen gets the next three undone to-dos across open trips, soonest first, with the trip name', async () => {
    const soon = await engine.createTrip({ name: 'Weekend', startDate: '2026-11-07', endDate: '2026-11-08', travelers, car: null })
    const coming = await engine.comingUpTripTasks(3)
    expect(coming).toHaveLength(3)
    expect(coming.map((t) => t.dueOn)).toEqual([...coming.map((t) => t.dueOn)].sort())
    expect(coming[0]).toMatchObject({ tripName: 'Weekend', key: 'dining', dueOn: '2026-09-08' })
    expect(coming.every((t) => t.tripId === soon.id)).toBe(true)
    await engine.retireTrip(soon.id)
    expect((await engine.comingUpTripTasks(3)).every((t) => t.tripId === tripId)).toBe(true)
    await expect(engine.tickTask(soon.id, coming[0]!.id)).rejects.toThrow('put away')
  })

  it('a trip that is a plan is still planned: days, reservations and to-dos go on; the money does not', async () => {
    const account = await engine.createReserveAccount({ name: 'Vacation', institutionLabel: 'Cap One' })
    const lines = (await engine.tripView(tripId))!.variants[0]!.lines
    await engine.updateTripLine(tripId, lines.find((l) => l.label === 'Flights, each person')!.id, { unitAmountCents: 30_000 })
    const sent = await engine.sendVariantToPlans(tripId, variantId, { defaultAccountId: account.id })
    expect(sent.ok).toBe(true)
    const day = (await engine.listTripDays(tripId))[2]!
    await engine.updateTripDay(tripId, day.id, { park: 'epcot' })
    expect((await engine.listTripDays(tripId))[2]!.park).toBe('epcot')
    await engine.addTask(tripId, { kind: 'do', label: 'Print the confirmations', dueOn: '2027-06-05' })
    await expect(engine.updateTrip(tripId, { name: 'Renamed' })).rejects.toThrow('a plan now')
    await expect(engine.shiftTrip(tripId, '2027-07-03')).rejects.toThrow('a plan now')
  })
})
