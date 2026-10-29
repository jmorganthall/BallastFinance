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
import { selfUpdateOffered } from '@/server/self-update'
import { requireEngine } from '@/server/session'
import { dismissBackupNoticeAction } from '@/server/actions'
import { UpdateNow } from './update-now'

const REPO = 'https://github.com/jmorganthall/BallastFinance'

export async function AppFooter() {
  const build = runningBuild()
  const { engine } = await requireEngine()
  const [status, backupNotice] = await Promise.all([
    updateStatus(),
    engine.backupNotice(),
    // Settles a press of Update now on the first page the new build serves,
    // while "started within ten minutes of the press" can still be told.
    engine.updateHistory({ runningRevision: build.revision, limit: 5 }),
  ])
  const revision = shortRevision(build.revision)
  const offered = selfUpdateOffered()

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
            {shortRevision(status.latestRevision)}.{' '}
            {offered
              ? 'Press Update now to install it, or pull the latest image and restart the container.'
              : 'Pull the latest image and restart the container to update.'}{' '}
            Nothing here needs doing first — the update migrates itself on start, and backs
            the database up first when it changes it.
          </p>
          {offered ? <UpdateNow revision={build.revision} /> : null}
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

      {backupNotice ? (
        <form
          action={dismissBackupNoticeAction}
          role="status"
          className="mb-4 flex flex-col gap-2 rounded-2xl border border-[var(--color-caution)] bg-[var(--color-caution-soft)] p-3 text-sm text-[var(--color-ink)] sm:flex-row sm:items-center sm:justify-between"
        >
          <input type="hidden" name="backup_id" value={backupNotice.id} />
          <p>The last update changed the database without a backup: {backupNotice.reason}.</p>
          <button type="submit" className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-1 font-medium">
            Got it
          </button>
        </form>
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
