import { describe, expect, it } from 'vitest'
import { fetchDrive, fetchGasPrice, GAS_PRICE_CSV_URL, osrmRouteUrl } from '../trip-fetch'

const home = { label: 'Home', latitude: 41.8781, longitude: -87.6298 }

const respond = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch

describe('the drive fetch', () => {
  it('asks OSRM for lon,lat to lon,lat with no geometry, and reads whole miles and minutes', async () => {
    let asked = ''
    const fake = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 1_773_000, duration: 60_500 }] }))
    }) as unknown as typeof fetch
    expect(await fetchDrive(home, 'wdw', '2026-09-25', fake)).toEqual({ miles: 1_102, minutes: 1_009, fetchedOn: '2026-09-25' })
    expect(asked).toBe('https://router.project-osrm.org/route/v1/driving/-87.62980,41.87810;-81.56390,28.38520?overview=false')
    expect(osrmRouteUrl(home, 'wdw')).toBe(asked)
  })

  it('throws on an error status, so the screen can say so', async () => {
    await expect(fetchDrive(home, 'wdw', '2026-09-25', respond('busy', 503))).rejects.toThrow('503')
  })

  it('returns nothing for a page that is not a route', async () => {
    expect(await fetchDrive(home, 'wdw', '2026-09-25', respond('<html>captive portal</html>'))).toBeNull()
    expect(await fetchDrive(home, 'wdw', '2026-09-25', respond('{"code":"NoRoute","routes":[]}'))).toBeNull()
  })
})

describe('the gas price fetch', () => {
  it('asks FRED for the weekly regular series and reads the latest week to cents', async () => {
    let asked = ''
    const fake = (async (url: string) => {
      asked = url
      return new Response('observation_date,GASREGW\n2026-09-15,3.052\n')
    }) as unknown as typeof fetch
    expect(await fetchGasPrice(fake)).toEqual({ centsPerGallon: 305, observationDate: '2026-09-15' })
    expect(asked).toBe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=GASREGW')
    expect(GAS_PRICE_CSV_URL).toBe(asked)
  })

  it('throws on an error status and returns nothing for a page that is not the CSV', async () => {
    await expect(fetchGasPrice(respond('nope', 500))).rejects.toThrow('500')
    expect(await fetchGasPrice(respond('<html>blocked</html>'))).toBeNull()
  })
})
