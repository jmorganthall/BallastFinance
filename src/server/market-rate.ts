/**
 * The weekly mortgage-rate fetch (PRD §15, D14).
 *
 * Freddie Mac's 30-year fixed average, from FRED's public CSV: no key, no
 * account, nothing to leak. This is the only outbound call the app makes for
 * data, and it is optional -- set MARKET_RATE_FETCH=off on a machine that
 * should not reach the internet, and type a rate on the screen instead.
 *
 * What came back is read by the derivation module (parseFredCsv), which
 * refuses anything that does not look like a mortgage rate: a changed format
 * or a proxy's error page must not become the rate a house price rests on.
 */

import { MORTGAGE_RATE_SERIES, parseFredCsv, type MarketRate } from '@/domain'

export const FRED_CSV_URL = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${MORTGAGE_RATE_SERIES}`

export function marketRateFetchEnabled(): boolean {
  return (process.env.MARKET_RATE_FETCH ?? 'on').toLowerCase() !== 'off'
}

export async function fetchMarketMortgageRate(fetchImpl: typeof fetch = fetch): Promise<MarketRate | null> {
  const response = await fetchImpl(FRED_CSV_URL, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'text/csv' },
  })
  if (!response.ok) throw new Error(`FRED answered ${response.status}`)
  return parseFredCsv(await response.text())
}
