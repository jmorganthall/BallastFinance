'use client'

import { useState } from 'react'

const field =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

export function DebtForm({ action }: { action: (formData: FormData) => void }) {
  const [minType, setMinType] = useState('fixed')
  const [hasPromo, setHasPromo] = useState(false)

  return (
    <form
      action={action}
      className="space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-4"
    >
      <label className="block text-sm font-medium">
        Name
        <input name="name" required placeholder="US Bank Shield 0568" className={field} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm font-medium">
          Kind
          <select name="category" className={field} defaultValue="consumer">
            <option value="consumer">Credit card or loan</option>
            <option value="auto">Car</option>
            <option value="mortgage">Mortgage</option>
          </select>
        </label>
        <label className="block text-sm font-medium">
          Balance owed
          <input name="balance" inputMode="decimal" required placeholder="5000" className={field} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm font-medium">
          Interest rate (%)
          <input name="apr" inputMode="decimal" required placeholder="24.99" className={field} />
          <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
            The normal rate. If it is on a 0% deal, put the rate it goes back to here.
          </span>
        </label>
        <label className="block text-sm font-medium">
          Credit limit (optional)
          <input name="credit_limit" inputMode="decimal" placeholder="8000" className={field} />
        </label>
      </div>

      <label className="block text-sm font-medium">
        How the minimum payment works
        <select
          name="min_type"
          className={field}
          value={minType}
          onChange={(e) => setMinType(e.target.value)}
        >
          <option value="fixed">A set amount each month</option>
          <option value="percent">A percentage of the balance</option>
          <option value="percent_with_floor">A percentage, but never below a set amount</option>
        </select>
      </label>

      {minType === 'fixed' ? (
        <label className="block text-sm font-medium">
          Minimum each month
          <input name="min_amount" inputMode="decimal" placeholder="150" className={field} />
        </label>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Percentage
            <input name="min_percent" inputMode="decimal" placeholder="2" className={field} />
          </label>
          {minType === 'percent_with_floor' ? (
            <label className="block text-sm font-medium">
              But never below
              <input name="min_floor" inputMode="decimal" placeholder="25" className={field} />
            </label>
          ) : null}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={hasPromo}
          onChange={(e) => setHasPromo(e.target.checked)}
          className="h-5 w-5"
        />
        It has a promotional rate (0% deal, balance transfer)
      </label>

      {hasPromo ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              Promotional rate (%)
              <input name="promo_rate" inputMode="decimal" placeholder="0" className={field} />
            </label>
            <label className="block text-sm font-medium">
              Until
              <input name="promo_until" type="date" required className={field} />
            </label>
          </div>
          <p className="rounded-lg bg-[var(--color-surface)] p-3 text-xs text-[var(--color-ink-soft)]">
            Make sure the interest rate above is the one it reverts to, not 0. Ballast uses that
            to work out whether you can clear the balance before the deal ends — and to start
            pushing this debt up the list in time if you cannot.
          </p>
        </>
      ) : null}

      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" name="fixed_payment" className="h-5 w-5" />
        The payment never changes (a loan, not a card)
      </label>

      <button
        type="submit"
        className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
      >
        Add this debt
      </button>
    </form>
  )
}
