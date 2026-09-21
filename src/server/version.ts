/**
 * Which build is running, and whether the published image has moved on.
 *
 * The container knows its own git revision (baked in at build time) but not
 * its image digest, because a digest exists only after the push. So the
 * comparison is by revision: the `latest` tag on the registry carries the
 * commit it was built from in its `org.opencontainers.image.revision` label,
 * and if that differs from ours, there is a newer image to pull.
 *
 * Everything here is best-effort and quiet. A registry that is down, a box
 * with no outbound network, or an image built locally with no revision all
 * come back as "unknown" -- never an error, never a slow page. The check runs
 * at most once every few hours per process and is shared across requests.
 */

export interface RunningBuild {
  /** package.json version, inlined at build time. */
  version: string | null
  /** Full git revision the image was built from, or null for a local build. */
  revision: string | null
}

export type UpdateStatus =
  | { kind: 'off' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'current' }
  | { kind: 'behind'; latestRevision: string }

export const DEFAULT_IMAGE = 'ghcr.io/jmorganthall/ballastfinance'

const OCI_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export const REVISION_LABEL = 'org.opencontainers.image.revision'

/** process.env, or a plain map of it, so a test can hand in exactly what it wants. */
type Env = Record<string, string | undefined>

export function runningBuild(env: Env = process.env): RunningBuild {
  const version = env.BALLAST_VERSION?.trim() || null
  const revision = env.BALLAST_BUILD_SHA?.trim() || null
  return { version, revision }
}

/** "8d3ea70" for the footer; a full revision is noise to a person. */
export function shortRevision(revision: string | null): string | null {
  return revision ? revision.slice(0, 7) : null
}

/**
 * Two revisions name the same build when one is a prefix of the other, so a
 * short revision baked in by hand still compares against the registry's full
 * one. Both must be real hex to count -- "unknown" never equals "unknown".
 */
export function compareRevisions(
  running: string | null,
  latest: string | null,
): 'current' | 'behind' | 'unknown' {
  if (!isRevision(running) || !isRevision(latest)) return 'unknown'
  const a = running.toLowerCase()
  const b = latest.toLowerCase()
  return a.startsWith(b) || b.startsWith(a) ? 'current' : 'behind'
}

function isRevision(value: string | null): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value)
}

/**
 * Buildx publishes `latest` as an image index that also carries provenance
 * and SBOM attestations, whose platform is "unknown/unknown". The real image
 * is the linux manifest -- amd64 is the only platform published, but any
 * linux entry would carry the same revision label.
 */
export function pickImageManifestDigest(index: unknown): string | null {
  if (!isRecord(index) || !Array.isArray(index.manifests)) return null
  const entries = index.manifests.filter(isRecord)
  const linux = entries.find((m) => isRecord(m.platform) && m.platform.os === 'linux')
  const chosen = linux ?? entries.find((m) => !isRecord(m.platform) || m.platform.os !== 'unknown')
  return chosen && typeof chosen.digest === 'string' ? chosen.digest : null
}

export function configDigestOf(manifest: unknown): string | null {
  if (!isRecord(manifest) || !isRecord(manifest.config)) return null
  return typeof manifest.config.digest === 'string' ? manifest.config.digest : null
}

export function revisionFromConfig(config: unknown): string | null {
  if (!isRecord(config) || !isRecord(config.config) || !isRecord(config.config.Labels)) return null
  const revision = config.config.Labels[REVISION_LABEL]
  return typeof revision === 'string' && revision.trim() !== '' ? revision.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** "ghcr.io/owner/name" -> the registry host and the repository path. */
export function parseImage(image: string): { host: string; path: string } | null {
  const trimmed = image.trim().replace(/:[^/]+$/, '') // drop a tag if one was pasted
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return null
  const host = trimmed.slice(0, slash)
  const path = trimmed.slice(slash + 1)
  if (!host.includes('.') || !path) return null
  return { host, path: path.toLowerCase() }
}

type Fetch = typeof fetch

/**
 * The revision label on `<image>:<tag>` from an OCI registry, using the
 * anonymous pull token a public package hands out. Four small requests, all
 * under one abort signal.
 */
export async function fetchLatestRevision(options: {
  image: string
  tag?: string
  fetchImpl?: Fetch
  signal?: AbortSignal
}): Promise<string | null> {
  const parsed = parseImage(options.image)
  if (!parsed) return null
  const { host, path } = parsed
  const tag = options.tag ?? 'latest'
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = options.signal

  const tokenResponse = await fetchImpl(
    `https://${host}/token?scope=${encodeURIComponent(`repository:${path}:pull`)}&service=${host}`,
    { signal, cache: 'no-store' },
  )
  if (!tokenResponse.ok) return null
  const tokenBody: unknown = await tokenResponse.json()
  const token = isRecord(tokenBody) && typeof tokenBody.token === 'string' ? tokenBody.token : null
  if (!token) return null

  const headers = { Authorization: `Bearer ${token}`, Accept: OCI_ACCEPT }
  const getJson = async (url: string): Promise<unknown> => {
    const response = await fetchImpl(url, { headers, signal, cache: 'no-store' })
    if (!response.ok) return null
    return response.json()
  }

  let manifest = await getJson(`https://${host}/v2/${path}/manifests/${tag}`)
  const imageDigest = pickImageManifestDigest(manifest)
  if (imageDigest) manifest = await getJson(`https://${host}/v2/${path}/manifests/${imageDigest}`)

  const configDigest = configDigestOf(manifest)
  if (!configDigest) return null
  return revisionFromConfig(await getJson(`https://${host}/v2/${path}/blobs/${configDigest}`))
}

// ---------------------------------------------------------------- the check

/**
 * Once an hour. Four small anonymous requests, well inside the registry's
 * limits, and the difference between a household that pulls the new image
 * the evening it lands and one that reads "up to date" for most of a day.
 */
const CHECK_EVERY_MS = 60 * 60 * 1000
/** How long a page render will wait on the registry before showing "unknown". */
const RENDER_WAIT_MS = 3000
const REQUEST_TIMEOUT_MS = 10_000

interface CacheEntry {
  checkedAt: number
  status: UpdateStatus
}

let cache: CacheEntry | null = null
let inflight: Promise<UpdateStatus> | null = null

/** For tests: forget everything this process has learned. */
export function resetUpdateCheck(): void {
  cache = null
  inflight = null
}

async function checkNow(
  running: RunningBuild,
  env: Env,
  fetchImpl: Fetch,
): Promise<UpdateStatus> {
  const image = env.BALLAST_IMAGE_REPO?.trim() || DEFAULT_IMAGE
  try {
    const latest = await fetchLatestRevision({
      image,
      tag: env.BALLAST_UPDATE_TAG?.trim() || 'latest',
      fetchImpl,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!latest) return { kind: 'unknown', reason: 'The registry did not say which build is latest.' }
    const verdict = compareRevisions(running.revision, latest)
    if (verdict === 'behind') return { kind: 'behind', latestRevision: latest }
    if (verdict === 'current') return { kind: 'current' }
    return { kind: 'unknown', reason: 'Could not compare builds.' }
  } catch (error) {
    // Logged once per check, not once per page: a homelab with no outbound
    // network would otherwise fill the log with the same line.
    console.warn('[version] update check failed:', error instanceof Error ? error.message : error)
    return { kind: 'unknown', reason: 'Could not reach the registry.' }
  }
}

/**
 * The status the footer shows. Returns the cached answer when there is one,
 * refreshes in the background when it is old, and on the very first call
 * waits briefly so a fresh container usually knows on its first page.
 */
export async function updateStatus(options: {
  env?: Env
  fetchImpl?: Fetch
  now?: () => number
} = {}): Promise<UpdateStatus> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const running = runningBuild(env)

  if (env.BALLAST_UPDATE_CHECK === 'off' || env.BALLAST_UPDATE_CHECK === '0') return { kind: 'off' }
  if (!running.revision) {
    return { kind: 'unknown', reason: 'This build was made locally, so there is nothing to compare it to.' }
  }

  const fresh = cache && now() - cache.checkedAt < CHECK_EVERY_MS
  if (fresh && cache) return cache.status

  if (!inflight) {
    inflight = checkNow(running, env, options.fetchImpl ?? fetch)
      .then((status) => {
        cache = { checkedAt: now(), status }
        return status
      })
      .finally(() => {
        inflight = null
      })
  }

  // Never hold a page for the registry: stale-while-revalidate, and a first
  // render that gives up after a short wait rather than hanging.
  if (cache) return cache.status
  const waited = await Promise.race([
    inflight,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RENDER_WAIT_MS)),
  ])
  return waited ?? { kind: 'unknown', reason: 'Still checking.' }
}
