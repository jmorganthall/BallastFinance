/**
 * What a night costs (PRD D55 (5)): the ladder from a typed quote down to
 * Disney's rate for the month, the flags a tap shows, a window's lodging,
 * and resortings.com's page read as a person pastes it. The page below is
 * the one the household pasted on 2026-10-30, trimmed to a few resorts;
 * resortings.com allows reproducing it with a link.
 */

import { describe, expect, it } from 'vitest'
import {
  nightCosts,
  parseResortingsPrices,
  priceDetail,
  priceWords,
  stayFromKey,
  windowPrice,
  ratesPullSummary,
  staysIn,
  stayKey,
  validateLodgingQuote,
  windowLodging,
  type LodgingQuote,
  type LodgingRate,
} from '../night-cost'
import { TripPlanError } from '../trip-plan'

const PASTED = [
  'What a night costs, month by month',
  'MONTH\tALL RESORTS\tVS YEAR\tVALUE\tMODERATE\tDELUXE',
  'October 2026\t$548\t+0%\t$206\t$335\t$698',
  'November 2026\t$555\t+1%\t$219\t$353\t$701',
  'December 2026\t$716\t+30%\t$292\t$411\t$910',
  'January 2027 AMONG THE 3 CHEAPEST\t$494\t-10%\t$173\t$294\t$633',
  'February 2027\t$547\t+0%\t$211\t$328\t$696',
  'March 2027\t$619\t+13%\t$254\t$363\t$784',
  'April 2027\t$565\t+3%\t$218\t$330\t$719',
  'May 2027\t$519\t-5%\t$213\t$310\t$658',
  'June 2027\t$512\t-7%\t$220\t$308\t$646',
  'July 2027 AMONG THE 3 CHEAPEST\t$486\t-11%\t$220\t$308\t$607',
  'August 2027 AMONG THE 3 CHEAPEST\t$473\t-14%\t$192\t$309\t$596',
  'Year average\t$549\t-\t$220\t$332\t$695',
  'The cheapest and priciest weeks',
  'Months hide the detail. Priced by check-in week, the spread widens to 64%. These are the six cheapest and the four priciest weeks in the collected year.',
  'CHEAPEST WEEKS\tAVERAGE A NIGHT',
  'August 16, 2027\t$466',
  'August 23, 2027\t$466',
  'September 6, 2027\t$473',
  'PRICIEST WEEKS\tAVERAGE A NIGHT',
  'December 28, 2026\t$765',
  'March 29, 2027\t$676',
  'Every resort, month by month',
  'Jump to a resort',
  'RESORT\tOCT\tNOV\tDEC\tJAN\tFEB\tMAR\tAPR\tMAY\tJUN\tJUL\tAUG\tYEAR\tROOM ALERT',
  'Grand Floridian Resort & Spa\t$904\t$907\t$1144\t$850\t$886\t$1001\t$899\t$851\t$836\t$791\t$789\t$896\tWatch',
  'Port Orleans Resort - Riverside\t$337\t$353\t$407\t$302\t$338\t$369\t$336\t$308\t$312\t$312\t$312\t$335\tWatch',
  'All-Star Sports Resort\t$167\t$178\t$252\t$141\t$175\t$216\t$179\t$175\t$187\t$187\t$156\t$183\tWatch',
  'The Campsites at Fort Wilderness Resort\t$115\t$121\t$176\t$113\t$121\t$176\t$167\t$116\t$124\t$108\t$75\t$128\tWatch',
  'How far each resort moves across the year',
  'The figure usually published for this is 30 to 50 percent.',
  'RESORT\tCHEAPEST WEEK\tPRICIEST WEEK\tSWING',
  'The Campsites at Fort Wilderness Resort\t$75\t$193\t157%',
  'All-Star Sports Resort\t$141\t$274\t94%',
  'What these figures are',
  'Every figure is Disney’s own average price per night for a four-night midweek stay, two adults, standard room, room only, before tax, as published on Disney’s own site in September 2026. Nothing here is estimated or modeled.',
  'Anyone is welcome to cite or reproduce this table with a link to resortings.com.',
].join('\n')

const TODAY = '2026-10-31'

const rate = (stay: string, period: 'week' | 'month', periodStart: string, dollars: number, observedOn = '2026-09-01'): LodgingRate => ({
  source: 'resortings',
  stay,
  period,
  periodStart,
  nightlyCents: dollars * 100,
  observedOn,
  fetchedOn: TODAY,
  sourceUrl: 'https://resortings.com/',
})

const quote = (fromDate: string, toDate: string, dollars: number, recordedOn = TODAY, stay = 'tier:moderate'): LodgingQuote => ({
  id: `${fromDate}-${dollars}`,
  stay,
  fromDate,
  toDate,
  nightlyCents: dollars * 100,
  note: 'Phone quote',
  recordedOn,
})

describe('resortings.com, pasted', () => {
  const parsed = parseResortingsPrices(PASTED)
  const find = (stay: string, period: string, start: string) => parsed.rates.find((r) => r.stay === stay && r.period === period && r.periodStart === start)

  it('reads the month table for all resorts and each tier, dated by when Disney published them', () => {
    expect(parsed.reason).toBeNull()
    expect(parsed.basis).toBe("Disney's average a night for a four-night midweek stay, two adults, standard room, room only, before tax, as published on Disney’s own site in September 2026")
    expect(parsed.rates.filter((r) => r.stay === 'all' && r.period === 'month')).toHaveLength(11)
    expect(find('tier:moderate', 'month', '2027-01-01')).toMatchObject({ nightlyCents: 294_00, observedOn: '2026-09-01', source: 'resortings' })
    expect(find('tier:value', 'month', '2027-08-01')?.nightlyCents).toBe(192_00)
    expect(find('Year average', 'month', '2026-10-01')).toBeUndefined()
  })

  it('reads each resort by month, the years from the first table, and leaves the swing table alone', () => {
    expect(find('Port Orleans Resort - Riverside', 'month', '2027-01-01')?.nightlyCents).toBe(302_00)
    expect(find('Grand Floridian Resort & Spa', 'month', '2026-12-01')?.nightlyCents).toBe(1144_00)
    expect(parsed.rates.filter((r) => r.stay === 'The Campsites at Fort Wilderness Resort')).toHaveLength(11)
    expect(parsed.rates.some((r) => r.stay === 'RESORT')).toBe(false)
  })

  it('reads the cheapest and priciest weeks as all-resort weeks by check-in date', () => {
    expect(find('all', 'week', '2027-08-16')?.nightlyCents).toBe(466_00)
    expect(find('all', 'week', '2026-12-28')?.nightlyCents).toBe(765_00)
    expect(parsed.rates.filter((r) => r.period === 'week')).toHaveLength(5)
  })

  it('reads the same page as HTML', () => {
    const html = `<table><tr><th>MONTH</th><th>ALL RESORTS</th></tr><tr><td>October 2026</td><td>$548</td><td>+0%</td><td>$206</td><td>$335</td><td>$698</td></tr></table><p>Every figure is Disney&#8217;s own average price per night for a four-night midweek stay, as published on Disney&#8217;s own site in September 2026.</p>`
    expect(parseResortingsPrices(html).rates.find((r) => r.stay === 'tier:deluxe')?.nightlyCents).toBe(698_00)
  })

  it('is nothing with a reason for garbage, an empty paste, or a page that does not say when', () => {
    expect(parseResortingsPrices('').reason).toMatch(/Nothing/)
    expect(parseResortingsPrices('hello\tworld').reason).toMatch(/when Disney published/)
    expect(parseResortingsPrices('as published on Disney’s own site in September 2026. nothing else').reason).toMatch(/No prices/)
  })

  it('lists the stays it can price and sums the pull for the screen', () => {
    expect(staysIn(parsed.rates).slice(0, 5)).toEqual(['all', 'tier:value', 'tier:moderate', 'tier:deluxe', 'All-Star Sports Resort'])
    expect(ratesPullSummary(parsed.rates)).toMatchObject({ resorts: 4, weeks: 5, from: '2026-10-01', to: '2027-09-06' })
  })
})

describe('the ladder', () => {
  const rates = [rate('tier:moderate', 'month', '2027-03-01', 363), rate('tier:moderate', 'week', '2027-03-01', 400), rate('tier:moderate', 'month', '2027-03-01', 380, '2026-10-15')]

  it('takes a typed quote over a week, a week over a month, and the newest within a level', () => {
    const costs = nightCosts({ nights: ['2027-03-03', '2027-03-08', '2027-03-20'], stay: 'tier:moderate', rates, quotes: [quote('2027-03-03', '2027-03-03', 310)], today: TODAY })
    expect(costs.map((c) => [c.winner?.level, c.winner?.cents])).toEqual([
      ['typed', 310_00],
      ['rates_month', 380_00],
      ['rates_month', 380_00],
    ])
    // The week starting Mar 1 covers through Mar 7, so the 8th falls to the month.
    expect(nightCosts({ nights: ['2027-03-07'], stay: 'tier:moderate', rates, quotes: [], today: TODAY })[0]!.winner?.level).toBe('rates_week')
  })

  it('matches the stay exactly: a resort quote does not price a tier', () => {
    const costs = nightCosts({ nights: ['2027-04-02'], stay: 'tier:moderate', rates: [], quotes: [quote('2027-04-01', '2027-04-05', 250, TODAY, 'Port Orleans Resort - Riverside')], today: TODAY })
    expect(costs[0]!.winner).toBeNull()
  })

  it('shows the next level down when it is more than 25% away, and flags a figure older than 180 days', () => {
    const [far] = nightCosts({ nights: ['2027-03-03'], stay: 'tier:moderate', rates, quotes: [quote('2027-03-03', '2027-03-03', 290)], today: TODAY })
    expect(far!.disagrees).toMatchObject({ level: 'rates_week', cents: 400_00 })
    const [near] = nightCosts({ nights: ['2027-03-03'], stay: 'tier:moderate', rates, quotes: [quote('2027-03-03', '2027-03-03', 330)], today: TODAY })
    expect(near!.disagrees).toBeNull()
    const [old] = nightCosts({ nights: ['2027-03-20'], stay: 'tier:moderate', rates, quotes: [], today: '2027-04-20' })
    expect(old!.stale).toBe(true)
  })

  it("prices a window only when every night is known, rounds the night up, and says its weakest level", () => {
    const all = windowLodging(nightCosts({ nights: ['2027-03-03', '2027-03-04', '2027-03-08'], stay: 'tier:moderate', rates, quotes: [quote('2027-03-03', '2027-03-04', 301)], today: TODAY }))
    expect(all).toMatchObject({ totalCents: 982_00, perNightCents: 32734, weakest: 'rates_month', nightsKnown: 3, oldestAsOf: '2026-10-15' })
    const part = windowLodging(nightCosts({ nights: ['2027-03-03', '2027-05-01'], stay: 'tier:moderate', rates, quotes: [], today: TODAY }))
    expect(part).toMatchObject({ totalCents: null, perNightCents: null, nightsKnown: 1, nights: 2 })
  })

  it('keys a stay choice the way rates and quotes are stored', () => {
    expect(stayKey({ kind: 'all' })).toBe('all')
    expect(stayKey({ kind: 'tier', tier: 'deluxe' })).toBe('tier:deluxe')
    expect(stayKey({ kind: 'resort', name: ' Pop Century Resort ' })).toBe('Pop Century Resort')
  })

  it('refuses a quote that cannot be a price for nights', () => {
    expect(() => validateLodgingQuote({ stay: 'all', fromDate: '2027-03-05', toDate: '2027-03-04', nightlyCents: 100_00 })).toThrow(TripPlanError)
    expect(() => validateLodgingQuote({ stay: 'all', fromDate: '2027-03-01', toDate: '2027-03-04', nightlyCents: 0 })).toThrow(/more than \$0/)
  })
})

describe("a window's price", () => {
  const rates = [rate('tier:moderate', 'month', '2027-03-01', 363)]
  const args = { stay: 'tier:moderate', rates, quotes: [], today: TODAY, roadNightCents: 150_00 }

  it('adds the nights on the road to the resort nights, and is nothing until every resort night is known', () => {
    const p = windowPrice({ resortNights: ['2027-03-03', '2027-03-04', '2027-03-05'], roadNights: 1 }, args)
    expect(p.cents).toBe(3 * 363_00 + 150_00)
    expect(priceWords(p)).toBe('about $363.00 a night')
    expect(priceDetail(p)).toBe(
      "3 nights at the resort, the least sure from Disney's rate for the month, Sep 2026; Disney's average a night for a midweek stay, before tax; 1 night on the way at $150.00; $1,239.00 in all to sleep.",
    )
    const part = windowPrice({ resortNights: ['2027-03-31', '2027-04-01'], roadNights: 0 }, args)
    expect(part.cents).toBeNull()
    expect(priceWords(part)).toBe('prices for 1 of 2 nights')
    expect(priceWords(windowPrice({ resortNights: ['2027-05-01'], roadNights: 0 }, args))).toBe('no price yet')
    expect(priceDetail(null)).toMatch(/paste the resortings.com page/)
  })

  it('reads a stored stay key back to a choice', () => {
    expect(stayFromKey('all')).toEqual({ kind: 'all' })
    expect(stayFromKey('tier:value')).toEqual({ kind: 'tier', tier: 'value' })
    expect(stayFromKey('Pop Century Resort')).toEqual({ kind: 'resort', name: 'Pop Century Resort' })
  })
})
