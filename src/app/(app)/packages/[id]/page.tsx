/**
 * Package detail (PRD §9, screen 2).
 *
 * Editing a quantity or a date is an ordinary inline change, not a planning
 * session -- that is the whole point of the product. Each edit posts straight to
 * the engine, which records the event and recomputes; the new decomposed weekly
 * number is on screen immediately.
 */

import { notFound } from 'next/navigation'
import { requireEngine } from '@/server/session'
import { Card, Hint, Money, PageHeader, Pill } from '@/components/ui'
import { WeeklyNumber } from '@/components/weekly-number'
import { AccrualChart } from '@/components/accrual-chart'
import { commitPackageAction, updateDueDateAction, updateQuantityAction } from '@/server/actions'
import { formatCents } from '@/domain'

export const dynamic = 'force-dynamic'

export default async function PackageDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { engine } = await requireEngine()

  const view = (await engine.packageViews()).find((v) => v.package.id === id)
  if (!view) notFound()

  const isDraft = view.package.state === 'simulated'
  const whatIf = isDraft ? await engine.whatIf(id) : []
  const curve = isDraft ? null : await engine.packageCurve(id)
  const accounts = await engine.listReserveAccounts()
  const accountName = (accountId: string) =>
    accounts.find((a) => a.id === accountId)?.name ?? 'Unknown account'

  return (
    <>
      <PageHeader
        title={view.package.name}
        subtitle={
          isDraft
            ? 'A draft. Nothing is being set aside yet.'
            : `Committed ${view.package.committedAt}.`
        }
      />

      <Card className="mb-4">
        <p className="text-sm text-[var(--color-ink-soft)]">Total cost of this plan</p>
        <p className="mt-1 text-2xl font-semibold">
          <Money cents={view.totalCents} />
        </p>

        {isDraft ? (
          <>
            <div className="mt-4 rounded-xl bg-[var(--color-surface)] p-3">
              <p className="text-sm font-medium">If you commit this today</p>
              {whatIf.length === 0 ? (
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  Nothing to set aside — check the dates and amounts below.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {whatIf.map((line) => (
                    <li key={line.accountId} className="flex justify-between gap-3">
                      <span>{line.accountName}</span>
                      <span className="tabular">
                        <Money cents={line.currentPerWeekCents} /> →{' '}
                        <strong>
                          <Money cents={line.projectedPerWeekCents} />
                        </strong>
                        /wk
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <form action={commitPackageAction} className="mt-4">
              <input type="hidden" name="package_id" value={view.package.id} />
              <button
                type="submit"
                className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
              >
                Start saving for this
              </button>
            </form>
            <p className="mt-2 text-center text-xs text-[var(--color-ink-soft)]">
              Starts today with nothing set aside yet.
            </p>
          </>
        ) : (
          <div className="mt-4">
            <WeeklyNumber weekly={view.weekly} size="small" />
            <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
              <Money cents={view.shouldHaveSavedCents} /> should be set aside for this so far.
            </p>
          </div>
        )}
      </Card>

      {curve ? (
        <Card className="mb-4">
          <h2 className="mb-3 text-sm font-semibold">How the money builds up</h2>
          <AccrualChart
            points={curve.points}
            confirmed={curve.confirmed}
            today={engine.today()}
            targetCents={curve.targetCents}
          />
        </Card>
      ) : null}

      <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        What it is made of
      </h2>

      <ul className="space-y-3">
        {view.items.map((item) => (
          <li key={item.lineItem.id}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">{item.lineItem.label}</h3>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
                    {accountName(item.lineItem.reserveAccountId)}
                  </p>
                </div>
                {item.isOverdue ? <Pill tone="behind">Date has passed</Pill> : null}
              </div>

              <p className="mt-2 text-sm">
                {item.lineItem.quantity} × <Money cents={item.lineItem.unitAmountCents} /> ={' '}
                <strong>
                  <Money cents={item.totalCents} />
                </strong>
              </p>

              {!isDraft ? (
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  <Money cents={item.shouldHaveSavedCents} /> set aside ·{' '}
                  <Money cents={item.remainingCents} /> to go ·{' '}
                  {formatCents(item.weekly.totalPerWeekCents)}/wk
                </p>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-[var(--color-line)] pt-3">
                <form action={updateQuantityAction} className="flex items-end gap-2">
                  <input type="hidden" name="line_item_id" value={item.lineItem.id} />
                  <input type="hidden" name="package_id" value={view.package.id} />
                  <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
                    How many
                    <input
                      name="quantity"
                      type="number"
                      min={0}
                      defaultValue={item.lineItem.quantity}
                      className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-2 text-base text-[var(--color-ink)]"
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded-lg border border-[var(--color-line)] px-3 text-sm"
                  >
                    Save
                  </button>
                </form>

                <form action={updateDueDateAction} className="flex items-end gap-2">
                  <input type="hidden" name="line_item_id" value={item.lineItem.id} />
                  <input type="hidden" name="package_id" value={view.package.id} />
                  <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
                    Needed by
                    <input
                      name="due_date"
                      type="date"
                      defaultValue={item.lineItem.dueDate}
                      className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-2 text-base text-[var(--color-ink)]"
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded-lg border border-[var(--color-line)] px-3 text-sm"
                  >
                    Save
                  </button>
                </form>
              </div>

              {!isDraft && item.components.length > 1 ? (
                <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
                  <Hint
                    detail={item.components
                      .map(
                        (c) =>
                          `${c.kind === 'base' ? 'Original plan' : 'Added when the plan changed'}: ${formatCents(c.amountCents)} over ${c.weeks} week${c.weeks === 1 ? '' : 's'}, ${c.startDate} to ${c.endDate}`,
                      )
                      .join(' · ')}
                  >
                    Changed {item.components.length - 1} time
                    {item.components.length - 1 === 1 ? '' : 's'} since committing
                  </Hint>
                </p>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </>
  )
}
