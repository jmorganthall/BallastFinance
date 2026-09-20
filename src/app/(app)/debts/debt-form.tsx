'use client'

/**
 * Add a debt.
 *
 * Every box is controlled, so nothing typed here is ever lost: a slip is shown
 * next to the box it happened in, the rest of the form stays exactly as it was,
 * and the only thing that clears it is a successful add.
 *
 * The browser and the server run the same validator (parseDebtForm), so the
 * message shown before submitting is the message the server would have sent.
 */

import { useActionState, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
// The one module, not the whole domain: this runs in the browser, and the
// validator is all the form needs from it.
import {
  EMPTY_DEBT_FORM,
  parseDebtForm,
  type DebtFormField,
  type DebtFormValues,
} from '@/domain/debt-form'
import type { DebtFormState } from '@/server/actions'

type Problem = { field: string; message: string }

const INITIAL: DebtFormState = { problems: [], saved: 0 }

const fieldClass =
  'mt-1 w-full rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const okBorder = 'border-[var(--color-line)]'
const badBorder = 'border-[var(--color-behind)]'

export function DebtForm({
  action,
}: {
  action: (previous: DebtFormState, formData: FormData) => Promise<DebtFormState>
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL)
  const [values, setValues] = useState<DebtFormValues>(EMPTY_DEBT_FORM)
  const [problems, setProblems] = useState<Problem[]>([])
  const [justSaved, setJustSaved] = useState(false)

  // Whatever the server found goes next to the box it belongs to.
  useEffect(() => {
    setProblems(state.problems)
  }, [state.problems])

  // The one and only time the form clears: a successful add.
  useEffect(() => {
    if (state.saved > 0) {
      setValues(EMPTY_DEBT_FORM)
      setProblems([])
      setJustSaved(true)
    }
  }, [state.saved])

  function set<K extends DebtFormField>(field: K, value: DebtFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }))
    // Editing a box withdraws its complaint until the next attempt.
    setProblems((current) => current.filter((p) => p.field !== field && p.field !== 'form'))
    setJustSaved(false)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const result = parseDebtForm(values)
    if (!result.ok) {
      event.preventDefault()
      setProblems(result.problems)
      // Put the person at the first thing to fix, which matters on a phone
      // where the form is taller than the screen.
      const first = result.problems[0]
      const box = first
        ? event.currentTarget.querySelector<HTMLElement>(`[name="${first.field}"]`)
        : null
      box?.focus()
      box?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }

  const problemFor = (field: DebtFormField) => problems.find((p) => p.field === field)?.message
  const formProblem = problems.find((p) => p.field === 'form')?.message

  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      noValidate
      className="space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-4"
    >
      {formProblem ? (
        <p
          role="alert"
          className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]"
        >
          {formProblem}
        </p>
      ) : null}
      {justSaved ? (
        <p role="status" className="rounded-xl bg-[var(--color-ahead-soft)] p-3 text-sm text-[var(--color-ahead)]">
          Added. It is in the payoff order above.
        </p>
      ) : null}

      <Field label="Name" problem={problemFor('name')}>
        {(a) => (
          <input
            {...a}
            name="name"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="US Bank Shield 0568"
            autoComplete="off"
          />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Kind" problem={problemFor('category')}>
          {(a) => (
            <select
              {...a}
              name="category"
              value={values.category}
              onChange={(e) => set('category', e.target.value)}
            >
              <option value="consumer">Credit card or loan</option>
              <option value="auto">Car</option>
              <option value="mortgage">Mortgage</option>
            </select>
          )}
        </Field>
        <Field label="Balance owed" problem={problemFor('balance')}>
          {(a) => (
            <input
              {...a}
              name="balance"
              inputMode="decimal"
              value={values.balance}
              onChange={(e) => set('balance', e.target.value)}
              placeholder="5000"
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Interest rate (%)"
          problem={problemFor('apr')}
          hint="The normal rate. If it is on a 0% deal, put the rate it goes back to here."
        >
          {(a) => (
            <input
              {...a}
              name="apr"
              inputMode="decimal"
              value={values.apr}
              onChange={(e) => set('apr', e.target.value)}
              placeholder="24.99"
            />
          )}
        </Field>
        <Field label="Credit limit (optional)" problem={problemFor('credit_limit')}>
          {(a) => (
            <input
              {...a}
              name="credit_limit"
              inputMode="decimal"
              value={values.credit_limit}
              onChange={(e) => set('credit_limit', e.target.value)}
              placeholder="8000"
            />
          )}
        </Field>
      </div>

      <Field label="How the minimum payment works" problem={problemFor('min_type')}>
        {(a) => (
          <select
            {...a}
            name="min_type"
            value={values.min_type}
            onChange={(e) => set('min_type', e.target.value)}
          >
            <option value="fixed">A set amount each month</option>
            <option value="percent">A percentage of the balance</option>
            <option value="percent_with_floor">A percentage, but never below a set amount</option>
          </select>
        )}
      </Field>

      {values.min_type === 'fixed' ? (
        <Field label="Minimum each month" problem={problemFor('min_amount')}>
          {(a) => (
            <input
              {...a}
              name="min_amount"
              inputMode="decimal"
              value={values.min_amount}
              onChange={(e) => set('min_amount', e.target.value)}
              placeholder="150"
            />
          )}
        </Field>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Percentage" problem={problemFor('min_percent')}>
            {(a) => (
              <input
                {...a}
                name="min_percent"
                inputMode="decimal"
                value={values.min_percent}
                onChange={(e) => set('min_percent', e.target.value)}
                placeholder="2"
              />
            )}
          </Field>
          {values.min_type === 'percent_with_floor' ? (
            <Field label="But never below" problem={problemFor('min_floor')}>
              {(a) => (
                <input
                  {...a}
                  name="min_floor"
                  inputMode="decimal"
                  value={values.min_floor}
                  onChange={(e) => set('min_floor', e.target.value)}
                  placeholder="25"
                />
              )}
            </Field>
          ) : null}
        </div>
      )}

      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input
          type="checkbox"
          name="has_promo"
          checked={values.has_promo}
          onChange={(e) => set('has_promo', e.target.checked)}
          className="h-5 w-5 shrink-0"
        />
        It has a promotional rate (0% deal, balance transfer)
      </label>

      {values.has_promo ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Promotional rate (%)" problem={problemFor('promo_rate')}>
              {(a) => (
                <input
                  {...a}
                  name="promo_rate"
                  inputMode="decimal"
                  value={values.promo_rate}
                  onChange={(e) => set('promo_rate', e.target.value)}
                  placeholder="0"
                />
              )}
            </Field>
            <Field label="Until" problem={problemFor('promo_until')}>
              {(a) => (
                <input
                  {...a}
                  name="promo_until"
                  type="date"
                  value={values.promo_until}
                  onChange={(e) => set('promo_until', e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="rounded-lg bg-[var(--color-surface)] p-3 text-xs text-[var(--color-ink-soft)]">
            Make sure the interest rate above is the one it reverts to, not 0. Ballast uses that
            to work out whether you can clear the balance before the deal ends — and to start
            pushing this debt up the list in time if you cannot.
          </p>
        </>
      ) : null}

      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input
          type="checkbox"
          name="fixed_payment"
          checked={values.fixed_payment}
          onChange={(e) => set('fixed_payment', e.target.checked)}
          className="h-5 w-5 shrink-0"
        />
        The payment never changes (a loan, not a card)
      </label>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white disabled:opacity-60"
      >
        {pending ? 'Adding…' : 'Add this debt'}
      </button>
    </form>
  )
}

/**
 * A labelled box with its own complaint underneath. The render-prop hands the
 * control its class and the aria wiring, so every box reports a problem the
 * same way to a screen reader as it does to the eye.
 */
function Field({
  label,
  hint,
  problem,
  children,
}: {
  label: string
  hint?: string
  problem?: string
  children: (attrs: {
    className: string
    'aria-invalid': boolean | undefined
    'aria-describedby': string | undefined
  }) => ReactNode
}) {
  const id = useId()
  const describedBy = problem ? `${id}-problem` : hint ? `${id}-hint` : undefined
  return (
    <label className="block text-sm font-medium">
      {label}
      {children({
        className: `${fieldClass} ${problem ? badBorder : okBorder}`,
        'aria-invalid': problem ? true : undefined,
        'aria-describedby': describedBy,
      })}
      {problem ? (
        <span id={`${id}-problem`} className="mt-1 block text-xs font-normal text-[var(--color-behind)]">
          {problem}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
          {hint}
        </span>
      ) : null}
    </label>
  )
}
