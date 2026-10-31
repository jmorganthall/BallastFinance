'use client'

/** "Test connection" for Watchtower and the backup folder. Never starts an update. */

import { useState } from 'react'
import { testUpdateConnectionAction, type UpdateConnectionTest } from '@/server/actions'

export function TestConnection() {
  const [result, setResult] = useState<UpdateConnectionTest | null>(null)
  const [pending, setPending] = useState(false)

  const run = async () => {
    setPending(true)
    try {
      setResult(await testUpdateConnectionAction())
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="w-full rounded-xl border border-[var(--color-line)] px-4 py-3 font-medium disabled:opacity-60"
      >
        {pending ? 'Testing…' : 'Test connection'}
      </button>
      {result ? (
        <div
          role="status"
          className={`mt-3 space-y-1 rounded-xl p-3 text-sm ${
            result.ok
              ? 'bg-[var(--color-ahead-soft)] text-[var(--color-ahead)]'
              : 'bg-[var(--color-caution-soft)] text-[var(--color-ink)]'
          }`}
        >
          <p>{result.watchtower}</p>
          <p>{result.backups}</p>
        </div>
      ) : null}
    </div>
  )
}
