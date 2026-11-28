/**
 * The raw layer (D64 (1), proposed): a page fetched, or text a person
 * pasted, exactly as it arrived, before any parser read it.
 *
 * A pull is never edited or deleted (migration 0032 enforces it). The
 * facts read from it (rates, listings) name the pull they came from, so a
 * better parser or a fixed resort match can read the same pull again and
 * nothing anyone received is lost when a newer capture replaces a rate.
 * The same body from the same source is one pull: its fingerprint is the
 * SHA-256 of the body, worked out where the pull is landed.
 *
 * Nothing here does I/O.
 */

import type { CivilDate } from './dates'

export type PullHow = 'fetched' | 'pasted'

/** What a pull's body is, so a reader knows how to read it again. */
export type PullMediaType = 'text/html' | 'text/plain' | 'application/json'

export interface SourcePull {
  id: string
  /** The source's key, e.g. "resortings" or "dvc_rental_store". */
  source: string
  /** The page fetched, or the page a person said they copied from. */
  url: string
  how: PullHow
  mediaType: PullMediaType
  body: string
  /** SHA-256 of the body, lower-case hex. */
  sha256: string
  pulledOn: CivilDate
}

export type NewSourcePull = Omit<SourcePull, 'id' | 'sha256'>

/** A body larger than this is refused: no page Ballast reads is near it, and a database row is not a file store. */
export const MAX_PULL_BYTES = 5_000_000

export class SourcePullError extends Error {}

/** HTML when it carries tags, else plain text; JSON when it parses as an object or array. */
export function mediaTypeOf(body: string): PullMediaType {
  const t = body.trim()
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      JSON.parse(t)
      return 'application/json'
    } catch {
      // not JSON: fall through
    }
  }
  return /<\/?[a-z][^>]*>/i.test(t) ? 'text/html' : 'text/plain'
}

export function validateSourcePull(p: NewSourcePull): void {
  if (!p.source.trim()) throw new SourcePullError('A pull needs its source.')
  if (!/^https?:\/\//.test(p.url)) throw new SourcePullError('A pull needs the address it came from.')
  if (p.body.trim() === '') throw new SourcePullError('An empty page is not kept.')
  if (byteLength(p.body) > MAX_PULL_BYTES) throw new SourcePullError('That page is too large to keep.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.pulledOn)) throw new SourcePullError('A pull needs the day it came in.')
}

/** UTF-8 length without Buffer, so the domain stays free of Node. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
