'use client'

/**
 * "Update now" in the footer's update notice (design 2026-10-29). Pressing it
 * asks the server to call Watchtower; the page then waits for a different
 * build to answer and reloads. It gives up after four minutes and says so,
 * because Watchtower taking the request never meant the build changed.
 */

import { useEffect, useState } from 'react'
import { updateNowAction } from '@/server/actions'
import { GIVE_UP_AFTER_MS, POLL_EVERY_MS, outcomeOfCallError, shouldReload } from './update-now-logic'

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'updating'; since: number }
  | { kind: 'stuck' }
  | { kind: 'error'; message: string }

export function UpdateNow({ revision }: { revision: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  useEffect(() => {
    if (phase.kind !== 'updating') return
    const timer = setInterval(async () => {
      if (Date.now() - phase.since > GIVE_UP_AFTER_MS) {
        clearInterval(timer)
        setPhase({ kind: 'stuck' })
        return
      }
      try {
        const response = await fetch('/api/version', { cache: 'no-store' })
        const polled = response.ok ? ((await response.json()) as { revision: string | null }) : null
        if (shouldReload(revision, polled)) window.location.reload()
      } catch {
        // The container is between builds; keep asking.
      }
    }, POLL_EVERY_MS)
    return () => clearInterval(timer)
  }, [phase, revision])

  const press = async () => {
    setPhase({ kind: 'starting' })
    let result: Awaited<ReturnType<typeof updateNowAction>> | undefined
    try {
      result = await updateNowAction()
    } catch (error) {
      setPhase(
        outcomeOfCallError(error) === 'started'
          ? { kind: 'updating', since: Date.now() }
          : { kind: 'error', message: 'Something went wrong before Watchtower was asked. Nothing was updated.' },
      )
      return
    }
    // No answer at all: the session ended and the action sent the page to sign in.
    if (!result) {
      setPhase({ kind: 'idle' })
      return
    }
    setPhase(result.started ? { kind: 'updating', since: Date.now() } : { kind: 'error', message: result.message })
  }

  if (phase.kind === 'updating') {
    return (
      <p className="mt-3 font-medium" role="status">
        Updating — back in a minute
      </p>
    )
  }
  if (phase.kind === 'stuck') {
    return (
      <p className="mt-3" role="status">
        Watchtower took the request, but Ballast is still on {revision ? revision.slice(0, 7) : 'the same build'}.{' '}
        <a href="/settings#updates" className="underline">
          See the update history
        </a>
        .
      </p>
    )
  }
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={press}
        disabled={phase.kind === 'starting'}
        className="rounded-xl bg-[var(--color-accent)] px-4 py-2 font-medium text-white disabled:opacity-60"
      >
        {phase.kind === 'starting' ? 'Starting…' : 'Update now'}
      </button>
      {phase.kind === 'error' ? (
        <p className="mt-2 text-[var(--color-behind)]" role="alert">
          {phase.message}
        </p>
      ) : null}
    </div>
  )
}
