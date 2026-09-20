'use client'

/**
 * Bring in the spreadsheet (temporary). Paste the rows with their header line,
 * see exactly what would be made and what is thrown away, then import. The
 * text is carried in a hidden field between the two steps, so what lands is
 * what was shown.
 */

import { useActionState } from 'react'
import { formatCents } from '@/domain/money'
import { RECURRENCE_LABELS, type Recurrence } from '@/domain/recurrence'
import { humanDate } from '@/components/ui'
import { sheetImportAction, type SheetImportState } from '@/server/actions'

const CATEGORY_LABELS: Record<string, string> = {
  consumer: 'Credit card or loan',
  auto: 'Car',
  mortgage: 'Mortgage',
}

export function SheetImport() {
  const [state, formAction, pending] = useActionState(sheetImportAction, { phase: 'idle' })

  if (state.phase === 'done') {
    return (
      <div className="space-y-3 text-sm">
        <p className="rounded-xl bg-[var(--color-ahead-soft)] p-3 font-medium text-[var(--color-ahead)]">
          Done. {state.plansCreated.length} plan{state.plansCreated.length === 1 ? '' : 's'},{' '}
          {state.debtsCreated.length} debt{state.debtsCreated.length === 1 ? '' : 's'}
          {state.accountsCreated.length > 0
            ? ` and ${state.accountsCreated.length} account${state.accountsCreated.length === 1 ? '' : 's'}`
            : ''}{' '}
          brought in. They are live: the plans are saving from today, with what was already
          reserved counted as set aside.
        </p>
        {state.problems.length > 0 ? (
          <div className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-[var(--color-behind)]">
            <p className="font-medium">Not brought in:</p>
            <ul className="mt-1 list-disc pl-5">
              {state.problems.map((p, i) => (
                <li key={i}>
                  Line {p.row}: {p.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <form action={formAction}>
          <input type="hidden" name="sheet" value="" />
          <button type="button" onClick={() => window.location.reload()} className="underline">
            Bring in more
          </button>
        </form>
      </div>
    )
  }

  const preview = state.phase === 'preview' ? state : null
  const count = preview ? preview.expenses.length + preview.debts.length : 0

  return (
    <form action={formAction} className="space-y-4">
      <label className="block text-sm font-medium">
        Paste the rows, header line included
        <textarea
          name="sheet"
          rows={preview ? 4 : 8}
          defaultValue={preview?.text ?? ''}
          placeholder={
            'Account\tIn Simplifi\tExpense\tBracket\tDue Every\tNext Due\tReserved Now\tAmount\tMonthly\tWeekly\n…\n\nLoan\tCategory\tFreed Up\tMonthly\tAPR\t%\t$\t…'
          }
          className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-ink)]"
        />
        <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
          Copy straight out of the sheet: both tabs at once is fine. Ballast keeps the raw
          inputs and throws the sheet&apos;s own arithmetic away.
        </span>
      </label>

      {state.phase === 'idle' && state.error ? (
        <p className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">
          {state.error}
        </p>
      ) : null}

      {preview ? (
        <div className="space-y-4 text-sm">
          {preview.problems.length > 0 ? (
            <div className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-[var(--color-behind)]">
              <p className="font-medium">
                {preview.problems.length} line{preview.problems.length === 1 ? '' : 's'} would be
                skipped:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {preview.problems.map((p, i) => (
                  <li key={i}>
                    Line {p.row}: {p.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.accountsToCreate.length > 0 ? (
            <p className="rounded-xl bg-[var(--color-accent-soft)] p-3">
              New savings account{preview.accountsToCreate.length === 1 ? '' : 's'} to create:{' '}
              <strong>{preview.accountsToCreate.join(', ')}</strong>
            </p>
          ) : null}

          {preview.expenses.length > 0 ? (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
                {preview.expenses.length} plan{preview.expenses.length === 1 ? '' : 's'}
              </h3>
              <ul className="mt-2 divide-y divide-[var(--color-line)]">
                {preview.expenses.map((e) => (
                  <li key={e.row} className="py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{e.label}</span>
                      <span className="shrink-0 tabular">{formatCents(e.amountCents)}</span>
                    </div>
                    <p className="text-xs text-[var(--color-ink-soft)]">
                      {e.account} · {RECURRENCE_LABELS[e.recurrence as Recurrence].toLowerCase()}
                      {e.recurrence === 'none' ? ', needed by' : ', next'} {humanDate(e.dueDate)}
                      {e.openingCents > 0 ? ` · ${formatCents(e.openingCents)} already set aside` : ''}
                    </p>
                    {e.notes.map((n, i) => (
                      <p key={i} className="text-xs text-[var(--color-accent)]">
                        {n}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.debts.length > 0 ? (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
                {preview.debts.length} debt{preview.debts.length === 1 ? '' : 's'}
              </h3>
              <ul className="mt-2 divide-y divide-[var(--color-line)]">
                {preview.debts.map((d) => (
                  <li key={d.row} className="py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{d.name}</span>
                      <span className="shrink-0 tabular">{formatCents(d.balanceCents)}</span>
                    </div>
                    <p className="text-xs text-[var(--color-ink-soft)]">
                      {CATEGORY_LABELS[d.category] ?? d.category} · {(d.aprBasisPoints / 100).toFixed(2)}% ·
                      minimum {d.minimum}
                      {d.creditLimitCents ? ` · limit ${formatCents(d.creditLimitCents)}` : ''}
                      {d.balanceAsOf ? ` · balance as of ${humanDate(d.balanceAsOf)}` : ''}
                    </p>
                    {d.notes.map((n, i) => (
                      <p key={i} className="text-xs text-[var(--color-accent)]">
                        {n}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.ignoredColumns.length > 0 ? (
            <p className="text-xs text-[var(--color-ink-soft)]">
              Thrown away on purpose, because Ballast works these out itself:{' '}
              {preview.ignoredColumns.join(', ')}.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="submit"
          name="mode"
          value="preview"
          disabled={pending}
          className="rounded-xl border border-[var(--color-line)] px-4 py-3 text-sm font-medium disabled:opacity-60"
        >
          {pending ? 'Reading…' : preview ? 'Check it again' : 'Check it first'}
        </button>
        {preview && count > 0 ? (
          <button
            type="submit"
            name="mode"
            value="import"
            disabled={pending}
            className="rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
          >
            {pending ? 'Bringing in…' : `Bring in ${count} row${count === 1 ? '' : 's'}`}
          </button>
        ) : null}
      </div>
      {preview && count > 0 ? (
        <p className="text-center text-xs text-[var(--color-ink-soft)]">
          Plans go live straight away, saving from today. Anything wrong afterwards can be changed
          on its own screen.
        </p>
      ) : null}
    </form>
  )
}
