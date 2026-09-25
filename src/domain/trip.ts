/**
 * The trip planner (PRD §16, Disney first).
 *
 * A trip is a price tag and a due date, then in one tap a plan the reservation
 * engine funds weekly. This module owns the trip's facts, prices each way of
 * doing it, and emits a package through the intake contract (PRD §4). The
 * core never reads a trip; the trip never touches weekly math (D19).
 *
 * Every cost is a fact a person stated, with the date it was true and where it
 * came from (D20). Nothing Disney sells is fetched. The two figures the app
 * does fetch -- the drive and the gas price -- are read here from what the
 * server layer downloaded, so the formats are tested without a network.
 *
 * Rounding: a fuel figure and the cushion round UP to the dollar, and the
 * price tag rounds up to the dollar, so a plan never sets aside less than the
 * trip will cost. A promotion is capped at what it applies to, because a
 * discount cannot make a room cost less than nothing.
 */

import { addDays, compareDates, maxDate, minDate, type CivilDate } from './dates'
import { ceilDiv, ceilToWholeDollars, parseAmountOrNull, type Cents } from './money'
import { INTAKE_CONTRACT_VERSION, type PackageIntake } from './intake'
import type { Id } from './types'

export class TripDataError extends Error {}

// ---------------------------------------------------------------- facts

export type TravelerBand = 'adult' | 'child' | 'infant'
/** Disney's bands: adult from 10, child 3 to 9, infant under 3. */
export interface Traveler {
  name: string
  band: TravelerBand
}

export interface HomeLocation {
  label: string
  latitude: number
  longitude: number
}

export interface TripCar {
  mpg: number
  seats: number
}

export type TripDestination = 'wdw'

export const DESTINATIONS: Record<TripDestination, HomeLocation> = {
  wdw: { label: 'Walt Disney World', latitude: 28.3852, longitude: -81.5639 },
}

export interface Trip {
  id: Id
  householdId: Id
  name: string
  destination: TripDestination
  startDate: CivilDate
  endDate: CivilDate
  travelers: Traveler[]
  /** Copied from the household setting when the trip is made, so a move later does not rewrite an old trip. */
  home: HomeLocation | null
  car: TripCar | null
  chosenVariantId: Id | null
  packageId: Id | null
  sentOn: CivilDate | null
  createdAt: CivilDate
  retiredAt: CivilDate | null
}

export type TravelChoice = 'drive' | 'fly'
export type LodgingChoice = 'disney_resort' | 'dvc_rental' | 'rental'
export type LightningLaneChoice = 'none' | 'multi_pass' | 'premier'
export type DiningChoice = 'plan' | 'out_of_pocket'

export type TripLineCategory =
  | 'travel'
  | 'lodging'
  | 'tickets'
  | 'lightning_lane'
  | 'dining'
  | 'photos'
  | 'souvenirs'
  | 'promotion'
  | 'contingency'

export const TRIP_LINE_CATEGORIES: readonly TripLineCategory[] = [
  'travel',
  'lodging',
  'tickets',
  'lightning_lane',
  'dining',
  'photos',
  'souvenirs',
  'promotion',
  'contingency',
]

/** What each part is called on screen (PRD §9: plain words, no "line" or "variant"). */
export const CATEGORY_LABELS: Record<TripLineCategory, string> = {
  travel: 'Getting there',
  lodging: 'Where we stay',
  tickets: 'Park tickets',
  lightning_lane: 'Lightning Lane',
  dining: 'Food',
  photos: 'Photos',
  souvenirs: 'Souvenirs',
  promotion: 'Deal',
  contingency: 'Cushion',
}

export interface Promotion {
  name: string
  /** Basis points off the category it applies to: 2000 = 20%. */
  percentOffBasisPoints?: number
  amountOffCents?: Cents
  appliesToCategory: TripLineCategory
  bookBy: CivilDate
}

export interface VariantChoices {
  travel: TravelChoice
  lodging: LodgingChoice
  lightningLane: LightningLaneChoice
  dining: DiningChoice
  parkDays: number
  promotion?: Promotion
}

export interface TripVariant {
  id: Id
  tripId: Id
  name: string
  choices: VariantChoices
  createdAt: CivilDate
}

export type TripLineSource = 'typed' | 'quote' | 'fetched'

export interface TripLine {
  id: Id
  variantId: Id
  category: TripLineCategory
  label: string
  quantity: number
  /** Negative for a promotion; zero for a figure nobody has typed yet. */
  unitAmountCents: Cents
  dueDate: CivilDate
  reserveAccountId: Id | null
  source: TripLineSource
  asOf: CivilDate
  note: string | null
  sort: number
}

/** A line as the default builder produces it: everything but the ids the database assigns. */
export type DefaultLine = Omit<TripLine, 'id' | 'variantId'>

export type ReferenceUnit = 'per_person_per_day' | 'per_night' | 'per_point' | 'per_day' | 'flat' | 'per_person' | 'percent'

export interface ReferencePrice {
  key: string
  label: string
  /** Cents, or basis points when the unit is 'percent'. */
  amountCents: number
  unit: ReferenceUnit
  asOf: CivilDate
  sourceUrl: string | null
}

export interface DriveEstimate {
  /** One way. */
  miles: number
  minutes: number
  fetchedOn: CivilDate
}

export interface GasPrice {
  centsPerGallon: Cents
  /** The week the survey describes, not when it was fetched. */
  observationDate: CivilDate
}

// ---------------------------------------------------------------- the usual figures

const AS_OF = '2026-09-25'

/**
 * Where the defaults start (PRD §16, D20). All approximate, all dated, all
 * editable by the household; a figure with no source is a household guess.
 */
export const DEFAULT_REFERENCE_PRICES: readonly ReferencePrice[] = [
  { key: 'tickets_adult_per_day', label: 'Park ticket, adult, per day', amountCents: 11_900, unit: 'per_day', asOf: AS_OF, sourceUrl: 'https://www.disneyfoodblog.com/2026/04/16/full-list-of-disney-world-ticket-prices-for-2027/' },
  { key: 'tickets_child_per_day', label: 'Park ticket, child, per day', amountCents: 11_400, unit: 'per_day', asOf: AS_OF, sourceUrl: 'https://www.disneyfoodblog.com/2026/04/16/full-list-of-disney-world-ticket-prices-for-2027/' },
  { key: 'll_multi_pass_per_person_per_day', label: 'Lightning Lane Multi Pass, per person per day', amountCents: 3_000, unit: 'per_person_per_day', asOf: AS_OF, sourceUrl: 'https://deeparrival.com/theme-parks/walt-disney-world/lightning-lane/' },
  { key: 'll_premier_per_person_per_day', label: 'Lightning Lane Premier Pass, per person per day', amountCents: 25_000, unit: 'per_person_per_day', asOf: AS_OF, sourceUrl: 'https://www.wdwmagic.com/other/disney-genie/news/13mar2026-disney-world-lightning-lane-premier-pass-spring-break-2026-prices,-sellouts,-and-what-to-know-before-you-buy.htm' },
  { key: 'dining_plan_adult_per_night', label: 'Dining plan, adult, per night', amountCents: 6_047, unit: 'per_night', asOf: AS_OF, sourceUrl: 'https://www.disneytouristblog.com/disney-dining-plan-costs-info-tips/' },
  { key: 'dining_plan_child_per_night', label: 'Dining plan, child, per night', amountCents: 2_616, unit: 'per_night', asOf: AS_OF, sourceUrl: 'https://www.disneytouristblog.com/disney-dining-plan-costs-info-tips/' },
  { key: 'dining_out_of_pocket_per_person_per_day', label: 'Food out of pocket, per person per day', amountCents: 7_500, unit: 'per_person_per_day', asOf: AS_OF, sourceUrl: null },
  { key: 'memory_maker_flat', label: 'Memory Maker', amountCents: 18_500, unit: 'flat', asOf: AS_OF, sourceUrl: 'https://disneyworld.disney.go.com/memory-maker/' },
  { key: 'theme_park_parking_per_day', label: 'Theme-park parking, per day', amountCents: 3_500, unit: 'per_day', asOf: AS_OF, sourceUrl: 'https://disneyworld.disney.go.com/guest-services/parking/' },
  { key: 'mco_ride_each_way', label: 'Ride between the airport and the resort, each way', amountCents: 4_500, unit: 'flat', asOf: AS_OF, sourceUrl: 'https://www.uber.com/global/en/r/routes/mco-to-disneys-pop-century-resort/' },
  { key: 'home_airport_parking_per_day', label: 'Home airport parking, per day', amountCents: 1_200, unit: 'per_day', asOf: AS_OF, sourceUrl: null },
  { key: 'dvc_per_point', label: 'DVC rental, per point', amountCents: 2_200, unit: 'per_point', asOf: AS_OF, sourceUrl: 'https://bestdvcbroker.com/blog/dvc-rental-prices-2026' },
  { key: 'souvenirs_per_person', label: 'Souvenirs, per person', amountCents: 10_000, unit: 'per_person', asOf: AS_OF, sourceUrl: null },
  { key: 'midway_hotel_per_night', label: 'Hotel on the way, per night', amountCents: 15_000, unit: 'per_night', asOf: AS_OF, sourceUrl: null },
  { key: 'contingency_percent', label: 'Cushion, percent of the trip', amountCents: 1_000, unit: 'percent', asOf: AS_OF, sourceUrl: null },
]

/** One way, in minutes. Longer than this and the drive gets a hotel on the way. */
export const DEFAULT_MAX_DRIVE_MINUTES = 600

/** A usual figure older than this is flagged: Disney reprices at least yearly. */
export const REFERENCE_STALE_AFTER_DAYS = 180

/**
 * The household's table over the defaults: a stored row replaces the default
 * with its key, and a default the household has never touched still appears,
 * so a figure added in a later release is not silently missing.
 */
export function mergeReferencePrices(
  defaults: readonly ReferencePrice[],
  stored: readonly ReferencePrice[] | null,
): ReferencePrice[] {
  if (!stored) return [...defaults]
  const byKey = new Map(stored.map((p) => [p.key, p]))
  const merged = defaults.map((d) => byKey.get(d.key) ?? d)
  const known = new Set(defaults.map((d) => d.key))
  return [...merged, ...stored.filter((p) => !known.has(p.key))]
}

export function validateReferencePrices(prices: readonly ReferencePrice[]): void {
  const seen = new Set<string>()
  for (const p of prices) {
    if (!/^[a-z0-9_]+$/.test(p.key)) throw new TripDataError(`"${p.key}" is not a usable key: lowercase letters, digits and underscores.`)
    if (seen.has(p.key)) throw new TripDataError(`"${p.key}" appears twice.`)
    seen.add(p.key)
    if (!p.label.trim()) throw new TripDataError(`"${p.key}" needs a label.`)
    if (!Number.isInteger(p.amountCents) || p.amountCents < 0) throw new TripDataError(`"${p.label}" must be zero or more.`)
    if (p.unit === 'percent' && p.amountCents > 10_000) throw new TripDataError(`"${p.label}" cannot be over 100%.`)
  }
}

export function referenceFreshness(
  price: Pick<ReferencePrice, 'asOf'>,
  today: CivilDate,
  staleAfterDays: number = REFERENCE_STALE_AFTER_DAYS,
): { ageDays: number; stale: boolean } {
  const ageDays = Math.max(0, compareDates(today, price.asOf))
  return { ageDays, stale: ageDays > staleAfterDays }
}

// ---------------------------------------------------------------- validation

export function validateTripInputs(input: {
  name: string
  startDate: CivilDate
  endDate: CivilDate
  travelers: readonly Traveler[]
  car: TripCar | null
}): void {
  if (!input.name.trim()) throw new TripDataError('A trip needs a name.')
  if (compareDates(input.endDate, input.startDate) < 0) throw new TripDataError('The trip cannot end before it starts.')
  if (compareDates(input.endDate, input.startDate) > 60) throw new TripDataError('A trip here is at most 60 days.')
  if (input.travelers.length === 0) throw new TripDataError('Say who is going.')
  for (const t of input.travelers) {
    if (!t.name.trim()) throw new TripDataError('Every traveler needs a name.')
    if (!['adult', 'child', 'infant'].includes(t.band)) throw new TripDataError(`"${t.name}" needs an age band.`)
  }
  if (input.car) {
    if (!Number.isInteger(input.car.mpg) || input.car.mpg < 1 || input.car.mpg > 200) throw new TripDataError('The car needs miles per gallon, like 28.')
    if (!Number.isInteger(input.car.seats) || input.car.seats < 1 || input.car.seats > 15) throw new TripDataError('The car needs a number of seats.')
  }
}

export function validateChoices(choices: VariantChoices, trip: Pick<Trip, 'startDate' | 'endDate'>): void {
  const nights = tripNights(trip)
  if (!Number.isInteger(choices.parkDays) || choices.parkDays < 0 || choices.parkDays > nights + 1) {
    throw new TripDataError(`Park days must be between 0 and ${nights + 1} for these dates.`)
  }
  const p = choices.promotion
  if (p) {
    if (!p.name.trim()) throw new TripDataError('The deal needs a name.')
    const hasPercent = p.percentOffBasisPoints !== undefined
    const hasAmount = p.amountOffCents !== undefined
    if (hasPercent === hasAmount) throw new TripDataError('A deal is either a percent off or an amount off.')
    if (hasPercent && (!Number.isInteger(p.percentOffBasisPoints) || p.percentOffBasisPoints! <= 0 || p.percentOffBasisPoints! > 10_000)) {
      throw new TripDataError('The percent off must be between 0 and 100.')
    }
    if (hasAmount && (!Number.isInteger(p.amountOffCents) || p.amountOffCents! <= 0)) throw new TripDataError('The amount off must be more than zero.')
    if (p.appliesToCategory === 'promotion' || p.appliesToCategory === 'contingency') throw new TripDataError('A deal applies to a part of the trip.')
  }
}

export function validateLineInputs(line: Pick<TripLine, 'category' | 'label' | 'quantity' | 'unitAmountCents'>): void {
  if (!line.label.trim()) throw new TripDataError('Every part needs a name.')
  if (!Number.isInteger(line.quantity) || line.quantity < 0) throw new TripDataError('How many must be a whole number, zero or more.')
  if (!Number.isInteger(line.unitAmountCents)) throw new TripDataError('The figure must be whole cents.')
  if (line.category === 'promotion' ? line.unitAmountCents > 0 : line.unitAmountCents < 0) {
    throw new TripDataError(line.category === 'promotion' ? 'A deal takes money off, so its figure is negative or zero.' : 'A part cannot cost less than nothing.')
  }
}

// ---------------------------------------------------------------- counting

export function tripNights(trip: Pick<Trip, 'startDate' | 'endDate'>): number {
  return Math.max(0, compareDates(trip.endDate, trip.startDate))
}

/** Days away, travel days included: a Friday-to-Sunday trip is 3 days, 2 nights. */
export function tripDays(trip: Pick<Trip, 'startDate' | 'endDate'>): number {
  return tripNights(trip) + 1
}

export interface HeadCount {
  adults: number
  children: number
  infants: number
  /** Adults and children: who pays for tickets, Lightning Lane, dining and souvenirs. */
  guests: number
  /** Everyone, infants included: who takes a seat on a plane or in a car. */
  everyone: number
}

export function headCount(travelers: readonly Traveler[]): HeadCount {
  const adults = travelers.filter((t) => t.band === 'adult').length
  const children = travelers.filter((t) => t.band === 'child').length
  const infants = travelers.filter((t) => t.band === 'infant').length
  return { adults, children, infants, guests: adults + children, everyone: adults + children + infants }
}

// ---------------------------------------------------------------- derivations

/** What one part comes to. The one place quantity x figure is computed for a trip. */
export function lineTotalCents(line: Pick<TripLine, 'quantity' | 'unitAmountCents'>): Cents {
  return line.quantity * line.unitAmountCents
}

/**
 * Fuel for the whole drive, rounded up to the dollar: whole gallons (a tank
 * is not bought by the tenth), times the price. Never under-funds a fill-up.
 */
export function fuelCents(args: { roundTripMiles: number; mpg: number; centsPerGallon: Cents }): Cents {
  if (args.mpg <= 0) throw new TripDataError('Fuel needs miles per gallon.')
  if (args.roundTripMiles < 0 || args.centsPerGallon < 0) throw new TripDataError('Fuel needs a distance and a price.')
  const gallons = Math.ceil(args.roundTripMiles / args.mpg)
  return ceilToWholeDollars(gallons * args.centsPerGallon)
}

/** Hotel nights on the way, each way: none for a day's drive, one per extra stretch. */
export function midwayNightsEachWay(oneWayMinutes: number, maxDriveMinutes: number = DEFAULT_MAX_DRIVE_MINUTES): number {
  if (maxDriveMinutes <= 0 || oneWayMinutes <= maxDriveMinutes) return 0
  return Math.ceil(oneWayMinutes / maxDriveMinutes) - 1
}

/** Vehicles for the airport ride: four to a car. */
export function vehiclesNeeded(everyone: number): number {
  return Math.max(1, Math.ceil(everyone / 4))
}

const BASIS_POINTS = 10_000

/**
 * A deal cannot take off more than the part it applies to comes to. What it
 * can take off, as a non-positive figure.
 */
export function promotionCents(lines: readonly Pick<TripLine, 'category' | 'quantity' | 'unitAmountCents'>[]): Cents {
  const deals = lines.filter((l) => l.category === 'promotion')
  if (deals.length === 0) return 0
  let total = 0
  for (const deal of deals) {
    total += cappedPromotion(deal, lines)
  }
  return total
}

function cappedPromotion(
  deal: Pick<TripLine, 'category' | 'quantity' | 'unitAmountCents'> & { note?: string | null },
  lines: readonly Pick<TripLine, 'category' | 'quantity' | 'unitAmountCents'>[],
): Cents {
  const off = -Math.min(0, lineTotalCents(deal))
  const category = promotionCategory(deal)
  const applies = lines
    .filter((l) => l.category !== 'promotion' && l.category !== 'contingency' && (category === null || l.category === category))
    .reduce((sum, l) => sum + Math.max(0, lineTotalCents(l)), 0)
  return -Math.min(off, applies) || 0 // never -0
}

/**
 * Which part a stored deal applies to. Kept on the line itself, in its note
 * as "applies:<category>", so the cap does not depend on the variant's choices
 * still naming the same deal.
 */
export const PROMOTION_NOTE_PREFIX = 'applies:'

export function promotionCategory(deal: { note?: string | null }): TripLineCategory | null {
  const note = deal.note ?? ''
  if (!note.startsWith(PROMOTION_NOTE_PREFIX)) return null
  const category = note.slice(PROMOTION_NOTE_PREFIX.length).split(/\s/)[0] as TripLineCategory
  return TRIP_LINE_CATEGORIES.includes(category) ? category : null
}

export interface VariantPrice {
  /** Everything that costs money, before any deal. */
  partsCents: Cents
  /** What the deals take off, capped. Zero or negative. */
  promotionCents: Cents
  /** The cushion: a typed one if there is a cushion part, else the household's percent, rounded up to the dollar. */
  cushionCents: Cents
  /** The price tag, rounded up to the dollar. */
  totalCents: Cents
}

/**
 * The price tag (PRD §16): parts, less the capped deal, plus the cushion,
 * rounded up to the dollar.
 */
export function variantPrice(lines: readonly DefaultLine[], contingencyBasisPoints: number): VariantPrice {
  const parts = lines
    .filter((l) => l.category !== 'promotion' && l.category !== 'contingency')
    .reduce((sum, l) => sum + Math.max(0, lineTotalCents(l)), 0)
  const promotion = promotionCents(lines)
  const base = parts + promotion
  const typedCushion = lines.filter((l) => l.category === 'contingency')
  const cushion =
    typedCushion.length > 0
      ? typedCushion.reduce((sum, l) => sum + Math.max(0, lineTotalCents(l)), 0)
      : ceilToWholeDollars(ceilDiv(base * contingencyBasisPoints, BASIS_POINTS))
  return {
    partsCents: parts,
    promotionCents: promotion,
    cushionCents: cushion,
    totalCents: ceilToWholeDollars(base + cushion),
  }
}

export function contingencyBasisPoints(prices: readonly ReferencePrice[]): number {
  return prices.find((p) => p.key === 'contingency_percent')?.amountCents ?? 1_000
}

/**
 * First money due (D21): the earliest due date among parts worth more than the
 * household's cushion setting, so a $40 parking figure does not set the
 * headline. A deal's date is when to book, not when money goes, so it never
 * counts. With nothing over the buffer, the trip's first day.
 */
export function headlineDueDate(
  lines: readonly Pick<TripLine, 'category' | 'quantity' | 'unitAmountCents' | 'dueDate'>[],
  bufferCents: Cents,
  startDate: CivilDate,
): CivilDate {
  let earliest: CivilDate | null = null
  for (const line of lines) {
    if (line.category === 'promotion') continue
    if (lineTotalCents(line) <= bufferCents) continue
    earliest = earliest === null ? line.dueDate : minDate(earliest, line.dueDate)
  }
  return earliest ?? startDate
}

// ---------------------------------------------------------------- the default parts

export interface DefaultLinesContext {
  referencePrices: readonly ReferencePrice[]
  drive?: DriveEstimate | null
  gasPrice?: GasPrice | null
  maxDriveMinutes?: number
  today: CivilDate
}

/** A due date that has already gone is due now: the plan funds it from its first week. */
function noEarlierThanTomorrow(date: CivilDate, today: CivilDate): CivilDate {
  return maxDate(date, addDays(today, 1))
}

/**
 * The parts of a Disney trip, with quantities from who is going, how long,
 * and how many park days (PRD §16). A figure with a usual price starts there,
 * marked with that price's date and source; one nobody can know for the
 * household -- a room rate, a fare, tolls -- starts at zero and says so.
 */
export function defaultLines(trip: Trip, variant: Pick<TripVariant, 'choices'>, context: DefaultLinesContext): DefaultLine[] {
  const { choices } = variant
  const { today } = context
  const start = trip.startDate
  const heads = headCount(trip.travelers)
  const nights = tripNights(trip)
  const days = tripDays(trip)
  const parkDays = choices.parkDays
  const maxDriveMinutes = context.maxDriveMinutes ?? DEFAULT_MAX_DRIVE_MINUTES
  const drive = context.drive ?? null
  const gas = context.gasPrice ?? null
  const prices = new Map(context.referencePrices.map((p) => [p.key, p]))

  const lines: DefaultLine[] = []
  const due = (date: CivilDate) => noEarlierThanTomorrow(date, today)

  const usual = (key: string): ReferencePrice => {
    const price = prices.get(key)
    if (!price) throw new TripDataError(`There is no usual figure for "${key}".`)
    return price
  }
  const push = (line: Omit<DefaultLine, 'sort' | 'reserveAccountId'> & { reserveAccountId?: Id | null }) => {
    lines.push({ ...line, reserveAccountId: line.reserveAccountId ?? null, sort: lines.length })
  }
  const typed = (category: TripLineCategory, label: string, quantity: number, dueDate: CivilDate, note: string | null = null) =>
    push({ category, label, quantity, unitAmountCents: 0, dueDate: due(dueDate), source: 'typed', asOf: today, note })
  const priced = (category: TripLineCategory, label: string, quantity: number, key: string, dueDate: CivilDate) => {
    const price = usual(key)
    push({
      category,
      label,
      quantity,
      unitAmountCents: price.amountCents,
      dueDate: due(dueDate),
      source: price.sourceUrl ? 'quote' : 'typed',
      asOf: price.asOf,
      note: price.sourceUrl,
    })
  }

  // Getting there.
  if (choices.travel === 'drive') {
    if (drive && gas && trip.car) {
      push({
        category: 'travel',
        label: 'Fuel, there and back',
        quantity: 1,
        unitAmountCents: fuelCents({ roundTripMiles: drive.miles * 2, mpg: trip.car.mpg, centsPerGallon: gas.centsPerGallon }),
        dueDate: due(start),
        source: 'fetched',
        asOf: minDate(drive.fetchedOn, gas.observationDate),
        note: `${Math.round(drive.miles * 2)} miles at ${trip.car.mpg} mpg, gas ${(gas.centsPerGallon / 100).toFixed(2)}/gal`,
      })
    } else {
      typed('travel', 'Fuel, there and back', 1, start, 'Check the drive and the gas price to fill this in')
    }
    typed('travel', 'Tolls, each way', 2, start)
    const midway = drive ? midwayNightsEachWay(drive.minutes, maxDriveMinutes) : 0
    if (midway > 0) priced('travel', 'Hotel on the way, each way', midway * 2, 'midway_hotel_per_night', start)
    if (choices.lodging !== 'disney_resort' && parkDays > 0) {
      priced('travel', 'Theme-park parking', parkDays, 'theme_park_parking_per_day', start)
    }
  } else {
    typed('travel', 'Flights, each person', heads.everyone, addDays(start, -120))
    typed('travel', 'Checked bags', 1, addDays(start, -120))
    priced('travel', 'Parking at our airport', days, 'home_airport_parking_per_day', start)
    priced('travel', 'Airport rides, each way', 2 * vehiclesNeeded(heads.everyone), 'mco_ride_each_way', start)
  }

  // Where we stay.
  if (choices.lodging === 'disney_resort') {
    typed('lodging', 'Disney resort room, per night', nights, addDays(start, -30))
  } else if (choices.lodging === 'dvc_rental') {
    const price = usual('dvc_per_point')
    push({
      category: 'lodging',
      label: 'DVC rental, per point',
      quantity: 0,
      unitAmountCents: price.amountCents,
      dueDate: due(minDate(addDays(today, 14), addDays(start, -30))),
      source: price.sourceUrl ? 'quote' : 'typed',
      asOf: price.asOf,
      note: 'Type the points the stay needs',
    })
  } else {
    typed('lodging', 'Rental, half at booking, per night', nights, addDays(today, 14), 'Half the nightly rate')
    typed('lodging', 'Rental, other half, per night', nights, addDays(start, -60), 'Half the nightly rate')
    typed('lodging', 'Rental fees', 1, addDays(today, 14))
  }

  // Park tickets.
  if (parkDays > 0) {
    if (heads.adults > 0) priced('tickets', 'Park tickets, adults', heads.adults * parkDays, 'tickets_adult_per_day', addDays(start, -60))
    if (heads.children > 0) priced('tickets', 'Park tickets, children', heads.children * parkDays, 'tickets_child_per_day', addDays(start, -60))
    if (heads.guests > 0) typed('tickets', 'Park Hopper add-on, each person', heads.guests, addDays(start, -60))
  }

  // Lightning Lane.
  if (parkDays > 0 && heads.guests > 0 && choices.lightningLane !== 'none') {
    if (choices.lightningLane === 'multi_pass') {
      priced('lightning_lane', 'Lightning Lane Multi Pass', heads.guests * parkDays, 'll_multi_pass_per_person_per_day', start)
    } else {
      priced('lightning_lane', 'Lightning Lane Premier Pass', heads.guests * parkDays, 'll_premier_per_person_per_day', start)
    }
  }

  // Food. The dining plan is only sold with a Disney resort room.
  if (choices.dining === 'plan' && choices.lodging === 'disney_resort' && nights > 0) {
    if (heads.adults > 0) priced('dining', 'Dining plan, adults', heads.adults * nights, 'dining_plan_adult_per_night', addDays(start, -30))
    if (heads.children > 0) priced('dining', 'Dining plan, children', heads.children * nights, 'dining_plan_child_per_night', addDays(start, -30))
  } else if (heads.guests > 0) {
    priced('dining', 'Food out of pocket', heads.guests * days, 'dining_out_of_pocket_per_person_per_day', start)
  }

  // Photos and souvenirs.
  priced('photos', 'Memory Maker', 1, 'memory_maker_flat', addDays(start, -3))
  if (heads.guests > 0) priced('souvenirs', 'Souvenirs', heads.guests, 'souvenirs_per_person', start)

  // A deal: a negative part, dated when it must be booked by.
  const deal = choices.promotion
  if (deal) {
    const applies = lines
      .filter((l) => l.category === deal.appliesToCategory)
      .reduce((sum, l) => sum + Math.max(0, lineTotalCents(l)), 0)
    const off =
      deal.amountOffCents !== undefined
        ? deal.amountOffCents
        : Math.floor((applies * (deal.percentOffBasisPoints ?? 0)) / BASIS_POINTS)
    push({
      category: 'promotion',
      label: deal.name,
      quantity: 1,
      unitAmountCents: -Math.min(off, applies) || 0, // never -0
      dueDate: deal.bookBy,
      source: 'typed',
      asOf: today,
      note: `${PROMOTION_NOTE_PREFIX}${deal.appliesToCategory}`,
    })
  }

  return lines
}

/**
 * Rebuilding the parts after a choice changes must not throw away what a
 * person typed: a part with the same name keeps its typed figure, date,
 * account and note. A fetched or usual figure is taken fresh.
 */
export function keepTypedLines(existing: readonly TripLine[], fresh: readonly DefaultLine[]): DefaultLine[] {
  const typed = new Map(existing.filter((l) => l.source === 'typed' && l.unitAmountCents !== 0).map((l) => [l.label, l]))
  return fresh.map((line) => {
    const kept = typed.get(line.label)
    if (!kept || kept.category !== line.category) return line
    return {
      ...line,
      unitAmountCents: kept.unitAmountCents,
      dueDate: kept.dueDate,
      reserveAccountId: kept.reserveAccountId,
      source: 'typed',
      asOf: kept.asOf,
      note: line.category === 'promotion' ? line.note : kept.note,
    }
  })
}

// ---------------------------------------------------------------- the handoff

export interface TripPackageDetail {
  trip_id: Id
  variant_id: Id
}

/**
 * The package the reservation engine funds (PRD §4, §16): one line item per
 * part that costs money, the deal netted off the parts it applies to, and
 * the cushion as a part of its own. Every figure is whole cents, and the line
 * items add up to exactly the price tag.
 *
 * A deal is taken off the biggest part it applies to first, then the next,
 * because the intake contract has no negative line items: a plan that sets
 * money aside cannot set aside less than nothing for a room.
 */
export function toIntake(args: {
  trip: Trip
  variant: TripVariant
  lines: readonly TripLine[]
  referencePrices: readonly ReferencePrice[]
  defaultAccountId: Id
  today: CivilDate
}): PackageIntake {
  const { trip, variant, lines, today } = args
  const price = variantPrice(lines, contingencyBasisPoints(args.referencePrices))
  const positive = lines
    .filter((l) => l.category !== 'promotion' && l.category !== 'contingency' && lineTotalCents(l) > 0)
    .map((l) => ({ line: l, totalCents: lineTotalCents(l), quantity: l.quantity, unitAmountCents: l.unitAmountCents }))

  // Net each deal off its parts, biggest first.
  for (const deal of lines.filter((l) => l.category === 'promotion')) {
    let remaining = -cappedPromotion(deal, lines)
    const category = promotionCategory(deal)
    const targets = positive
      .filter((p) => category === null || p.line.category === category)
      .sort((a, b) => b.totalCents - a.totalCents)
    for (const target of targets) {
      if (remaining <= 0) break
      const taken = Math.min(remaining, target.totalCents)
      target.totalCents -= taken
      target.quantity = 1
      target.unitAmountCents = target.totalCents
      remaining -= taken
    }
  }

  interface Item {
    label: string
    unitAmountCents: Cents
    quantity: number
    dueDate: CivilDate
    reserveAccountId: Id
  }
  const account = (line: TripLine) => line.reserveAccountId ?? args.defaultAccountId
  const items: Item[] = positive
    .filter((p) => p.totalCents > 0)
    .map((p) => ({
      label: p.line.label,
      unitAmountCents: p.unitAmountCents,
      quantity: p.quantity,
      dueDate: p.line.dueDate,
      reserveAccountId: account(p.line),
    }))

  // The cushion is a part of its own, due with the trip. A cushion someone
  // typed is sent as typed; otherwise the household's percent.
  const cushionDue = noEarlierThanTomorrow(trip.startDate, today)
  const typedCushion = lines.filter((l) => l.category === 'contingency' && lineTotalCents(l) > 0)
  for (const c of typedCushion) {
    items.push({ label: c.label, unitAmountCents: c.unitAmountCents, quantity: c.quantity, dueDate: c.dueDate, reserveAccountId: account(c) })
  }
  if (typedCushion.length === 0 && price.cushionCents > 0) {
    items.push({ label: 'Cushion', unitAmountCents: price.cushionCents, quantity: 1, dueDate: cushionDue, reserveAccountId: args.defaultAccountId })
  }

  // The price tag rounds up to the dollar; the odd cents go on the cushion,
  // so the line items add up to exactly what the screen said.
  const summed = items.reduce((sum, item) => sum + item.unitAmountCents * item.quantity, 0)
  const short = price.totalCents - summed
  if (short > 0) {
    const cushion = items.find((item) => item.label === 'Cushion' && item.quantity === 1)
    if (cushion) cushion.unitAmountCents += short
    else items.push({ label: 'Rounding up to the dollar', unitAmountCents: short, quantity: 1, dueDate: cushionDue, reserveAccountId: args.defaultAccountId })
  }

  const detail: TripPackageDetail = { trip_id: trip.id, variant_id: variant.id }
  return {
    contract_version: INTAKE_CONTRACT_VERSION,
    package: { name: `${trip.name} — ${variant.name}`, module: 'trip', detail },
    line_items: items.map((item) => ({
      label: item.label,
      unit_amount: (item.unitAmountCents / 100).toFixed(2),
      quantity: item.quantity,
      due_date: item.dueDate,
      reserve_account: item.reserveAccountId,
    })),
  }
}

// ---------------------------------------------------------------- what came back from a fetch

/** The setting key a drive is stored under: one per home and destination. */
export function driveSettingKey(home: HomeLocation, destination: TripDestination): string {
  const text = `${home.latitude.toFixed(4)},${home.longitude.toFixed(4)}->${destination}`
  // FNV-1a, 32-bit: a stable short key, not a secret.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `trip_drive_${hash.toString(16).padStart(8, '0')}`
}

const METERS_PER_MILE = 1609.344

/**
 * The route OSRM answered with: {routes: [{distance: meters, duration: seconds}]}.
 * Anything else, or a distance no road trip has, is refused rather than
 * stored as a fact.
 */
export function parseOsrmRoute(json: unknown, fetchedOn: CivilDate): DriveEstimate | null {
  if (!json || typeof json !== 'object') return null
  const body = json as { code?: unknown; routes?: unknown }
  if (body.code !== undefined && body.code !== 'Ok') return null
  if (!Array.isArray(body.routes) || body.routes.length === 0) return null
  const route = body.routes[0] as { distance?: unknown; duration?: unknown }
  if (typeof route.distance !== 'number' || typeof route.duration !== 'number') return null
  if (!Number.isFinite(route.distance) || !Number.isFinite(route.duration)) return null
  const miles = Math.ceil(route.distance / METERS_PER_MILE)
  const minutes = Math.ceil(route.duration / 60)
  if (miles <= 0 || miles > 6000 || minutes <= 0) return null
  return { miles, minutes, fetchedOn }
}

export const GAS_PRICE_SERIES = 'GASREGW'

/**
 * The latest week in FRED's CSV for regular gasoline, dollars per gallon,
 * read to cents. A figure outside $0.50-$20 is a format change, not a price.
 */
export function parseGasPriceCsv(text: string): GasPrice | null {
  const rows = text.split(/\r?\n/).slice(1)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const [date = '', value = ''] = rows[i]!.split(',').map((cell) => cell.trim())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (value === '' || value === '.') continue
    if (!/^\d+(\.\d+)?$/.test(value)) return null
    const [whole = '0', frac = ''] = value.split('.')
    const centsPerGallon = parseAmountOrNull(`${whole}.${frac.slice(0, 2).padEnd(2, '0')}`)
    if (centsPerGallon === null) return null
    if (centsPerGallon < 50 || centsPerGallon > 2_000) return null
    return { centsPerGallon, observationDate: date }
  }
  return null
}

/** A gas price is weekly; two missed weeks means the fetch has stopped. */
export const GAS_PRICE_STALE_AFTER_DAYS = 14

export function validateDriveEstimate(drive: DriveEstimate): void {
  if (!Number.isInteger(drive.miles) || drive.miles <= 0 || drive.miles > 6000) throw new TripDataError('The drive needs a distance in miles.')
  if (!Number.isInteger(drive.minutes) || drive.minutes <= 0) throw new TripDataError('The drive needs a time in minutes.')
}

export function validateGasPrice(gas: GasPrice): void {
  if (!Number.isInteger(gas.centsPerGallon) || gas.centsPerGallon < 50 || gas.centsPerGallon > 2_000) {
    throw new TripDataError('The gas price must be between $0.50 and $20 a gallon.')
  }
}

export function validateHomeLocation(home: HomeLocation): void {
  if (!home.label.trim()) throw new TripDataError('Home needs a label, like the town.')
  if (!Number.isFinite(home.latitude) || home.latitude < -90 || home.latitude > 90) throw new TripDataError('Latitude is between -90 and 90.')
  if (!Number.isFinite(home.longitude) || home.longitude < -180 || home.longitude > 180) throw new TripDataError('Longitude is between -180 and 180.')
}

// ---------------------------------------------------------------- words on screen

/** "typed 3 days ago", "Disney, Sep 2026", "fetched Sep 18": where a figure came from and how old it is. */
export function describeSource(line: Pick<TripLine, 'source' | 'asOf' | 'note'>, today: CivilDate): string {
  const age = Math.max(0, compareDates(today, line.asOf))
  const ago = age === 0 ? 'today' : age === 1 ? 'yesterday' : age < 60 ? `${age} days ago` : monthYear(line.asOf)
  if (line.source === 'typed') return `typed ${ago}`
  if (line.source === 'fetched') return `looked up ${ago}`
  return `${sourceName(line.note)}, ${monthYear(line.asOf)}`
}

function monthYear(date: CivilDate): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[m - 1]} ${y}`
}

/** The site a usual figure was read from, in a word: "Disney", "disneyfoodblog.com". */
export function sourceName(url: string | null | undefined): string {
  if (!url) return 'our usual figure'
  const host = url.replace(/^https?:\/\//, '').split('/')[0] ?? ''
  const bare = host.replace(/^www\./, '')
  if (bare.endsWith('disney.go.com')) return 'Disney'
  return bare || 'our usual figure'
}
