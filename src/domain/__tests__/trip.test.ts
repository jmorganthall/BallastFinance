/**
 * The trip planner's derivations (PRD §16). Every figure a person sees on the
 * trip screen is one of these, so each is pinned here without a database.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REFERENCE_PRICES,
  defaultLines,
  describeSource,
  driveSettingKey,
  fuelCents,
  headCount,
  headlineDueDate,
  keepTypedLines,
  lineTotalCents,
  mergeReferencePrices,
  midwayNightsEachWay,
  parseGasPriceCsv,
  parseOsrmRoute,
  promotionCents,
  referenceFreshness,
  toIntake,
  tripDays,
  tripNights,
  validateChoices,
  validateReferencePrices,
  validateTripInputs,
  variantPrice,
  vehiclesNeeded,
  TripDataError,
  type DefaultLine,
  type Trip,
  type TripLine,
  type TripVariant,
  type VariantChoices,
} from '../trip'
import { validateIntake, packageIntakeSchema } from '../intake'
import type { ReserveAccount } from '../types'

const TODAY = '2026-09-25'

const trip: Trip = {
  id: 'trip-1',
  householdId: 'hh',
  name: 'Disney 2027',
  destination: 'wdw',
  startDate: '2027-06-12',
  endDate: '2027-06-18', // 6 nights, 7 days
  travelers: [
    { name: 'Josh', band: 'adult' },
    { name: 'Sam', band: 'adult' },
    { name: 'Ada', band: 'child' },
    { name: 'Bo', band: 'infant' },
  ],
  home: { label: 'Home', latitude: 41.8781, longitude: -87.6298 },
  car: { mpg: 25, seats: 7 },
  chosenVariantId: null,
  packageId: null,
  sentOn: null,
  createdAt: TODAY,
  retiredAt: null,
}

const choices = (over: Partial<VariantChoices> = {}): VariantChoices => ({
  travel: 'drive',
  lodging: 'disney_resort',
  lightningLane: 'multi_pass',
  dining: 'out_of_pocket',
  parkDays: 4,
  ...over,
})

const variant = (over: Partial<VariantChoices> = {}): TripVariant => ({
  id: 'var-1',
  tripId: trip.id,
  name: 'Drive, stay at Pop',
  choices: choices(over),
  createdAt: TODAY,
})

const build = (over: Partial<VariantChoices> = {}, extra: Parameters<typeof defaultLines>[2] = { referencePrices: DEFAULT_REFERENCE_PRICES, today: TODAY }) =>
  defaultLines(trip, variant(over), extra)

const byLabel = (lines: readonly DefaultLine[], label: string) => {
  const line = lines.find((l) => l.label === label)
  if (!line) throw new Error(`no part called "${label}" in ${lines.map((l) => l.label).join(', ')}`)
  return line
}

const withIds = (lines: readonly DefaultLine[], variantId = 'var-1'): TripLine[] =>
  lines.map((l, i) => ({ ...l, id: `line-${i}`, variantId }))

describe('counting who and how long', () => {
  it('bands: adults and children are guests; infants take a seat but pay for nothing', () => {
    expect(headCount(trip.travelers)).toEqual({ adults: 2, children: 1, infants: 1, guests: 3, everyone: 4 })
  })

  it('nights and days: Friday to Sunday is 2 nights, 3 days', () => {
    expect(tripNights(trip)).toBe(6)
    expect(tripDays(trip)).toBe(7)
    expect(tripNights({ startDate: '2027-01-01', endDate: '2027-01-01' })).toBe(0)
  })

  it('four to a car for the airport ride', () => {
    expect(vehiclesNeeded(1)).toBe(1)
    expect(vehiclesNeeded(4)).toBe(1)
    expect(vehiclesNeeded(5)).toBe(2)
  })
})

describe('fuel', () => {
  it('buys whole gallons and rounds up to the dollar, never under-funding a fill-up', () => {
    // 2204 miles / 25 mpg = 88.16 -> 89 gallons x $3.05 = $271.45 -> $272
    expect(fuelCents({ roundTripMiles: 2204, mpg: 25, centsPerGallon: 305 })).toBe(27_200)
    // Exact gallons, exact dollars: no rounding added.
    expect(fuelCents({ roundTripMiles: 250, mpg: 25, centsPerGallon: 300 })).toBe(3_000)
  })

  it('refuses a car with no mileage', () => {
    expect(() => fuelCents({ roundTripMiles: 100, mpg: 0, centsPerGallon: 300 })).toThrow(TripDataError)
  })

  it('offers a hotel on the way only past the household limit', () => {
    expect(midwayNightsEachWay(540)).toBe(0)
    expect(midwayNightsEachWay(600)).toBe(0)
    expect(midwayNightsEachWay(601)).toBe(1)
    expect(midwayNightsEachWay(1300)).toBe(2)
    expect(midwayNightsEachWay(700, 400)).toBe(1)
  })
})

describe('the price tag', () => {
  const lines: DefaultLine[] = [
    { category: 'lodging', label: 'Room', quantity: 6, unitAmountCents: 30_000, dueDate: '2027-05-13', reserveAccountId: null, source: 'typed', asOf: TODAY, note: null, sort: 0 },
    { category: 'tickets', label: 'Tickets', quantity: 8, unitAmountCents: 11_900, dueDate: '2027-04-13', reserveAccountId: null, source: 'quote', asOf: TODAY, note: null, sort: 1 },
  ]

  it('adds the parts, the cushion rounded up to the dollar, and rounds the whole to the dollar', () => {
    const price = variantPrice(lines, 1000)
    expect(price.partsCents).toBe(180_000 + 95_200)
    expect(price.promotionCents).toBe(0)
    expect(price.cushionCents).toBe(27_600) // 10% of $2,752 is $275.20 -> $276
    expect(price.totalCents).toBe(275_200 + 27_600)
  })

  it('caps a deal at what it applies to, and applies it before the cushion', () => {
    const deal: DefaultLine = { category: 'promotion', label: '30% off rooms', quantity: 1, unitAmountCents: -54_000, dueDate: '2026-12-01', reserveAccountId: null, source: 'typed', asOf: TODAY, note: 'applies:lodging', sort: 2 }
    expect(promotionCents([...lines, deal])).toBe(-54_000)
    const price = variantPrice([...lines, deal], 1000)
    expect(price.promotionCents).toBe(-54_000)
    expect(price.cushionCents).toBe(22_200) // 10% of $2,212 -> $221.20 -> $222
    expect(price.totalCents).toBe(221_200 + 22_200)

    const tooBig = { ...deal, unitAmountCents: -999_999 }
    expect(promotionCents([...lines, tooBig])).toBe(-180_000) // never more than the rooms
    // A deal with no part to apply to takes nothing off.
    expect(promotionCents([lines[1]!, deal])).toBe(0)
  })

  it('a typed cushion replaces the percent', () => {
    const cushion: DefaultLine = { category: 'contingency', label: 'Cushion', quantity: 1, unitAmountCents: 50_050, dueDate: '2027-06-12', reserveAccountId: null, source: 'typed', asOf: TODAY, note: null, sort: 3 }
    const price = variantPrice([...lines, cushion], 1000)
    expect(price.cushionCents).toBe(50_050)
    expect(price.totalCents).toBe(275_200 + 50_100) // whole rounded up to the dollar
  })

  it('a trip with nothing typed yet costs nothing', () => {
    expect(variantPrice([], 1000)).toEqual({ partsCents: 0, promotionCents: 0, cushionCents: 0, totalCents: 0 })
  })
})

describe('first money due', () => {
  const lines = [
    { category: 'travel' as const, label: 'Parking', quantity: 4, unitAmountCents: 3_500, dueDate: '2027-01-01' },
    { category: 'tickets' as const, label: 'Tickets', quantity: 8, unitAmountCents: 11_900, dueDate: '2027-04-13' },
    { category: 'lodging' as const, label: 'Room', quantity: 6, unitAmountCents: 30_000, dueDate: '2027-05-13' },
    { category: 'promotion' as const, label: 'Deal', quantity: 1, unitAmountCents: -50_000, dueDate: '2026-10-01' },
  ]

  it('is the earliest date among parts worth more than the buffer; small parts and deals do not count', () => {
    expect(headlineDueDate(lines, 35_000, '2027-06-12')).toBe('2027-04-13')
    expect(headlineDueDate(lines, 10_000, '2027-06-12')).toBe('2027-01-01')
    expect(headlineDueDate(lines, 1_000_000, '2027-06-12')).toBe('2027-06-12')
    expect(headlineDueDate([], 0, '2027-06-12')).toBe('2027-06-12')
  })
})

describe('the default parts', () => {
  it('driving to a Disney resort: fuel and tolls to type, no theme-park parking, tickets by band, infants pay for nothing', () => {
    const lines = build()
    expect(byLabel(lines, 'Fuel, there and back')).toMatchObject({ category: 'travel', quantity: 1, unitAmountCents: 0, source: 'typed', dueDate: trip.startDate })
    expect(byLabel(lines, 'Tolls, each way').quantity).toBe(2)
    expect(lines.find((l) => l.label === 'Theme-park parking')).toBeUndefined()
    expect(lines.find((l) => l.label === 'Hotel on the way, each way')).toBeUndefined()

    expect(byLabel(lines, 'Disney resort room, per night')).toMatchObject({ quantity: 6, unitAmountCents: 0, dueDate: '2027-05-13' })
    expect(byLabel(lines, 'Park tickets, adults')).toMatchObject({ quantity: 8, unitAmountCents: 11_900, source: 'quote', dueDate: '2027-04-13' })
    expect(byLabel(lines, 'Park tickets, children')).toMatchObject({ quantity: 4, unitAmountCents: 11_400 })
    expect(byLabel(lines, 'Park Hopper add-on, each person').quantity).toBe(3)
    expect(byLabel(lines, 'Lightning Lane Multi Pass')).toMatchObject({ quantity: 12, unitAmountCents: 3_000, dueDate: trip.startDate })
    expect(byLabel(lines, 'Food out of pocket')).toMatchObject({ quantity: 21, unitAmountCents: 7_500, source: 'typed' })
    expect(byLabel(lines, 'Memory Maker')).toMatchObject({ quantity: 1, unitAmountCents: 18_500, dueDate: '2027-06-09' })
    expect(byLabel(lines, 'Souvenirs')).toMatchObject({ quantity: 3, unitAmountCents: 10_000 })
    expect(lines.find((l) => l.category === 'promotion')).toBeUndefined()
    expect(lines.find((l) => l.category === 'contingency')).toBeUndefined()
    expect(lines.map((l) => l.sort)).toEqual(lines.map((_, i) => i))
  })

  it('prices the fuel from the drive and the gas price, and adds a hotel on the way for a long drive', () => {
    const lines = build({}, {
      referencePrices: DEFAULT_REFERENCE_PRICES,
      today: TODAY,
      drive: { miles: 1_102, minutes: 1_000, fetchedOn: '2026-09-20' },
      gasPrice: { centsPerGallon: 305, observationDate: '2026-09-21' },
    })
    // 2204 miles / 25 = 88.16 -> 89 gallons x 3.05 = 271.45 -> $272
    expect(byLabel(lines, 'Fuel, there and back')).toMatchObject({ unitAmountCents: 27_200, source: 'fetched', asOf: '2026-09-20' })
    expect(byLabel(lines, 'Hotel on the way, each way')).toMatchObject({ quantity: 2, unitAmountCents: 15_000 })
  })

  it('drives with no car cannot price fuel, and a short drive has no hotel', () => {
    const lines = defaultLines({ ...trip, car: null }, variant(), {
      referencePrices: DEFAULT_REFERENCE_PRICES,
      today: TODAY,
      drive: { miles: 200, minutes: 300, fetchedOn: TODAY },
      gasPrice: { centsPerGallon: 305, observationDate: TODAY },
    })
    expect(byLabel(lines, 'Fuel, there and back')).toMatchObject({ unitAmountCents: 0, source: 'typed' })
    expect(lines.find((l) => l.label === 'Hotel on the way, each way')).toBeUndefined()
  })

  it('flying: a fare per person including the infant, bags, airport parking by the day, rides by the carload', () => {
    const lines = build({ travel: 'fly' })
    expect(byLabel(lines, 'Flights, each person')).toMatchObject({ quantity: 4, unitAmountCents: 0, dueDate: '2027-02-12' })
    expect(byLabel(lines, 'Checked bags').dueDate).toBe('2027-02-12')
    expect(byLabel(lines, 'Parking at our airport')).toMatchObject({ quantity: 7, unitAmountCents: 1_200 })
    expect(byLabel(lines, 'Airport rides, each way')).toMatchObject({ quantity: 2, unitAmountCents: 4_500 })
    expect(lines.find((l) => l.label.startsWith('Fuel'))).toBeUndefined()
  })

  it('five people need two cars from the airport', () => {
    const bigger = { ...trip, travelers: [...trip.travelers, { name: 'Cy', band: 'child' as const }] }
    const lines = defaultLines(bigger, variant({ travel: 'fly' }), { referencePrices: DEFAULT_REFERENCE_PRICES, today: TODAY })
    expect(byLabel(lines, 'Airport rides, each way').quantity).toBe(4)
  })

  it('a DVC rental is points to type, due at booking but no later than a month before', () => {
    const lines = build({ lodging: 'dvc_rental' })
    expect(byLabel(lines, 'DVC rental, per point')).toMatchObject({ quantity: 0, unitAmountCents: 2_200, dueDate: '2026-10-09' })
    // Theme-park parking applies when driving and not at a Disney resort.
    expect(byLabel(lines, 'Theme-park parking')).toMatchObject({ quantity: 4, unitAmountCents: 3_500 })

    const soon = defaultLines({ ...trip, startDate: '2026-10-20', endDate: '2026-10-24' }, variant({ lodging: 'dvc_rental', parkDays: 3 }), {
      referencePrices: DEFAULT_REFERENCE_PRICES,
      today: TODAY,
    })
    // A month before is already gone, so it is due tomorrow: the plan funds it from its first week.
    expect(byLabel(soon, 'DVC rental, per point').dueDate).toBe('2026-09-26')
  })

  it('a rental is half at booking and half sixty days before, plus fees', () => {
    const lines = build({ lodging: 'rental' })
    expect(byLabel(lines, 'Rental, half at booking, per night')).toMatchObject({ quantity: 6, dueDate: '2026-10-09' })
    expect(byLabel(lines, 'Rental, other half, per night')).toMatchObject({ quantity: 6, dueDate: '2027-04-13' })
    expect(byLabel(lines, 'Rental fees').dueDate).toBe('2026-10-09')
    expect(byLabel(lines, 'Theme-park parking').quantity).toBe(4)
    // No parking when flying to a rental: no car.
    const flown = build({ lodging: 'rental', travel: 'fly' })
    expect(flown.find((l) => l.label === 'Theme-park parking')).toBeUndefined()
  })

  it('Premier Pass replaces Multi Pass; none means neither', () => {
    expect(byLabel(build({ lightningLane: 'premier' }), 'Lightning Lane Premier Pass')).toMatchObject({ quantity: 12, unitAmountCents: 25_000 })
    expect(build({ lightningLane: 'premier' }).find((l) => l.label === 'Lightning Lane Multi Pass')).toBeUndefined()
    expect(build({ lightningLane: 'none' }).find((l) => l.category === 'lightning_lane')).toBeUndefined()
  })

  it('the dining plan is by night and band, only at a Disney resort; otherwise food is out of pocket by the day', () => {
    const plan = build({ dining: 'plan' })
    expect(byLabel(plan, 'Dining plan, adults')).toMatchObject({ quantity: 12, unitAmountCents: 6_047, dueDate: '2027-05-13' })
    expect(byLabel(plan, 'Dining plan, children')).toMatchObject({ quantity: 6, unitAmountCents: 2_616 })
    expect(plan.find((l) => l.label === 'Food out of pocket')).toBeUndefined()

    const offSite = build({ dining: 'plan', lodging: 'rental' })
    expect(offSite.find((l) => l.category === 'dining' && l.label.startsWith('Dining plan'))).toBeUndefined()
    expect(byLabel(offSite, 'Food out of pocket').quantity).toBe(21)
  })

  it('no park days: no tickets, no Lightning Lane, no theme-park parking', () => {
    const lines = build({ parkDays: 0, lodging: 'rental' })
    expect(lines.find((l) => l.category === 'tickets')).toBeUndefined()
    expect(lines.find((l) => l.category === 'lightning_lane')).toBeUndefined()
    expect(lines.find((l) => l.label === 'Theme-park parking')).toBeUndefined()
  })

  it('a percent deal is worked off the parts it applies to at build time; an amount deal is capped there too', () => {
    const percent = build({ promotion: { name: 'Summer 25% off', percentOffBasisPoints: 2_500, appliesToCategory: 'tickets', bookBy: '2027-03-01' } })
    const tickets = percent.filter((l) => l.category === 'tickets').reduce((s, l) => s + lineTotalCents(l), 0)
    expect(tickets).toBe(8 * 11_900 + 4 * 11_400)
    expect(byLabel(percent, 'Summer 25% off')).toMatchObject({
      category: 'promotion',
      unitAmountCents: -Math.floor(tickets / 4),
      dueDate: '2027-03-01',
      note: 'applies:tickets',
    })
    const amount = build({ promotion: { name: '$5,000 off rooms', amountOffCents: 500_000, appliesToCategory: 'lodging', bookBy: '2027-03-01' } })
    // Rooms are still $0 to type, so the deal can take nothing off yet.
    expect(byLabel(amount, '$5,000 off rooms').unitAmountCents).toBe(0)
  })

  it('refuses a usual figure it needs but cannot find', () => {
    expect(() => build({}, { referencePrices: [], today: TODAY })).toThrow(TripDataError)
  })
})

describe('rebuilding after a change', () => {
  it('keeps a typed figure by name, takes usual and fetched figures fresh, and lets a cleared figure go back', () => {
    const fresh = build()
    const existing = withIds(fresh).map((l) =>
      l.label === 'Disney resort room, per night'
        ? { ...l, unitAmountCents: 28_000, source: 'typed' as const, asOf: '2026-09-01', note: 'Pop Century standard' }
        : l.label === 'Park tickets, adults'
          ? { ...l, unitAmountCents: 1 } // still a quote: not typed, so not kept
          : l,
    )
    const kept = keepTypedLines(existing, fresh)
    expect(byLabel(kept, 'Disney resort room, per night')).toMatchObject({ unitAmountCents: 28_000, source: 'typed', asOf: '2026-09-01', note: 'Pop Century standard' })
    expect(byLabel(kept, 'Park tickets, adults').unitAmountCents).toBe(11_900)
    expect(kept).toHaveLength(fresh.length)
  })
})

describe('the handoff to Plans', () => {
  const accounts: ReserveAccount[] = [
    { id: 'acct-trip', householdId: 'hh', name: 'Vacation', institutionLabel: 'Cap One', scope: 'household', ownerUserId: null, active: true },
    { id: 'acct-mine', householdId: 'hh', name: 'Mine', institutionLabel: 'Cap One', scope: 'individual', ownerUserId: 'me', active: true },
  ]

  const priced = () =>
    withIds(build()).map((l) => (l.label === 'Disney resort room, per night' ? { ...l, unitAmountCents: 30_000, source: 'typed' as const } : l))

  it('emits a package for the trip module whose line items add up to the price tag and pass intake', () => {
    const lines = priced()
    const intake = toIntake({ trip, variant: variant(), lines, referencePrices: DEFAULT_REFERENCE_PRICES, defaultAccountId: 'acct-trip', today: TODAY })
    expect(intake.package).toEqual({ name: 'Disney 2027 — Drive, stay at Pop', module: 'trip', detail: { trip_id: 'trip-1', variant_id: 'var-1' } })
    expect(packageIntakeSchema.safeParse(intake).success).toBe(true)

    const result = validateIntake(intake, { today: TODAY, accounts, packages: [], actorUserId: 'me' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sent = result.value.lineItems.reduce((s, i) => s + i.unitAmountCents * i.quantity, 0)
    expect(sent).toBe(variantPrice(lines, 1000).totalCents)
    expect(result.value.module).toBe('trip')
    // Zero figures (fuel, tolls, Park Hopper) are not sent: a plan funds what costs something.
    expect(result.value.lineItems.find((i) => i.label.startsWith('Fuel'))).toBeUndefined()
    expect(result.value.lineItems.find((i) => i.label === 'Cushion')).toBeDefined()
    expect(result.value.lineItems.every((i) => i.reserveAccountId === 'acct-trip')).toBe(true)
  })

  it('nets a deal off the biggest part it applies to, so no line item is negative', () => {
    const lines = [
      ...priced(),
      { id: 'deal', variantId: 'var-1', category: 'promotion' as const, label: '$1,000 off rooms', quantity: 1, unitAmountCents: -100_000, dueDate: '2027-01-01', reserveAccountId: null, source: 'typed' as const, asOf: TODAY, note: 'applies:lodging', sort: 99 },
    ]
    const intake = toIntake({ trip, variant: variant(), lines, referencePrices: DEFAULT_REFERENCE_PRICES, defaultAccountId: 'acct-trip', today: TODAY })
    const room = intake.line_items.find((i) => i.label === 'Disney resort room, per night')!
    expect(room).toMatchObject({ quantity: 1, unit_amount: '800.00' })
    expect(intake.line_items.find((i) => i.label === '$1,000 off rooms')).toBeUndefined()
    const result = validateIntake(intake, { today: TODAY, accounts, packages: [], actorUserId: 'me' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lineItems.reduce((s, i) => s + i.unitAmountCents * i.quantity, 0)).toBe(variantPrice(lines, 1000).totalCents)
  })

  it("a part on someone else's account is refused by intake, not sent", () => {
    const lines = priced().map((l) => (l.label === 'Memory Maker' ? { ...l, reserveAccountId: 'acct-mine' } : l))
    const intake = toIntake({ trip, variant: variant(), lines, referencePrices: DEFAULT_REFERENCE_PRICES, defaultAccountId: 'acct-trip', today: TODAY })
    expect(intake.line_items.find((i) => i.label === 'Memory Maker')?.reserve_account).toBe('acct-mine')
    const result = validateIntake(intake, { today: TODAY, accounts, packages: [], actorUserId: 'spouse' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => p.message).join(' ')).toContain('belongs to someone else')
  })

  it('a cushion due date that has passed is due tomorrow', () => {
    const past = { ...trip, startDate: '2026-09-20', endDate: '2026-09-24' }
    const lines = withIds(defaultLines(past, variant({ parkDays: 2 }), { referencePrices: DEFAULT_REFERENCE_PRICES, today: '2026-09-01' }))
    const intake = toIntake({ trip: past, variant: variant(), lines, referencePrices: DEFAULT_REFERENCE_PRICES, defaultAccountId: 'acct-trip', today: TODAY })
    expect(intake.line_items.find((i) => i.label === 'Cushion')?.due_date).toBe('2026-09-26')
  })
})

describe('what came back from a fetch', () => {
  it("reads OSRM's route to whole miles and minutes, rounded up", () => {
    const body = { code: 'Ok', routes: [{ distance: 1_773_000, duration: 60_500 }] }
    expect(parseOsrmRoute(body, TODAY)).toEqual({ miles: 1_102, minutes: 1_009, fetchedOn: TODAY })
  })

  it('refuses anything that is not a route', () => {
    expect(parseOsrmRoute({ code: 'NoRoute', routes: [] }, TODAY)).toBeNull()
    expect(parseOsrmRoute({ routes: [{ distance: 'far' }] }, TODAY)).toBeNull()
    expect(parseOsrmRoute('<html>', TODAY)).toBeNull()
    expect(parseOsrmRoute(null, TODAY)).toBeNull()
    expect(parseOsrmRoute({ routes: [{ distance: 0, duration: 0 }] }, TODAY)).toBeNull()
  })

  it("reads FRED's gasoline CSV to cents a gallon, latest week, passing over a missing one", () => {
    const csv = 'observation_date,GASREGW\n2026-09-08,3.112\n2026-09-15,3.05\n2026-09-22,.\n'
    expect(parseGasPriceCsv(csv)).toEqual({ centsPerGallon: 305, observationDate: '2026-09-15' })
    expect(parseGasPriceCsv('DATE,GASREGW\r\n2026-09-15,3.119\r\n')).toEqual({ centsPerGallon: 311, observationDate: '2026-09-15' })
  })

  it('refuses a page that is not the CSV, or a price no pump has', () => {
    expect(parseGasPriceCsv('<html>blocked</html>')).toBeNull()
    expect(parseGasPriceCsv('')).toBeNull()
    expect(parseGasPriceCsv('observation_date,GASREGW\n2026-09-15,305\n')).toBeNull()
    expect(parseGasPriceCsv('observation_date,GASREGW\n2026-09-15,abc\n')).toBeNull()
  })

  it('stores a drive under a key that depends only on home and destination', () => {
    const key = driveSettingKey(trip.home!, 'wdw')
    expect(key).toMatch(/^trip_drive_[0-9a-f]{8}$/)
    expect(driveSettingKey({ label: 'Elsewhere', latitude: 41.87811, longitude: -87.62981 }, 'wdw')).toBe(key)
    expect(driveSettingKey({ label: 'Home', latitude: 40.0, longitude: -87.6298 }, 'wdw')).not.toBe(key)
  })
})

describe('the usual figures', () => {
  it('lays the household table over the defaults and keeps a default the household never touched', () => {
    const stored = [{ ...DEFAULT_REFERENCE_PRICES[0]!, amountCents: 12_500, asOf: '2026-10-01' }, { key: 'custom_thing', label: 'Custom', amountCents: 100, unit: 'flat' as const, asOf: TODAY, sourceUrl: null }]
    const merged = mergeReferencePrices(DEFAULT_REFERENCE_PRICES, stored)
    expect(merged).toHaveLength(DEFAULT_REFERENCE_PRICES.length + 1)
    expect(merged[0]).toMatchObject({ key: 'tickets_adult_per_day', amountCents: 12_500 })
    expect(merged.at(-1)?.key).toBe('custom_thing')
    expect(mergeReferencePrices(DEFAULT_REFERENCE_PRICES, null)).toEqual(DEFAULT_REFERENCE_PRICES)
  })

  it('is stale after half a year', () => {
    expect(referenceFreshness({ asOf: '2026-09-25' }, '2027-03-24')).toEqual({ ageDays: 180, stale: false })
    expect(referenceFreshness({ asOf: '2026-09-25' }, '2027-03-25').stale).toBe(true)
  })

  it('refuses a bad table', () => {
    expect(() => validateReferencePrices([{ key: 'Bad Key', label: 'x', amountCents: 1, unit: 'flat', asOf: TODAY, sourceUrl: null }])).toThrow(TripDataError)
    expect(() => validateReferencePrices([DEFAULT_REFERENCE_PRICES[0]!, DEFAULT_REFERENCE_PRICES[0]!])).toThrow(TripDataError)
    expect(() => validateReferencePrices([{ ...DEFAULT_REFERENCE_PRICES[0]!, amountCents: -1 }])).toThrow(TripDataError)
    expect(() => validateReferencePrices(DEFAULT_REFERENCE_PRICES)).not.toThrow()
  })

  it('says where a figure came from and how old it is', () => {
    expect(describeSource({ source: 'typed', asOf: '2026-09-22', note: null }, TODAY)).toBe('typed 3 days ago')
    expect(describeSource({ source: 'typed', asOf: TODAY, note: null }, TODAY)).toBe('typed today')
    expect(describeSource({ source: 'fetched', asOf: '2026-09-24', note: null }, TODAY)).toBe('looked up yesterday')
    expect(describeSource({ source: 'quote', asOf: '2026-09-25', note: 'https://disneyworld.disney.go.com/memory-maker/' }, TODAY)).toBe('Disney, Sep 2026')
    expect(describeSource({ source: 'quote', asOf: '2026-04-16', note: 'https://www.disneyfoodblog.com/x' }, TODAY)).toBe('disneyfoodblog.com, Apr 2026')
  })
})

describe('validation', () => {
  it('refuses a trip that ends before it starts, has nobody on it, or a car with no mileage', () => {
    expect(() => validateTripInputs({ name: 'x', startDate: '2027-06-12', endDate: '2027-06-11', travelers: trip.travelers, car: null })).toThrow(TripDataError)
    expect(() => validateTripInputs({ name: 'x', startDate: '2027-06-12', endDate: '2027-06-12', travelers: [], car: null })).toThrow(TripDataError)
    expect(() => validateTripInputs({ name: ' ', startDate: '2027-06-12', endDate: '2027-06-12', travelers: trip.travelers, car: null })).toThrow(TripDataError)
    expect(() => validateTripInputs({ name: 'x', startDate: '2027-06-12', endDate: '2027-06-12', travelers: trip.travelers, car: { mpg: 0, seats: 5 } })).toThrow(TripDataError)
    expect(() => validateTripInputs(trip)).not.toThrow()
  })

  it('refuses more park days than days, and a deal that is both a percent and an amount', () => {
    expect(() => validateChoices(choices({ parkDays: 8 }), trip)).toThrow(TripDataError)
    expect(() => validateChoices(choices({ parkDays: 7 }), trip)).not.toThrow()
    expect(() => validateChoices(choices({ promotion: { name: 'x', percentOffBasisPoints: 100, amountOffCents: 100, appliesToCategory: 'lodging', bookBy: TODAY } }), trip)).toThrow(TripDataError)
    expect(() => validateChoices(choices({ promotion: { name: 'x', appliesToCategory: 'lodging', bookBy: TODAY } }), trip)).toThrow(TripDataError)
    expect(() => validateChoices(choices({ promotion: { name: 'x', percentOffBasisPoints: 2000, appliesToCategory: 'promotion', bookBy: TODAY } }), trip)).toThrow(TripDataError)
  })
})
