/**
 * What a night costs (PRD D55 (5)): each night of a stay from the most
 * trusted fact that covers it, never an average of two.
 *
 *   1 typed         a price we were quoted for those nights
 *   2 disney_page   Disney's own page, sent with Send this page (reserved)
 *   3 rates_week    Disney's rate for the week the night falls in
 *   4 rates_month   Disney's rate for the month
 *   5 predicted     worked out from Disney's rate a year earlier (D64 (6))
 *   6 points_fitted DVC points x a $/point worked out from overlap (later)
 *   7 points_own    DVC points x the household's $/point (later)
 *   - nothing       no price yet
 *
 * Each level says how sure it is, in four words the household reads
 * (D64 (6), proposed). Definite: a price for these very nights, quoted or
 * looked up. Disney list price: Disney's published rate for the period,
 * before any discount. Predicted: no published rate covers the night, so
 * it is worked out. Unknown: nothing to go on. Only a definite figure is
 * definite; a prediction is never shown as one.
 *
 * A prediction is Disney's rate for the same week or month a year earlier,
 * times the year-on-year change the stored rates themselves show (the
 * median over months priced in both years), times how far the household's
 * own quotes ran from Disney's rate on the nights both covered. A quote
 * never becomes a prediction; it only moves the next one. With too little
 * to measure a change, none is applied and the basis says so: no rate of
 * increase is assumed.
 *
 * Within a level the newest wins: the quote recorded last, the rate
 * captured last. A night takes the winner's figure as it stands; a week or
 * month rate is that period's average a night, spread flat until point
 * charts can shape it.
 *
 * Two things are said on a tap, never in the ranking: a figure older than
 * STALE_AFTER_DAYS (Disney reprices; the snapshot moves), and the next
 * level down when it differs from the winner by more than DISAGREE_PERCENT,
 * so a quote far from Disney's rate is visible.
 *
 * A window's lodging is known only when every night is: a partial sum
 * would compare a cheap half-priced week with a fully priced one. The
 * level a window shows is the weakest one it used.
 *
 * Rates come from resortings.com, which publishes Disney's own average a
 * night for a four-night midweek stay (two adults, standard room, room
 * only, before tax) and allows reproducing its table with a link back.
 * parseResortingsPrices reads its "prices by month" page as a person pastes
 * it or as it is fetched; it never throws.
 *
 * Nothing here is stored.
 */

import { addDays, addMonths, compareDates, type CivilDate } from './dates'
import { formatCents, type Cents } from './money'
import { TripPlanError } from './trip-plan'
import type { ShapedWindow, StayChoice } from './trip-shape'
import { ANY_SOURCE, canonicalStay, type Resort, type ResortAlias } from './resort'

export type CostLevel = 'typed' | 'disney_page' | 'rates_week' | 'rates_month' | 'predicted'

/** Most trusted first. */
export const COST_LEVELS: readonly CostLevel[] = ['typed', 'disney_page', 'rates_week', 'rates_month', 'predicted']

export const COST_LEVEL_WORDS: Record<CostLevel, string> = {
  typed: 'a price we were quoted',
  disney_page: "Disney's own page",
  rates_week: "Disney's rate for the week",
  rates_month: "Disney's rate for the month",
  predicted: "a prediction from Disney's rate a year earlier",
}

/** How sure a price is (D64 (6)). Most sure first. */
export type PriceCertainty = 'definite' | 'list' | 'predicted' | 'unknown'

export const PRICE_CERTAINTIES: readonly PriceCertainty[] = ['definite', 'list', 'predicted', 'unknown']

export const CERTAINTY_WORDS: Record<PriceCertainty, string> = {
  definite: 'Definite',
  list: 'Disney list price',
  predicted: 'Predicted',
  unknown: 'Unknown',
}

const CERTAINTY_OF_LEVEL: Record<CostLevel, PriceCertainty> = {
  typed: 'definite',
  disney_page: 'definite',
  rates_week: 'list',
  rates_month: 'list',
  predicted: 'predicted',
}

/** A level's certainty; no level is unknown. */
export function certaintyOf(level: CostLevel | null): PriceCertainty {
  return level === null ? 'unknown' : CERTAINTY_OF_LEVEL[level]
}

/** Below this many months priced in both years, no year-on-year change is measured. */
export const MIN_YEAR_PAIRS = 3

export const STALE_AFTER_DAYS = 180
export const DISAGREE_PERCENT = 25

export const RESORTINGS_SOURCE = 'resortings'
export const RESORTINGS_URL = 'https://resortings.com/disney-world-resort-prices-by-month'
export const RESORTINGS_CREDIT = { text: 'Prices from resortings.com', url: 'https://resortings.com/' }

// ---------------------------------------------------------------- facts

export interface LodgingRate {
  source: string
  /** "all", "tier:value", or a resort's name. */
  stay: string
  period: 'week' | 'month'
  /** A week's check-in date, or a month's first day. */
  periodStart: CivilDate
  nightlyCents: Cents
  /** When the source captured Disney's price. */
  observedOn: CivilDate
  fetchedOn: CivilDate
  sourceUrl: string
}

export interface LodgingQuote {
  id: string
  stay: string
  fromDate: CivilDate
  /** The last night. */
  toDate: CivilDate
  nightlyCents: Cents
  note: string
  recordedOn: CivilDate
}

/** The key a stay choice is stored and matched under. */
export function stayKey(stay: StayChoice): string {
  if (stay.kind === 'all') return 'all'
  if (stay.kind === 'tier') return `tier:${stay.tier}`
  return stay.name.trim()
}

/** A stored key back to a choice: "tier:moderate" is the moderate tier, anything else not "all" is a resort. */
export function stayFromKey(key: string): StayChoice {
  const k = key.trim()
  if (k === '' || k === 'all') return { kind: 'all' }
  const tier = k.match(/^tier:(value|moderate|deluxe)$/)
  if (tier) return { kind: 'tier', tier: tier[1] as 'value' | 'moderate' | 'deluxe' }
  return { kind: 'resort', name: k }
}

const TIER_WORDS: Record<string, string> = { 'tier:value': 'a value resort', 'tier:moderate': 'a moderate resort', 'tier:deluxe': 'a deluxe resort' }

/** "any Disney resort", "a moderate resort", "Port Orleans Resort - Riverside". */
export function stayWords(key: string): string {
  if (key === 'all') return 'any Disney resort'
  return TIER_WORDS[key] ?? key
}

export function validateLodgingQuote(q: Pick<LodgingQuote, 'stay' | 'fromDate' | 'toDate' | 'nightlyCents'>): void {
  if (!q.stay.trim()) throw new TripPlanError('Say where the quote is for.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(q.toDate)) throw new TripPlanError('A quote needs the first and last night, like 2027-03-04.')
  if (compareDates(q.toDate, q.fromDate) < 0) throw new TripPlanError('The last night cannot be before the first.')
  if (compareDates(q.toDate, q.fromDate) >= 60) throw new TripPlanError('A quote covers at most 60 nights.')
  if (!Number.isInteger(q.nightlyCents) || q.nightlyCents <= 0 || q.nightlyCents > 5_000_00) throw new TripPlanError('A night costs more than $0 and at most $5,000.')
}

export function validateLodgingRate(r: LodgingRate): void {
  if (!r.stay.trim()) throw new TripPlanError('A rate needs a resort or a tier.')
  if (r.period !== 'week' && r.period !== 'month') throw new TripPlanError('A rate is for a week or a month.')
  if (!Number.isInteger(r.nightlyCents) || r.nightlyCents <= 0 || r.nightlyCents > 5_000_00) throw new TripPlanError('A nightly rate is more than $0 and at most $5,000.')
  if (r.period === 'month' && !r.periodStart.endsWith('-01')) throw new TripPlanError("A month's rate starts on the first.")
}

// ---------------------------------------------------------------- the ladder

export interface NightFigure {
  level: CostLevel
  cents: Cents
  /** The day the figure was true: a quote's recording, a rate's capture, a prediction's base rate's capture. */
  asOf: CivilDate
  source: string
  /** How a predicted figure was worked out, in words; null for a figure a source gave as it stands. */
  basis: string | null
}

export interface NightCost {
  date: CivilDate
  /** Null when nothing covers the night. */
  winner: NightFigure | null
  stale: boolean
  /** The next level down, when it is more than DISAGREE_PERCENT away from the winner. */
  disagrees: NightFigure | null
}

function covers(rate: LodgingRate, date: CivilDate): boolean {
  if (rate.period === 'week') return compareDates(rate.periodStart, date) <= 0 && compareDates(date, addDays(rate.periodStart, 6)) <= 0
  return rate.periodStart.slice(0, 7) === date.slice(0, 7)
}

/** Disney's newest rate for a stay covering a night, week before month; null when none does. */
function listRateFor(date: CivilDate, stay: string, rates: readonly LodgingRate[]): LodgingRate | null {
  for (const period of ['week', 'month'] as const) {
    const rate = rates
      .filter((r) => r.stay === stay && r.period === period && covers(r, date))
      .sort((a, b) => compareDates(b.observedOn, a.observedOn))[0]
    if (rate) return rate
  }
  return null
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

/** The same night a year earlier: the same weekday 52 weeks back for a week's rate, the same date for a month's. */
function yearEarlier(date: CivilDate, period: 'week' | 'month'): CivilDate {
  return period === 'week' ? addDays(date, -364) : addMonths(date, -12)
}

/**
 * How much Disney's rate for a stay moved in a year, as the stored rates
 * show it: for each month priced in both years, the later over the
 * earlier, and the median of those. Null below MIN_YEAR_PAIRS months.
 */
export function yearOnYearChange(stay: string, rates: readonly LodgingRate[]): { factor: number; months: number } | null {
  const newest = new Map<CivilDate, LodgingRate>()
  for (const r of rates) {
    if (r.stay !== stay || r.period !== 'month') continue
    const had = newest.get(r.periodStart)
    if (!had || compareDates(r.observedOn, had.observedOn) > 0) newest.set(r.periodStart, r)
  }
  const ratios: number[] = []
  for (const [start, later] of newest) {
    const earlier = newest.get(addMonths(start, -12))
    if (earlier) ratios.push(later.nightlyCents / earlier.nightlyCents)
  }
  if (ratios.length < MIN_YEAR_PAIRS) return null
  return { factor: median(ratios)!, months: ratios.length }
}

/**
 * How the household's own quotes for a stay ran against Disney's rate on
 * the nights both covered: the median of quote over rate, night by night.
 * Null when no quoted night has a rate beside it.
 */
export function quotesAgainstList(stay: string, rates: readonly LodgingRate[], quotes: readonly LodgingQuote[]): { factor: number; nights: number } | null {
  const ratios: number[] = []
  for (const q of quotes) {
    if (q.stay !== stay) continue
    for (let d = q.fromDate; compareDates(d, q.toDate) <= 0; d = addDays(d, 1)) {
      const list = listRateFor(d, stay, rates)
      if (list) ratios.push(q.nightlyCents / list.nightlyCents)
    }
  }
  const m = median(ratios)
  return m === null ? null : { factor: m, nights: ratios.length }
}

function percentWords(factor: number): string {
  const p = Math.round((factor - 1) * 100)
  return p === 0 ? 'no change' : `${Math.abs(p)}% ${p > 0 ? 'up' : 'down'}`
}

/**
 * A night no published rate covers, worked out from Disney's rate a year
 * earlier (the week's, else the month's), the year-on-year change and the
 * quotes' lean. Null when there is no rate a year earlier.
 */
export function predictNight(
  date: CivilDate,
  stay: string,
  rates: readonly LodgingRate[],
  adjust: { yearOnYear: { factor: number; months: number } | null; quotes: { factor: number; nights: number } | null },
): NightFigure | null {
  let base: LodgingRate | null = null
  for (const period of ['week', 'month'] as const) {
    const then = yearEarlier(date, period)
    base = rates
      .filter((r) => r.stay === stay && r.period === period && covers(r, then))
      .sort((a, b) => compareDates(b.observedOn, a.observedOn))[0] ?? null
    if (base) break
  }
  if (!base) return null
  const growth = adjust.yearOnYear?.factor ?? 1
  const lean = adjust.quotes?.factor ?? 1
  const parts = [`Disney's rate for the ${base.period} a year earlier, ${formatCents(base.nightlyCents)} a night`]
  parts.push(
    adjust.yearOnYear
      ? `moved ${percentWords(growth)}, the median change over ${adjust.yearOnYear.months} months priced in both years`
      : 'with no year-on-year change, since too few months are priced in both years to measure one',
  )
  if (adjust.quotes) parts.push(`then ${percentWords(lean)}, where our quotes ran against Disney's rate over ${adjust.quotes.nights} ${adjust.quotes.nights === 1 ? 'night' : 'nights'}`)
  return { level: 'predicted', cents: Math.round(base.nightlyCents * growth * lean), asOf: base.observedOn, source: base.source, basis: parts.join(', ') }
}

/** The best figure at each level for one night, most trusted first; levels with nothing are left out. */
function figuresFor(
  date: CivilDate,
  stay: string,
  rates: readonly LodgingRate[],
  quotes: readonly LodgingQuote[],
  adjust: Parameters<typeof predictNight>[3],
): NightFigure[] {
  const out: NightFigure[] = []
  const quote = quotes
    .filter((q) => q.stay === stay && compareDates(q.fromDate, date) <= 0 && compareDates(date, q.toDate) <= 0)
    .sort((a, b) => compareDates(b.recordedOn, a.recordedOn))[0]
  if (quote) out.push({ level: 'typed', cents: quote.nightlyCents, asOf: quote.recordedOn, source: quote.note || 'typed', basis: null })
  let listed = false
  for (const period of ['week', 'month'] as const) {
    const rate = rates
      .filter((r) => r.stay === stay && r.period === period && covers(r, date))
      .sort((a, b) => compareDates(b.observedOn, a.observedOn))[0]
    if (rate) {
      listed = true
      out.push({ level: period === 'week' ? 'rates_week' : 'rates_month', cents: rate.nightlyCents, asOf: rate.observedOn, source: rate.source, basis: null })
    }
  }
  // A prediction only where Disney has published nothing for the night.
  if (!listed) {
    const predicted = predictNight(date, stay, rates, adjust)
    if (predicted) out.push(predicted)
  }
  return out
}

/**
 * The rates and quotes that are about one stay, each re-keyed to the
 * stay's canonical key (D64): a resort's name in any spelling the resort
 * list can place becomes "resort:<id>", so a quote typed "Pop Century"
 * and Disney's rate for "Pop Century Resort" price the same nights. A name
 * the list cannot place still matches only itself, as before. The facts
 * are not changed: this is a reading of them.
 */
export function priceFactsFor(
  stay: string,
  facts: { rates: readonly LodgingRate[]; quotes: readonly LodgingQuote[] },
  catalogue: { resorts: readonly Resort[]; aliases: readonly ResortAlias[] },
): { stay: string; rates: LodgingRate[]; quotes: LodgingQuote[] } {
  const wanted = canonicalStay(stay, ANY_SOURCE, catalogue)
  return {
    stay: wanted,
    rates: facts.rates.filter((r) => canonicalStay(r.stay, r.source, catalogue) === wanted).map((r) => ({ ...r, stay: wanted })),
    quotes: facts.quotes.filter((q) => canonicalStay(q.stay, ANY_SOURCE, catalogue) === wanted).map((q) => ({ ...q, stay: wanted })),
  }
}

/** Each night's figure by the ladder at the top of this file. */
export function nightCosts(input: {
  nights: readonly CivilDate[]
  stay: string
  rates: readonly LodgingRate[]
  quotes: readonly LodgingQuote[]
  today: CivilDate
}): NightCost[] {
  const adjust = { yearOnYear: yearOnYearChange(input.stay, input.rates), quotes: quotesAgainstList(input.stay, input.rates, input.quotes) }
  return input.nights.map((date) => {
    const [winner, next] = figuresFor(date, input.stay, input.rates, input.quotes, adjust)
    if (!winner) return { date, winner: null, stale: false, disagrees: null }
    const apart = next ? Math.abs(next.cents - winner.cents) * 100 > DISAGREE_PERCENT * winner.cents : false
    return { date, winner, stale: compareDates(input.today, winner.asOf) > STALE_AFTER_DAYS, disagrees: apart ? next! : null }
  })
}

export interface WindowLodging {
  /** Null unless every night has a figure. */
  totalCents: Cents | null
  /** Rounded up, so it never claims a night is cheaper than it is. */
  perNightCents: Cents | null
  nightsKnown: number
  nights: number
  /** The least trusted level any night used. */
  weakest: CostLevel | null
  /** How sure the window's price is: its weakest night's, or unknown until every night is priced. */
  certainty: PriceCertainty
  /** How each predicted night was worked out, each way once. */
  bases: string[]
  stale: boolean
  disagrees: boolean
  /** The oldest figure used, for "Disney's rates, Sep 2026". */
  oldestAsOf: CivilDate | null
}

export function windowLodging(costs: readonly NightCost[]): WindowLodging {
  const known = costs.filter((c) => c.winner !== null)
  const all = known.length === costs.length && costs.length > 0
  const total = known.reduce((s, c) => s + c.winner!.cents, 0)
  const weakest = known.reduce<CostLevel | null>((w, c) => (w === null || COST_LEVELS.indexOf(c.winner!.level) > COST_LEVELS.indexOf(w) ? c.winner!.level : w), null)
  const oldest = known.reduce<CivilDate | null>((o, c) => (o === null || compareDates(c.winner!.asOf, o) < 0 ? c.winner!.asOf : o), null)
  return {
    totalCents: all ? total : null,
    perNightCents: all ? Math.ceil(total / costs.length) : null,
    nightsKnown: known.length,
    nights: costs.length,
    weakest,
    certainty: all ? certaintyOf(weakest) : 'unknown',
    bases: [...new Set(known.map((c) => c.winner!.basis).filter((b): b is string => b !== null))],
    stale: known.some((c) => c.stale),
    disagrees: known.some((c) => c.disagrees !== null),
    oldestAsOf: oldest,
  }
}

// ---------------------------------------------------------------- a window's price

export interface WindowPrice {
  /** The resort nights plus the nights on the road; null until every resort night is known. */
  cents: Cents | null
  lodging: WindowLodging
  roadNights: number
  roadNightCents: Cents
}

/**
 * What a window costs to sleep: each resort night by the ladder, plus each
 * night on the road at the household's hotel-on-the-way figure. Only these
 * change with the dates; tickets and food come to the same for the same
 * number of park days, so the ranking leaves them out (D55 (4)).
 */
export function windowPrice(
  window: Pick<ShapedWindow, 'resortNights' | 'roadNights'>,
  args: { stay: string; rates: readonly LodgingRate[]; quotes: readonly LodgingQuote[]; today: CivilDate; roadNightCents: Cents },
): WindowPrice {
  const lodging = windowLodging(nightCosts({ nights: window.resortNights, stay: args.stay, rates: args.rates, quotes: args.quotes, today: args.today }))
  return {
    cents: lodging.totalCents === null ? null : lodging.totalCents + window.roadNights * args.roadNightCents,
    lodging,
    roadNights: window.roadNights,
    roadNightCents: args.roadNightCents,
  }
}

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthYear(date: CivilDate): string {
  return `${SHORT_MONTH[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`
}

/** The price in the reasons line: "about $327 a night", or what is missing. */
export function priceWords(price: WindowPrice | null): string {
  if (!price || price.lodging.nightsKnown === 0) return 'no price yet'
  if (price.lodging.perNightCents === null) return `prices for ${price.lodging.nightsKnown} of ${price.lodging.nights} nights`
  if (price.lodging.certainty === 'predicted') return `about ${formatCents(price.lodging.perNightCents)} a night, predicted`
  return `about ${formatCents(price.lodging.perNightCents)} a night`
}

/** What a tap on the price says: the weakest source used and how old, the flags, and the nights on the road. */
export function priceDetail(price: WindowPrice | null): string {
  const weakest = price?.lodging.weakest ?? null
  if (!price || weakest === null) return 'No price for these nights yet: paste the resortings.com page or type a quote under Trips.'
  const l = price.lodging
  const parts = [
    `${CERTAINTY_WORDS[l.certainty]}: ${l.nights} ${l.nights === 1 ? 'night' : 'nights'} at the resort, the least sure from ${COST_LEVEL_WORDS[weakest]}${l.oldestAsOf ? `, ${monthYear(l.oldestAsOf)}` : ''}`,
  ]
  if (weakest === 'rates_week' || weakest === 'rates_month' || weakest === 'predicted') parts.push('Disney\'s average a night for a midweek stay, before tax')
  for (const b of l.bases) parts.push(b)
  if (l.stale) parts.push(`a figure is older than ${STALE_AFTER_DAYS} days, so check it`)
  if (l.disagrees) parts.push(`on a night, a quote and Disney's rate or our prediction differ by more than ${DISAGREE_PERCENT}%`)
  if (price.roadNights > 0) parts.push(`${price.roadNights} ${price.roadNights === 1 ? 'night' : 'nights'} on the way at ${formatCents(price.roadNightCents)}`)
  if (price.cents !== null) parts.push(`${formatCents(price.cents)} in all to sleep`)
  return parts.join('; ') + '.'
}

// ---------------------------------------------------------------- resortings.com

export interface ParsedRates {
  rates: Omit<LodgingRate, 'fetchedOn' | 'sourceUrl'>[]
  /** What the figures are, as the page says it. */
  basis: string | null
  reason: string | null
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

function dollarsToCents(text: string | undefined): Cents | null {
  const m = (text ?? '').trim().match(/^\$\s?([\d,]+)(?:\.(\d{2}))?$/)
  if (!m) return null
  const cents = Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2] ?? '0')
  return Number.isFinite(cents) && cents > 0 && cents <= 5_000_00 ? cents : null
}

function monthStart(year: number, month: number): CivilDate {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** Cells of a pasted or fetched table row: tabs, or two spaces or more, between them. */
function cells(line: string): string[] {
  return line.split(/\t| {2,}/).map((c) => c.trim()).filter((c) => c !== '')
}

/**
 * The rates on resortings.com's "prices by month" page, as text: the
 * month-by-month table (all resorts and each tier), every resort's row,
 * and the cheapest and priciest weeks (all resorts, by check-in week). The
 * resort table's columns are months without years; the years come from the
 * first table, which names them. Anything unreadable is left out, and a
 * page with nothing readable is nothing with a reason.
 */
export function parseResortingsPrices(text: string): ParsedRates {
  if (typeof text !== 'string' || text.trim() === '') return { rates: [], basis: null, reason: 'Nothing was pasted.' }
  const html = /<\/?[a-z][^>]*>/i.test(text)
  const plain = html
    ? text
        .replace(/<\/(td|th)>/gi, '\t')
        .replace(/<\/(tr|p|h\d|li|div)>|<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#8217;|&rsquo;/g, '’')
        .replace(/&nbsp;/g, ' ')
    : text
  const lines = plain.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')

  const captured = plain.match(/as published on Disney[’']s own site in ([A-Za-z]+) (\d{4})/i)
  const capturedMonth = captured ? MONTHS[captured[1]!.toLowerCase()] : undefined
  if (!captured || !capturedMonth) return { rates: [], basis: null, reason: 'The page does not say when Disney published these prices, so they cannot be dated.' }
  const observedOn = monthStart(Number(captured[2]), capturedMonth)
  const basisMatch = plain.match(/Disney[’']s own average price per night for an? ([^.]+)\./i)
  const basis = basisMatch ? `Disney's average a night for a ${basisMatch[1]!.trim()}` : null

  const rates: ParsedRates['rates'] = []
  const put = (stay: string, period: 'week' | 'month', periodStart: CivilDate, cents: Cents | null) => {
    if (cents === null) return
    rates.push({ source: RESORTINGS_SOURCE, stay, period, periodStart, nightlyCents: cents, observedOn })
  }

  // The month table: "October 2026  $548  +0%  $206  $335  $698", a tag like "AMONG THE 3 CHEAPEST" allowed after the year.
  const monthYears: { month: number; year: number }[] = []
  for (const line of lines) {
    const c = cells(line)
    const head = c[0]?.match(/^([A-Za-z]+) (\d{4})\b/)
    if (!head || c.length < 6) continue
    const month = MONTHS[head[1]!.toLowerCase()]
    if (!month) continue
    const year = Number(head[2])
    const start = monthStart(year, month)
    put('all', 'month', start, dollarsToCents(c[1]))
    put('tier:value', 'month', start, dollarsToCents(c[3]))
    put('tier:moderate', 'month', start, dollarsToCents(c[4]))
    put('tier:deluxe', 'month', start, dollarsToCents(c[5]))
    monthYears.push({ month, year })
  }

  // Weeks by check-in date: "August 16, 2027  $466".
  for (const line of lines) {
    const c = cells(line)
    const m = c[0]?.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/)
    if (!m || c.length !== 2) continue
    const month = MONTHS[m[1]!.toLowerCase()]
    if (!month) continue
    const date = `${m[3]}-${String(month).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
    put('all', 'week', date, dollarsToCents(c[1]))
  }

  // Every resort, month by month: a header "RESORT  OCT  NOV ..." then a row per resort.
  const headerAt = lines.findIndex((l) => /^RESORT\b/i.test(cells(l)[0] ?? '') && cells(l).slice(1).some((x) => MONTHS[x.toLowerCase()] !== undefined))
  if (headerAt >= 0 && monthYears.length > 0) {
    const header = cells(lines[headerAt]!)
    const yearOf = new Map(monthYears.map((m) => [m.month, m.year]))
    const columns = header.slice(1).map((h) => {
      const month = MONTHS[h.toLowerCase()]
      return month && yearOf.has(month) ? monthStart(yearOf.get(month)!, month) : null
    })
    for (const line of lines.slice(headerAt + 1)) {
      const c = cells(line)
      if (c.length < 3 || !dollarsToCents(c[1])) {
        if (c.length > 0 && /^[A-Z][A-Z ]+$/.test(c[0]!) && rates.length > 0) break
        continue
      }
      columns.forEach((start, i) => {
        if (start) put(c[0]!, 'month', start, dollarsToCents(c[i + 1]))
      })
    }
  }

  if (rates.length === 0) return { rates: [], basis, reason: 'No prices could be read from what was pasted. Copy the whole page, tables included.' }
  return { rates, basis, reason: null }
}

/** The stays a set of rates can price: all resorts, the three tiers, then each resort by name. */
export function staysIn(rates: readonly Pick<LodgingRate, 'stay'>[]): string[] {
  const seen = [...new Set(rates.map((r) => r.stay))]
  const head = ['all', 'tier:value', 'tier:moderate', 'tier:deluxe'].filter((s) => seen.includes(s))
  return [...head, ...seen.filter((s) => !head.includes(s)).sort()]
}

/** A held pull summarised for the screen: how many rates, which stays, which months. */
export function ratesPullSummary(rates: readonly Pick<LodgingRate, 'stay' | 'period' | 'periodStart'>[]): { rates: number; resorts: number; weeks: number; from: CivilDate | null; to: CivilDate | null } {
  const starts = rates.map((r) => r.periodStart).sort(compareDates)
  return {
    rates: rates.length,
    resorts: new Set(rates.filter((r) => r.stay !== 'all' && !r.stay.startsWith('tier:')).map((r) => r.stay)).size,
    weeks: rates.filter((r) => r.period === 'week').length,
    from: starts[0] ?? null,
    to: starts[starts.length - 1] ?? null,
  }
}
