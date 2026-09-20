/**
 * Settings (PRD §9, screen 7): the household's standing rules.
 *
 * Every number here is a rule, not a fact about money, and each is versioned by
 * effective_from rather than overwritten -- so a past allocation still reads
 * correctly against the rules that were in force when it was made.
 */

import { requireEngine } from '@/server/session'
import { Card, Hint, Money, PageHeader } from '@/components/ui'
import {
  createReserveAccountAction,
  saveAllocationRulesAction,
  saveNotificationPrefsAction,
  saveNudgeSettingsAction,
  signOutAction,
} from '@/server/actions'
import { formatCents } from '@/domain'

export const dynamic = 'force-dynamic'

const field =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const { saved, error } = await searchParams
  const { engine, viewer } = await requireEngine()

  const [rules, buffer, weight, accounts, nudgeWeeks, promoLead, prefs] = await Promise.all([
    engine.allocationRules(),
    engine.bufferCents(),
    engine.priorityWeight(),
    engine.listReserveAccounts(),
    engine.getSetting<number>('check_in_nudge_weeks', 2),
    engine.promoLeadWeeks(),
    engine.getSetting<Record<string, boolean>>('notification_prefs', {}),
  ])
  // Absent means subscribed: both spouses receive everything by default (PRD §8).
  const receives = prefs[viewer.userId] !== false

  return (
    <>
      <PageHeader title="Settings" subtitle={`Signed in as ${viewer.email}.`} />

      {saved ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <p className="text-sm font-medium text-[var(--color-ahead)]">Saved.</p>
        </Card>
      ) : null}
      {error ? (
        <Card className="mb-4 bg-[var(--color-behind-soft)]">
          <p className="text-sm text-[var(--color-behind)]">{error}</p>
        </Card>
      ) : null}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        How spare money gets shared out
      </h2>
      <Card className="mb-6">
        <form action={saveAllocationRulesAction} className="space-y-3">
          {rules.map((rule) => (
            <label key={rule.destination} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{rule.label}</span>
              <span className="flex items-center gap-1">
                <input
                  name={`percent_${rule.destination}`}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={rule.percent}
                  className="w-20 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-2 text-right text-base text-[var(--color-ink)]"
                />
                <span className="text-[var(--color-ink-soft)]">%</span>
              </span>
            </label>
          ))}

          <p className="text-xs text-[var(--color-ink-soft)]">
            These have to add up to 100%.
          </p>

          <label className="block text-sm font-medium">
            Cushion to keep back before sharing anything out
            <input
              name="buffer"
              inputMode="decimal"
              defaultValue={formatCents(buffer).replace('$', '').replace(/,/g, '')}
              className={field}
            />
          </label>

          <button
            type="submit"
            className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
          >
            Save these rules
          </button>
        </form>
      </Card>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        Reminders
      </h2>
      <Card className="mb-6">
        <form action={saveNudgeSettingsAction} className="space-y-3">
          <label className="block text-sm font-medium">
            Nudge us if we have not checked balances for this many weeks
            <input
              name="check_in_nudge_weeks"
              type="number"
              min={1}
              max={12}
              defaultValue={nudgeWeeks}
              className={field}
            />
          </label>
          <label className="block text-sm font-medium">
            <Hint detail="How far ahead of a promotional rate ending Ballast starts treating that debt as urgent, so there is still time to clear the balance.">
              Start warning about an ending deal this many weeks early
            </Hint>
            <input
              name="promo_lead_weeks"
              type="number"
              min={1}
              max={52}
              defaultValue={promoLead}
              className={field}
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-xl border border-[var(--color-line)] px-4 py-3 font-medium"
          >
            Save reminders
          </button>
        </form>

        <form
          action={saveNotificationPrefsAction}
          className="mt-4 border-t border-[var(--color-line)] pt-4"
        >
          <label className="flex items-start gap-3 text-sm font-medium">
            <input
              type="checkbox"
              name="muted"
              defaultChecked={receives}
              className="mt-0.5 h-5 w-5"
            />
            <span>
              Send these to me
              <span className="mt-0.5 block text-xs font-normal text-[var(--color-ink-soft)]">
                Turning this off only stops your own messages, not your spouse&apos;s.
              </span>
            </span>
          </label>
          <button
            type="submit"
            className="mt-3 w-full rounded-xl border border-[var(--color-line)] px-4 py-2 text-sm font-medium"
          >
            Save
          </button>
        </form>
      </Card>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        Payoff order
      </h2>
      <Card className="mb-6">
        <p className="text-sm">
          Currently weighted {Math.round(weight * 100)}% toward paying the least interest and{' '}
          {Math.round((1 - weight) * 100)}% toward freeing up cash each month.
        </p>
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
          Change it with the slider on the Debts screen, then choose to make it the normal setting.
        </p>
      </Card>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        Savings accounts
      </h2>
      <Card className="mb-6">
        {accounts.length > 0 ? (
          <ul className="mb-4 space-y-2 text-sm">
            {accounts.map((account) => (
              <li key={account.id} className="flex justify-between gap-3">
                <span className="font-medium">{account.name}</span>
                <span className="text-[var(--color-ink-soft)]">{account.institutionLabel}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-sm text-[var(--color-ink-soft)]">None yet.</p>
        )}

        <form action={createReserveAccountAction} className="space-y-3 border-t border-[var(--color-line)] pt-4">
          <label className="block text-sm font-medium">
            Add an account
            <input name="name" required placeholder="Gifts &amp; Giving" className={field} />
          </label>
          <label className="block text-sm font-medium">
            What it is called at the bank
            <input name="institution_label" placeholder="Capital One 360 — Gifts &amp; Giving" className={field} />
          </label>
          <button
            type="submit"
            className="w-full rounded-xl border border-[var(--color-line)] px-4 py-3 font-medium"
          >
            Add it
          </button>
        </form>
      </Card>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        Your data
      </h2>
      <Card>
        <p className="text-sm">
          Everything Ballast knows — plans, accounts, debts, and the full history of every
          confirmation — downloads as one file.
        </p>
        <a
          href="/api/export"
          download
          className="mt-3 block rounded-xl border border-[var(--color-line)] px-4 py-3 text-center font-medium"
        >
          Download everything
        </a>
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
          It is your data. Nothing here is locked in, and Ballast never holds a bank login.
        </p>
      </Card>

      <form action={signOutAction} className="mt-6">
        <button
          type="submit"
          className="w-full rounded-xl border border-[var(--color-line)] px-4 py-3 text-sm font-medium text-[var(--color-ink-soft)]"
        >
          Sign out
        </button>
      </form>
    </>
  )
}
