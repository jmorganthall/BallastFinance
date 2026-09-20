/**
 * Check-in (PRD §9, screen 4).
 *
 * The user tells Ballast what each account actually holds. Everything else on
 * this screen is derived from that one number against the plan: behind, ahead,
 * and what to do about it.
 */

import { requireEngine } from '@/server/session'
import { Card, Money, PageHeader, Pill } from '@/components/ui'
import { acceptCatchUpAction, confirmBalancesAction } from '@/server/actions'
import { catchUpOptions, computeDrift, formatCents } from '@/domain'

export const dynamic = 'force-dynamic'

const CATCH_UP_WEEKS = 8

export default async function CheckInPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>
}) {
  const { done } = await searchParams
  const { engine } = await requireEngine()
  const [accounts, confirmed] = await Promise.all([
    engine.accountViews(),
    engine.latestConfirmedBalances(),
  ])
  const today = engine.today()

  const live = accounts.filter((a) => a.items.length > 0)

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
              const shortfall = Math.abs(drift.driftCents)
              const options = behind
                ? catchUpOptions({ shortfallCents: shortfall, today, overWeeks: CATCH_UP_WEEKS })
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
                    ) : drift.driftCents > 0 ? (
                      <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
                        Nothing to do — the extra stays as a cushion.
                      </p>
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
