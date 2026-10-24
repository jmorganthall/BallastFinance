'use client'

/**
 * The income forms. A refusal comes back to the same form with what was
 * typed still in it and the reason above the button; nothing is lost to a
 * page reload. A save goes back to Income.
 */

import { useActionState } from 'react'
import { addIncomePaymentAction, saveIncomeSourceAction, type IncomeFormState } from '@/server/actions'
import { FREQUENCIES, FREQUENCY_WORDS } from '@/domain/recurring'
import type { IncomeSource, PaystubLine } from '@/domain/income'
import { PaystubLines, type LineValue } from './paystub-lines'

const small =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-ink)]'

const EMPTY: IncomeFormState = { error: null, values: {}, attempt: 0 }

export type Member = { userId: string; name: string }

function lineInput(line: PaystubLine): string {
  if (line.percentBasisPoints !== null && line.percentBasisPoints !== undefined) return `${line.percentBasisPoints / 100}%`
  return line.cents !== null && line.cents !== undefined ? (line.cents / 100).toFixed(2) : ''
}

const dollars = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2))

/** What the form last posted, when it came back refused; else what is saved. */
function typed(state: IncomeFormState) {
  const one = (name: string, fallback: string) => state.values[name]?.[0] ?? fallback
  const lines = (prefix: 'pretax' | 'tax', fallback: LineValue[]): LineValue[] => {
    const labels = state.values[`${prefix}_label`]
    if (!labels) return fallback
    const amounts = state.values[`${prefix}_amount`] ?? []
    return labels.map((label, i) => ({ label, amount: amounts[i] ?? '' }))
  }
  return { one, lines }
}

function Problem({ state }: { state: IncomeFormState }) {
  return state.error ? (
    <p role="alert" className="rounded-lg bg-[var(--color-behind-soft)] p-2 text-sm text-[var(--color-behind)]">
      {state.error}
    </p>
  ) : null
}

export function SourceForm({
  source,
  takeHomeCents,
  members,
  viewerId,
}: {
  source?: IncomeSource
  /** The take-home as worked out now, for a source saved with its tax lines typed: filled in so a save keeps it. */
  takeHomeCents?: number
  members: Member[]
  viewerId: string
}) {
  const [state, formAction, pending] = useActionState(saveIncomeSourceAction, EMPTY)
  const { one, lines } = typed(state)
  // Editing: whoever it is now. Adding: the person signed in, if they are a member.
  const whoseDefault = source
    ? source.personUserId
      ? `user:${source.personUserId}`
      : 'other'
    : members.some((m) => m.userId === viewerId)
      ? `user:${viewerId}`
      : members.length > 0
        ? `user:${members[0]!.userId}`
        : 'other'

  return (
    // The key remounts the fields after a refusal, so they show what was posted.
    <form key={state.attempt} action={formAction} className="space-y-3 text-sm">
      {source ? <input type="hidden" name="id" value={source.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="block">
          <legend className="font-medium">Whose</legend>
          <select name="whose" defaultValue={one('whose', whoseDefault)} className={`mt-1 ${small}`}>
            {members.map((m) => (
              <option key={m.userId} value={`user:${m.userId}`}>
                {m.name}
              </option>
            ))}
            <option value="other">Someone else</option>
          </select>
          <input
            name="person"
            defaultValue={one('person', source && source.personUserId === null ? source.person : '')}
            placeholder="Their name, for someone else"
            aria-label="Their name, for someone else"
            className={`mt-1 ${small}`}
          />
        </fieldset>
        <label className="block font-medium">
          Job
          <input name="name" required defaultValue={one('name', source?.name ?? '')} placeholder="The employer" className={`mt-1 ${small}`} />
        </label>
        <label className="block font-medium">
          Paid
          <select name="frequency" defaultValue={one('frequency', source?.frequency ?? 'biweekly')} className={`mt-1 ${small}`}>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_WORDS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="block font-medium">
          Started
          <input type="date" name="started_on" defaultValue={one('started_on', source?.startedOn ?? '')} className={`mt-1 ${small}`} />
          <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">The bonus figure is per day since.</span>
        </label>
        <label className="block font-medium">
          Annual salary
          <input name="annual_salary" inputMode="decimal" defaultValue={one('annual_salary', dollars(source?.annualSalaryCents))} placeholder="85000" className={`mt-1 ${small}`} />
        </label>
        <label className="block font-medium">
          Gross per check, if the stub differs
          <input name="gross_per_check" inputMode="decimal" defaultValue={one('gross_per_check', dollars(source?.grossPerCheckCents))} placeholder="Salary ÷ checks a year" className={`mt-1 ${small}`} />
        </label>
      </div>

      <fieldset>
        <legend className="font-medium">Taken out before taxes, per check</legend>
        <p className="text-xs text-[var(--color-ink-soft)]">Dollars, or a percent of the check like 6%. A line left without an amount is dropped.</p>
        <PaystubLines prefix="pretax" initial={lines('pretax', (source?.pretax ?? []).map((l) => ({ label: l.label, amount: lineInput(l) })))} placeholder="Health insurance, 401k, HSA…" />
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block font-medium">
          Take-home per check
          <input
            name="net_per_check"
            required
            inputMode="decimal"
            defaultValue={one('net_per_check', dollars(source?.netPerCheckCents ?? takeHomeCents))}
            className={`mt-1 ${small}`}
          />
          <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
            What lands in checking, off the stub. Ballast works the taxes out from it: whatever is left
            after the deductions above.
          </span>
        </label>
        <label className="block font-medium">
          Of each bonus, to spending
          <input name="spending_share" inputMode="decimal" defaultValue={one('spending_share', `${(source?.spendingShareBasisPoints ?? 2000) / 100}%`)} className={`mt-1 ${small}`} />
        </label>
      </div>
      <label className="block font-medium">
        Known in Simplifi as
        <input name="simplifi_names" defaultValue={one('simplifi_names', source?.simplifiNames.join(', ') ?? '')} placeholder="Acme Payroll" className={`mt-1 ${small}`} />
        <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
          The paycheck&apos;s name in Simplifi&apos;s recurring list; several with commas. Simplifi&apos;s figure is then
          checked against this one.
        </span>
      </label>
      <Problem state={state} />
      <button type="submit" disabled={pending} className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white disabled:opacity-60">
        {pending ? 'Saving…' : source ? 'Save' : 'Add this income'}
      </button>
    </form>
  )
}

export function PaymentForm({ sourceId, today }: { sourceId: string; today: string }) {
  const [state, formAction, pending] = useActionState(addIncomePaymentAction, EMPTY)
  const { one } = typed(state)
  return (
    <form key={state.attempt} action={formAction} className="mt-2 grid gap-2 sm:grid-cols-2">
      <input type="hidden" name="income_source_id" value={sourceId} />
      <label className="text-xs font-medium">
        Landed on
        <input type="date" name="paid_on" required max={today} defaultValue={one('paid_on', today)} className={`mt-1 ${small}`} />
      </label>
      <label className="text-xs font-medium">
        Amount that landed
        <input name="landed" required inputMode="decimal" defaultValue={one('landed', '')} className={`mt-1 ${small}`} />
      </label>
      <label className="text-xs font-medium">
        Before tax (estimate)
        <input name="pretax_estimate" inputMode="decimal" defaultValue={one('pretax_estimate', '')} className={`mt-1 ${small}`} />
      </label>
      <label className="text-xs font-medium">
        Note
        <input name="note" placeholder="Q3 commission" defaultValue={one('note', '')} className={`mt-1 ${small}`} />
      </label>
      <div className="sm:col-span-2">
        <Problem state={state} />
      </div>
      <button type="submit" disabled={pending} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium disabled:opacity-60 sm:col-span-2">
        {pending ? 'Logging…' : 'Log it'}
      </button>
    </form>
  )
}
