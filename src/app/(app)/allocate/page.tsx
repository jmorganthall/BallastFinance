/**
 * Allocate (PRD §9, screen 5).
 *
 * Drop in one number and get a recommended path. Ad hoc by decision D3: no
 * schedule, no nagging about a missed run -- you open this when you have just
 * looked at Simplifi.
 *
 * Preview is a GET so the flow needs no client JavaScript and the back button
 * behaves: nothing is recorded until the confirm button is pressed.
 */

import { requireEngine } from '@/server/session'
import { debtTopUps } from '@/server/engine'
import { Card, Money, PageHeader } from '@/components/ui'
import { DebtShare } from '@/components/debt-share'
import { runAllocationAction } from '@/server/actions'
import { formatCents, parseAmountToCents } from '@/domain'

export const dynamic = 'force-dynamic'

export default async function AllocatePage({
  searchParams,
}: {
  searchParams: Promise<{ floor?: string; error?: string; from?: string; fill?: string | string[] }>
}) {
  const { floor, error, from, fill } = await searchParams
  const { engine } = await requireEngine()
  const bufferCents = await engine.bufferCents()

  // The optional first step: what is short right now. Before a split has
  // been asked for, everything short is ticked -- covering a hole before
  // sharing out is the sensible default -- and after that the ticks are
  // whatever the person left.
  const shortfalls = await engine.shortfalls()
  const keyOf = (s: { kind: string; targetId: string }) => `${s.kind}:${s.targetId}`
  const ticked = new Set(
    floor === undefined
      ? shortfalls.map(keyOf)
      : fill === undefined
        ? []
        : Array.isArray(fill)
          ? fill
          : [fill],
  )
  const cover = shortfalls.filter((s) => ticked.has(keyOf(s)))

  // The check-in sends an account's extra here to be shared out; the run
  // then also asks for that money to be moved out of the account.
  const source = from
    ? ((await engine.listReserveAccounts()).find((a) => a.id === from) ?? null)
    : null

  let floorCents: number | null = null
  if (floor) {
    try {
      floorCents = parseAmountToCents(floor)
    } catch {
      floorCents = null
    }
  }

  const plan = floorCents !== null ? await engine.previewAllocation(floorCents, undefined, cover) : null

  // The debt share is not "some money at debt": the optimizer names which debts,
  // in the same order the Debts screen shows, and it is the same call the
  // confirm button makes -- so what is previewed here is what gets issued.
  const debtShare = plan?.shares.find((share) => share.destination === 'debt')
  // After the first step: a cliff the top-ups covered is a deal again here.
  const optimised =
    plan && debtShare && debtShare.amountCents > 0
      ? await engine.optimiseLumpSum(debtShare.amountCents, undefined, { lessPaid: debtTopUps(plan) })
      : null

  return (
    <>
      <PageHeader
        title="Share out spare money"
        subtitle="When you have checked Simplifi and know what is genuinely spare, put the number in here."
      />

      {source ? (
        <Card className="mb-4 bg-[var(--color-accent-soft)]">
          <p className="text-sm">
            This is the extra sitting in <strong>{source.name}</strong>. Whatever is shared out
            below will also go on your to-do list as a move out of that account.
          </p>
        </Card>
      ) : null}

      <Card className="mb-4">
        <form method="GET" className="space-y-3">
          {source ? <input type="hidden" name="from" value={source.id} /> : null}
          <label className="block text-sm font-medium">
            {source
              ? `How much of the extra in ${source.name} to share out?`
              : 'What is left over after everything that is already spoken for?'}
            <input
              name="floor"
              inputMode="decimal"
              required
              defaultValue={floor ?? ''}
              placeholder="2500"
              className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
            />
          </label>
          <p className="text-xs text-[var(--color-ink-soft)]">
            {source
              ? 'The cushion you keep back stays in the account.'
              : 'The lowest your unclaimed cash gets over the coming weeks — not today’s balance.'}
          </p>

          {shortfalls.length > 0 ? (
            <fieldset className="rounded-xl border border-[var(--color-line)] p-3">
              <legend className="px-1 text-sm font-medium">First, cover what is short?</legend>
              <p className="mb-2 text-xs text-[var(--color-ink-soft)]">
                Optional. Anything ticked is covered off the top, and the rest is shared out by
                your rules.
              </p>
              <ul className="space-y-2">
                {shortfalls.map((s) => (
                  <li key={keyOf(s)}>
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        name="fill"
                        value={keyOf(s)}
                        defaultChecked={ticked.has(keyOf(s))}
                        className="mt-1 h-5 w-5 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="font-medium">{s.label}</span>
                          <span className="shrink-0 tabular">
                            <Money cents={s.shortCents} /> {s.kind === 'plan' ? 'behind' : 'short'}
                          </span>
                        </span>
                        <span className="block text-xs text-[var(--color-ink-soft)]">{s.reason}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}

          <button
            type="submit"
            className="w-full rounded-xl border border-[var(--color-line)] px-4 py-3 font-medium"
          >
            Work out the split
          </button>
        </form>

        {error === 'amount' ? (
          <p className="mt-3 rounded-lg bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">
            That did not look like an amount. Try something like 2500 or 2,500.00.
          </p>
        ) : null}
      </Card>

      {plan ? (
        plan.netCents <= 0 ? (
          <Card>
            <p className="font-medium">Nothing to share out.</p>
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              <Money cents={plan.floorCents} /> does not clear the{' '}
              <Money cents={bufferCents} /> cushion you keep back, so this round leaves
              everything where it is.
            </p>
          </Card>
        ) : (
          <>
            <Card className="mb-4 bg-[var(--color-accent-soft)]">
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt>Spare</dt>
                  <dd className="tabular">
                    <Money cents={plan.floorCents} />
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Cushion you keep back</dt>
                  <dd className="tabular">
                    −<Money cents={plan.bufferCents} />
                  </dd>
                </div>
                {plan.topUpCents > 0 ? (
                  <div className="flex justify-between">
                    <dt>Covering what is short</dt>
                    <dd className="tabular">
                      −<Money cents={plan.topUpCents} />
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-[var(--color-line)] pt-1 font-semibold">
                  <dt>To share out</dt>
                  <dd className="tabular">
                    <Money cents={plan.splitCents} />
                  </dd>
                </div>
              </dl>
            </Card>

            {plan.topUps.length > 0 ? (
              <Card className="mb-4">
                <h2 className="font-semibold">First, what is short</h2>
                <ul className="mt-2 divide-y divide-[var(--color-line)]">
                  {plan.topUps.map((t) => (
                    <li key={`${t.kind}:${t.targetId}`} className="flex items-baseline justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
                      <span>
                        {t.label}
                        <span className="block text-xs text-[var(--color-ink-soft)]">
                          {t.amountCents < t.shortCents
                            ? `Part of the ${formatCents(t.shortCents)} it is short; the rest another time.`
                            : t.kind === 'plan'
                              ? 'Back on pace.'
                              : 'Cleared before the deal ends.'}
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold tabular">
                        <Money cents={t.amountCents} />
                      </span>
                    </li>
                  ))}
                </ul>
                {plan.splitCents === 0 ? (
                  <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                    That takes all of it, so there is nothing left to share out this time.
                  </p>
                ) : null}
              </Card>
            ) : null}

            <ul className="space-y-3">
              {plan.shares
                .filter((share) => share.amountCents > 0)
                .map((share) => (
                  <li key={share.destination}>
                    <Card>
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="font-semibold">{share.label}</h2>
                        <span className="text-lg font-semibold tabular">
                          <Money cents={share.amountCents} />
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                        {share.percent}% of what is being shared out
                      </p>

                      {share.destination === 'lifestyle' && plan.lifestyleReleases.length === 2 ? (
                        <p className="mt-2 rounded-lg bg-[var(--color-surface)] p-2 text-sm">
                          Released in two halves so it does not all go at once:{' '}
                          {formatCents(plan.lifestyleReleases[0]!.amountCents)} now, then{' '}
                          {formatCents(plan.lifestyleReleases[1]!.amountCents)} on{' '}
                          {plan.lifestyleReleases[1]!.releaseOn}.
                        </p>
                      ) : null}

                      {share.destination === 'debt' ? <DebtShare optimised={optimised} /> : null}
                    </Card>
                  </li>
                ))}
            </ul>

            <form action={runAllocationAction} className="mt-5">
              <input type="hidden" name="floor" value={floor ?? ''} />
              {source ? <input type="hidden" name="from" value={source.id} /> : null}
              {cover.map((s) => (
                <input key={keyOf(s)} type="hidden" name="fill" value={keyOf(s)} />
              ))}
              <button
                type="submit"
                className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
              >
                Use this split
              </button>
            </form>
            <p className="mt-2 text-center text-xs text-[var(--color-ink-soft)]">
              Adds each move to your to-do list. Nothing happens until you say you have done it.
            </p>
          </>
        )
      ) : null}
    </>
  )
}
