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
import { shareFromStatement } from '@/domain/debt'
import { parseAmountOrNull, parsePercentOrNull } from '@/domain/money'
import type { DebtFormState } from '@/server/actions'

type Problem = { field: string; message: string }

const INITIAL: DebtFormState = { problems: [], saved: 0 }

const fieldClass =
  'mt-1 w-full rounded-lg border bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const okBorder = 'border-[var(--color-line)]'
const badBorder = 'border-[var(--color-behind)]'

export function DebtForm({
  action,
  initial,
  debtId,
  submitLabel = 'Add this debt',
  onSaved,
}: {
  action: (previous: DebtFormState, formData: FormData) => Promise<DebtFormState>
  /** Editing an existing debt: the boxes start from what is stored. */
  initial?: DebtFormValues
  debtId?: string
  submitLabel?: string
  onSaved?: () => void
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL)
  const [values, setValues] = useState<DebtFormValues>(initial ?? EMPTY_DEBT_FORM)
  const [problems, setProblems] = useState<Problem[]>([])
  const [justSaved, setJustSaved] = useState(false)
  const editing = debtId !== undefined

  // Whatever the server found goes next to the box it belongs to.
  useEffect(() => {
    setProblems(state.problems)
  }, [state.problems])

  // A successful add clears the form for the next one; a successful edit
  // keeps what was typed and tells its owner it is done.
  useEffect(() => {
    if (state.saved > 0) {
      if (!editing) setValues(EMPTY_DEBT_FORM)
      setProblems([])
      setJustSaved(true)
      onSaved?.()
    }
    // onSaved is a callback prop; re-running on its identity would re-fire the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.saved, editing])

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
          {editing ? 'Saved.' : 'Added. It is in the payoff order above.'}
        </p>
      ) : null}
      {editing ? <input type="hidden" name="debt_id" value={debtId} /> : null}

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
            <option value="fixed">A set amount each month (a loan, or a card with a flat minimum)</option>
            <option value="percent">Interest plus a percentage of the balance</option>
            <option value="percent_with_floor">Interest plus a percentage, but never below a set amount</option>
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
          <Field
            label="Percentage"
            hint="On top of the month's interest. Most cards use 1%."
            problem={problemFor('min_percent')}
          >
            {(a) => (
              <input
                {...a}
                name="min_percent"
                inputMode="decimal"
                value={values.min_percent}
                onChange={(e) => set('min_percent', e.target.value)}
                placeholder="1"
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
          <ShareFromStatement
            aprText={values.apr}
            floorText={values.min_type === 'percent_with_floor' ? values.min_floor : ''}
            onShare={(percent) => set('min_percent', percent)}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="What you actually pay each month (optional)" problem={problemFor('monthly_payment')}>
          {(a) => (
            <input
              {...a}
              name="monthly_payment"
              inputMode="decimal"
              value={values.monthly_payment}
              onChange={(e) => set('monthly_payment', e.target.value)}
              placeholder="Leave blank if it is just the minimum"
            />
          )}
        </Field>
        <Field label="Day it goes out (optional)" problem={problemFor('payment_day')}>
          {(a) => (
            <input
              {...a}
              name="payment_day"
              inputMode="numeric"
              value={values.payment_day}
              onChange={(e) => set('payment_day', e.target.value)}
              placeholder="13"
            />
          )}
        </Field>
      </div>
      <p className="-mt-2 text-xs text-[var(--color-ink-soft)]">
        If you pay more than the minimum, this is what decides whether a deal-rate balance is on
        track to be cleared before the rate ends, and when it is paid off. With a day, Ballast
        assumes the payment goes out each month and keeps the balance current between
        statements.
      </p>

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
          {/* The fine print of the deal (D49 (9)): asked once, kept out of the way. */}
          <details
            className="rounded-lg border border-[var(--color-line)] p-3"
            open={Boolean(problemFor('promo_started')) || undefined}
          >
            <summary className="cursor-pointer text-sm font-medium">More about this deal</summary>
            <div className="mt-3 space-y-3">
              <Field
                label="If it is not paid off by the end, is the interest charged back?"
                problem={problemFor('promo_charged_back')}
                hint="Most store cards and some balance transfers charge interest back to the day the deal started."
              >
                {(a) => (
                  <select
                    {...a}
                    name="promo_charged_back"
                    value={values.promo_charged_back}
                    onChange={(e) => set('promo_charged_back', e.target.value)}
                  >
                    <option value="yes">Yes, back to when it started</option>
                    <option value="no">No, only on what is left</option>
                    <option value="">Not sure yet (Ballast assumes yes)</option>
                  </select>
                )}
              </Field>
              <Field
                label="When the deal started (optional)"
                problem={problemFor('promo_started')}
                hint="Leave it blank and Ballast counts from the day you entered this debt."
              >
                {(a) => (
                  <input
                    {...a}
                    name="promo_started"
                    type="date"
                    value={values.promo_started}
                    onChange={(e) => set('promo_started', e.target.value)}
                  />
                )}
              </Field>
            </div>
          </details>
        </>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white disabled:opacity-60"
      >
        {pending ? (editing ? 'Saving…' : 'Adding…') : submitLabel}
      </button>
    </form>
  )
}

/**
 * A labelled box with its own complaint underneath. The render-prop hands the
 * control its class and the aria wiring, so every box reports a problem the
 * same way to a screen reader as it does to the eye.
 */
/**
 * "Work it out from a statement" (PRD D51): the percentage a card's minimum
 * uses, from one statement's balance, minimum, interest and fees. It fills
 * the Percentage box and stores nothing; its boxes have no names, so the
 * form never sends them. The arithmetic is the domain's `shareFromStatement`.
 */
function ShareFromStatement({
  aprText,
  floorText,
  onShare,
}: {
  aprText: string
  floorText: string
  onShare: (percent: string) => void
}) {
  const [box, setBox] = useState({ balance: '', minimum: '', interest: '', fees: '' })
  const [said, setSaid] = useState<string | null>(null)
  const small = `${fieldClass} ${okBorder}`
  const put = (field: keyof typeof box) => (e: { target: { value: string } }) =>
    setBox((b) => ({ ...b, [field]: e.target.value }))

  const workItOut = () => {
    const balanceCents = parseAmountOrNull(box.balance)
    const minimumCents = parseAmountOrNull(box.minimum)
    if (balanceCents === null || minimumCents === null || balanceCents <= 0 || minimumCents <= 0) {
      setSaid('Fill in the statement balance and its minimum payment due.')
      return
    }
    const interestCents = box.interest.trim() === '' ? null : parseAmountOrNull(box.interest)
    const feesCents = box.fees.trim() === '' ? 0 : parseAmountOrNull(box.fees)
    if ((box.interest.trim() !== '' && interestCents === null) || feesCents === null) {
      setSaid('Enter the interest and fees as amounts, like 83.52.')
      return
    }
    const aprBasisPoints = parsePercentOrNull(aprText)
    if (interestCents === null && aprBasisPoints === null) {
      setSaid('Fill in the interest charged, or the interest rate above.')
      return
    }
    const got = shareFromStatement({
      balanceCents,
      minimumCents,
      interestCents,
      feesCents,
      floorCents: floorText.trim() === '' ? null : parseAmountOrNull(floorText),
      aprBasisPoints: aprBasisPoints ?? 0,
    })
    if (!got.ok) {
      setSaid(
        got.reason === 'floor'
          ? 'That minimum is the floor, so this statement does not show the percentage. Try one with a bigger balance.'
          : got.reason === 'whole_balance'
            ? 'That minimum is the whole balance, so this statement does not show the percentage.'
            : 'That minimum does not cover the interest and fees, so the figures do not fit interest plus a percentage. Check them against the statement.',
      )
      return
    }
    const percent = (got.basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')
    onShare(percent)
    setSaid(
      `${got.snapped ? 'Looks like' : 'About'} ${percent}%, now in the Percentage box.` +
        (got.interestEstimated
          ? ' The interest was worked out from the rate above, so check it against the statement if you can.'
          : ''),
    )
  }

  return (
    <details className="sm:col-span-2">
      <summary className="cursor-pointer text-sm font-medium text-[var(--color-accent)]">
        Work it out from a statement
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Statement balance
          <input inputMode="decimal" value={box.balance} onChange={put('balance')} placeholder="3341.75" className={small} />
        </label>
        <label className="block text-sm font-medium">
          Minimum payment due
          <input inputMode="decimal" value={box.minimum} onChange={put('minimum')} placeholder="116.94" className={small} />
        </label>
        <label className="block text-sm font-medium">
          Interest charged (optional)
          <input inputMode="decimal" value={box.interest} onChange={put('interest')} placeholder="83.52" className={small} />
        </label>
        <label className="block text-sm font-medium">
          Fees on this statement (optional)
          <input inputMode="decimal" value={box.fees} onChange={put('fees')} placeholder="0" className={small} />
        </label>
      </div>
      <button
        type="button"
        onClick={workItOut}
        className="mt-3 min-h-11 w-full rounded-lg border border-[var(--color-line)] px-4 text-sm font-medium"
      >
        Work out the percentage
      </button>
      {said ? (
        <p role="status" className="mt-2 text-sm text-[var(--color-ink-soft)]">
          {said}
        </p>
      ) : null}
    </details>
  )
}

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
