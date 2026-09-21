'use client'

/**
 * A page title that can be renamed in place: the name, a small pencil beside
 * it, and on a tap the name becomes a box with Save and Cancel. The rename
 * itself is the same server action a form would post; this only decides when
 * the box is showing, so a renamed plan is still one event in the log.
 */

import { useEffect, useRef, useState } from 'react'

export function EditableTitle({
  name,
  subtitle,
  packageId,
  action,
  canEdit = true,
}: {
  name: string
  subtitle?: string
  packageId: string
  action: (formData: FormData) => Promise<void>
  canEdit?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  return (
    <header className="mb-5">
      {editing ? (
        <form action={action} className="flex items-center gap-2" onReset={() => setEditing(false)}>
          <input type="hidden" name="package_id" value={packageId} />
          <input
            ref={input}
            name="name"
            defaultValue={name}
            required
            autoFocus
            aria-label="Plan name"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
            }}
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-2xl font-semibold tracking-tight text-[var(--color-ink)]"
          />
          <button
            type="submit"
            className="min-h-11 shrink-0 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white"
          >
            Save
          </button>
          <button
            type="reset"
            className="min-h-11 shrink-0 rounded-lg border border-[var(--color-line)] px-3 text-sm font-medium"
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{name}</h1>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Rename ${name}`}
              title="Rename"
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-ink-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                <path d="M13.5 3.5a2.1 2.1 0 0 1 3 3L7 16l-4 1 1-4 9.5-9.5z" />
                <path d="M12 5l3 3" />
              </svg>
            </button>
          ) : null}
        </div>
      )}
      {subtitle ? <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{subtitle}</p> : null}
    </header>
  )
}
