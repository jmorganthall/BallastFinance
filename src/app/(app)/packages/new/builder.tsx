'use client'

/**
 * The package builder (PRD §5, capability 1).
 *
 * It emits the intake contract like any other producer -- the manual builder is
 * simply the first client of it, and a vacation or vehicle planner will fill the
 * same shape later. Rows are added and removed in the browser; validation is the
 * engine's, so the rules cannot drift between here and a planner module.
 *
 * Two shapes, one form. Most plans are one thing ("Park tickets, $600, by
 * March"), so that is the default: one card, no talk of bundles. The moment a
 * second part is added, the same plan becomes a bundle -- the name at the top
 * is what the bundle is for, and each card below is one part of it -- and the
 * screen says so in those words. Under the hood both are a package with line
 * items; a single-part plan just uses its name as the part's label.
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

const field =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

function Problem({ message }: { message?: string }) {
  return message ? (
    <span className="mt-1 block text-sm font-normal text-[var(--color-behind)]">{message}</span>
  ) : null
}

export function PackageBuilder({ accounts }: { accounts: AccountOption[] }) {
  // Default to something the user can actually submit.
  const first = accounts.find((a) => a.writable)?.id ?? accounts[0]?.id ?? ''
  const [name, setName] = useState('')
  const [rows, setRows] = useState<Row[]>([blankRow(first)])
  const [state, formAction, pending] = useActionState<FormState, FormData>(createPackageAction, {
    problems: [],
  })

  const isBundle = rows.length > 1

  const problemFor = (index: number, field: string) =>
    state.problems.find((p) => p.path === `line_items.${index}.${field}`)?.message

  const nameProblem = state.problems.find((p) => p.path.startsWith('package.name'))?.message
  const generalProblems = state.problems.filter(
    (p) => !p.path.startsWith('line_items') && !p.path.startsWith('package.name'),
  )

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const addPart = () => setRows((c) => [...c, blankRow(first)])

  const costFields = (row: Row, index: number) => (
    <>
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
            aria-invalid={Boolean(problemFor(index, 'unit_amount'))}
          />
          <Problem message={problemFor(index, 'unit_amount')} />
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
            aria-invalid={Boolean(problemFor(index, 'due_date'))}
          />
          <Problem message={problemFor(index, 'due_date')} />
        </label>

        <label className="block text-sm font-medium">
          Save it in
          <select
            name="reserve_account"
            value={row.account}
            onChange={(e) => update(row.key, { account: e.target.value })}
            className={field}
            aria-invalid={Boolean(problemFor(index, 'reserve_account'))}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.writable}>
                {a.name}
                {a.scope === 'individual' ? (a.writable ? ' (yours)' : ' — theirs') : ''}
              </option>
            ))}
          </select>
          <Problem message={problemFor(index, 'reserve_account')} />
        </label>
      </div>
    </>
  )

  return (
    <form action={formAction} className="space-y-5">
      {generalProblems.length > 0 ? (
        <div className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">
          {generalProblems.map((p) => (
            <p key={p.path}>{p.message}</p>
          ))}
        </div>
      ) : null}

      {!isBundle ? (
        /*
         * One thing. The name is the thing, so it is also the single part's
         * label: the hidden input keeps the intake contract whole without
         * asking the same question twice.
         */
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-4">
          <label className="block text-sm font-medium">
            What are you saving for?
            <input
              name="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Park tickets"
              className={field}
              aria-invalid={Boolean(nameProblem || problemFor(0, 'label'))}
            />
            <Problem message={nameProblem ?? problemFor(0, 'label')} />
          </label>
          <input type="hidden" name="label" value={name} />
          {rows[0] ? costFields(rows[0], 0) : null}
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-[var(--color-accent)] bg-[var(--color-card)] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)]">
              The plan
            </p>
            <label className="mt-2 block text-sm font-medium">
              What is this whole plan for?
              <input
                name="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="RunDisney 5k Weekend"
                className={field}
                aria-invalid={Boolean(nameProblem)}
              />
              <Problem message={nameProblem} />
            </label>
            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
              One name for the whole thing. The {rows.length} parts below are what it is made of,
              and each one has its own cost and date.
            </p>
          </div>

          <div className="space-y-4 border-l-2 border-[var(--color-accent)] pl-3 sm:pl-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
              What it is made of
            </h2>
            {rows.map((row, index) => (
              <fieldset
                key={row.key}
                className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-4"
              >
                <legend className="px-1 text-xs font-medium text-[var(--color-ink-soft)]">
                  Part {index + 1} of {rows.length}
                </legend>

                <label className="block text-sm font-medium">
                  What is this part?
                  <input
                    name="label"
                    value={row.label}
                    onChange={(e) => update(row.key, { label: e.target.value })}
                    placeholder={index === 0 ? 'Park tickets' : index === 1 ? 'Hotel' : 'Flights'}
                    className={field}
                    aria-invalid={Boolean(problemFor(index, 'label'))}
                  />
                  <Problem message={problemFor(index, 'label')} />
                </label>

                {costFields(row, index)}

                <button
                  type="button"
                  onClick={() => setRows((c) => c.filter((r) => r.key !== row.key))}
                  className="mt-3 min-h-11 text-sm text-[var(--color-ink-soft)] underline"
                >
                  Remove this part
                </button>
              </fieldset>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={addPart}
        className="w-full rounded-xl border border-dashed border-[var(--color-line)] px-4 py-3 text-sm font-medium"
      >
        {isBundle ? 'Add another part' : 'This has more than one part'}
      </button>
      {!isBundle ? (
        <p className="-mt-3 text-center text-xs text-[var(--color-ink-soft)]">
          Tickets, hotel and flights can be one plan with several parts, each with its own date.
        </p>
      ) : null}

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
