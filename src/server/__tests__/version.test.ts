import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareRevisions,
  configDigestOf,
  fetchLatestRevision,
  parseImage,
  pickImageManifestDigest,
  resetUpdateCheck,
  revisionFromConfig,
  runningBuild,
  shortRevision,
  updateStatus,
  checkForUpdatesNow,
  lastUpdateCheckWords,
  FORCED_CHECK_GAP_MS,
} from '../version'

const RUNNING = '8d3ea70f1c2b3a4d5e6f708192a3b4c5d6e7f809'
const NEWER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

describe('the running build', () => {
  it('reads what the image baked in, and treats blanks as unknown', () => {
    expect(runningBuild({ BALLAST_VERSION: '0.1.0', BALLAST_BUILD_SHA: RUNNING })).toEqual({
      version: '0.1.0',
      revision: RUNNING,
    })
    expect(runningBuild({ BALLAST_VERSION: '', BALLAST_BUILD_SHA: '  ' })).toEqual({
      version: null,
      revision: null,
    })
    expect(shortRevision(RUNNING)).toBe('8d3ea70')
    expect(shortRevision(null)).toBeNull()
  })
})

describe('comparing revisions', () => {
  it('is current when they name the same commit, long or short', () => {
    expect(compareRevisions(RUNNING, RUNNING)).toBe('current')
    expect(compareRevisions('8d3ea70', RUNNING)).toBe('current')
    expect(compareRevisions(RUNNING, '8D3EA70')).toBe('current')
  })

  it('is behind when the registry names a different commit', () => {
    expect(compareRevisions(RUNNING, NEWER)).toBe('behind')
  })

  it('never claims anything from a missing or junk revision', () => {
    expect(compareRevisions(null, NEWER)).toBe('unknown')
    expect(compareRevisions(RUNNING, null)).toBe('unknown')
    expect(compareRevisions('unknown', 'unknown')).toBe('unknown')
    expect(compareRevisions('', '')).toBe('unknown')
  })
})

describe('reading the registry', () => {
  it('parses an image reference, dropping a pasted tag', () => {
    expect(parseImage('ghcr.io/jmorganthall/ballastfinance')).toEqual({
      host: 'ghcr.io',
      path: 'jmorganthall/ballastfinance',
    })
    expect(parseImage('ghcr.io/JMorganthall/BallastFinance:latest')).toEqual({
      host: 'ghcr.io',
      path: 'jmorganthall/ballastfinance',
    })
    expect(parseImage('ballastfinance')).toBeNull()
  })

  it('picks the linux image out of an index that also carries attestations', () => {
    const index = {
      manifests: [
        { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
        { digest: 'sha256:img', platform: { os: 'linux', architecture: 'amd64' } },
      ],
    }
    expect(pickImageManifestDigest(index)).toBe('sha256:img')
    // A plain manifest is not an index.
    expect(pickImageManifestDigest({ config: { digest: 'sha256:cfg' } })).toBeNull()
    expect(pickImageManifestDigest(null)).toBeNull()
  })

  it('reads the revision label off the image config', () => {
    expect(configDigestOf({ config: { digest: 'sha256:cfg' } })).toBe('sha256:cfg')
    expect(
      revisionFromConfig({ config: { Labels: { 'org.opencontainers.image.revision': NEWER } } }),
    ).toBe(NEWER)
    expect(revisionFromConfig({ config: { Labels: {} } })).toBeNull()
    expect(revisionFromConfig('nope')).toBeNull()
  })

  it('walks token, index, manifest and config with an anonymous pull token', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
      if (url.startsWith('https://ghcr.io/token?')) return body({ token: 'anon' })
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer anon')
      if (url.endsWith('/manifests/latest')) {
        return body({
          manifests: [
            { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
            { digest: 'sha256:img', platform: { os: 'linux', architecture: 'amd64' } },
          ],
        })
      }
      if (url.endsWith('/manifests/sha256:img')) return body({ config: { digest: 'sha256:cfg' } })
      if (url.endsWith('/blobs/sha256:cfg')) {
        return body({ config: { Labels: { 'org.opencontainers.image.revision': NEWER } } })
      }
      return new Response('not found', { status: 404 })
    })

    const revision = await fetchLatestRevision({
      image: 'ghcr.io/jmorganthall/ballastfinance',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(revision).toBe(NEWER)
    expect(calls).toEqual([
      'https://ghcr.io/token?scope=repository%3Ajmorganthall%2Fballastfinance%3Apull&service=ghcr.io',
      'https://ghcr.io/v2/jmorganthall/ballastfinance/manifests/latest',
      'https://ghcr.io/v2/jmorganthall/ballastfinance/manifests/sha256:img',
      'https://ghcr.io/v2/jmorganthall/ballastfinance/blobs/sha256:cfg',
    ])
  })

  it('comes back empty, not thrown, when the registry refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }))
    await expect(
      fetchLatestRevision({
        image: 'ghcr.io/jmorganthall/ballastfinance',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeNull()
  })
})

describe('the update check the footer reads', () => {
  afterEach(() => {
    resetUpdateCheck()
    vi.restoreAllMocks()
  })

  function registryReturning(revision: string | null) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
      if (url.includes('/token?')) return body({ token: 't' })
      if (url.endsWith('/manifests/latest')) return body({ config: { digest: 'sha256:cfg' } })
      if (url.endsWith('/blobs/sha256:cfg')) {
        return body({ config: { Labels: revision ? { 'org.opencontainers.image.revision': revision } : {} } })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
  }

  it('can be switched off', async () => {
    const status = await updateStatus({
      env: { BALLAST_UPDATE_CHECK: 'off', BALLAST_BUILD_SHA: RUNNING },
      fetchImpl: registryReturning(NEWER),
    })
    expect(status).toEqual({ kind: 'off' })
  })

  it('says so when the build was made locally and has nothing to compare against', async () => {
    const fetchImpl = registryReturning(NEWER)
    const status = await updateStatus({ env: {}, fetchImpl })
    expect(status.kind).toBe('unknown')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('warns when latest is a different commit, and is quiet when it is the same', async () => {
    expect(
      await updateStatus({ env: { BALLAST_BUILD_SHA: RUNNING }, fetchImpl: registryReturning(NEWER) }),
    ).toEqual({ kind: 'behind', latestRevision: NEWER })

    resetUpdateCheck()
    expect(
      await updateStatus({ env: { BALLAST_BUILD_SHA: RUNNING }, fetchImpl: registryReturning(RUNNING) }),
    ).toEqual({ kind: 'current' })
  })

  it('asks the registry once and answers every later page from memory', async () => {
    const fetchImpl = registryReturning(NEWER)
    const env = { BALLAST_BUILD_SHA: RUNNING }
    await updateStatus({ env, fetchImpl })
    await updateStatus({ env, fetchImpl })
    await updateStatus({ env, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(3) // token, manifest, config -- one check
  })

  it('checks again once the answer is old', async () => {
    const fetchImpl = registryReturning(NEWER)
    const env = { BALLAST_BUILD_SHA: RUNNING }
    let clock = 0
    const now = () => clock
    await updateStatus({ env, fetchImpl, now })
    clock += 7 * 60 * 60 * 1000
    // Old answer is served straight away while the refresh runs in the background.
    const status = await updateStatus({ env, fetchImpl, now })
    expect(status.kind).toBe('behind')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it('"Check for updates" asks now, past the hourly answer, and waits for it', async () => {
    const env = { BALLAST_BUILD_SHA: RUNNING }
    let clock = 0
    const now = () => clock
    expect(await updateStatus({ env, fetchImpl: registryReturning(RUNNING), now })).toEqual({ kind: 'current' })
    // A newer build is published; the hourly answer would still say "current" for most of an hour.
    clock += 5 * 60 * 1000
    const newer = registryReturning(NEWER)
    expect(await updateStatus({ env, fetchImpl: newer, now })).toEqual({ kind: 'current' })
    expect(newer).not.toHaveBeenCalled()
    expect(await checkForUpdatesNow({ env, fetchImpl: newer, now })).toEqual({ kind: 'behind', latestRevision: NEWER })
    // And every page after it says so.
    expect(await updateStatus({ env, fetchImpl: newer, now })).toEqual({ kind: 'behind', latestRevision: NEWER })
  })

  it('answers a press within a few seconds of the last check from that check, so it never hammers the registry', async () => {
    const env = { BALLAST_BUILD_SHA: RUNNING }
    let clock = 0
    const now = () => clock
    const fetchImpl = registryReturning(NEWER)
    await checkForUpdatesNow({ env, fetchImpl, now })
    clock += FORCED_CHECK_GAP_MS - 1
    await checkForUpdatesNow({ env, fetchImpl, now })
    expect(fetchImpl).toHaveBeenCalledTimes(3) // one check: token, manifest, config
    clock += 2
    await checkForUpdatesNow({ env, fetchImpl, now })
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    // Off, or a local build: nothing is asked.
    expect(await checkForUpdatesNow({ env: { ...env, BALLAST_UPDATE_CHECK: 'off' }, fetchImpl, now })).toEqual({ kind: 'off' })
    expect((await checkForUpdatesNow({ env: {}, fetchImpl, now })).kind).toBe('unknown')
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it('says when it last asked', async () => {
    expect(lastUpdateCheckWords()).toBeNull()
    let clock = 0
    const now = () => clock
    await checkForUpdatesNow({ env: { BALLAST_BUILD_SHA: RUNNING }, fetchImpl: registryReturning(RUNNING), now })
    expect(lastUpdateCheckWords(now)).toBe('just now')
    clock = 60_000
    expect(lastUpdateCheckWords(now)).toBe('1 minute ago')
    clock = 45 * 60_000
    expect(lastUpdateCheckWords(now)).toBe('45 minutes ago')
    clock = 2 * 60 * 60_000 + 5
    expect(lastUpdateCheckWords(now)).toBe('2 hours ago')
  })

  it('never throws when the network is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const status = await updateStatus({ env: { BALLAST_BUILD_SHA: RUNNING }, fetchImpl })
    expect(status.kind).toBe('unknown')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
