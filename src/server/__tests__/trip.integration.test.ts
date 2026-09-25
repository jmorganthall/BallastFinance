/**
 * Trip planner acceptance (PRD §16): a trip is priced from stated figures and
 * the household's usual ones, each way of doing it is priced side by side,
 * and "Add to Plans" makes a package through the intake contract with the
 * trip module's name on it -- then the trip is read-only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine, EngineError } from '@/server/engine'
import { headlineDueDate, lineItemTotalCents, variantPrice, type Traveler } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('the trip planner', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let otherHouseholdId: string
  let engine: Engine
  let other: Engine
  let vacationAccountId: string
  let tripId: string
  let driveVariantId: string
  let flyVariantId: string
  const TODAY = '2026-09-25'
  const travelers: Traveler[] = [
    { name: 'Josh', band: 'adult' },
    { name: 'Sam', band: 'adult' },
    { name: 'Ada', band: 'child' },
    { name: 'Bo', band: 'infant' },
  ]

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db.insert(schema.households).values({ name: `Trips ${crypto.randomUUID()}` }).returning()
    const [neighbour] = await db.insert(schema.households).values({ name: `Other ${crypto.randomUUID()}` }).returning()
    householdId = household!.id
    otherHouseholdId = neighbour!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    other = new Engine({ householdId: otherHouseholdId, actorUserId: null, db, today: TODAY })
    vacationAccountId = (await engine.createReserveAccount({ name: 'Vacation', institutionLabel: 'Cap One' })).id
    await engine.setHomeLocation({ label: 'Home', latitude: 41.8781, longitude: -87.6298 })
  })

  afterAll(async () => {
    for (const id of [householdId, otherHouseholdId].filter(Boolean)) {
      await db.delete(schema.trips).where(eq(schema.trips.householdId, id))
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, id))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, id))
    }
    await client?.end()
  })

  it('starts a trip with home copied in, and prices two ways of doing it from the usual figures', async () => {
    const trip = await engine.createTrip({
      name: 'Disney 2027',
      startDate: '2027-06-12',
      endDate: '2027-06-18',
      travelers,
      car: { mpg: 25, seats: 7 },
    })
    tripId = trip.id
    expect(trip.home).toEqual({ label: 'Home', latitude: 41.8781, longitude: -87.6298 })
    expect(trip.packageId).toBeNull()

    const drive = await engine.addVariant(tripId, {
      name: 'Drive, stay at Pop',
      choices: { travel: 'drive', lodging: 'disney_resort', lightningLane: 'multi_pass', dining: 'out_of_pocket', parkDays: 4 },
    })
    const fly = await engine.addVariant(tripId, {
      name: 'Fly, rent a house',
      choices: { travel: 'fly', lodging: 'rental', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 4 },
    })
    driveVariantId = drive.id
    flyVariantId = fly.id

    const view = (await engine.tripView(tripId))!
    expect(view.variants.map((v) => v.name)).toEqual(['Drive, stay at Pop', 'Fly, rent a house'])
    const [d, f] = view.variants
    // The usual figures alone: tickets 8 x 119 + 4 x 114, LL 12 x 30, food 21 x 75, photos 185, souvenirs 3 x 100.
    expect(d!.price.partsCents).toBe(95_200 + 45_600 + 36_000 + 157_500 + 18_500 + 30_000)
    expect(d!.price).toEqual(variantPrice(d!.lines, 1000))
    expect(d!.firstMoneyDue).toBe(headlineDueDate(d!.lines, view.bufferCents, '2027-06-12'))
    expect(d!.firstMoneyDue).toBe('2027-04-13') // the tickets, 60 days before
    expect(f!.lines.find((l) => l.label === 'Theme-park parking')).toBeUndefined()
    expect(f!.lines.find((l) => l.label === 'Airport rides, each way')?.quantity).toBe(2)
  })

  it('a typed figure is kept as typed and dated today, and survives a change of choices', async () => {
    const view = (await engine.tripView(tripId))!
    const room = view.variants[0]!.lines.find((l) => l.label === 'Disney resort room, per night')!
    await engine.updateTripLine(tripId, room.id, { unitAmountCents: 28_000, note: 'Pop Century, standard' })
    let after = (await engine.tripView(tripId))!.variants[0]!.lines.find((l) => l.label === 'Disney resort room, per night')!
    expect(after).toMatchObject({ unitAmountCents: 28_000, source: 'typed', asOf: TODAY, quantity: 6 })

    // Changing a choice rebuilds the parts; the typed room survives, and the added part too.
    await engine.addTripLine(tripId, driveVariantId, { category: 'travel', label: 'Car wash before we go', quantity: 1, unitAmountCents: 2_000, dueDate: '2027-06-10' })
    await engine.updateVariant(tripId, driveVariantId, {
      choices: { travel: 'drive', lodging: 'disney_resort', lightningLane: 'premier', dining: 'plan', parkDays: 4 },
    })
    const lines = (await engine.tripView(tripId))!.variants[0]!.lines
    after = lines.find((l) => l.label === 'Disney resort room, per night')!
    expect(after).toMatchObject({ unitAmountCents: 28_000, source: 'typed', note: 'Pop Century, standard' })
    expect(lines.find((l) => l.label === 'Lightning Lane Premier Pass')).toMatchObject({ quantity: 12, unitAmountCents: 25_000 })
    expect(lines.find((l) => l.label === 'Dining plan, adults')).toMatchObject({ quantity: 12, unitAmountCents: 6_047 })
    expect(lines.find((l) => l.label === 'Car wash before we go')).toMatchObject({ unitAmountCents: 2_000, source: 'typed' })

    const changes = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'trip_changed')))
    expect(changes.length).toBeGreaterThanOrEqual(5) // trip, two variants, a line, an added line, a variant change
  })

  it('a looked-up drive prices the fuel and offers a hotel on the way; a typed fuel figure is never overwritten', async () => {
    await engine.recordGasPrice({ centsPerGallon: 305, observationDate: '2026-09-21' })
    await engine.recordDriveEstimate(tripId, { miles: 1_102, minutes: 1_000, fetchedOn: TODAY })
    let lines = (await engine.tripView(tripId))!.variants[0]!.lines
    // 2204 / 25 = 88.16 -> 89 gallons x $3.05 = $271.45 -> $272
    expect(lines.find((l) => l.label === 'Fuel, there and back')).toMatchObject({ unitAmountCents: 27_200, source: 'fetched' })
    expect(lines.find((l) => l.label === 'Hotel on the way, each way')).toMatchObject({ quantity: 2, unitAmountCents: 15_000 })

    const fuel = lines.find((l) => l.label === 'Fuel, there and back')!
    await engine.updateTripLine(tripId, fuel.id, { unitAmountCents: 30_000 })
    await engine.recordGasPrice({ centsPerGallon: 400, observationDate: '2026-09-28' })
    lines = (await engine.tripView(tripId))!.variants[0]!.lines
    expect(lines.find((l) => l.label === 'Fuel, there and back')).toMatchObject({ unitAmountCents: 30_000, source: 'typed' })
    expect((await engine.tripView(tripId))!.drive).toEqual({ miles: 1_102, minutes: 1_000, fetchedOn: TODAY })
  })

  it("a deal keeps what it applies to when its date is changed, and an added part with a default's name is not doubled", async () => {
    const dealVariant = await engine.addVariant(tripId, {
      name: 'Fly, with the room offer',
      choices: {
        travel: 'fly',
        lodging: 'disney_resort',
        lightningLane: 'none',
        dining: 'out_of_pocket',
        parkDays: 3,
        promotion: { name: 'Room offer', percentOffBasisPoints: 2_500, appliesToCategory: 'lodging', bookBy: '2027-03-01' },
      },
    })
    let lines = (await engine.tripView(tripId))!.variants.find((v) => v.id === dealVariant.id)!.lines
    const deal = lines.find((l) => l.category === 'promotion')!
    expect(deal.note).toBe('applies:lodging')
    await engine.updateTripLine(tripId, deal.id, { dueDate: '2027-02-01', note: '' })
    lines = (await engine.tripView(tripId))!.variants.find((v) => v.id === dealVariant.id)!.lines
    expect(lines.find((l) => l.category === 'promotion')).toMatchObject({ dueDate: '2027-02-01', note: 'applies:lodging' })

    await engine.addTripLine(tripId, dealVariant.id, { category: 'souvenirs', label: 'Souvenirs', quantity: 1, unitAmountCents: 5_000, dueDate: '2027-06-12' })
    await engine.updateVariant(tripId, dealVariant.id, { choices: { ...dealVariant.choices, parkDays: 2 } })
    lines = (await engine.tripView(tripId))!.variants.find((v) => v.id === dealVariant.id)!.lines
    const souvenirs = lines.filter((l) => l.label === 'Souvenirs')
    expect(souvenirs).toHaveLength(2)
    expect(souvenirs.map((l) => l.unitAmountCents).sort((a, b) => a - b)).toEqual([5_000, 10_000])
    await engine.removeVariant(tripId, dealVariant.id)
  })

  it("another household cannot see or change this trip", async () => {
    expect(await other.tripView(tripId)).toBeNull()
    await expect(other.updateTrip(tripId, { name: 'Theirs' })).rejects.toThrow(EngineError)
    await expect(other.addVariant(tripId, { name: 'x', choices: { travel: 'fly', lodging: 'rental', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 1 } })).rejects.toThrow(EngineError)
    await expect(other.sendVariantToPlans(tripId, driveVariantId, { defaultAccountId: vacationAccountId })).rejects.toThrow(EngineError)
    expect(await other.listTrips()).toEqual([])
  })

  it('Add to Plans makes a package through intake, records the send, and makes the trip read-only', async () => {
    const before = (await engine.tripView(tripId))!.variants.find((v) => v.id === driveVariantId)!
    const result = await engine.sendVariantToPlans(tripId, driveVariantId, { defaultAccountId: vacationAccountId })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const pkg = (await engine.listPackages()).find((p) => p.id === result.packageId)!
    expect(pkg).toMatchObject({ name: 'Disney 2027 — Drive, stay at Pop', module: 'trip', state: 'simulated', detail: { trip_id: tripId, variant_id: driveVariantId } })
    const items = (await engine.listLineItems()).filter((i) => i.packageId === pkg.id)
    expect(items.reduce((sum, i) => sum + lineItemTotalCents(i), 0)).toBe(before.price.totalCents)
    expect(items.every((i) => i.reserveAccountId === vacationAccountId)).toBe(true)
    expect(items.map((i) => i.label)).toContain('Cushion')
    expect(items.map((i) => i.label)).toContain('Car wash before we go')
    expect(items.find((i) => i.label === 'Disney resort room, per night')).toMatchObject({ quantity: 6, unitAmountCents: 28_000, dueDate: '2027-05-13' })
    // A part that costs nothing is not in the plan.
    expect(items.find((i) => i.label === 'Tolls, each way')).toBeUndefined()

    const trip = (await engine.tripView(tripId))!.trip
    expect(trip).toMatchObject({ packageId: pkg.id, chosenVariantId: driveVariantId, sentOn: TODAY })

    const sent = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, 'trip_sent')))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toEqual({ trip_id: tripId, variant_id: driveVariantId, package_id: pkg.id })

    // From here on the plan is the truth.
    const room = before.lines.find((l) => l.label === 'Disney resort room, per night')!
    await expect(engine.updateTripLine(tripId, room.id, { unitAmountCents: 1 })).rejects.toThrow('a plan now')
    await expect(engine.sendVariantToPlans(tripId, flyVariantId, { defaultAccountId: vacationAccountId })).rejects.toThrow('a plan already')
    await expect(engine.updateTrip(tripId, { name: 'Renamed' })).rejects.toThrow(EngineError)

    // The weekly number comes from the same what-if as any other draft.
    expect((await engine.whatIf(pkg.id)).length).toBeGreaterThan(0)
  })

  it('a send with nothing priced is refused by intake with problems, not a crash', async () => {
    const empty = await engine.createTrip({ name: 'Someday', startDate: '2027-01-02', endDate: '2027-01-02', travelers: [{ name: 'Bo', band: 'infant' }], car: null })
    const v = await engine.addVariant(empty.id, { name: 'Just looking', choices: { travel: 'fly', lodging: 'rental', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 0 } })
    // Airport rides and parking still price from the usual figures; clear them so nothing is left.
    for (const line of (await engine.tripView(empty.id))!.variants[0]!.lines) {
      await engine.updateTripLine(empty.id, line.id, { unitAmountCents: 0 })
    }
    const result = await engine.sendVariantToPlans(empty.id, v.id, { defaultAccountId: vacationAccountId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.message).toContain('at least one line item')
    expect((await engine.tripView(empty.id))!.trip.packageId).toBeNull()
  })

  it('the usual figures can be changed by the household and flow into the next way of doing it', async () => {
    const prices = await engine.referencePrices()
    const adult = prices.find((p) => p.key === 'tickets_adult_per_day')!
    await engine.setReferencePrices(prices.map((p) => (p.key === adult.key ? { ...p, amountCents: 12_500, asOf: TODAY } : p)))
    expect((await engine.referencePrices()).find((p) => p.key === adult.key)?.amountCents).toBe(12_500)

    const trip = await engine.createTrip({ name: 'Disney 2028', startDate: '2028-03-04', endDate: '2028-03-08', travelers, car: null })
    await engine.addVariant(trip.id, { name: 'Fly', choices: { travel: 'fly', lodging: 'disney_resort', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 3 } })
    const lines = (await engine.tripView(trip.id))!.variants[0]!.lines
    expect(lines.find((l) => l.label === 'Park tickets, adults')).toMatchObject({ quantity: 6, unitAmountCents: 12_500 })

    await expect(engine.setReferencePrices([{ ...adult, key: 'Not A Key' }])).rejects.toThrow()
    await engine.retireTrip(trip.id)
    expect((await engine.listTrips()).find((t) => t.id === trip.id)?.retiredAt).toBe(TODAY)
    await expect(engine.addVariant(trip.id, { name: 'x', choices: { travel: 'fly', lodging: 'rental', lightningLane: 'none', dining: 'out_of_pocket', parkDays: 1 } })).rejects.toThrow('put away')
  })

  it('refuses what the database would never hold', async () => {
    await expect(engine.createTrip({ name: 'Backwards', startDate: '2027-06-12', endDate: '2027-06-11', travelers, car: null })).rejects.toThrow()
    await expect(engine.recordGasPrice({ centsPerGallon: 5, observationDate: TODAY })).rejects.toThrow()
    await expect(engine.recordDriveEstimate(tripId, { miles: 0, minutes: 1, fetchedOn: TODAY })).rejects.toThrow()
  })
})
