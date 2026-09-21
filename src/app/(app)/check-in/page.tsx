/**
 * Check-in (PRD §9, screen 4).
 *
 * The user tells Ballast what each account actually holds. Everything else on
 * this screen is derived from that one number against the plan: behind, ahead,
 * and what to do about it.
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import {
  acceptCatchUpAction,
  acceptOpeningsAction,
  confirmBalancesAction,
  reshuffleAction,
} from '@/server/actions'
import {
  aheadOptions,
  assignExtraToPlans,
  catchUpOptions,
  computeDrift,
  formatCents,
} from '@/domain'

export const dynamic = 'force-dynamic'

const CATCH_UP_WEEKS = 8

export default async function CheckInPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; counted?: string; reshuffled?: string }>
}) {
  const { done, counted, reshuffled } = await searchParams
  const { engine } = await requireEngine()
  const [accounts, confirmed] = await Promise.all([
    engine.accountViews(),
    engine.latestConfirmedBalances(),
  ])
  const today = engine.today()

  const live = accounts.filter((a) => a.items.length > 0)
  // Where each account's counted money would sit if reshuffled (PRD §6).
  const spreads = await Promise.all(live.map((view) => engine.reshufflePreview(view.account.id)))

  return (
    <>
      <PageHeader
        title="Check in"
        subtitle="Open Capital One and tell Ballast what each account really holds today."
      />

      {done ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <p className="text-sm font-medium text-[var(--color-ahead)]">Balances recorded.</p>
        </Card>
      ) : null}
      {counted ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <p className="text-sm font-medium text-[var(--color-ahead)]">
            Counted toward your plans. The weekly amounts have been worked out again.
          </p>
        </Card>
      ) : null}
      {reshuffled ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <p className="text-sm font-medium text-[var(--color-ahead)]">
            Reshuffled. The weekly amounts have been worked out again; nothing has to move.
          </p>
        </Card>
      ) : null}

      {live.length === 0 ? (
        <Card>
          <p>Nothing to check yet — commit a plan first.</p>
        </Card>
      ) : (
        <>
          <form action={confirmBalancesAction} className="space-y-4">
            {live.map((view) => {
              const last = confirmed.get(view.account.id)
              return (
                <Card key={view.account.id}>
                  <h2 className="font-semibold">{view.account.name}</h2>
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                    Should hold <Money cents={view.shouldHaveSavedCents} /> today
                    {last ? (
                      <>
                        {' · '}last checked {last.on} at <Money cents={last.amountCents} />
                      </>
                    ) : null}
                  </p>
                  <label className="mt-3 block text-sm font-medium">
                    What it actually holds
                    <input
                      name={`balance_${view.account.id}`}
                      inputMode="decimal"
                      placeholder={formatCents(view.shouldHaveSavedCents).replace('$', '')}
                      className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
                    />
                  </label>
                </Card>
              )
            })}

            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
            >
              Record these balances
            </button>
            <p className="text-center text-xs text-[var(--color-ink-soft)]">
              Leave any box empty to skip that account.
            </p>
          </form>

          {/* Once a balance exists, show where it stands and what to do. */}
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Where you stand
          </h2>

          <ul className="space-y-3">
            {live.map((view) => {
              const last = confirmed.get(view.account.id)
              if (!last) {
                return (
                  <li key={view.account.id}>
                    <Card>
                      <p className="text-sm">
                        <strong>{view.account.name}</strong> — no balance recorded yet.
                      </p>
                    </Card>
                  </li>
                )
              }

              const drift = computeDrift({ account: view, confirmedCents: last.amountCents })
              const behind = drift.driftCents < 0
              const ahead = drift.driftCents > 0
              const shortfall = Math.abs(drift.driftCents)
              const options = behind
                ? catchUpOptions({ shortfallCents: shortfall, today, overWeeks: CATCH_UP_WEEKS })
                : []
              // Ahead: first count the extra toward this account's plans, soonest
              // due first. What those cannot absorb is a real surplus, which can be
              // shared out, or the weekly set-aside can ease off.
              const counted = ahead
                ? assignExtraToPlans({ extraCents: shortfall, items: view.items })
                : { assignments: [], leftoverCents: 0, stillShort: [], alreadyFundedCount: 0 }
              const easeOff = ahead
                ? aheadOptions({
                    extraCents: shortfall,
                    weeklyCents: view.weekly.totalPerWeekCents,
                    today,
                    overWeeks: CATCH_UP_WEEKS,
                  }).filter((o) => o.kind === 'rate_cut')
                : []

              return (
                <li key={view.account.id}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-semibold">{view.account.name}</h3>
                      {drift.driftCents === 0 ? (
                        <Pill tone="ahead">On track</Pill>
                      ) : behind ? (
                        <Pill tone="behind">Behind</Pill>
                      ) : (
                        <Pill tone="ahead">Ahead</Pill>
                      )}
                    </div>

                    <p className="mt-2 text-sm">
                      Holds <Money cents={last.amountCents} />, should hold{' '}
                      <Money cents={drift.expectedCents} /> —{' '}
                      <strong>
                        <Money cents={shortfall} /> {behind ? 'short' : 'extra'}
                      </strong>
                      .
                    </p>

                    {behind ? (
                      <div className="mt-4 space-y-2">
                        <p className="text-sm text-[var(--color-ink-soft)]">
                          Two ways to get back on track:
                        </p>
                        {options.map((option) => (
                          <form
                            key={option.kind}
                            action={acceptCatchUpAction}
                            className="flex items-center justify-between gap-3 rounded-xl bg-[var(--color-surface)] p-3"
                          >
                            <input type="hidden" name="reserve_account_id" value={view.account.id} />
                            <input type="hidden" name="account_name" value={view.account.name} />
                            <input type="hidden" name="amount_cents" value={option.amountCents} />
                            <input type="hidden" name="kind" value={option.kind} />
                            {option.endDate ? (
                              <input type="hidden" name="ends_on" value={option.endDate} />
                            ) : null}

                            <span className="text-sm">
                              {option.kind === 'one_time'
                                ? `Move ${formatCents(option.amountCents)} across now`
                                : `Add ${formatCents(option.perWeekCents ?? 0)}/week until ${option.endDate}`}
                            </span>
                            <button
                              type="submit"
                              className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
                            >
                              Do this
                            </button>
                          </form>
                        ))}
                      </div>
                    ) : ahead ? (
                      <div className="mt-4 space-y-2">
                        {counted.assignments.length > 0 ? (
                          <form
                            action={acceptOpeningsAction}
                            className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3"
                          >
                            {counted.assignments.map((a) => (
                              <input key={a.lineItemId} type="hidden" name={`opening_${a.lineItemId}`} value={a.openingCents} />
                            ))}
                            <p className="text-sm font-medium">
                              Count{' '}
                              {counted.leftoverCents > 0
                                ? formatCents(shortfall - counted.leftoverCents)
                                : 'it'}{' '}
                              toward your plans here, soonest first
                            </p>
                            <ul className="mt-2 space-y-1 text-sm">
                              {counted.assignments.map((a) => (
                                <li key={a.lineItemId} className="flex justify-between gap-3">
                                  <span>
                                    {a.label}
                                    <span className="text-[var(--color-ink-soft)]">
                                      {' '}· {humanDate(a.dueDate)}
                                      {a.fullyFunded
                                        ? ' · the last it needs'
                                        : ` · of the ${formatCents(a.shortCents)} it still needs`}
                                    </span>
                                  </span>
                                  <span className="shrink-0 tabular">
                                    +<Money cents={a.addedCents} />
                                  </span>
                                </li>
                              ))}
                            </ul>
                            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                              The weekly amounts drop to match, and nothing has to move.
                              {counted.leftoverCents > 0
                                ? ` The other ${formatCents(counted.leftoverCents)} is more than every plan here needs.`
                                : ''}
                              {counted.stillShort.length > 0
                                ? ` The extra runs out there; ${
                                    counted.stillShort.length === 1
                                      ? `${counted.stillShort[0]!.label} still needs ${formatCents(counted.stillShort[0]!.shortCents)}`
                                      : `${counted.stillShort.length} later plans here still need more`
                                  } and will keep saving weekly.`
                                : ''}
                              {counted.alreadyFundedCount > 0
                                ? ` ${counted.alreadyFundedCount === 1 ? 'One plan here is' : `${counted.alreadyFundedCount} plans here are`} already fully funded, so ${counted.alreadyFundedCount === 1 ? 'it is' : 'they are'} not listed.`
                                : ''}
                            </p>
                            <button
                              type="submit"
                              className="mt-3 w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
                            >
                              Count it toward these plans
                            </button>
                          </form>
                        ) : (
                          <p className="text-sm text-[var(--color-ink-soft)]">
                            {view.items.length === 0
                              ? 'Nothing is planned against this account, so the extra is spare.'
                              : 'Every plan here is already fully funded, so the extra is spare.'}
                          </p>
                        )}

                        {/* The alternative to counting it toward plans: share the whole
                            extra out. Whatever the plans cannot use is still extra at the
                            next check-in, and this option is offered again then. */}
                        <Link
                          href={`/allocate?from=${view.account.id}&floor=${encodeURIComponent(
                            formatCents(shortfall).replace('$', '').replace(/,/g, ''),
                          )}`}
                          className="flex items-center justify-between gap-3 rounded-xl bg-[var(--color-surface)] p-3 text-sm"
                        >
                          <span>
                            Share {formatCents(shortfall)} out instead
                            <span className="block text-xs text-[var(--color-ink-soft)]">
                              Runs it through Share out: debts, fun money, savings, by your rules.
                            </span>
                          </span>
                          <span className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-2 font-medium">
                            Go
                          </span>
                        </Link>

                        {easeOff.map((option) => (
                          <form
                            key={option.kind}
                            action={acceptCatchUpAction}
                            className="flex items-center justify-between gap-3 rounded-xl bg-[var(--color-surface)] p-3"
                          >
                            <input type="hidden" name="reserve_account_id" value={view.account.id} />
                            <input type="hidden" name="account_name" value={view.account.name} />
                            <input type="hidden" name="amount_cents" value={option.amountCents} />
                            <input type="hidden" name="kind" value={option.kind} />
                            {option.endDate ? (
                              <input type="hidden" name="ends_on" value={option.endDate} />
                            ) : null}
                            <span className="text-sm">
                              {option.pauses
                                ? `Or pause the weekly set-aside until ${humanDate(option.endDate!)}`
                                : `Or set aside ${formatCents(option.perWeekCents ?? 0)}/week less until ${humanDate(option.endDate!)}`}
                              <span className="block text-xs text-[var(--color-ink-soft)]">
                                Leaves the extra where it is and uses it up over time.
                              </span>
                            </span>
                            <button
                              type="submit"
                              className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
                            >
                              Do this
                            </button>
                          </form>
                        ))}
                        <p className="text-xs text-[var(--color-ink-soft)]">
                          Or do nothing, and the extra stays as a cushion.
                        </p>
                      </div>
                    ) : null}
                  </Card>
                </li>
              )
            })}
          </ul>

          {/* Where the money is counted: the same dollars, spread so the weekly
              transfer is the household's steady rate and no more (PRD §6). */}
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Where the money is counted
          </h2>
          <p className="mb-3 text-sm text-[var(--color-ink-soft)]">
            What an account holds is counted toward its parts, and where it is counted sets each
            part&apos;s weekly figure. A reshuffle spreads it again: every part up to where it should be
            by now, soonest due first, then whatever is left to the parts due soonest. Nothing moves in
            the bank.
          </p>
          <ul className="space-y-3">
            {live.map((view, index) => {
              const spread = spreads[index]
              if (!spread) return null
              const moved = spread.lines.filter((l) => l.holdsAfterCents !== l.holdsNowCents)
              const parts = `${spread.lines.length} part${spread.lines.length === 1 ? '' : 's'}`
              return (
                <li key={view.account.id} id={`spread-${view.account.id}`}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-semibold">{view.account.name}</h3>
                      {moved.length === 0 ? (
                        <Pill tone="ahead">Spread well</Pill>
                      ) : (
                        <Pill tone="accent">Could be reshuffled</Pill>
                      )}
                    </div>
                    <p className="mt-2 text-sm">
                      <Money cents={spread.potCents} /> is counted across {parts}.
                      {moved.length === 0
                        ? ' It is already spread the best way this money allows.'
                        : ''}
                    </p>

                    {moved.length > 0 ? (
                      <form
                        action={reshuffleAction}
                        className="mt-3 rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3"
                      >
                        <input type="hidden" name="reserve_account_id" value={view.account.id} />
                        <p className="text-sm font-medium">
                          Reshuffled, the weekly transfer goes from {formatCents(spread.perWeekNowCents)} to{' '}
                          {formatCents(spread.perWeekAfterCents)}
                          {spread.behindNowCount !== spread.behindAfterCount
                            ? `, and ${
                                spread.behindAfterCount === 0
                                  ? 'no part is'
                                  : `${spread.behindAfterCount} part${spread.behindAfterCount === 1 ? ' is' : 's are'}`
                              } behind instead of ${spread.behindNowCount}`
                            : ''}
                          .
                        </p>
                        <ul className="mt-2 space-y-1 text-sm">
                          {moved.map((line) => (
                            <li key={line.lineItemId} className="flex justify-between gap-3">
                              <span>
                                {line.label}
                                <span className="text-[var(--color-ink-soft)]"> · {humanDate(line.dueDate)}</span>
                              </span>
                              <span className="shrink-0 tabular">
                                <Money cents={line.holdsNowCents} /> to <Money cents={line.holdsAfterCents} />
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                          Only where the money is counted changes. The account still holds the same{' '}
                          {formatCents(spread.potCents)}, and nothing has to move.
                        </p>
                        <button
                          type="submit"
                          className="mt-3 w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
                        >
                          Reshuffle it
                        </button>
                      </form>
                    ) : null}
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
