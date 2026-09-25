/**
 * The trip fetches (PRD §16, D20, D23, D24), on the D14 pattern: public,
 * key-free, nothing to leak, and optional -- TRIP_FETCH=off keeps a machine
 * off the internet, and the figures are typed instead.
 *
 * - The drive: distance and time from the OSRM public router.
 * - The gas price: the weekly US regular average from FRED's public CSV.
 * - Where home is: the address geocoded once, on save, through Nominatim.
 * - How busy: a public crowd calendar, on a button press, shown before kept.
 *
 * Nothing Disney sells is fetched: there is no public API and the terms
 * forbid scraping. Flights and rentals are typed too (no open API remains).
 * TouringPlans is subscriber-only and not fetched.
 *
 * What comes back is read by the domain module (parseOsrmRoute,
 * parseGasPriceCsv, parseNominatim, the crowd parsers), which refuses
 * anything that does not look like what was asked for: a changed format or
 * a proxy's error page must not become a figure a plan sets money aside
 * for, or a home the drive is measured from. A failure here is shown on the
 * screen, never stored and never thrown past the action.
 *
 * Every request carries this app's own User-Agent, as Nominatim's usage
 * policy asks, and Nominatim is asked at most once a second.
 */

import {
  CROWD_SOURCES,
  DESTINATIONS,
  GAS_PRICE_SERIES,
  nominatimUrl,
  parseGasPriceCsv,
  parseNominatim,
  parseOsrmRoute,
  type CivilDate,
  type CrowdSource,
  type DriveEstimate,
  type GasPrice,
  type GeocodeResult,
  type LocatedHome,
  type ParsedCrowd,
  type TripDestination,
} from '@/domain'

export const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving'
export const GAS_PRICE_CSV_URL = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${GAS_PRICE_SERIES}`

export function tripFetchEnabled(): boolean {
  return (process.env.TRIP_FETCH ?? 'on').toLowerCase() !== 'off'
}

/** "BallastFinance/0.3.0 (self-hosted family planner)": who is asking, so a public service can tell. */
export function userAgent(version: string | undefined = process.env.BALLAST_VERSION): string {
  return `BallastFinance/${version?.trim() || 'dev'} (self-hosted family planner)`
}

/** OSRM takes lon,lat pairs; a swapped pair silently routes across the ocean. */
export function osrmRouteUrl(home: LocatedHome, destination: TripDestination): string {
  const to = DESTINATIONS[destination]
  const point = (p: LocatedHome) => `${p.longitude.toFixed(5)},${p.latitude.toFixed(5)}`
  return `${OSRM_BASE_URL}/${point(home)};${point(to)}?overview=false`
}

export async function fetchDrive(
  home: LocatedHome,
  destination: TripDestination,
  today: CivilDate,
  fetchImpl: typeof fetch = fetch,
): Promise<DriveEstimate | null> {
  const response = await fetchImpl(osrmRouteUrl(home, destination), {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'user-agent': userAgent() },
  })
  if (!response.ok) throw new Error(`The route service answered ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  return parseOsrmRoute(body, today)
}

export async function fetchGasPrice(fetchImpl: typeof fetch = fetch): Promise<GasPrice | null> {
  const response = await fetchImpl(GAS_PRICE_CSV_URL, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'text/csv', 'user-agent': userAgent() },
  })
  if (!response.ok) throw new Error(`FRED answered ${response.status}`)
  return parseGasPriceCsv(await response.text())
}

// ---------------------------------------------------------------- where home is (D24)

/** Nominatim's usage policy: no more than one request a second. */
export const NOMINATIM_MIN_GAP_MS = 1_000

let lastNominatimAt = 0
const geocodeCache = new Map<string, GeocodeResult | null>()

/** For tests: forget the last call and everything cached. */
export function resetGeocoder(): void {
  lastNominatimAt = 0
  geocodeCache.clear()
}

/**
 * The point for an address, asked once: the same address again comes from
 * memory, and two different ones are a second apart. Nothing is sent
 * anywhere except when a person saves the address.
 */
export async function geocodeAddress(
  address: string,
  fetchImpl: typeof fetch = fetch,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<GeocodeResult | null> {
  const key = address.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!key) return null
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null
  const wait = lastNominatimAt + NOMINATIM_MIN_GAP_MS - clock.now()
  if (wait > 0) await clock.sleep(wait)
  lastNominatimAt = clock.now()
  const response = await fetchImpl(nominatimUrl(address), {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'user-agent': userAgent() },
  })
  if (!response.ok) throw new Error(`The map service answered ${response.status}`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  const result = parseNominatim(body)
  geocodeCache.set(key, result)
  return result
}

// ---------------------------------------------------------------- how busy (D23)

export interface CrowdFetch extends ParsedCrowd {
  source: CrowdSource
  url: string
}

/** One source, one month: the page read by that source's own parser. An error status is thrown; an unreadable page is nothing with a reason. */
export async function fetchCrowdCalendar(
  source: CrowdSource,
  destination: TripDestination,
  month: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CrowdFetch> {
  const url = source.url(destination, month)
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'text/html, application/json', 'user-agent': userAgent() },
  })
  if (!response.ok) throw new Error(`${source.label} answered ${response.status}`)
  return { source, url, ...source.parse(await response.text(), month) }
}

export interface CrowdPullResult {
  /** The source that gave something, or null when none did. */
  source: CrowdSource | null
  levels: CrowdFetch['levels']
  /** What each source said, in order tried, for the screen. */
  notes: string[]
}

/**
 * The sources in order (D23): the first that reads as a crowd calendar for
 * every month asked wins. Each source's failure is a line for the screen,
 * never an exception.
 */
export async function pullCrowdCalendar(
  destination: TripDestination,
  months: readonly string[],
  fetchImpl: typeof fetch = fetch,
  sources: readonly CrowdSource[] = CROWD_SOURCES,
): Promise<CrowdPullResult> {
  const notes: string[] = []
  for (const source of sources) {
    const levels: CrowdFetch['levels'] = []
    let failed: string | null = null
    for (const month of months) {
      try {
        const got = await fetchCrowdCalendar(source, destination, month, fetchImpl)
        if (got.levels.length === 0) {
          failed = `${source.label}: ${got.reason ?? 'nothing for ' + month}`
          break
        }
        levels.push(...got.levels)
      } catch (error) {
        failed = `${source.label}: ${(error as Error).message}`
        break
      }
    }
    if (failed) {
      notes.push(failed)
      continue
    }
    notes.push(`${source.label}: ${levels.length} park-days read.`)
    return { source, levels, notes }
  }
  return { source: null, levels: [], notes }
}
