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
import { Card, Money, PageHeader } from '@/components/ui'
import { DebtShare } from '@/components/debt-share'
import { runAllocationAction } from '@/server/actions'
import { formatCents, parseAmountToCents } from '@/domain'

export const dynamic = 'force-dynamic'

export default async function AllocatePage({
  searchParams,
}: {
  searchParams: Promise<{ floor?: string; error?: string }>
}) {
  const { floor, error } = await searchParams
  const { engine } = await requireEngine()
  const bufferCents = await engine.bufferCents()

  let floorCents: number | null = null
  if (floor) {
    try {
      floorCents = parseAmountToCents(floor)
    } catch {
      floorCents = null
    }
  }

  const plan = floorCents !== null ? await engine.previewAllocation(floorCents) : null

  // The debt share is not "some money at debt": the optimizer names which debts,
  // in the same order the Debts screen shows, and it is the same call the
  // confirm button makes -- so what is previewed here is what gets issued.
  const debtShare = plan?.shares.find((share) => share.destination === 'debt')
  const optimised =
    debtShare && debtShare.amountCents > 0
      ? await engine.optimiseLumpSum(debtShare.amountCents)
      : null

  return (
    <>
      <PageHeader
        title="Share out spare money"
        subtitle="When you have checked Simplifi and know what is genuinely spare, put the number in here."
      />

      <Card className="mb-4">
        <form method="GET" className="space-y-3">
          <label className="block text-sm font-medium">
            What is left over after everything that is already spoken for?
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
            The lowest your unclaimed cash gets over the coming weeks — not today&apos;s balance.
          </p>
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
                <div className="flex justify-between border-t border-[var(--color-line)] pt-1 font-semibold">
                  <dt>To share out</dt>
                  <dd className="tabular">
                    <Money cents={plan.netCents} />
                  </dd>
                </div>
              </dl>
            </Card>

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
