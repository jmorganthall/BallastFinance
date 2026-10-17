/**
 * Why a plan below its own pace still lands on its date (D50 (3)-(7)), in
 * the words a person doing the napkin math needs, under its chart:
 *
 * 1. Where the money is today: what is here, what saving it on its own would
 *    hold, and which other plans in the same account hold the difference,
 *    paid first (due sooner) or already set aside (due later), with the
 *    amounts. Anything the account does not hold yet comes from the
 *    transfers on the way.
 * 2. What happens next: the stretches of transfers ahead, numbered as the
 *    badges on the chart are numbered, each "In N · start to end" and one
 *    line: where the money is focused while nothing comes here, or which
 *    plans are covered so money starts coming here, and how much.
 * 3. The day it is full, and the promise, only when `story.onTrack`: never
 *    "guaranteed", because it rests on the transfer running.
 *
 * Every figure is the chart's story; this only says it.
 */

import { StretchBadge } from '@/components/accrual-chart'
import { Money, shortDate, When } from '@/components/ui'
import type { CivilDate, PlanStory as Story, StoryOther, StoryPhase } from '@/domain'

function names(plans: readonly { name: string }[]): string {
  const all = plans.map((p) => p.name)
  return all.length <= 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`
}

function transfers(n: number): string {
  return n === 1 ? '1 transfer' : `${n} transfers`
}

function Held({ other, today }: { other: StoryOther & { sooner: boolean }; today: CivilDate }) {
  return (
    <li>
      <Money cents={other.cents} /> {other.sooner ? 'is paying' : 'is set aside for'}{' '}
      <strong className="font-semibold">{other.name}</strong>,{' '}
      <When date={other.dueDate} today={today} as="due" />
      {other.sooner ? ', so it is paid first' : ''}
    </li>
  )
}

/**
 * One stretch, read at a glance (D50 (10)): when it starts and the dates it
 * runs, then one line. A waiting stretch says where the money is focused and
 * that nothing comes here until it ends; a filling one says which plans are
 * covered so money starts coming here, how much a transfer and to what.
 */
function Stretch({ phase, n, first, today }: { phase: StoryPhase; n: number; first: boolean; today: CivilDate }) {
  const waiting = phase.kind === 'waiting'
  const plans = (list: readonly { name: string }[]) => <strong className="font-semibold">{names(list)}</strong>
  return (
    <li className="flex gap-3">
      <StretchBadge n={n} waiting={waiting} />
      <div className="min-w-0">
        <p className="text-xs text-[var(--color-ink-soft)]">
          <When date={phase.from} today={today} as="lead" /> · {shortDate(phase.from, today)}
          {phase.to !== phase.from ? ` to ${shortDate(phase.to, today)}` : ''}
        </p>
        {waiting ? (
          <p>
            Money is focused on {phase.others.length > 0 ? plans(phase.others) : 'other plans'}.{' '}
            {phase.addedCents === 0 ? 'Nothing comes here.' : 'Almost nothing comes here.'}
          </p>
        ) : (
          <p>
            {phase.rolledOff.length > 0 ? (
              <>
                {plans(phase.rolledOff)} {phase.rolledOff.length === 1 ? 'is' : 'are'} covered, so money starts coming
                here
              </>
            ) : first ? (
              'Money comes here'
            ) : (
              'Money starts coming here'
            )}
            : about <Money cents={phase.perWeekCents} /> a transfer, to <Money cents={phase.endCents} />.
            {phase.others.length > 0 ? <> Shared with {plans(phase.others)}.</> : null}
          </p>
        )}
      </div>
    </li>
  )
}

export function PlanStory({ story, today }: { story: Story; today: CivilDate }) {
  const { now, phases, full, due } = story
  return (
    <div className="mt-5 space-y-5 text-sm">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
          Where the money is today
        </h3>
        <p className="mt-1">
          <Money cents={now.cents} className="font-semibold" /> is counted here. Saved on its own, it would hold{' '}
          <Money cents={now.onItsOwnCents} />.
          {now.belowCents > 0 ? (
            <>
              {' '}
              Here is where the other <Money cents={now.belowCents} /> is:
            </>
          ) : (
            ' It is at or ahead of saving on its own.'
          )}
        </p>
        {now.belowCents > 0 ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {now.heldBy.map((x) => (
              <Held key={x.packageId} other={x} today={today} />
            ))}
            {now.toComeCents > 0 && due.reachesTotal ? (
              <li>
                <Money cents={now.toComeCents} /> comes from the transfers on the way
              </li>
            ) : null}
            {now.toComeCents > 0 && !due.reachesTotal ? (
              <li>
                <Money cents={now.toComeCents} /> is not in the account yet, and the transfer set up now does not
                bring all of it
              </li>
            ) : null}
          </ul>
        ) : null}
        {now.heldBy.length > 0 ? (
          <p className="mt-1 text-[var(--color-ink-soft)]">
            One account, one pile: the money goes to whatever is due soonest and to what must already be set aside,
            which is how the weekly transfer stays low.
          </p>
        ) : null}
      </section>

      {phases.length > 0 ? (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            What happens next
          </h3>
          <ol className="mt-2 space-y-3">
            {phases.map((p, i) => (
              <Stretch key={p.from} phase={p} n={i + 1} first={i === 0} today={today} />
            ))}
          </ol>
        </section>
      ) : null}

      <p>
        {full ? (
          <>
            <strong className="text-[var(--color-ahead)]">
              All <Money cents={due.totalCents} /> is here <When date={full.on} today={today} />
            </strong>
            {full.transfersEarly > 0 ? `, ${transfers(full.transfersEarly)} before it is due.` : ', on the day.'}
          </>
        ) : (
          <>
            On the day it holds <Money cents={due.cents} /> of <Money cents={due.totalCents} /> on the transfer set up
            now. All of it after the fix on This week.
          </>
        )}
      </p>

      {story.onTrack ? (
        <p className="rounded-xl bg-[var(--color-ahead-soft)] p-3">
          <strong className="text-[var(--color-ahead)]">
            On track: all <Money cents={due.totalCents} /> <When date={due.on} today={today} as="due" />.
          </strong>{' '}
          Ballast checks every date in this account each week, and would say Short, with the fix, if the transfer
          stopped being enough.
        </p>
      ) : null}
    </div>
  )
}
