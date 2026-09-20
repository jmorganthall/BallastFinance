'use client'

/**
 * The package builder (PRD §5, capability 1).
 *
 * It emits the intake contract like any other producer -- the manual builder is
 * simply the first client of it, and a vacation or vehicle planner will fill the
 * same shape later. Rows are added and removed in the browser; validation is the
 * engine's, so the rules cannot drift between here and a planner module.
 */

import { useActionState, useState } from 'react'
import { createPackageAction, type FormState } from '@/server/actions'

interface AccountOption {
  id: string
  name: string
  /** Accounts belonging to the other spouse are shown but cannot be chosen. */
  writable: boolean
  scope: 'household' | 'individual'
}

interface Row {
  key: number
  label: string
  amount: string
  quantity: string
  dueDate: string
  account: string
}

let nextKey = 1
const blankRow = (account: string): Row => ({
  key: nextKey++,
  label: '',
  amount: '',
  quantity: '1',
  dueDate: '',
  account,
})

export function PackageBuilder({ accounts }: { accounts: AccountOption[] }) {
  // Default to something the user can actually submit.
  const first = accounts.find((a) => a.writable)?.id ?? accounts[0]?.id ?? ''
  const [rows, setRows] = useState<Row[]>([blankRow(first)])
  const [state, formAction, pending] = useActionState<FormState, FormData>(createPackageAction, {
    problems: [],
  })

  const problemFor = (index: number, field: string) =>
    state.problems.find((p) => p.path === `line_items.${index}.${field}`)?.message

  const nameProblem = state.problems.find((p) => p.path.startsWith('package.name'))?.message
  const generalProblems = state.problems.filter(
    (p) => !p.path.startsWith('line_items') && !p.path.startsWith('package.name'),
  )

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const field =
    'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

  return (
    <form action={formAction} className="space-y-5">
      {generalProblems.length > 0 ? (
        <div className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">
          {generalProblems.map((p) => (
            <p key={p.path}>{p.message}</p>
          ))}
        </div>
      ) : null}

      <label className="block text-sm font-medium">
        What are you saving for?
        <input
          name="name"
          required
          placeholder="Disney Feb 2027"
          className={field}
          aria-invalid={Boolean(nameProblem)}
        />
        {nameProblem ? (
          <span className="mt-1 block text-sm font-normal text-[var(--color-behind)]">
            {nameProblem}
          </span>
        ) : null}
      </label>

      <div className="space-y-4">
        {rows.map((row, index) => (
          <fieldset
            key={row.key}
            className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-4"
          >
            <legend className="px-1 text-xs text-[var(--color-ink-soft)]">
              Cost {index + 1}
            </legend>

            <label className="block text-sm font-medium">
              What is it?
              <input
                name="label"
                value={row.label}
                onChange={(e) => update(row.key, { label: e.target.value })}
                placeholder="Park tickets"
                className={field}
              />
              {problemFor(index, 'label') ? (
                <span className="mt-1 block text-sm font-normal text-[var(--color-behind)]">
                  {problemFor(index, 'label')}
                </span>
              ) : null}
            </label>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-sm font-medium">
                Cost of one
                <input
                  name="unit_amount"
                  inputMode="decimal"
                  value={row.amount}
                  onChange={(e) => update(row.key, { amount: e.target.value })}
                  placeholder="600"
                  className={field}
                />
                {problemFor(index, 'unit_amount') ? (
                  <span className="mt-1 block text-sm font-normal text-[var(--color-behind)]">
                    {problemFor(index, 'unit_amount')}
                  </span>
                ) : null}
              </label>

              <label className="block text-sm font-medium">
                How many
                <input
                  name="quantity"
                  type="number"
                  min={1}
                  value={row.quantity}
                  onChange={(e) => update(row.key, { quantity: e.target.value })}
                  className={field}
                />
              </label>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-sm font-medium">
                Needed by
                <input
                  name="due_date"
                  type="date"
                  value={row.dueDate}
                  onChange={(e) => update(row.key, { dueDate: e.target.value })}
                  className={field}
                />
                {problemFor(index, 'due_date') ? (
                  <span className="mt-1 block text-sm font-normal text-[var(--color-behind)]">
                    {problemFor(index, 'due_date')}
                  </span>
                ) : null}
              </label>

              <label className="block text-sm font-medium">
                Save it in
                <select
                  name="reserve_account"
                  value={row.account}
                  onChange={(e) => update(row.key, { account: e.target.value })}
                  className={field}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.writable}>
                      {a.name}
                      {a.scope === 'individual' ? (a.writable ? ' (yours)' : ' — theirs') : ''}
                    </option>
                  ))}
                </select>
                {problemFor(index, 'reserve_account') ? (
                  <span className="mt-1 block text-sm font-normal text-[var(--color-behind)]">
                    {problemFor(index, 'reserve_account')}
                  </span>
                ) : null}
              </label>
            </div>

            {rows.length > 1 ? (
              <button
                type="button"
                onClick={() => setRows((c) => c.filter((r) => r.key !== row.key))}
                className="mt-3 text-sm text-[var(--color-ink-soft)] underline"
              >
                Remove this cost
              </button>
            ) : null}
          </fieldset>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setRows((c) => [...c, blankRow(first)])}
        className="w-full rounded-xl border border-dashed border-[var(--color-line)] px-4 py-3 text-sm font-medium"
      >
        Add another cost
      </button>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white disabled:opacity-60"
      >
        {pending ? 'Working it out…' : 'See what this would cost per week'}
      </button>

      <p className="text-center text-xs text-[var(--color-ink-soft)]">
        This creates a draft. Nothing is set aside until you say so.
      </p>
    </form>
  )
}
