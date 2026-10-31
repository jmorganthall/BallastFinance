/**
 * Updates (design 2026-10-29): whether Watchtower is set up, a connection
 * test that never starts an update, the last backup taken before an update,
 * and every press of "Update now" with whether the build actually changed --
 * the only answer to "did it work?", since a successful update replaces the
 * container log you would otherwise read.
 */

import type { Engine } from '@/server/engine'
import { attemptWords, selfUpdateConfig } from '@/server/self-update'
import { runningBuild } from '@/server/version'
import { Card } from '@/components/ui'
import { TestConnection } from './test-connection'

const at = (when: Date) =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: process.env.HOUSEHOLD_TIMEZONE || 'America/Chicago',
  }).format(when)

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

const LABEL_TONE: Record<string, string> = {
  Updated: 'text-[var(--color-ahead)]',
  'No change': 'text-[var(--color-caution)]',
  "Didn't start": 'text-[var(--color-behind)]',
  'Waiting to see': 'text-[var(--color-ink-soft)]',
}

export async function UpdateCard({ engine }: { engine: Engine }) {
  const config = selfUpdateConfig()
  const [history, backup] = await Promise.all([
    engine.updateHistory({ runningRevision: runningBuild().revision }),
    engine.latestBackup(),
  ])

  return (
    <Card className="mb-6">
      <div id="updates" className="scroll-mt-20 space-y-1 text-sm">
        <p className="font-medium">Watchtower</p>
        {config.configured ? (
          <p>
            Set up at {config.url}, {config.tokenSet ? 'with a token' : 'with no token'}. When a newer
            version is out, the notice at the bottom of every page has an Update now button.
          </p>
        ) : (
          <p className="text-[var(--color-ink-soft)]">
            Not set up. Set WATCHTOWER_URL and WATCHTOWER_TOKEN for the app container to update from
            here.
          </p>
        )}
      </div>
      <TestConnection />

      <div className="mt-5 text-sm">
        <p className="font-medium">Last backup before an update</p>
        {backup ? (
          <p className="mt-1">
            {at(backup.takenAt)}:{' '}
            {backup.ok && backup.file
              ? `${backup.file.split('/').pop()} (${size(backup.bytes ?? 0)})`
              : `none was taken: ${backup.reason}`}
          </p>
        ) : (
          <p className="mt-1 text-[var(--color-ink-soft)]">
            None yet. One is taken whenever an update changes the database.
          </p>
        )}
      </div>

      <div className="mt-5 text-sm">
        <p className="font-medium">Update history</p>
        {history.length === 0 ? (
          <p className="mt-1 text-[var(--color-ink-soft)]">Update now has not been pressed yet.</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {history.map((attempt) => {
              const words = attemptWords(attempt)
              return (
                <li key={attempt.id}>
                  <p>
                    <span className={`font-medium ${LABEL_TONE[words.label] ?? ''}`}>{words.label}</span>
                    <span className="text-[var(--color-ink-soft)]"> · {at(attempt.createdAt)}</span>
                  </p>
                  <p className="text-[var(--color-ink-soft)]">{words.detail}</p>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Card>
  )
}
