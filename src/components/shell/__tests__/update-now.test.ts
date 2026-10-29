import { describe, expect, it } from 'vitest'
import { outcomeOfCallError, shouldReload } from '../update-now-logic'

describe('the Update now button', () => {
  it('reads a call that never answered as started, because the update stops this container', () => {
    expect(outcomeOfCallError(new TypeError('Failed to fetch'))).toBe('started')
    expect(outcomeOfCallError(new Error('An unexpected response was received from the server.'))).toBe('started')
  })

  it('reloads only once a different build answers', () => {
    expect(shouldReload('aaa', { revision: 'bbb' })).toBe(true)
    expect(shouldReload('aaa', { revision: 'aaa' })).toBe(false)
    expect(shouldReload('aaa', null)).toBe(false)
    expect(shouldReload('aaa', { revision: null })).toBe(false)
    expect(shouldReload(null, { revision: 'bbb' })).toBe(true)
  })
})
