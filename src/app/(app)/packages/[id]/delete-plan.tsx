'use client'

/**
 * Deleting a finished plan for good, behind a deliberate confirmation: the
 * person types the plan's name back before the button will do anything. A
 * tap that lands wrong should never erase a plan, so this is the one place in
 * the app that asks for more than a tap. The engine checks the name again;
 * this component only keeps an honest button from being pressed by accident.
 */

import { useId, useState } from 'react'

export function DeletePlan({
  packageId,
  name,
  action,
}: {
  packageId: string
  name: string
  action: (formData: FormData) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const matches = typed.trim() === name

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full text-center text-sm text-[var(--color-ink-soft)] underline"
      >
        Delete this plan for good
      </button>
    )
  }

  return (
    <form action={action} className="rounded-xl bg-[var(--color-behind-soft)] p-3">
      <input type="hidden" name="package_id" value={packageId} />
      <p className="text-sm font-medium text-[var(--color-behind)]">Delete {name} for good?</p>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        It disappears from your plans and cannot be brought back. What was set aside and spent
        stays in the log, but no screen will show this plan again.
      </p>
      <label htmlFor={inputId} className="mt-3 block text-xs font-medium">
        Type <span className="font-semibold">{name}</span> to confirm
      </label>
      <input
        id={inputId}
        name="confirm_name"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
      />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="submit"
          disabled={!matches}
          className="w-full rounded-lg bg-[var(--color-behind)] px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Yes, delete it for good
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setTyped('')
          }}
          className="w-full rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
        >
          Keep it
        </button>
      </div>
    </form>
  )
}
