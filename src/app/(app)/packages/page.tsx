import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { nextDue, type DueUrgency } from '@/domain/next-due'
import { Card, Empty, Hint, humanDate, Money, PageHeader, Pill, When, Zzz } from '@/components/ui'
import { MakeUp, ProgressBar } from '@/components/progress-bar'
import {
  orderPlans,
  PLAN_SORTS,
  planOrderAfterTap,
  readPlanOrder,
  shortReasons,
  type PlanOrder,
} from '@/domain'

export const dynamic = 'force-dynamic'

const STATE_COPY = {
  simulated: { tone: 'neutral' as const, label: 'Draft — costs nothing yet' },
  active: null,
  retired: { tone: 'neutral' as const, label: 'Done' },
}

/** The nearer the next thing out, the heavier it reads: under 30 days bold, 30 to 60 medium, beyond plain. */
const URGENCY_WEIGHT: Record<DueUrgency, string> = {
  soon: 'font-semibold text-[var(--color-ink)]',
  near: 'font-medium text-[var(--color-ink)]',
  far: '',
}

/** A sort chip's address: the order is kept in the URL, never in a setting (D41 (5)). */
const sortHref = (o: PlanOrder) => `/packages?sort=${o.sort}&dir=${o.dir}`

export default async function PackagesPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string | string[]; dir?: string | string[] }>
}) {
  const order = readPlanOrder(await searchParams)
  const { engine } = await requireEngine()
  const [views, position, today, closeOuts] = await Promise.all([
    engine.packageViews(),
    engine.position(),
    Promise.resolve(engine.today()),
    engine.closeOutPrompts(),
  ])
  // Every figure on a live plan's card is the one position's (D35): the same
  // numbers the plan's own page, This week and the check-in read.
  const plans = new Map(position.plans.map((p) => [p.package.id, p]))
  const reasons = shortReasons(position)
  // A plan with a snoozed "did this get spent?" carries the Zzz (D38), with
  // the soonest day one wakes in its tooltip.
  const snoozedParts = new Map(
    closeOuts.filter((c) => c.snoozedUntil).map((c) => [c.lineItemId, c] as const),
  )
  const accountNames = new Map(position.accounts.map((a) => [a.account.id, a.account.name]))

  // Each plan with the figures its card shows and the list is ordered by,
  // every one of them the position's (D41): the order is the domain's.
  const rows = orderPlans(
    views.map((view) => {
      const plan = view.package.state === 'active' ? plans.get(view.package.id) : undefined
      // A live plan's next date is its rounds' (D53): the round saving now
      // for a date ahead, so a round still open past its date -- asked
      // about under "did this get spent?" -- never holds the plan back.
      const ahead = plan ? plan.parts.filter((x) => !x.round.past) : []
      const next =
        view.package.state === 'retired'
          ? null
          : nextDue(
              plan && plan.parts.length > 0
                ? (ahead.length > 0 ? ahead : plan.parts).map((x) => x.lineItem)
                : view.items.map((item) => item.lineItem),
              today,
            )
      return {
        view,
        plan,
        next,
        name: view.package.name,
        state: view.package.state,
        nextDue: next?.dueDate ?? null,
        perWeekCents: plan ? plan.steadyPerWeekCents : null,
        totalCents: plan && plan.parts.length > 0 ? plan.totalCents : view.totalCents,
        shortByCents: plan ? plan.shortByCents : null,
      }
    }),
    order,
  )

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

      {views.length > 1 ? (
        <nav aria-label="Sort plans" className="mb-3 flex flex-wrap gap-2">
          {PLAN_SORTS.map((s) => {
            const active = order.sort === s.key
            return (
              <Link
                key={s.key}
                href={sortHref(planOrderAfterTap(order, s.key))}
                aria-current={active ? 'true' : undefined}
                className={`rounded-full border px-3 py-1 text-sm ${
                  active
                    ? 'border-transparent bg-[var(--color-accent)] font-medium text-white'
                    : 'border-[var(--color-line)] text-[var(--color-ink-soft)]'
                }`}
              >
                {s.label}
                {active ? (
                  <span aria-label={order.dir === 'asc' ? ', soonest or smallest first' : ', largest first'}>
                    {' '}
                    {order.dir === 'asc' ? '↑' : '↓'}
                  </span>
                ) : null}
              </Link>
            )
          })}
        </nav>
      ) : null}

      {views.length === 0 ? (
        <Empty title="No plans yet.">
          <p>A plan is a trip, a bill, a Christmas — anything with a date and a cost.</p>
        </Empty>
      ) : (
        <ul className="space-y-3">
          {rows.map(({ view, plan, next }) => {
            const copy = STATE_COPY[view.package.state]
            const snoozed = view.items
              .map((item) => snoozedParts.get(item.lineItem.id))
              .filter((c) => c !== undefined)
              .sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!))
            const accounts = plan ? [...new Set(plan.parts.map((p) => p.accountId))] : []
            return (
              <li key={view.package.id}>
                <Link href={`/packages/${view.package.id}`}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-semibold">{view.package.name}</h2>
                      <span className="flex shrink-0 items-center gap-2">
                        {snoozed.length > 0 ? (
                          <Hint
                            detail={`${snoozed.map((c) => c.label).join(', ')}: "did this get spent?" is snoozed until ${humanDate(snoozed[0]!.snoozedUntil!)}. The money stays held.`}
                          >
                            <span className="text-[var(--color-accent)]">
                              <Zzz />
                              <span className="sr-only">Snoozed</span>
                            </span>
                          </Hint>
                        ) : null}
                        {/* A live plan says nothing here: the bar is its state (D38). */}
                        {copy ? <Pill tone={copy.tone}>{copy.label}</Pill> : null}
                      </span>
                    </div>
                    {!plan || plan.parts.length === 0 ? (
                      <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                        <Money cents={view.totalCents} /> total
                      </p>
                    ) : null}
                    {/* Every card names what is next and when (D41 (4)); the bar does not repeat it. */}
                    {next ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        Next due: {next.label === view.package.name ? null : <>{next.label}, </>}
                        <span className={URGENCY_WEIGHT[next.urgency]}>
                          <When date={next.dueDate} today={today} />
                        </span>
                      </p>
                    ) : null}
                    {/*
                      The plan's steady weekly cost, for comparing plans; never
                      the transfer, which is the account's (D41 (1)). While
                      Short, what it is missing today beside it (D41 (2)).
                    */}
                    {plan && plan.parts.length > 0 ? (
                      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                        <Hint
                          detail={`What this plan costs a week, saved evenly. The transfer itself is set for the whole account${accounts.length === 1 ? '' : 's'} (${accounts.map((id) => accountNames.get(id) ?? '').join(', ')}), not plan by plan.`}
                        >
                          <span className="tabular">
                            <Money cents={plan.steadyPerWeekCents} /> a week
                          </span>
                        </Hint>
                        {plan.status === 'short' && plan.shortByCents > 0 ? (
                          <>
                            {' · '}
                            <MakeUp cents={plan.shortByCents} />
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {plan && plan.parts.length > 0 ? (
                      <ProgressBar
                        className="mt-3"
                        totalCents={plan.totalCents}
                        countedCents={plan.countedCents}
                        tickCents={plan.tickCents}
                        status={plan.status}
                        today={today}
                        shortReasons={[...new Set(plan.parts.map((p) => p.accountId))].flatMap((id) => reasons.get(id) ?? [])}
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
