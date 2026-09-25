import { describe, expect, it } from 'vitest'
import { parseFredCsv, rateInUse } from '../market-rate'

describe("reading FRED's CSV", () => {
  it('takes the latest week', () => {
    const csv = 'observation_date,MORTGAGE30US\n2026-09-03,6.35\n2026-09-10,6.29\n2026-09-17,6.26\n'
    expect(parseFredCsv(csv)).toEqual({ rateBasisPoints: 626, observedOn: '2026-09-17', series: 'MORTGAGE30US' })
  })

  it('does not depend on the header naming the date column', () => {
    expect(parseFredCsv('DATE,MORTGAGE30US\r\n2026-09-17,6.26\r\n')?.rateBasisPoints).toBe(626)
  })

  it('passes over a missing week', () => {
    expect(parseFredCsv('observation_date,MORTGAGE30US\n2026-09-10,6.29\n2026-09-17,.\n2026-09-24,\n')).toEqual({
      rateBasisPoints: 629,
      observedOn: '2026-09-10',
      series: 'MORTGAGE30US',
    })
  })

  it('refuses a page that is not the CSV, and a rate no mortgage has', () => {
    expect(parseFredCsv('<html>blocked</html>')).toBeNull()
    expect(parseFredCsv('')).toBeNull()
    expect(parseFredCsv('observation_date,MORTGAGE30US\n2026-09-17,626\n')).toBeNull()
  })
})

describe('the rate in use', () => {
  const market = { rateBasisPoints: 626, observedOn: '2026-09-17', series: 'MORTGAGE30US' }

  it('prefers a rate the household typed', () => {
    expect(rateInUse({ typedBasisPoints: 599, market, today: '2026-09-23' })).toMatchObject({
      rateBasisPoints: 599,
      source: 'typed',
    })
  })

  it('uses the weekly average otherwise, and says when it has stopped arriving', () => {
    expect(rateInUse({ typedBasisPoints: null, market, today: '2026-09-23' })).toMatchObject({ source: 'weekly_average', stale: false })
    expect(rateInUse({ typedBasisPoints: null, market, today: '2026-10-05' })!.stale).toBe(true)
  })

  it('is nothing when neither exists', () => {
    expect(rateInUse({ typedBasisPoints: null, market: null, today: '2026-09-23' })).toBeNull()
  })
})
