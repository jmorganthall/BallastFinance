import { describe, expect, it } from 'vitest'
import { outcomeOfCallError, shouldReload } from '../update-now-logic'

describe('the Update now button', () => {
  it('reads a call cut off by the network as started, because the update stops this container', () => {
    expect(outcomeOfCallError(new TypeError('Failed to fetch'))).toBe('started')
    expect(outcomeOfCallError(new TypeError('Load failed'))).toBe('started')
  })

  it('reads an error the server answered with as failed, never as an update under way', () => {
    // Next.js rethrows a server-side failure with a digest: the server was alive and said no.
    expect(outcomeOfCallError(Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '123' }))).toBe('failed')
    expect(outcomeOfCallError(Object.assign(new TypeError('x'), { digest: '123' }))).toBe('failed')
    expect(outcomeOfCallError(new Error('something else'))).toBe('failed')
  })

  it('reloads only once a different build answers', () => {
    expect(shouldReload('aaa', { revision: 'bbb' })).toBe(true)
    expect(shouldReload('aaa', { revision: 'aaa' })).toBe(false)
    expect(shouldReload('aaa', null)).toBe(false)
    expect(shouldReload('aaa', { revision: null })).toBe(false)
    expect(shouldReload(null, { revision: 'bbb' })).toBe(true)
  })
})
