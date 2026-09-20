/**
 * Home / This Week (PRD §9, screen 1).
 *
 * The one question the product exists to answer, answered at the top of the
 * screen: how much moves into each account this week. Every figure is
 * decomposed, and nothing here is computed in the component -- the derivation
 * module produced all of it (PRD §10).
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Empty, Money, PageHeader, Pill } from '@/components/ui'
import { WeeklyNumber } from '@/components/weekly-number'
import { formatCents, respreadEquivalentPerWeekCents } from '@/domain'

export const dynamic = 'force-dynamic'

export default async function ThisWeekPage() {
  const { engine, viewer } = await requireEngine()
  const accounts = await engine.accountViews()
  const today = engine.today()

  const withWork = accounts.filter((a) => a.weekly.totalPerWeekCents !== 0)
  const grandTotal = withWork.reduce((s, a) => s + a.weekly.totalPerWeekCents, 0)
  const shouldHold = accounts.reduce((s, a) => s + a.shouldHaveSavedCents, 0)

  const firstName = viewer.name?.split(' ')[0] ?? 'there'

  return (
    <>
      <PageHeader
        title="This week"
        subtitle={`Hi ${firstName} — here is what to move, as of ${today}.`}
      />

      {withWork.length === 0 ? (
        <Empty title="Nothing to move this week.">
          <p>
            When you commit a plan, the weekly amounts show up here.{' '}
            <Link href="/packages/new" className="text-[var(--color-accent)] underline">
              Start a plan
            </Link>
          </p>
        </Empty>
      ) : (
        <>
          <Card className="mb-4 bg-[var(--color-accent-soft)]">
            <p className="text-sm text-[var(--color-ink-soft)]">Total across every account</p>
            <p className="mt-1 text-3xl font-semibold">
              <Money cents={grandTotal} />
              <span className="text-base font-normal text-[var(--color-ink-soft)]"> / week</span>
            </p>
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              Your accounts should hold <Money cents={shouldHold} /> in total today.
            </p>
          </Card>

          <ul className="space-y-4">
            {withWork.map((view) => {
              const outstanding = view.outstandingCents
              const soonest = view.items
                .map((i) => i.lineItem.dueDate)
                .sort()
                .at(0)
              const respread = respreadEquivalentPerWeekCents({
                remainingCents: outstanding,
                asOf: today,
                dueDate: soonest ?? today,
              })

              return (
                <li key={view.account.id}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="font-semibold">{view.account.name}</h2>
                        <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
                          {view.account.institutionLabel}
                        </p>
                      </div>
                      {view.items.some((i) => i.isOverdue) ? (
                        <Pill tone="behind">Needs a check</Pill>
                      ) : null}
                    </div>

                    <div className="mt-4">
                      <WeeklyNumber weekly={view.weekly} respreadCents={respread} />
                    </div>

                    <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--color-line)] pt-3 text-sm">
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">Should hold today</dt>
                        <dd className="mt-0.5 font-medium">
                          <Money cents={view.shouldHaveSavedCents} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">Still to set aside</dt>
                        <dd className="mt-0.5 font-medium">
                          <Money cents={outstanding} />
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-4 rounded-xl bg-[var(--color-surface)] p-3 text-sm">
                      In Capital One 360, set the recurring transfer into{' '}
                      <strong>{view.account.name}</strong> to{' '}
                      <strong>{formatCents(view.weekly.totalPerWeekCents)} per week</strong>.
                    </p>
                  </Card>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </>
  )
}
