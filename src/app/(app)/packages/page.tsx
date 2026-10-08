import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { nextDue, type DueUrgency } from '@/domain/next-due'
import { Card, Empty, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import { ProgressBar } from '@/components/progress-bar'
import { steadySinceWords } from '@/domain'

export const dynamic = 'force-dynamic'

const STATE_COPY = {
  simulated: { tone: 'neutral' as const, label: 'Draft — costs nothing yet' },
  active: { tone: 'accent' as const, label: 'Saving now' },
  retired: { tone: 'neutral' as const, label: 'Done' },
}

/** The nearer the next thing out, the heavier it reads: under 30 days bold, 30 to 60 medium, beyond plain. */
const URGENCY_WEIGHT: Record<DueUrgency, string> = {
  soon: 'font-semibold text-[var(--color-ink)]',
  near: 'font-medium text-[var(--color-ink)]',
  far: '',
}

export default async function PackagesPage() {
  const { engine } = await requireEngine()
  const [views, position, today] = await Promise.all([
    engine.packageViews(),
    engine.position(),
    Promise.resolve(engine.today()),
  ])
  // Every figure on a live plan's card is the one position's (D35): the same
  // numbers the plan's own page, This week and the check-in read.
  const plans = new Map(position.plans.map((p) => [p.package.id, p]))
  const shortOn = new Map(position.accounts.map((a) => [a.account.id, a.short?.on ?? null]))

  return (
    <>
      <PageHeader title="Plans" subtitle="Things you are setting money aside for." />

      <Link
        href="/packages/new"
        className="mb-4 block rounded-xl bg-[var(--color-accent)] px-4 py-3 text-center font-medium text-white"
      >
        Start a plan
      </Link>
      <p className="-mt-2 mb-4 text-sm text-[var(--color-ink-soft)]">
        Pricing a Disney trip?{' '}
        <Link href="/trips" className="text-[var(--color-accent)] underline underline-offset-4">
          Work it out under Trips
        </Link>{' '}
        and add it here in one tap.
      </p>

      {views.length === 0 ? (
        <Empty title="No plans yet.">
          <p>A plan is a trip, a bill, a Christmas — anything with a date and a cost.</p>
        </Empty>
      ) : (
        <ul className="space-y-3">
          {views.map((view) => {
            const copy = STATE_COPY[view.package.state]
            const plan = plans.get(view.package.id)
            const next =
              view.package.state === 'retired'
                ? null
                : nextDue(
                    view.items.map((item) => item.lineItem),
                    today,
                  )
            return (
              <li key={view.package.id}>
                <Link href={`/packages/${view.package.id}`}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-semibold">{view.package.name}</h2>
                      <Pill tone={copy.tone}>{copy.label}</Pill>
                    </div>
                    <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                      <Money cents={plan?.totalCents ?? view.totalCents} /> total
                      {plan ? (
                        <>
                          {' · '}
                          <Money cents={plan.steadyPerWeekCents} />/week steady
                          {' · '}
                          <Money cents={plan.countedCents} /> here now
                        </>
                      ) : null}
                    </p>
                    {next ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        Next out: {next.label},{' '}
                        <span className={URGENCY_WEIGHT[next.urgency]}>
                          {next.daysAway < 0 ? 'was due' : 'due'} {next.distance}
                        </span>{' '}
                        ({humanDate(next.dueDate)})
                      </p>
                    ) : null}
                    {plan && plan.parts.length > 0 ? (
                      <ProgressBar
                        className="mt-3"
                        totalCents={plan.totalCents}
                        countedCents={plan.countedCents}
                        savedForCents={plan.savedForCents}
                        coveringSoonerCents={plan.coveringSoonerCents}
                        notYetHereCents={plan.notYetHereCents}
                        status={plan.status}
                        savingSince={
                          plan.savingSince
                            ? {
                                date: plan.savingSince,
                                words: plan.parts.length === 1 ? steadySinceWords(plan.parts[0]!.savingSince.reason) : 'the earliest of its parts',
                              }
                            : undefined
                        }
                        shortOn={plan.parts.map((p) => shortOn.get(p.accountId) ?? null).find((d) => d !== null)}
                      />
                    ) : null}
                  </Card>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
