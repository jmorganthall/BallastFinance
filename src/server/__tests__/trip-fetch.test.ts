import { beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCrowdCalendar,
  fetchDrive,
  fetchDvcListings,
  fetchGasPrice,
  fetchSchoolCalendarIcal,
  GAS_PRICE_CSV_URL,
  geocodeAddress,
  osrmRouteUrl,
  pullCrowdCalendar,
  pullDvcListings,
  resetGeocoder,
  userAgent,
} from '../trip-fetch'
import { CROWD_SOURCES, DVC_LISTING_SOURCES } from '@/domain'

describe('the school calendar feed and the DVC listing pulls', () => {
  it('reads an iCal feed into days off and throws on an error status', async () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20270118\r\nSUMMARY:MLK Day\r\nEND:VEVENT\r\nEND:VCALENDAR'
    let asked = ''
    const fake = (async (url: string, init: RequestInit) => {
      asked = `${url} ${(init.headers as Record<string, string>)['user-agent']}`
      return new Response(ics)
    }) as unknown as typeof fetch
    expect(await fetchSchoolCalendarIcal('https://district.example/cal.ics', fake)).toEqual([{ date: '2027-01-18', label: 'MLK Day' }])
    expect(asked).toContain('https://district.example/cal.ics BallastFinance/')
    await expect(fetchSchoolCalendarIcal('https://district.example/cal.ics', respond('nope', 500))).rejects.toThrow('500')
    expect(await fetchSchoolCalendarIcal('https://district.example/cal.ics', respond('<html>login</html>'))).toEqual([])
  })

  it('tries the broker sources in order, keeps only check-ins in the window, and notes every failure', async () => {
    const page = `<script>[{"resort":"Bay Lake Tower","room":"Studio","checkIn":"2027-06-12","nights":5,"points":100,"price":2000},{"resort":"Late","room":"Studio","checkIn":"2027-07-12","nights":5,"points":100,"price":2000}]</script>`
    const window = { from: '2027-06-10', to: '2027-06-21' }
    let calls = 0
    const fake = (async (url: string) => {
      calls += 1
      return url.includes('confirmed') ? new Response(page) : new Response('busy', { status: 503 })
    }) as unknown as typeof fetch
    const got = await pullDvcListings(window, fake)
    expect(calls).toBe(2)
    expect(got.source?.key).toBe('dvc_rental_store_confirmed')
    expect(got.listings).toEqual([{ resort: 'Bay Lake Tower', room: 'Studio', checkIn: '2027-06-12', nights: 5, points: 100, priceCents: 200_000 }])
    expect(got.notes).toEqual(['DVC Rental Store: DVC Rental Store answered 503', 'DVC Rental Store confirmed reservations: 1 rooms read.'])
    const none = await pullDvcListings(window, respond('<html>Sign in</html>'))
    expect(none.source).toBeNull()
    expect(none.notes).toHaveLength(2)
    const one = await fetchDvcListings(DVC_LISTING_SOURCES[0]!, window, respond(page))
    expect(one.url).toBe('https://dvcrentalstore.com/guests/check-dvc-availability/?check_in=2027-06-10&check_out=2027-06-21')
    expect(one.listings).toHaveLength(2)
  })
})

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

describe('the user agent', () => {
  it('names the app and the version, as the public services ask', () => {
    expect(userAgent('0.4.0')).toBe('BallastFinance/0.4.0 (self-hosted family planner)')
    expect(userAgent(undefined)).toBe('BallastFinance/dev (self-hosted family planner)')
  })
})

describe('finding home on the map', () => {
  beforeEach(() => resetGeocoder())

  const found = JSON.stringify([{ lat: '41.8781136', lon: '-87.6297982', display_name: 'Chicago, Cook County, Illinois, United States' }])

  it('asks Nominatim for one jsonv2 result with our user agent, and reads the point', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> })
      return new Response(found)
    }) as unknown as typeof fetch
    const clock = { now: () => 10_000, sleep: async () => {} }
    expect(await geocodeAddress('233 S Wacker Dr, Chicago, IL', fake, clock)).toEqual({
      latitude: 41.8781136,
      longitude: -87.6297982,
      resolvedName: 'Chicago, Cook County, Illinois, United States',
    })
    expect(calls[0]!.url).toBe('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=233%20S%20Wacker%20Dr%2C%20Chicago%2C%20IL')
    expect(calls[0]!.headers['user-agent']).toMatch(/^BallastFinance\/\S+ \(self-hosted family planner\)$/)
  })

  it('the same address again comes from memory; two different ones are a second apart', async () => {
    let asked = 0
    const fake = (async () => {
      asked += 1
      return new Response(found)
    }) as unknown as typeof fetch
    let now = 10_000
    const slept: number[] = []
    const clock = { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms } }
    await geocodeAddress('1 First St', fake, clock)
    await geocodeAddress('  1 first st ', fake, clock)
    expect(asked).toBe(1)
    now += 300
    await geocodeAddress('2 Second St', fake, clock)
    expect(asked).toBe(2)
    expect(slept).toEqual([700])
  })

  it('an error status throws for the screen; a page that is not a result, or nothing found, is nothing', async () => {
    await expect(geocodeAddress('x', respond('slow down', 429))).rejects.toThrow('429')
    expect(await geocodeAddress('y', respond('<html>blocked</html>'), { now: () => 0, sleep: async () => {} })).toBeNull()
    expect(await geocodeAddress('z', respond('[]'), { now: () => 0, sleep: async () => {} })).toBeNull()
  })
})

describe('checking how busy', () => {
  const thrill = CROWD_SOURCES[0]!
  const undercover = CROWD_SOURCES[1]!
  const page = (month: string) =>
    `<script>window.__CROWD__ = {"parks":{"magic_kingdom":[{"date":"${month}-12","crowd_level":7}],"epcot":[{"date":"${month}-12","crowd_level":4}]}}</script>`

  it("fetches one source's page for a month with our user agent and reads it with that source's parser", async () => {
    let asked = ''
    let agent = ''
    const fake = (async (url: string, init?: RequestInit) => {
      asked = url
      agent = (init?.headers as Record<string, string>)['user-agent'] ?? ''
      return new Response(page('2027-06'))
    }) as unknown as typeof fetch
    const got = await fetchCrowdCalendar(thrill, 'wdw', '2027-06', fake)
    expect(asked).toBe(thrill.url('wdw', '2027-06'))
    expect(agent).toContain('BallastFinance/')
    expect(got.levels).toHaveLength(2)
    expect(got.reason).toBeNull()
    await expect(fetchCrowdCalendar(thrill, 'wdw', '2027-06', respond('no', 403))).rejects.toThrow('Thrill Data answered 403')
  })

  it('tries the sources in order: the first that reads every month wins, and each failure is a line for the screen', async () => {
    const fake = (async (url: string) => {
      if (url.startsWith('https://www.thrill-data.com')) return new Response('<html>Access denied</html>', { status: 403 })
      return new Response(page(url.includes('2027-06') ? '2027-06' : '2027-07'))
    }) as unknown as typeof fetch
    const got = await pullCrowdCalendar('wdw', ['2027-06', '2027-07'], fake)
    expect(got.source?.key).toBe('undercover_tourist')
    expect(got.levels).toHaveLength(4)
    expect(got.notes).toEqual(['Thrill Data: Thrill Data answered 403', 'Undercover Tourist: 4 park-days read.'])
  })

  it('every source unreadable is no source, with every reason, never a throw', async () => {
    const got = await pullCrowdCalendar('wdw', ['2027-06'], respond('<html>captive portal</html>'))
    expect(got.source).toBeNull()
    expect(got.levels).toEqual([])
    expect(got.notes).toEqual([
      'Thrill Data: Nothing on the page read as a crowd calendar.',
      'Undercover Tourist: Nothing on the page read as a crowd calendar.',
    ])
    // A source that reads one month but not the next does not half-win.
    const partial = (async (url: string) => new Response(url.includes('2027-06') ? page('2027-06') : 'nope')) as unknown as typeof fetch
    const half = await pullCrowdCalendar('wdw', ['2027-06', '2027-07'], partial, [undercover])
    expect(half.source).toBeNull()
    expect(half.notes[0]).toContain('Undercover Tourist: Nothing on the page')
  })
})
