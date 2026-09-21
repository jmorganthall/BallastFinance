'use client'

/**
 * The payoff order as a table: one row per debt, and everything you can do to
 * a debt happens in place. "Edit" opens the row: record a payment, type in a
 * statement balance, change any term, or remove it (with a confirm step that
 * stays inside the table). The last row adds a new one.
 *
 * Nothing here is computed; every figure arrives from the page, which got it
 * from the ladder (PRD §10). On a phone the less important columns fold away
 * rather than the table scrolling sideways, so the row stays tappable.
 */

import { useState, type ReactNode } from 'react'
import type { DebtFormValues } from '@/domain/debt-form'
import { formatCents } from '@/domain/money'
import { humanDate } from '@/components/ui'
import {
  confirmDebtPaymentAction,
  createDebtAction,
  removeDebtAction,
  updateDebtAction,
  updateDebtBalanceAction,
} from '@/server/actions'
import { DebtForm } from './debt-form'
import { DEFAULT_SORT, nextSort, sortDebtRows, type Sort, type SortKey } from './debt-sort'

export interface DebtRow {
  id: string
  rank: number
  name: string
  kind: string
  balanceCents: number
  asOf: string
  ageDays: number
  stale: boolean
  /** "20.49%", already formatted: what it really costs right now. */
  effectiveRate: string
  /** The same rate as a number, so the Rate column can be sorted. */
  effectiveAprBasisPoints: number
  /** The listed rate when a promo makes the effective one differ, else null. */
  listedRate: string | null
  minimumCents: number
  /** What goes at it each month: the planned payment, else the minimum. */
  paymentCents: number
  payoffDate: string | null
  cumulativeCostCents: number
  cumulativeFreedCents: number
  breakEvenMonths: number | null
  initial: DebtFormValues
}

type Open = { kind: 'edit' | 'remove'; id: string } | { kind: 'add' } | null

const smallField =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-2 text-base text-[var(--color-ink)]'
const th = 'px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'
const td = 'px-2 py-3 align-top'
const COLUMNS = 6

export function DebtTable({ rows }: { rows: DebtRow[] }) {
  const [open, setOpen] = useState<Open>(null)
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)
  const isOpen = (id: string) => open !== null && open.kind !== 'add' && open.id === id
  const sorted = sortDebtRows(rows, sort)

  const heading = (key: SortKey, label: string, extra = '') => (
    <SortHeading
      label={label}
      className={`${th} ${extra}`}
      active={sort.key === key ? sort.direction : null}
      onClick={() => setSort(nextSort(sort, key))}
    />
  )

  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            {heading('rank', '#', 'w-8')}
            {heading('name', 'Debt')}
            {heading('balance', 'Balance', 'text-right')}
            {heading('rate', 'Rate', 'hidden text-right sm:table-cell')}
            {heading('payment', 'Per month', 'text-right')}
            {heading('payoff', 'Paid off by', 'hidden md:table-cell')}
            <th className={`${th} w-16`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS + 1} className="px-3 py-6 text-center text-[var(--color-ink-soft)]">
                No debts recorded yet. Add one below and Ballast works out the payoff order.
              </td>
            </tr>
          ) : null}
          {sorted.map((row) => (
            <Row key={row.id} row={row} open={isOpen(row.id) ? (open as { kind: 'edit' | 'remove' }).kind : null} setOpen={setOpen} />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-[var(--color-line)]">
            <td colSpan={COLUMNS + 1} className="p-2">
              {open?.kind === 'add' ? (
                <Panel title="Add a debt" onClose={() => setOpen(null)}>
                  <DebtForm action={createDebtAction} onSaved={() => setOpen(null)} />
                </Panel>
              ) : (
                <button
                  type="button"
                  onClick={() => setOpen({ kind: 'add' })}
                  className="min-h-11 w-full rounded-xl border border-dashed border-[var(--color-line)] px-4 text-sm font-medium"
                >
                  + Add a debt
                </button>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function Row({
  row,
  open,
  setOpen,
}: {
  row: DebtRow
  open: 'edit' | 'remove' | null
  setOpen: (open: Open) => void
}) {
  return (
    <>
      <tr className={`border-t border-[var(--color-line)] ${open ? 'bg-[var(--color-surface)]' : ''}`}>
        <td className={`${td} text-[var(--color-ink-soft)]`}>{row.rank}</td>
        <td className={td}>
          <span className="font-medium">{row.name}</span>
          <span className={`block text-xs ${row.stale ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-soft)]'}`}>
            {row.kind}
            {' · '}
            {row.ageDays === 0 ? 'checked today' : `as of ${humanDate(row.asOf)}`}
            {row.stale ? ` (${row.ageDays} days ago)` : ''}
          </span>
        </td>
        <td className={`${td} text-right font-medium tabular`}>{formatCents(row.balanceCents)}</td>
        <td className={`${td} hidden text-right tabular sm:table-cell`}>
          {row.effectiveRate}
          {row.listedRate ? (
            <span className="block text-xs text-[var(--color-ink-soft)]">listed {row.listedRate}</span>
          ) : null}
        </td>
        <td className={`${td} text-right tabular`}>
          {formatCents(row.paymentCents)}
          {row.paymentCents > row.minimumCents ? (
            <span className="block text-xs text-[var(--color-ink-soft)]">min {formatCents(row.minimumCents)}</span>
          ) : null}
        </td>
        <td className={`${td} hidden md:table-cell`}>
          {row.payoffDate ? humanDate(row.payoffDate) : <span className="text-[var(--color-ink-soft)]">Never, at this rate</span>}
        </td>
        <td className={`${td} text-right`}>
          <button
            type="button"
            onClick={() => setOpen(open ? null : { kind: 'edit', id: row.id })}
            aria-expanded={open !== null}
            className="min-h-9 rounded-lg px-2 text-sm font-medium text-[var(--color-accent)] underline"
          >
            {open ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>

      {open ? (
        <tr className="bg-[var(--color-surface)]">
          <td colSpan={COLUMNS + 1} className="p-2 pt-0">
            {open === 'remove' ? (
              <div className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm">
                <p className="font-medium text-[var(--color-behind)]">Remove {row.name} from Ballast?</p>
                <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                  It comes off the payoff order. What it said stays in the log.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <form action={removeDebtAction}>
                    <input type="hidden" name="debt_id" value={row.id} />
                    <button
                      type="submit"
                      className="min-h-11 w-full rounded-lg bg-[var(--color-behind)] px-3 text-sm font-medium text-white"
                    >
                      Yes, remove it
                    </button>
                  </form>
                  <button
                    type="button"
                    onClick={() => setOpen({ kind: 'edit', id: row.id })}
                    className="min-h-11 rounded-lg border border-[var(--color-line)] px-3 text-sm font-medium"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] p-3">
                <p className="text-xs text-[var(--color-ink-soft)]">
                  Clearing everything down to here costs {formatCents(row.cumulativeCostCents)} and frees{' '}
                  {formatCents(row.cumulativeFreedCents)} a month
                  {row.breakEvenMonths !== null ? ` — it pays for itself in ${row.breakEvenMonths} months.` : '.'}
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <form action={confirmDebtPaymentAction} className="flex items-end gap-2">
                    <input type="hidden" name="debt_id" value={row.id} />
                    <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
                      I paid
                      <input
                        name="amount"
                        inputMode="decimal"
                        placeholder={formatCents(row.paymentCents).replace('$', '')}
                        className={smallField}
                      />
                    </label>
                    <button type="submit" className="min-h-11 rounded-lg border border-[var(--color-line)] px-3 text-sm">
                      Record
                    </button>
                  </form>
                  <form
                    action={updateDebtBalanceAction}
                    className={`flex items-end gap-2 ${row.stale ? 'rounded-lg bg-[var(--color-accent-soft)] p-2 sm:-m-2' : ''}`}
                  >
                    <input type="hidden" name="debt_id" value={row.id} />
                    <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
                      The statement says it is
                      <input
                        name="balance"
                        inputMode="decimal"
                        placeholder={formatCents(row.balanceCents).replace('$', '')}
                        className={smallField}
                      />
                    </label>
                    <button type="submit" className="min-h-11 rounded-lg border border-[var(--color-line)] px-3 text-sm">
                      Update
                    </button>
                  </form>
                </div>

                <details className="border-t border-[var(--color-line)] pt-3">
                  <summary className="cursor-pointer text-sm font-medium text-[var(--color-accent)]">
                    Change its terms
                  </summary>
                  <div className="mt-3">
                    <DebtForm
                      action={updateDebtAction}
                      initial={row.initial}
                      debtId={row.id}
                      submitLabel="Save changes"
                      onSaved={() => setOpen(null)}
                    />
                  </div>
                </details>

                <div className="flex items-center justify-between gap-3 border-t border-[var(--color-line)] pt-3">
                  <button
                    type="button"
                    onClick={() => setOpen(null)}
                    className="min-h-11 text-sm text-[var(--color-ink-soft)] underline"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpen({ kind: 'remove', id: row.id })}
                    className="min-h-11 text-sm text-[var(--color-behind)] underline"
                  >
                    Remove this debt
                  </button>
                </div>
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

/**
 * A column heading you can click to sort by. The whole cell is the button so
 * it is easy to hit on a phone, and `aria-sort` tells a screen reader which
 * way the table is ordered.
 */
function SortHeading({
  label,
  className,
  active,
  onClick,
}: {
  label: string
  className: string
  active: 'asc' | 'desc' | null
  onClick: () => void
}) {
  const alignRight = className.includes('text-right')
  return (
    <th
      className={className}
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex min-h-9 items-center gap-1 uppercase ${alignRight ? 'w-full justify-end' : ''} ${
          active ? 'text-[var(--color-ink)]' : ''
        }`}
      >
        {label}
        <span aria-hidden="true" className={`text-[10px] ${active ? '' : 'opacity-30'}`}>
          {active === 'desc' ? '▼' : '▲'}
        </span>
      </button>
    </th>
  )
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">{title}</p>
        <button type="button" onClick={onClose} className="min-h-9 text-sm text-[var(--color-ink-soft)] underline">
          Cancel
        </button>
      </div>
      {children}
    </div>
  )
}
