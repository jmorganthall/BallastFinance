import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Empty, Money, PageHeader, Pill } from '@/components/ui'
import { ProgressBar } from '@/components/progress-bar'

export const dynamic = 'force-dynamic'

const STATE_COPY = {
  simulated: { tone: 'neutral' as const, label: 'Draft — costs nothing yet' },
  active: { tone: 'accent' as const, label: 'Saving now' },
  retired: { tone: 'neutral' as const, label: 'Done' },
}

export default async function PackagesPage() {
  const { engine } = await requireEngine()
  const views = await engine.packageViews()

  return (
    <>
      <PageHeader title="Plans" subtitle="Things you are setting money aside for." />

      <Link
        href="/packages/new"
        className="mb-4 block rounded-xl bg-[var(--color-accent)] px-4 py-3 text-center font-medium text-white"
      >
        Start a plan
      </Link>

      {views.length === 0 ? (
        <Empty title="No plans yet.">
          <p>A plan is a trip, a bill, a Christmas — anything with a date and a cost.</p>
        </Empty>
      ) : (
        <ul className="space-y-3">
          {views.map((view) => {
            const copy = STATE_COPY[view.package.state]
            return (
              <li key={view.package.id}>
                <Link href={`/packages/${view.package.id}`}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-semibold">{view.package.name}</h2>
                      <Pill tone={copy.tone}>{copy.label}</Pill>
                    </div>
                    <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                      <Money cents={view.totalCents} /> total
                      {view.package.state === 'active' ? (
                        <>
                          {' · '}
                          <Money cents={view.weekly.totalPerWeekCents} />/week
                          {' · '}
                          <Money cents={view.shouldHaveSavedCents} /> set aside so far
                        </>
                      ) : null}
                    </p>
                    {view.package.state === 'active' ? (
                      <ProgressBar
                        className="mt-3"
                        totalCents={view.totalCents}
                        setAsideCents={view.shouldHaveSavedCents}
                        paceCents={view.paceCents}
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
