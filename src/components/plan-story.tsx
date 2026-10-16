/**
 * Why a plan below its own pace still lands on its date (D50 (5), (7)), in
 * steps under its chart: Now, the turning point when there is one, and the
 * day. Under them, for a plan On track that the transfer set up now gets
 * there, the promise in plain words: never "guaranteed", because it rests on
 * the transfer running. A Short plan keeps its own words above. Every figure
 * is the chart's story; this only says it.
 */

import type { ReactNode } from 'react'
import { Money, When } from '@/components/ui'
import { barOf, type CivilDate, type PlanStory as Story, type StoryPlan } from '@/domain'

function names(plans: readonly StoryPlan[]): string {
  const all = plans.map((p) => p.name)
  return all.length <= 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`
}

function Bar({ totalCents, segments }: { totalCents: number; segments: { cents: number; color: string }[] }) {
  return (
    <span aria-hidden className="mt-1 flex h-2 gap-0.5 overflow-hidden rounded bg-[var(--color-line)]">
      {segments.map((s, i) => (
        <span
          key={i}
          className="block h-full"
          style={{ width: `${barOf({ totalCents, countedCents: s.cents, tickCents: 0 }).fillPercent}%`, background: s.color }}
        />
      ))}
    </span>
  )
}

function Step({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-line)] p-3">
      <p className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">{label}</p>
      <div className="mt-1 space-y-1 text-sm">{children}</div>
    </div>
  )
}

export function PlanStory({ story, today }: { story: Story; today: CivilDate }) {
  const { now, turn, due } = story
  const total = due.totalCents
  const there = due.reachesTotal
  return (
    <div className="mt-4">
      <div className={`grid gap-2 ${turn ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        <Step label="Now">
          <p className="text-xl font-bold">
            <Money cents={now.cents} />
          </p>
          <Bar
            totalCents={total}
            segments={[
              { cents: now.cents, color: 'var(--color-ink)' },
              { cents: now.coveringCents, color: 'var(--color-ink-soft)' },
            ]}
          />
          {now.belowCents > 0 ? (
            <p className="text-[var(--color-ink-soft)]">
              Saved on its own, it would hold <Money cents={now.onItsOwnCents} />.
              {now.coveringCents > 0 ? (
                <>
                  {' '}
                  <Money cents={now.coveringCents} /> of the difference is paying {names(now.covering)} first, due
                  sooner in the same account.
                </>
              ) : null}
              {now.toComeCents > 0 && there ? (
                <>
                  {' '}
                  {now.coveringCents > 0 ? 'The other ' : 'The '}
                  <Money cents={now.toComeCents} /> comes from the transfers on the way.
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-[var(--color-ink-soft)]">
              At or ahead of saving it on its own (<Money cents={now.onItsOwnCents} />).
            </p>
          )}
        </Step>
        {turn ? (
          <Step label={<When date={turn.on} today={today} as="lead" />}>
            <p className="text-xl font-bold">
              <Money cents={turn.cents} />
            </p>
            <Bar totalCents={total} segments={[{ cents: turn.cents, color: 'var(--color-ink)' }]} />
            <p className="text-[var(--color-ink-soft)]">
              {names(turn.paid)} {turn.paid.length === 1 ? 'is' : 'are'} paid. From then about{' '}
              <Money cents={turn.perWeekAfterCents} /> a week comes here
              {there && turn.onItsOwnCents > turn.cents ? ', and it catches up with saving it on its own.' : '.'}
            </p>
          </Step>
        ) : null}
        <Step label={<When date={due.on} today={today} as="lead" />}>
          <p className={`text-xl font-bold ${there ? 'text-[var(--color-ahead)]' : ''}`}>
            <Money cents={there ? total : due.cents} />
          </p>
          <Bar
            totalCents={total}
            segments={[{ cents: due.cents, color: there ? 'var(--color-ahead)' : 'var(--color-ink)' }]}
          />
          <p className="text-[var(--color-ink-soft)]">
            {there ? (
              'All of it, on the day.'
            ) : (
              <>
                On the transfer set up now. All <Money cents={total} /> after the fix on This week.
              </>
            )}
          </p>
        </Step>
      </div>
      {story.onTrack ? (
        <p className="mt-3 rounded-xl bg-[var(--color-ahead-soft)] p-3 text-sm">
          <strong className="text-[var(--color-ahead)]">
            On track: all <Money cents={total} /> <When date={due.on} today={today} as="due" />.
          </strong>{' '}
          Ballast checks every date in this account each week, and would say Short, with the fix, if the
          transfer stopped being enough.
        </p>
      ) : null}
    </div>
  )
}
