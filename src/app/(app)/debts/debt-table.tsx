'use client'

/**
 * The payoff order as a table: one row per debt, and everything you can do to
 * a debt happens in place. "Edit" opens the row: record a payment, type in a
 * statement balance, change any term, or remove it (with a confirm step that
 * stays inside the table). The last row adds a new one.
 *
 * A card with nothing owed is not in the payoff order, so it has a table of
 * its own below (IdleDebtTable, "Idle lines of credit", D37) with the same
 * balance, terms and remove controls: typing a balance into one puts it back in
 * the order. A car loan or mortgage at $0 is paid off and done and is not
 * shown, so whatever would clear one asks once first (payoff-question.tsx).
 *
 * Nothing here is computed; every figure arrives from the page, which got it
 * from the ladder (PRD §10). On a phone the less important columns fold away
 * rather than the table scrolling sideways, so the row stays tappable.
 */

import { useState, type FormEvent, type ReactNode } from 'react'
import { balanceAfterPaymentCents, paysOffLoan, type DebtCategory } from '@/domain/debt'
import type { DebtFormValues } from '@/domain/debt-form'
import { formatCents, parseAmountOrNull } from '@/domain/money'
import { humanDate } from '@/components/ui'
import {
  confirmDebtPaymentAction,
  createDebtAction,
  removeDebtAction,
  updateDebtAction,
  updateDebtBalanceAction,
} from '@/server/actions'
import { DebtForm } from './debt-form'
import { usePayoffQuestion } from './payoff-question'
import { DEFAULT_SORT, nextSort, sortDebtRows, type Sort, type SortKey } from './debt-sort'

export interface DebtRow {
  id: string
  rank: number
  name: string
  kind: string
  /** Decides whether clearing it is a payoff that needs a yes (D37). */
  category: DebtCategory
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

export function DebtTable({
  rows,
  emptyMessage = 'No debts recorded yet. Add one below and Ballast works out the payoff order.',
}: {
  rows: DebtRow[]
  /** What the empty table says; the page knows whether idle debts exist. */
  emptyMessage?: string
}) {
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
    <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            {heading('rank', '#', 'w-8')}
            {heading('name', 'Debt')}
            {heading('balance', 'Balance', 'text-right')}
            {heading('rate', 'Rate', 'hidden text-right sm:table-cell')}
            {heading('payment', 'Per month', 'text-right')}
            {heading('payoff', 'Paid off by', 'hidden md:table-cell')}
            {/* On a phone the Edit link sits under the debt's name instead, so the table stays inside its card. */}
            <th className={`${th} hidden w-16 sm:table-cell`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS + 1} className="px-3 py-6 text-center text-[var(--color-ink-soft)]">
                {emptyMessage}
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
  const editButton = (
    <button
      type="button"
      onClick={() => setOpen(open ? null : { kind: 'edit', id: row.id })}
      aria-expanded={open !== null}
      className="min-h-9 rounded-lg px-2 text-sm font-medium text-[var(--color-accent)] underline"
    >
      {open ? 'Close' : 'Edit'}
    </button>
  )

  return (
    <>
      <tr className={`border-t border-[var(--color-line)] ${open ? 'bg-[var(--color-surface)]' : ''}`}>
        <td className={`${td} text-[var(--color-ink-soft)]`}>{row.rank}</td>
        <td className={`${td} break-words`}>
          <span className="font-medium">{row.name}</span>
          <span className={`block text-xs ${row.stale ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-soft)]'}`}>
            {row.kind}
            {' · '}
            {row.ageDays === 0 ? 'checked today' : `as of ${humanDate(row.asOf)}`}
            {row.stale ? ` (${row.ageDays} days ago)` : ''}
          </span>
          <span className="-ml-2 mt-1 block sm:hidden">{editButton}</span>
        </td>
        <td className={`${td} whitespace-nowrap text-right font-medium tabular`}>{formatCents(row.balanceCents)}</td>
        <td className={`${td} hidden text-right tabular sm:table-cell`}>
          {row.effectiveRate}
          {row.listedRate ? (
            <span className="block text-xs text-[var(--color-ink-soft)]">listed {row.listedRate}</span>
          ) : null}
        </td>
        <td className={`${td} whitespace-nowrap text-right tabular`}>
          {formatCents(row.paymentCents)}
          {row.paymentCents > row.minimumCents ? (
            <span className="block text-xs text-[var(--color-ink-soft)]">min {formatCents(row.minimumCents)}</span>
          ) : null}
        </td>
        <td className={`${td} hidden md:table-cell`}>
          {row.payoffDate ? humanDate(row.payoffDate) : <span className="text-[var(--color-ink-soft)]">Never, at this rate</span>}
        </td>
        <td className={`${td} hidden text-right sm:table-cell`}>{editButton}</td>
      </tr>

      {open ? (
        <tr className="bg-[var(--color-surface)]">
          <td colSpan={COLUMNS + 1} className="p-2 pt-0">
            {open === 'remove' ? (
              <RemoveConfirm
                id={row.id}
                name={row.name}
                note="It comes off the payoff order. What it said stays in the log."
                onKeep={() => setOpen({ kind: 'edit', id: row.id })}
              />
            ) : (
              <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] p-3">
                <p className="text-xs text-[var(--color-ink-soft)]">
                  Clearing everything down to here costs {formatCents(row.cumulativeCostCents)} and frees{' '}
                  {formatCents(row.cumulativeFreedCents)} a month
                  {row.breakEvenMonths !== null ? ` — it pays for itself in ${row.breakEvenMonths} months.` : '.'}
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <PaymentForm row={row} />
                  <StatementForm id={row.id} balanceCents={row.balanceCents} highlight={row.stale} payoff={row} />
                </div>

                <TermsAndRemove id={row.id} initial={row.initial} setOpen={setOpen} payoff={row} />
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

export interface IdleDebtRow {
  id: string
  name: string
  kind: string
  asOf: string
  ageDays: number
  /** "24.99%", already formatted: the listed rate, what a new balance would cost. */
  listedRate: string
  /** "0.00% until Mar 1, 2027" while a promotional rate runs, else null. */
  promo: string | null
  creditLimitCents: number | null
  initial: DebtFormValues
}

const IDLE_COLUMNS = 3

/**
 * Idle lines of credit: cards and lines with nothing owed on them (D37). No
 * rank, payment or payoff date, because they are not in the payoff order; the
 * same edit panel as the main table, less "I paid", since there is nothing to
 * pay. A running promotion shows under the rate, the fact you want when
 * deciding which card to use; a limit is shown and never totalled.
 */
export function IdleDebtTable({ rows }: { rows: IdleDebtRow[] }) {
  const [open, setOpen] = useState<Open>(null)
  const isOpen = (id: string) => open !== null && open.kind !== 'add' && open.id === id

  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            <th className={th}>Card or line</th>
            <th className={`${th} hidden text-right sm:table-cell`}>Rate</th>
            <th className={`${th} text-right`}>Limit</th>
            <th className={`${th} hidden w-16 sm:table-cell`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <IdleRow
              key={row.id}
              row={row}
              open={isOpen(row.id) ? (open as { kind: 'edit' | 'remove' }).kind : null}
              setOpen={setOpen}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IdleRow({
  row,
  open,
  setOpen,
}: {
  row: IdleDebtRow
  open: 'edit' | 'remove' | null
  setOpen: (open: Open) => void
}) {
  const editButton = (
    <button
      type="button"
      onClick={() => setOpen(open ? null : { kind: 'edit', id: row.id })}
      aria-expanded={open !== null}
      className="min-h-9 rounded-lg px-2 text-sm font-medium text-[var(--color-accent)] underline"
    >
      {open ? 'Close' : 'Edit'}
    </button>
  )

  return (
    <>
      <tr className={`border-t border-[var(--color-line)] ${open ? 'bg-[var(--color-surface)]' : ''}`}>
        <td className={`${td} break-words`}>
          <span className="font-medium">{row.name}</span>
          <span className="block text-xs text-[var(--color-ink-soft)]">
            {row.kind}
            {' · '}
            {row.ageDays === 0 ? '$0 as of today' : `$0 as of ${humanDate(row.asOf)}`}
          </span>
          {row.promo ? <span className="block text-xs text-[var(--color-ink-soft)] sm:hidden">{row.promo}</span> : null}
          <span className="-ml-2 mt-1 block sm:hidden">{editButton}</span>
        </td>
        <td className={`${td} hidden text-right tabular sm:table-cell`}>
          {row.listedRate}
          {row.promo ? <span className="block text-xs text-[var(--color-ink-soft)]">{row.promo}</span> : null}
        </td>
        <td className={`${td} whitespace-nowrap text-right tabular`}>
          {row.creditLimitCents !== null ? (
            formatCents(row.creditLimitCents)
          ) : (
            <span className="text-[var(--color-ink-soft)]">
              <span aria-hidden="true">—</span>
              <span className="sr-only">none recorded</span>
            </span>
          )}
        </td>
        <td className={`${td} hidden text-right sm:table-cell`}>{editButton}</td>
      </tr>

      {open ? (
        <tr className="bg-[var(--color-surface)]">
          <td colSpan={IDLE_COLUMNS + 1} className="p-2 pt-0">
            {open === 'remove' ? (
              <RemoveConfirm
                id={row.id}
                name={row.name}
                note="It comes off this list. What it said stays in the log."
                onKeep={() => setOpen({ kind: 'edit', id: row.id })}
              />
            ) : (
              <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] p-3">
                <p className="text-xs text-[var(--color-ink-soft)]">
                  Using it again? Type in what the statement says and it joins the payoff order.
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {/* A balance takes the row out of this table, so its panel closes with it. */}
                  <StatementForm id={row.id} balanceCents={0} highlight={false} onSubmit={() => setOpen(null)} />
                </div>

                <TermsAndRemove id={row.id} initial={row.initial} setOpen={setOpen} />
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

/** What a payoff question needs to know about the debt on the row. */
type PayoffSubject = Pick<DebtRow, 'name' | 'balanceCents' | 'category'>

/** The typed amount, or null while it does not read as one; the server says why. */
function typed(form: HTMLFormElement, field: string): number | null {
  const box = form.elements.namedItem(field)
  return box instanceof HTMLInputElement ? parseAmountOrNull(box.value) : null
}

/** "I paid": a payment made, which asks once first if it pays off a loan (D37). */
function PaymentForm({ row }: { row: DebtRow }) {
  const payoff = usePayoffQuestion(row.name)
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const amount = typed(event.currentTarget, 'amount')
    payoff.check(
      event,
      amount !== null && amount > 0 && paysOffLoan({ ...row, state: 'open' }, balanceAfterPaymentCents(row, amount)),
    )
  }
  return (
    <div className="space-y-2">
      <form action={confirmDebtPaymentAction} onSubmit={onSubmit} className="flex items-end gap-2">
        <input type="hidden" name="debt_id" value={row.id} />
        {payoff.hidden}
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
      {payoff.question}
    </div>
  )
}

/**
 * "The statement says it is": a balance read off a statement, dated today. On
 * a debt in the payoff order it asks once first if the balance pays off a loan.
 */
function StatementForm({
  id,
  balanceCents,
  highlight,
  onSubmit,
  payoff: subject,
}: {
  id: string
  balanceCents: number
  highlight: boolean
  onSubmit?: () => void
  payoff?: PayoffSubject
}) {
  const payoff = usePayoffQuestion(subject?.name ?? '')
  function submit(event: FormEvent<HTMLFormElement>) {
    const balance = typed(event.currentTarget, 'balance')
    const asks = subject !== undefined && balance !== null && balance >= 0 && paysOffLoan({ ...subject, state: 'open' }, balance)
    if (payoff.check(event, asks)) onSubmit?.()
  }
  return (
    <div className="space-y-2">
      <form
        action={updateDebtBalanceAction}
        onSubmit={submit}
        className={`flex items-end gap-2 ${highlight ? 'rounded-lg bg-[var(--color-accent-soft)] p-2 sm:-m-2' : ''}`}
      >
        <input type="hidden" name="debt_id" value={id} />
        {payoff.hidden}
        <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
          The statement says it is
          <input
            name="balance"
            inputMode="decimal"
            placeholder={formatCents(balanceCents).replace('$', '')}
            className={smallField}
          />
        </label>
        <button type="submit" className="min-h-11 rounded-lg border border-[var(--color-line)] px-3 text-sm">
          Update
        </button>
      </form>
      {payoff.question}
    </div>
  )
}

/** The foot of an open row: its terms behind a fold, then Close and Remove. */
function TermsAndRemove({
  id,
  initial,
  setOpen,
  payoff,
}: {
  id: string
  initial: DebtFormValues
  setOpen: (open: Open) => void
  /** A debt in the payoff order: a $0 balance typed here may pay off a loan. */
  payoff?: PayoffSubject
}) {
  return (
    <>
      <details className="border-t border-[var(--color-line)] pt-3">
        <summary className="cursor-pointer text-sm font-medium text-[var(--color-accent)]">
          Change its terms
        </summary>
        <div className="mt-3">
          <DebtForm
            action={updateDebtAction}
            initial={initial}
            debtId={id}
            payoff={payoff}
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
          onClick={() => setOpen({ kind: 'remove', id })}
          className="min-h-11 text-sm text-[var(--color-behind)] underline"
        >
          Remove this debt
        </button>
      </div>
    </>
  )
}

/** The confirm step for removing a debt, kept inside the table. */
function RemoveConfirm({
  id,
  name,
  note,
  onKeep,
}: {
  id: string
  name: string
  note: string
  onKeep: () => void
}) {
  return (
    <div className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm">
      <p className="font-medium text-[var(--color-behind)]">Remove {name} from Ballast?</p>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{note}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <form action={removeDebtAction}>
          <input type="hidden" name="debt_id" value={id} />
          <button
            type="submit"
            className="min-h-11 w-full rounded-lg bg-[var(--color-behind)] px-3 text-sm font-medium text-white"
          >
            Yes, remove it
          </button>
        </form>
        <button
          type="button"
          onClick={onKeep}
          className="min-h-11 rounded-lg border border-[var(--color-line)] px-3 text-sm font-medium"
        >
          Keep it
        </button>
      </div>
    </div>
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
