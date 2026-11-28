/** The raw layer's own rules (D64 (1)): what a pull's body is, and what is refused before it is kept. */

import { describe, expect, it } from 'vitest'
import { byteLength, MAX_PULL_BYTES, mediaTypeOf, SourcePullError, validateSourcePull, type NewSourcePull } from '../source-pull'

const pull: NewSourcePull = { source: 'resortings', url: 'https://resortings.com/', how: 'pasted', mediaType: 'text/plain', body: 'October 2026\t$548', pulledOn: '2026-11-28' }

describe('a raw pull', () => {
  it('says what its body is', () => {
    expect(mediaTypeOf('<table><tr><td>$548</td></tr></table>')).toBe('text/html')
    expect(mediaTypeOf('{"listings": []}')).toBe('application/json')
    expect(mediaTypeOf('{ not json }')).toBe('text/plain')
    expect(mediaTypeOf('October 2026\t$548')).toBe('text/plain')
  })

  it('needs a source, an address, a day and a body', () => {
    expect(() => validateSourcePull(pull)).not.toThrow()
    expect(() => validateSourcePull({ ...pull, source: ' ' })).toThrow(SourcePullError)
    expect(() => validateSourcePull({ ...pull, url: 'resortings.com' })).toThrow(SourcePullError)
    expect(() => validateSourcePull({ ...pull, body: '  ' })).toThrow(SourcePullError)
    expect(() => validateSourcePull({ ...pull, pulledOn: 'today' })).toThrow(SourcePullError)
  })

  it('refuses a body too large to be a page', () => {
    expect(byteLength('é')).toBe(2)
    expect(() => validateSourcePull({ ...pull, body: 'x'.repeat(MAX_PULL_BYTES + 1) })).toThrow(SourcePullError)
  })
})
