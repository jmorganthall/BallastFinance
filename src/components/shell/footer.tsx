/**
 * The bottom of every page: which build this is, whether a newer one exists,
 * and the source link.
 *
 * The source link is here rather than buried in Settings on purpose. AGPL §13:
 * a modified version offered over a network must make its source available to
 * its users, and a footer on every page is compliance by default rather than
 * by remembering.
 */

import { runningBuild, shortRevision, updateStatus } from '@/server/version'

const REPO = 'https://github.com/jmorganthall/BallastFinance'

export async function AppFooter() {
  const build = runningBuild()
  const status = await updateStatus()
  const revision = shortRevision(build.revision)

  const buildLabel = [build.version ? `v${build.version}` : null, revision ? `(${revision})` : null]
    .filter(Boolean)
    .join(' ')

  return (
    <footer className="mx-auto mt-10 w-full max-w-2xl px-4 pb-6 text-xs text-[var(--color-ink-soft)]">
      {status.kind === 'behind' ? (
        <div
          role="status"
          className="mb-4 rounded-2xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-4 text-sm text-[var(--color-ink)]"
        >
          <p className="font-semibold">A newer version of Ballast is available.</p>
          <p className="mt-1">
            This one is {revision ?? 'an older build'}; the latest image is{' '}
            {shortRevision(status.latestRevision)}. Pull the latest image and restart the
            container to update. Nothing here needs doing first — the update migrates itself on
            start.
          </p>
          <p className="mt-2">
            <a
              href={`${REPO}/compare/${build.revision}...${status.latestRevision}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              See what changed
            </a>
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-[var(--color-line)] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p>
          Ballast {buildLabel || 'development build'}
          {status.kind === 'current' ? <span> · Up to date</span> : null}
          {status.kind === 'unknown' ? (
            <span title={status.reason}> · Update check unavailable</span>
          ) : null}
        </p>
        <p>
          Free software under the{' '}
          <a href={`${REPO}/blob/main/LICENSE`} className="underline" target="_blank" rel="noreferrer">
            GNU AGPL-3.0
          </a>
          {' · '}
          <a href={REPO} className="underline" target="_blank" rel="noreferrer">
            Source code
          </a>
        </p>
      </div>
    </footer>
  )
}
