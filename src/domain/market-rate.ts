/**
 * The mortgage rate the next-home figures use (PRD §15, D14).
 *
 * The weekly 30-year fixed average from Freddie Mac's survey, as FRED
 * publishes it (series MORTGAGE30US), unless the household has typed a rate --
 * a lender's quote beats a national average for the family holding it. The
 * fetch lives in the server layer; reading what came back is here, so the
 * format it depends on is tested without a network.
 */

import { compareDates, type CivilDate } from './dates'
import { parsePercentOrNull } from './money'

export const MORTGAGE_RATE_SERIES = 'MORTGAGE30US'

export interface MarketRate {
  rateBasisPoints: number
  /** The week the survey describes, not when it was fetched. */
  observedOn: CivilDate
  series: string
}

export interface RateInUse {
  rateBasisPoints: number
  source: 'typed' | 'weekly_average'
  /** For the weekly average: the week it describes. */
  observedOn: CivilDate | null
  /** The average is weekly; one more than a fortnight old means the fetch has stopped. */
  stale: boolean
}

/** Two missed weekly releases. */
export const MARKET_RATE_STALE_AFTER_DAYS = 14

/**
 * The latest observation in FRED's graph CSV.
 *
 * The file is a header row then `YYYY-MM-DD,value` rows, oldest first. The
 * header's first column has been renamed before (DATE, observation_date), so
 * it is skipped rather than matched. A missing week is written as "." or left
 * blank and is passed over. Anything that is not a plausible mortgage rate
 * (0%-25%) is refused: a figure that decides a house price is not taken on
 * trust from a format change.
 */
export function parseFredCsv(text: string, series: string = MORTGAGE_RATE_SERIES): MarketRate | null {
  const rows = text.split(/\r?\n/).slice(1)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const [date = '', value = ''] = rows[i]!.split(',').map((cell) => cell.trim())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const rateBasisPoints = parsePercentOrNull(value)
    if (rateBasisPoints === null) continue
    if (rateBasisPoints <= 0 || rateBasisPoints > 2500) return null
    return { rateBasisPoints, observedOn: date, series }
  }
  return null
}

export function rateInUse(args: {
  typedBasisPoints: number | null
  market: MarketRate | null
  today: CivilDate
}): RateInUse | null {
  if (args.typedBasisPoints !== null) {
    return { rateBasisPoints: args.typedBasisPoints, source: 'typed', observedOn: null, stale: false }
  }
  if (!args.market) return null
  return {
    rateBasisPoints: args.market.rateBasisPoints,
    source: 'weekly_average',
    observedOn: args.market.observedOn,
    stale: compareDates(args.today, args.market.observedOn) > MARKET_RATE_STALE_AFTER_DAYS,
  }
}
