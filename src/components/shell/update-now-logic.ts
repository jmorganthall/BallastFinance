/**
 * The two decisions the Update now button makes, kept apart from React so
 * they can be tested on their own.
 */

/**
 * A successful update stops this container while the action is still
 * answering, so the browser's call fails with a network error. Any failure
 * of the call itself therefore means "it is happening": wait for the new
 * build. A real refusal (bad token, Watchtower not there) comes back as an
 * answer, not as a thrown error.
 */
export function outcomeOfCallError(_error: unknown): 'started' {
  return 'started'
}

/** Reload once a build other than the one the button was pressed on answers. */
export function shouldReload(fromRevision: string | null, polled: { revision: string | null } | null): boolean {
  return polled !== null && polled.revision !== null && polled.revision !== fromRevision
}

export const POLL_EVERY_MS = 3_000
/** A pull and recreate takes seconds; after this the page stops waiting and says so. */
export const GIVE_UP_AFTER_MS = 4 * 60 * 1000
