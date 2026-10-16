/**
 * The headline (D50 (1)): what Ballast needs a week for every plan, against
 * every plan saving on its own. Two bars, the second drawn to the share the
 * domain gives, and the difference a week and a year in a pill. When Ballast
 * needs as much as the plans on their own or more, only the weekly figure
 * shows: nothing is claimed. Every figure is `smartSaving`'s; this only
 * draws it.
 */

import { Card, Hint, Money } from '@/components/ui'
import { formatCents, type SmartSaving } from '@/domain'

export function SmartSavingCard({ saving }: { saving: SmartSaving }) {
  const plans = saving.planCount === 1 ? 'your plan' : `all ${saving.planCount} plans`
  return (
    <Card className="mb-5">
      <p className="text-sm text-[var(--color-ink-soft)]">Your weekly set-aside</p>
      <p className="mt-1">
        <Money cents={saving.withBallastPerWeekCents} className="text-4xl font-bold tracking-tight" />{' '}
        <span className="text-[var(--color-ink-soft)]">a week covers {plans}</span>
      </p>
      {saving.lessPerWeekCents > 0 ? (
        <>
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
          <p className="mt-4 text-sm">
            <span className="mr-2 inline-block rounded-full bg-[var(--color-ahead-soft)] px-2.5 py-0.5 text-xs font-semibold text-[var(--color-ahead)]">
              <Money cents={saving.lessPerWeekCents} /> a week less
            </span>
            <span className="text-[var(--color-ink-soft)]">
              That is <Money cents={saving.lessPerYearCents} /> a year. Ballast pays whatever is due soonest
              out of the money already set aside, so the transfer stays low.
            </span>
          </p>
        </>
      ) : null}
    </Card>
  )
}
