import { describe, expect, it } from 'vitest'
import {
  attemptWords,
  callWatchtower,
  classifyFetchError,
  selfUpdateConfig,
  selfUpdateOffered,
  settleAttempt,
  testWatchtower,
  type UpdateAttempt,
} from '../self-update'

const RUNNING = '8d3ea70f1c2b3a4d5e6f708192a3b4c5d6e7f809'
const NEWER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const IMAGE = 'ghcr.io/jmorganthall/ballastfinance'

interface Seen {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(answer: Response | Error, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    if (answer instanceof Error) throw answer
    return answer
  }) as typeof fetch
}

function fetchFailed(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
}

describe('asking Watchtower to update Ballast', () => {
  it('posts to /v1/update for Ballast only, with the token and our own User-Agent', async () => {
    const seen: Seen[] = []
    const result = await callWatchtower({
      url: 'http://wt:8080',
      token: 'tok',
      image: IMAGE,
      fetchImpl: fakeFetch(new Response('Updated', { status: 200 }), seen),
    })
    expect(result.outcome).toBe('accepted')
    expect(result.httpStatus).toBe(200)
    expect(result.body).toBe('Updated')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://wt:8080/v1/update?image=ghcr.io%2Fjmorganthall%2Fballastfinance')
    expect(seen[0]!.init?.method).toBe('POST')
    const headers = new Headers(seen[0]!.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer tok')
    expect(headers.get('user-agent')).toBe('Ballast-self-update')
    expect(headers.has('origin')).toBe(false)
    expect(headers.has('referer')).toBe(false)
  })

  it('sends no Authorization header when no token is set', async () => {
    const seen: Seen[] = []
    await callWatchtower({ url: 'http://wt:8080', token: null, image: IMAGE, fetchImpl: fakeFetch(new Response(''), seen) })
    expect(new Headers(seen[0]!.init?.headers).has('authorization')).toBe(false)
  })

  it('reads a 401 as turned down, with its status', async () => {
    const result = await callWatchtower({
      url: 'http://wt:8080',
      token: 'wrong',
      image: IMAGE,
      fetchImpl: fakeFetch(new Response('Unauthorized', { status: 401 })),
    })
    expect(result.outcome).toBe('rejected')
    expect(result.httpStatus).toBe(401)
  })

  it('reads a connection cut part-way as started, because that is what a successful update looks like', async () => {
    for (const error of [fetchFailed('ECONNRESET'), fetchFailed('UND_ERR_SOCKET'), new DOMException('x', 'TimeoutError')]) {
      const result = await callWatchtower({ url: 'http://wt:8080', token: 'tok', image: IMAGE, fetchImpl: fakeFetch(error) })
      expect(result.outcome).toBe('dropped')
    }
  })

  it('reads a refused connection, an unknown host or a connect timeout as unreachable', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH']) {
      const result = await callWatchtower({ url: 'http://wt:8080', token: 'tok', image: IMAGE, fetchImpl: fakeFetch(fetchFailed(code)) })
      expect(result.outcome).toBe('unreachable')
      expect(result.reason).toContain(code)
    }
  })

  it('classifies an unknown error as unreachable, never as started', () => {
    expect(classifyFetchError(new Error('strange')).kind).toBe('unreachable')
    expect(classifyFetchError('not even an error').kind).toBe('unreachable')
  })
})

describe('testing the connection', () => {
  it('asks the root, never /v1/update, and counts any answer as reachable', async () => {
    const seen: Seen[] = []
    const result = await testWatchtower({ url: 'http://wt:8080', fetchImpl: fakeFetch(new Response('', { status: 404 }), seen) })
    expect(seen[0]!.url).toBe('http://wt:8080/')
    expect(seen[0]!.init?.method).toBe('GET')
    expect(result).toEqual({ reachable: true, httpStatus: 404, reason: null })
  })

  it('is not reachable when the connection is refused', async () => {
    const result = await testWatchtower({ url: 'http://wt:8080', fetchImpl: fakeFetch(fetchFailed('ECONNREFUSED')) })
    expect(result.reachable).toBe(false)
    expect(result.reason).toContain('ECONNREFUSED')
  })
})

describe('whether the button is offered', () => {
  const base = { WATCHTOWER_URL: 'http://192.168.2.6:8998/', WATCHTOWER_TOKEN: 'tok' }

  it('reads the configuration without ever returning the token', () => {
    const config = selfUpdateConfig(base)
    expect(config).toEqual({ configured: true, url: 'http://192.168.2.6:8998', tokenSet: true, image: IMAGE })
    expect(JSON.stringify(config)).not.toContain('tok"')
    expect(selfUpdateConfig({}).configured).toBe(false)
  })

  it('needs a Watchtower address', () => {
    expect(selfUpdateOffered({})).toBe(false)
    expect(selfUpdateOffered({ WATCHTOWER_URL: '  ' })).toBe(false)
  })

  it('is offered when the image the container runs is not stated', () => {
    expect(selfUpdateOffered(base)).toBe(true)
  })

  it('is offered for the published image at the tag the update check follows', () => {
    expect(selfUpdateOffered({ ...base, BALLAST_IMAGE: `${IMAGE}:latest` })).toBe(true)
    expect(selfUpdateOffered({ ...base, BALLAST_IMAGE: IMAGE })).toBe(true)
    expect(selfUpdateOffered({ ...base, BALLAST_IMAGE: `${IMAGE}:edge`, BALLAST_UPDATE_TAG: 'edge' })).toBe(true)
  })

  it('is not offered for a pinned version or a different image', () => {
    expect(selfUpdateOffered({ ...base, BALLAST_IMAGE: `${IMAGE}:v1.2.0` })).toBe(false)
    expect(selfUpdateOffered({ ...base, BALLAST_IMAGE: 'ghcr.io/someone/fork:latest' })).toBe(false)
    expect(selfUpdateOffered({ ...base, BALLAST_IMAGE: 'ballast-app' })).toBe(false)
  })
})

describe('settling an attempt', () => {
  const at = new Date('2026-10-29T20:00:00Z')
  const minutes = (n: number) => new Date(at.getTime() + n * 60_000)
  const attempt = (over: Partial<UpdateAttempt> = {}) => ({
    createdAt: at,
    outcome: 'dropped' as const,
    verdict: 'pending' as const,
    revisionBefore: RUNNING,
    ...over,
  })

  it('is updated when a different build started within ten minutes of the press', () => {
    expect(settleAttempt(attempt(), NEWER, minutes(1), minutes(0.5))).toEqual({ verdict: 'updated', revisionAfter: NEWER })
    expect(settleAttempt(attempt(), NEWER, minutes(60 * 48), minutes(2))).toEqual({ verdict: 'updated', revisionAfter: NEWER })
  })

  it('is no change when the different build started long after the press, as by a later pull by hand', () => {
    expect(settleAttempt(attempt(), NEWER, minutes(60 * 48), minutes(60 * 47))).toEqual({
      verdict: 'no_change',
      revisionAfter: NEWER,
    })
  })

  it('is no change ten minutes on with the same build', () => {
    expect(settleAttempt(attempt(), RUNNING, minutes(10), minutes(-60))).toEqual({ verdict: 'no_change', revisionAfter: RUNNING })
  })

  it('waits before ten minutes', () => {
    expect(settleAttempt(attempt(), RUNNING, minutes(9), minutes(-60))).toBeNull()
  })

  it('fails a request that never got through', () => {
    expect(settleAttempt(attempt({ outcome: 'rejected' }), RUNNING, minutes(0), minutes(-60))?.verdict).toBe('failed')
    expect(settleAttempt(attempt({ outcome: 'unreachable' }), RUNNING, minutes(0), minutes(-60))?.verdict).toBe('failed')
  })

  it('leaves a settled attempt alone', () => {
    expect(settleAttempt(attempt({ verdict: 'updated' }), RUNNING, minutes(30), minutes(-60))).toBeNull()
  })

  it('says each verdict in plain words', () => {
    const row: UpdateAttempt = {
      id: 'x',
      createdAt: at,
      url: 'http://wt:8080/v1/update',
      tokenSent: true,
      revisionBefore: RUNNING,
      outcome: 'dropped',
      httpStatus: null,
      responseBody: null,
      error: null,
      elapsedMs: 10,
      verdict: 'no_change',
      verdictAt: minutes(10),
      revisionAfter: RUNNING,
    }
    expect(attemptWords({ ...row, verdict: 'updated', revisionAfter: NEWER }).label).toBe('Updated')
    expect(attemptWords(row).label).toBe('No change')
    expect(attemptWords(row).detail).toMatch(/scope/)
    expect(attemptWords({ ...row, verdict: 'failed', outcome: 'rejected', httpStatus: 401 }).label).toBe("Didn't start")
    expect(attemptWords({ ...row, verdict: 'pending' }).label).toBe('Waiting to see')
  })
})
