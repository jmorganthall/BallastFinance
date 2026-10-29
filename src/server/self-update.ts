/**
 * "Update now": asking Watchtower to pull the newer image and recreate this
 * container, and working out afterwards whether it did.
 *
 * Watchtower (v1.7.1, the last containrrr release, and its forks) answers
 * `POST /v1/update` with a `Bearer` token when it runs with
 * `--http-api-update`, and `?image=<repo>` limits it to containers running that
 * image, compared without the tag -- so the button updates Ballast and nothing
 * else the household runs. The handler performs the update inside the request,
 * which means a successful update stops this container before the answer
 * arrives: a connection cut part-way is what success looks like from in here,
 * while a refused connection or an unknown host means Watchtower is not there.
 *
 * "Watchtower took the call" never meant "the build changed": a Watchtower
 * whose scope or labels leave this container out answers 200 and updates
 * nothing. So every attempt is recorded before the request goes out (through
 * the engine) and settled afterwards by comparing builds -- `settleAttempt` --
 * which is the only conclusive answer.
 *
 * The token lives in the environment only, like the reader's key: never in the
 * database, never on a page, never in a log. Modelled on PathBrain's
 * `updates.py`.
 */

import { DEFAULT_IMAGE, compareRevisions, parseImage } from './version'

type Env = Record<string, string | undefined>
type Fetch = typeof fetch

export type AttemptOutcome = 'requested' | 'accepted' | 'dropped' | 'rejected' | 'unreachable'
export type AttemptVerdict = 'pending' | 'updated' | 'no_change' | 'failed'

export interface UpdateAttempt {
  id: string
  createdAt: Date
  url: string
  tokenSent: boolean
  revisionBefore: string | null
  outcome: AttemptOutcome
  httpStatus: number | null
  responseBody: string | null
  error: string | null
  elapsedMs: number | null
  verdict: AttemptVerdict
  verdictAt: Date | null
  revisionAfter: string | null
}

const USER_AGENT = 'Ballast-self-update'
const REQUEST_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 6_000
/** How long an accepted attempt may take before it is judged a no-show. */
export const SETTLE_AFTER_MS = 10 * 60 * 1000
const BODY_LIMIT = 2048

export interface SelfUpdateConfig {
  configured: boolean
  url: string | null
  tokenSet: boolean
  image: string
}

export function selfUpdateConfig(env: Env = process.env): SelfUpdateConfig {
  const url = env.WATCHTOWER_URL?.trim().replace(/\/+$/, '') || null
  return {
    configured: url !== null,
    url,
    tokenSet: Boolean(env.WATCHTOWER_TOKEN?.trim()),
    image: env.BALLAST_IMAGE_REPO?.trim() || DEFAULT_IMAGE,
  }
}

/** The token, for the one call that sends it. Never put it anywhere else. */
export function watchtowerToken(env: Env = process.env): string | null {
  return env.WATCHTOWER_TOKEN?.trim() || null
}

/** "ghcr.io/owner/name:tag" -> its tag, or null when none is given. */
function tagOf(image: string): string | null {
  const trimmed = image.trim()
  const colon = trimmed.lastIndexOf(':')
  return colon > trimmed.lastIndexOf('/') ? trimmed.slice(colon + 1) : null
}

/**
 * The button is offered only when Watchtower could actually do something:
 * an address is set, and the container runs the published image at the tag
 * the update check follows. Watchtower re-pulls the tag a container already
 * runs, so a pinned version or a locally built image would only ever come
 * back "No change". When the compose file does not say which image it runs
 * (`BALLAST_IMAGE` unset, as in an older file or an Unraid template), the
 * published image is assumed and the update history catches a wrong guess.
 */
export function selfUpdateOffered(env: Env = process.env): boolean {
  const config = selfUpdateConfig(env)
  if (!config.configured) return false
  const running = env.BALLAST_IMAGE?.trim()
  if (!running) return true
  const ran = parseImage(running)
  const published = parseImage(config.image)
  if (!ran || !published || ran.host !== published.host || ran.path !== published.path) return false
  const wanted = env.BALLAST_UPDATE_TAG?.trim() || 'latest'
  return (tagOf(running) ?? 'latest') === wanted
}

/** Error codes that mean the request landed and the connection was then cut. */
const DROPPED_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const cause = (error as { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code
  }
  const own = (error as { code?: unknown }).code
  return typeof own === 'string' ? own : null
}

/**
 * Dropped: the request went out and the connection was cut, which is what a
 * successful update looks like. Unreachable: everything else, including a
 * connect timeout (a wrong address on the LAN) and anything unrecognised --
 * an unknown error is never reported as an update that started.
 */
export function classifyFetchError(error: unknown): { kind: 'dropped' | 'unreachable'; reason: string } {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { kind: 'dropped', reason: 'no answer before the time limit' }
  }
  const code = errorCode(error)
  if (code && DROPPED_CODES.has(code)) return { kind: 'dropped', reason: code }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'unreachable', reason: code ? `${code} (${message})` : message }
}

export interface WatchtowerCall {
  outcome: 'accepted' | 'rejected' | 'dropped' | 'unreachable'
  httpStatus: number | null
  body: string | null
  reason: string | null
  elapsedMs: number
}

export function updateUrl(url: string, image: string): string {
  return `${url.replace(/\/+$/, '')}/v1/update?image=${encodeURIComponent(image)}`
}

export async function callWatchtower(input: {
  url: string
  token: string | null
  image: string
  fetchImpl?: Fetch
  timeoutMs?: number
}): Promise<WatchtowerCall> {
  const fetchImpl = input.fetchImpl ?? fetch
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
  if (input.token) headers.Authorization = `Bearer ${input.token}`
  const started = Date.now()
  const elapsed = () => Date.now() - started
  try {
    const response = await fetchImpl(updateUrl(input.url, input.image), {
      method: 'POST',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
    const body = (await response.text().catch(() => '')).trim().slice(0, BODY_LIMIT) || null
    return {
      outcome: response.ok ? 'accepted' : 'rejected',
      httpStatus: response.status,
      body,
      reason: response.ok ? null : `HTTP ${response.status}`,
      elapsedMs: elapsed(),
    }
  } catch (error) {
    const { kind, reason } = classifyFetchError(error)
    return { outcome: kind, httpStatus: null, body: null, reason, elapsedMs: elapsed() }
  }
}

/**
 * Is Watchtower there? Its only endpoint performs the update, so this asks the
 * root instead: any HTTP answer, even a 404, proves it is listening. The token
 * is checked for real only by "Update now", where a wrong one is a 401 that
 * updates nothing.
 */
export async function testWatchtower(input: {
  url: string
  fetchImpl?: Fetch
}): Promise<{ reachable: boolean; httpStatus: number | null; reason: string | null }> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${input.url.replace(/\/+$/, '')}/`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    return { reachable: true, httpStatus: response.status, reason: null }
  } catch (error) {
    return { reachable: false, httpStatus: null, reason: classifyFetchError(error).reason }
  }
}

/**
 * The verdict on a pending attempt, from the build running now, or null when
 * there is nothing new to say. A request that never got through failed; a
 * different build means it worked; the same build ten minutes on means
 * Watchtower took the call and changed nothing.
 */
export function settleAttempt(
  attempt: Pick<UpdateAttempt, 'createdAt' | 'outcome' | 'verdict' | 'revisionBefore'>,
  runningRevision: string | null,
  now: Date,
): { verdict: AttemptVerdict; revisionAfter: string | null } | null {
  if (attempt.verdict !== 'pending') return null
  if (attempt.outcome === 'rejected' || attempt.outcome === 'unreachable') {
    return { verdict: 'failed', revisionAfter: null }
  }
  if (compareRevisions(attempt.revisionBefore, runningRevision) === 'behind') {
    return { verdict: 'updated', revisionAfter: runningRevision }
  }
  if (now.getTime() - attempt.createdAt.getTime() >= SETTLE_AFTER_MS) {
    return { verdict: 'no_change', revisionAfter: runningRevision }
  }
  return null
}

const short = (revision: string | null) => (revision ? revision.slice(0, 7) : 'unknown')

export function attemptWords(attempt: UpdateAttempt): {
  label: 'Updated' | 'No change' | "Didn't start" | 'Waiting to see'
  detail: string
} {
  switch (attempt.verdict) {
    case 'updated':
      return {
        label: 'Updated',
        detail: `Ballast went from ${short(attempt.revisionBefore)} to ${short(attempt.revisionAfter)}.`,
      }
    case 'no_change':
      return {
        label: 'No change',
        detail:
          `Watchtower took the request, but Ballast was still on ${short(attempt.revisionAfter)} ten minutes later. ` +
          "Usually this container is outside Watchtower's scope or labels, the image was already current, " +
          'or Watchtower could not reach the registry.',
      }
    case 'failed':
      if (attempt.outcome === 'rejected') {
        const hint = attempt.httpStatus === 401 || attempt.httpStatus === 403 ? ' Check WATCHTOWER_TOKEN.' : ''
        return {
          label: "Didn't start",
          detail: `Watchtower turned it down (HTTP ${attempt.httpStatus ?? '?'}). Nothing was updated.${hint}`,
        }
      }
      return {
        label: "Didn't start",
        detail: `Could not reach Watchtower${attempt.error ? `: ${attempt.error}` : ''}. Nothing was updated.`,
      }
    default:
      return {
        label: 'Waiting to see',
        detail: 'Watchtower took the request. This settles once the new build answers, or after ten minutes.',
      }
  }
}
