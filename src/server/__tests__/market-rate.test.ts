import { describe, expect, it } from 'vitest'
import { FRED_CSV_URL, fetchMarketMortgageRate } from '../market-rate'

const csvResponse = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch

describe('the weekly rate fetch', () => {
  it('asks FRED for the 30-year series and reads the latest week', async () => {
    let asked = ''
    const fake = (async (url: string) => {
      asked = url
      return new Response('observation_date,MORTGAGE30US\n2026-09-17,6.26\n')
    }) as unknown as typeof fetch
    expect(await fetchMarketMortgageRate(fake)).toMatchObject({ rateBasisPoints: 626, observedOn: '2026-09-17' })
    expect(asked).toBe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US')
    expect(FRED_CSV_URL).toBe(asked)
  })

  it('throws on an error status, so the last good rate stays', async () => {
    await expect(fetchMarketMortgageRate(csvResponse('nope', 503))).rejects.toThrow('503')
  })

  it('returns nothing for a page that is not the CSV', async () => {
    expect(await fetchMarketMortgageRate(csvResponse('<html>captive portal</html>'))).toBeNull()
  })
})
