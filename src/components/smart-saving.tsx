/**
 * The headline (D50 (1)): how much less Ballast needs set aside than every
 * plan saving on its own, said a month first because that is the figure a
 * household feels, then a week and a year. Two bars, the second drawn to the
 * share the domain gives. Under them, the weekly set-aside and what each
 * account takes of it, so the transfer into every account is on the front
 * page. When Ballast needs as much as the plans on their own or more, or the
 * to-dos are not done, nothing is claimed: the weekly figure leads instead.
 * Every figure is `smartSaving`'s; this only draws it.
 */

import { Card, Hint, Money } from '@/components/ui'
import { formatCents, type SmartSaving } from '@/domain'

function PerAccount({ saving }: { saving: SmartSaving }) {
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {saving.accounts.map((a) => (
        <li key={a.accountId} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{a.name}</span>
          <span className="shrink-0 tabular-nums">
            <Money cents={a.perWeekCents} className="font-semibold" /> a week
            {a.bankPerWeekCents !== null ? (
              <span className="text-[var(--color-ink-soft)]">
                {' '}
                (the bank moves <Money cents={a.bankPerWeekCents} />)
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function SmartSavingCard({ saving }: { saving: SmartSaving }) {
  const plans = saving.planCount === 1 ? 'your plan' : `all ${saving.planCount} plans`
  const each = saving.planCount === 1 ? 'your plan' : `each of your ${saving.planCount} plans`
  const claim = saving.lessPerWeekCents > 0
  return (
    <Card className="mb-5">
      {claim ? (
        <>
          <p className="text-sm text-[var(--color-ink-soft)]">With Ballast you set aside</p>
          <p className="mt-1">
            <Money cents={saving.lessPerMonthCents} className="text-4xl font-bold tracking-tight text-[var(--color-ahead)]" />{' '}
            <span className="text-[var(--color-ink-soft)]">a month less</span>
          </p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            <Money cents={saving.lessPerWeekCents} /> a week, <Money cents={saving.lessPerYearCents} /> a year, than
            saving {each} on its own. Ballast pays whatever is due soonest out of the money already set aside.
          </p>
          <div className="mt-4 grid grid-cols-[9.5rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
            <span className="text-[var(--color-ink-soft)]">
              <Hint
                detail={`Each plan saving evenly on its own, from its Saving since to its due date: ${formatCents(saving.onItsOwnPerWeekCents)} a week. Ballast needs ${formatCents(saving.withBallastPerWeekCents)}, the smallest steady transfers that have the money there on every date.`}
              >
                Each plan on its own
              </Hint>
            </span>
            <span aria-hidden className="h-3.5 w-full rounded-r bg-[var(--color-line)]" />
            <span className="font-semibold">With Ballast</span>
            <span
              aria-hidden
              className="h-3.5 rounded-r bg-[var(--color-ink)]"
              style={{ width: `${saving.withBallastShare * 100}%` }}
            />
          </div>
          <p className="mt-5 text-sm">
            <Money cents={saving.withBallastPerWeekCents} className="font-semibold" />{' '}
            <span className="text-[var(--color-ink-soft)]">a week covers {plans}:</span>
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--color-ink-soft)]">Your weekly set-aside</p>
          <p className="mt-1">
            <Money cents={saving.withBallastPerWeekCents} className="text-4xl font-bold tracking-tight" />{' '}
            <span className="text-[var(--color-ink-soft)]">
              a week covers {plans}
              {saving.coversOnItsOwn ? '' : ', once the to-dos below are done'}
            </span>
          </p>
        </>
      )}
      <PerAccount saving={saving} />
    </Card>
  )
}
