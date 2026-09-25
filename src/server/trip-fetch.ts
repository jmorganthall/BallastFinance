/**
 * The two trip fetches (PRD §16, D20), on the D14 pattern: public, key-free,
 * nothing to leak, and optional -- TRIP_FETCH=off keeps a machine off the
 * internet, and the figures are typed instead.
 *
 * - The drive: distance and time from the OSRM public router.
 * - The gas price: the weekly US regular average from FRED's public CSV.
 *
 * Nothing Disney sells is fetched: there is no public API and the terms
 * forbid scraping. Flights and rentals are typed too (no open API remains).
 *
 * What comes back is read by the domain module (parseOsrmRoute,
 * parseGasPriceCsv), which refuses anything that does not look like a route
 * or a price: a changed format or a proxy's error page must not become a
 * figure a plan sets money aside for. A failure here is shown on the screen,
 * never stored and never thrown past the action.
 */

import {
  DESTINATIONS,
  GAS_PRICE_SERIES,
  parseGasPriceCsv,
  parseOsrmRoute,
  type CivilDate,
  type DriveEstimate,
  type GasPrice,
  type HomeLocation,
  type TripDestination,
} from '@/domain'

export const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving'
export const GAS_PRICE_CSV_URL = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${GAS_PRICE_SERIES}`

export function tripFetchEnabled(): boolean {
  return (process.env.TRIP_FETCH ?? 'on').toLowerCase() !== 'off'
}

/** OSRM takes lon,lat pairs; a swapped pair silently routes across the ocean. */
export function osrmRouteUrl(home: HomeLocation, destination: TripDestination): string {
  const to = DESTINATIONS[destination]
  const point = (p: HomeLocation) => `${p.longitude.toFixed(5)},${p.latitude.toFixed(5)}`
  return `${OSRM_BASE_URL}/${point(home)};${point(to)}?overview=false`
}

export async function fetchDrive(
  home: HomeLocation,
  destination: TripDestination,
  today: CivilDate,
  fetchImpl: typeof fetch = fetch,
): Promise<DriveEstimate | null> {
  const response = await fetchImpl(osrmRouteUrl(home, destination), {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json' },
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
    headers: { accept: 'text/csv' },
  })
  if (!response.ok) throw new Error(`FRED answered ${response.status}`)
  return parseGasPriceCsv(await response.text())
}
