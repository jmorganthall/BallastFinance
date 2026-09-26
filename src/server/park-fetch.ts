/**
 * Ballast's own park data pulls (PRD §16, D28), on the D14 pattern: public,
 * key-free, nothing to leak, and optional -- PARK_DATA_FETCH=off keeps a
 * machine off the internet and the calendar shows what it has.
 *
 * - Weather: Open-Meteo (free for non-commercial use). The forecast to 16
 *   days, the sub-seasonal outlook to about six weeks from its seasonal
 *   endpoint, and ten years of daily archive for what is typical on a date.
 * - Park hours: ThemeParks.wiki, the four parks' ids found once from the
 *   destination's children and kept in a setting.
 * - The forward crowd outlook: RopeDrop Planner's public JSON, from a
 *   setting, read defensively.
 * - Live waits: Queue-Times, polled every few minutes. Their data appears
 *   with "Powered by Queue-Times.com" wherever it is shown.
 *
 * DVC availability stays where D26 put it (trip-fetch.ts); there is no
 * second source here.
 *
 * Every request carries this app's own User-Agent and asks for JSON. No
 * request sets an origin or a referer, and nothing here calls an endpoint a
 * site's own front end uses privately: each URL is the one the service
 * documents for the public. What comes back is read by the domain parsers
 * (park-data.ts), which refuse anything that does not look like what was
 * asked for; a failure is a line in the log or on the screen, never a row.
 *
 * None of these hosts is reachable from the build sandbox: every adapter is
 * tested against a fake fetch and hand-written fixtures from the documented
 * response shapes.
 */

import {
  DESTINATIONS,
  addDays,
  parseOpenMeteoDaily,
  parseOpenMeteoSeasonal,
  parseQueueTimesParks,
  parseQueueTimesWaits,
  parseRopeDropOutlook,
  parseThemeParksChildren,
  parseThemeParksSchedule,
  THEMEPARKS_WDW_DESTINATION_ID,
  type CivilDate,
  type Parsed,
  type ParsedOutlookLevel,
  type ParsedParkHours,
  type ParsedWeatherDay,
  type ResolvedPark,
  type TripDestination,
  type WaitObservation,
  type WaitParkNames,
} from '@/domain'
import { userAgent } from '@/server/trip-fetch'

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
export const OPEN_METEO_SEASONAL_URL = 'https://seasonal-api.open-meteo.com/v1/seasonal'
export const OPEN_METEO_ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
export const THEMEPARKS_API_URL = 'https://api.themeparks.wiki/v1'
export const QUEUE_TIMES_PARKS_URL = 'https://queue-times.com/parks.json'
/** RopeDrop Planner documents a developer feed at /developers; this is the best reading of it, and a setting lays over it. */
export const DEFAULT_ROPEDROP_OUTLOOK_URL = 'https://ropedropplanner.com/api/crowd-calendar/walt-disney-world.json'

export const FORECAST_DAYS = 16
export const ARCHIVE_YEARS = 10
export const HOURS_DAYS_AHEAD = 180

/** The ThemeParks.wiki destination for each place the planner knows. */
export const THEMEPARKS_DESTINATION_IDS: Record<TripDestination, string> = { wdw: THEMEPARKS_WDW_DESTINATION_ID }

export function parkDataFetchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PARK_DATA_FETCH ?? 'on').toLowerCase() !== 'off'
}

async function getJson(url: string, fetchImpl: typeof fetch, who: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'user-agent': userAgent() },
  })
  if (!response.ok) throw new Error(`${who} answered ${response.status}`)
  try {
    return await response.json()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- weather

export function openMeteoForecastUrl(destination: TripDestination): string {
  const at = DESTINATIONS[destination]
  const q = new URLSearchParams({
    latitude: at.latitude.toFixed(4),
    longitude: at.longitude.toFixed(4),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    temperature_unit: 'fahrenheit',
    timezone: at.timezone,
    forecast_days: String(FORECAST_DAYS),
  })
  return `${OPEN_METEO_FORECAST_URL}?${q}`
}

export function openMeteoSeasonalUrl(destination: TripDestination): string {
  const at = DESTINATIONS[destination]
  const q = new URLSearchParams({
    latitude: at.latitude.toFixed(4),
    longitude: at.longitude.toFixed(4),
    daily: 'temperature_2m_max,temperature_2m_min',
    temperature_unit: 'fahrenheit',
    timezone: at.timezone,
  })
  return `${OPEN_METEO_SEASONAL_URL}?${q}`
}

export function openMeteoArchiveUrl(destination: TripDestination, from: CivilDate, to: CivilDate): string {
  const at = DESTINATIONS[destination]
  const q = new URLSearchParams({
    latitude: at.latitude.toFixed(4),
    longitude: at.longitude.toFixed(4),
    start_date: from,
    end_date: to,
    daily: 'temperature_2m_max,temperature_2m_min',
    temperature_unit: 'fahrenheit',
    timezone: at.timezone,
  })
  return `${OPEN_METEO_ARCHIVE_URL}?${q}`
}

export async function fetchForecast(destination: TripDestination, fetchImpl: typeof fetch = fetch): Promise<Parsed<ParsedWeatherDay>> {
  return parseOpenMeteoDaily(await getJson(openMeteoForecastUrl(destination), fetchImpl, 'The weather service'))
}

export async function fetchSubseasonal(destination: TripDestination, fetchImpl: typeof fetch = fetch): Promise<Parsed<ParsedWeatherDay>> {
  return parseOpenMeteoSeasonal(await getJson(openMeteoSeasonalUrl(destination), fetchImpl, 'The seasonal service'))
}

/** The archive window for what is typical: the ten years ending a week ago (the archive lags a few days). */
export function archiveWindow(today: CivilDate, years: number = ARCHIVE_YEARS): { from: CivilDate; to: CivilDate } {
  const to = addDays(today, -7)
  const from: CivilDate = `${Number(to.slice(0, 4)) - years}${to.slice(4)}`
  return { from: from.endsWith('02-29') ? `${from.slice(0, 8)}28` : from, to }
}

export async function fetchArchive(destination: TripDestination, today: CivilDate, fetchImpl: typeof fetch = fetch): Promise<Parsed<ParsedWeatherDay>> {
  const { from, to } = archiveWindow(today)
  return parseOpenMeteoDaily(await getJson(openMeteoArchiveUrl(destination, from, to), fetchImpl, 'The weather archive'))
}

// ---------------------------------------------------------------- park hours

export function themeParksChildrenUrl(destination: TripDestination): string {
  return `${THEMEPARKS_API_URL}/entity/${THEMEPARKS_DESTINATION_IDS[destination]}/children`
}

export function themeParksScheduleUrl(entityId: string): string {
  return `${THEMEPARKS_API_URL}/entity/${encodeURIComponent(entityId)}/schedule`
}

export async function fetchThemeParksChildren(destination: TripDestination, fetchImpl: typeof fetch = fetch): Promise<ReturnType<typeof parseThemeParksChildren>> {
  return parseThemeParksChildren(await getJson(themeParksChildrenUrl(destination), fetchImpl, 'The park service'))
}

export async function fetchThemeParksSchedule(entityId: string, fetchImpl: typeof fetch = fetch): Promise<Parsed<ParsedParkHours>> {
  return parseThemeParksSchedule(await getJson(themeParksScheduleUrl(entityId), fetchImpl, 'The park service'))
}

// ---------------------------------------------------------------- the crowd outlook

export async function fetchRopeDropOutlook(url: string, fetchImpl: typeof fetch = fetch): Promise<Parsed<ParsedOutlookLevel>> {
  if (!/^https?:\/\//.test(url)) return { rows: [], reason: 'The outlook link is not a web address.' }
  return parseRopeDropOutlook(await getJson(url, fetchImpl, 'The crowd outlook'))
}

// ---------------------------------------------------------------- live waits

export function queueTimesWaitsUrl(parkId: string): string {
  return `https://queue-times.com/parks/${encodeURIComponent(parkId)}/queue_times.json`
}

export async function fetchQueueTimesParks(
  wanted: WaitParkNames,
  group: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReturnType<typeof parseQueueTimesParks>> {
  return parseQueueTimesParks(await getJson(QUEUE_TIMES_PARKS_URL, fetchImpl, 'The wait service'), wanted, group)
}

export async function fetchQueueTimesWaits(park: ResolvedPark, fetchImpl: typeof fetch = fetch): Promise<Parsed<WaitObservation>> {
  return parseQueueTimesWaits(await getJson(queueTimesWaitsUrl(park.id), fetchImpl, 'The wait service'), { parkId: park.id, parkName: park.name })
}
