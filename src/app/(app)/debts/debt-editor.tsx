'use client'

/**
 * The way into changing a debt after it exists: a single "Change" link that
 * opens the same form that added it, filled in, plus the way out for one that
 * should never have been entered.
 */

import { useState } from 'react'
import type { DebtFormValues } from '@/domain/debt-form'
import { removeDebtAction, updateDebtAction } from '@/server/actions'
import { DebtForm } from './debt-form'

export function DebtEditor({
  debt,
  initial,
}: {
  debt: { id: string; name: string }
  initial: DebtFormValues
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 text-sm font-medium text-[var(--color-accent)] underline"
      >
        Change this debt
      </button>
    )
  }

  return (
    <div className="space-y-3">
      <DebtForm
        action={updateDebtAction}
        initial={initial}
        debtId={debt.id}
        submitLabel="Save changes"
        onSaved={() => setOpen(false)}
      />
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 text-sm text-[var(--color-ink-soft)] underline"
        >
          Cancel
        </button>
        <form
          action={removeDebtAction}
          onSubmit={(event) => {
            if (!window.confirm(`Remove ${debt.name} from Ballast? Its history stays in the log.`)) {
              event.preventDefault()
            }
          }}
        >
          <input type="hidden" name="debt_id" value={debt.id} />
          <button
            type="submit"
            className="min-h-11 text-sm text-[var(--color-behind)] underline"
          >
            Remove this debt
          </button>
        </form>
      </div>
    </div>
  )
}
