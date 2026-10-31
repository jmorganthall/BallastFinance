import { afterEach, describe, expect, it, vi } from 'vitest'

// The new build is polled while the old session may be mid-flight, so this
// route must answer without anyone signed in.
vi.mock('@/auth', () => ({
  auth: () => {
    throw new Error('the version route must not need a session')
  },
}))

describe('GET /api/version', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('says which build is running, and nothing else', async () => {
    vi.stubEnv('BALLAST_BUILD_SHA', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
    vi.stubEnv('WATCHTOWER_TOKEN', 'secret')
    const { GET } = await import('../route')
    const response = await GET()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toEqual({ revision: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' })
  })
})
