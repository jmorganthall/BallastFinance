/**
 * Debts (PRD §9, screen 6).
 *
 * The payoff order, the slider that reorders it, and the optimizer that answers
 * "given this much, where does it go?".
 *
 * The slider is a GET form, so moving it needs no client JavaScript and the
 * result is a shareable URL. Changing the standing default is a separate,
 * deliberate action -- looking at a what-if should not silently change the rule.
 */

import { requireEngine } from '@/server/session'
import { Card, Empty, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import { setPriorityWeightAction } from '@/server/actions'
import { balanceFreshness, debtFormValuesOf, parseAmountToCents, projectPayoff } from '@/domain'
import { PayoffImpact } from '@/components/payoff-impact'
import { DebtTable, type DebtRow } from './debt-table'

const KIND: Record<string, string> = {
  consumer: 'Credit card or loan',
  auto: 'Car',
  mortgage: 'Mortgage',
}

export const dynamic = 'force-dynamic'

export default async function DebtsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; amount?: string; error?: string }>
}) {
  const { w, amount, error } = await searchParams
  const { engine } = await requireEngine()

  const standingWeight = await engine.priorityWeight()
  const weight = w !== undefined && Number.isFinite(Number(w)) ? Number(w) : standingWeight
  const isPreview = Math.abs(weight - standingWeight) > 0.001

  const [ladder, warnings, today] = await Promise.all([
    engine.debtLadder(weight),
    engine.promoWarnings(),
    Promise.resolve(engine.today()),
  ])

  let optimisation = null
  let amountCents: number | null = null
  if (amount) {
    try {
      amountCents = parseAmountToCents(amount)
      optimisation = await engine.optimiseLumpSum(amountCents, weight)
    } catch {
      amountCents = null
    }
  }

  // A balance older than a statement cycle is a guess, and every number on this
  // screen is built on it. Said gently: the debt is still here, it just needs
  // a fresh look.
  const stale = ladder
    .map((rung) => ({ rung, freshness: balanceFreshness(rung.debt, today) }))
    .filter((entry) => entry.freshness.stale)

  // Everything the table shows, worked out here: the table only renders.
  const rate = (basisPoints: number) => `${(basisPoints / 100).toFixed(2)}%`
  const rows: DebtRow[] = ladder.map((rung) => {
    const projection = projectPayoff({ debt: rung.debt, today })
    const freshness = balanceFreshness(rung.debt, today)
    return {
      id: rung.debt.id,
      rank: rung.rank,
      name: rung.debt.name,
      kind: KIND[rung.debt.category] ?? rung.debt.category,
      balanceCents: rung.debt.balanceCents,
      asOf: rung.debt.balanceAsOf,
      ageDays: freshness.ageDays,
      stale: freshness.stale,
      effectiveRate: rate(rung.effectiveAprBasisPoints),
      effectiveAprBasisPoints: rung.effectiveAprBasisPoints,
      listedRate:
        rung.effectiveAprBasisPoints !== rung.debt.aprBasisPoints ? rate(rung.debt.aprBasisPoints) : null,
      minimumCents: rung.minimumPaymentCents,
      paymentCents: rung.paymentPerMonthCents,
      payoffDate: projection.payoffDate,
      cumulativeCostCents: rung.cumulativeCostCents,
      cumulativeFreedCents: rung.cumulativeFreedPerMonthCents,
      breakEvenMonths: rung.breakEvenMonths,
      initial: debtFormValuesOf(rung.debt),
    }
  })

  return (
    <>
      <PageHeader
        title="Payoff order"
        subtitle="Which debt to clear next, and where a lump sum should go."
      />

      {error ? (
        <p className="mb-4 rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">
          {error}
        </p>
      ) : null}

      {stale.length > 0 ? (
        <Card className="mb-4 bg-[var(--color-accent-soft)]">
          <h2 className="font-semibold">
            {stale.length === 1 ? 'One balance' : `${stale.length} balances`} could do with a fresh
            look
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            The payoff order is only as good as the balances it starts from. When you have a
            statement handy, type the current balance in below and Ballast will note today as the
            date it was last checked.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {stale.map(({ rung, freshness }) => (
              <li key={rung.debt.id}>
                <strong>{rung.debt.name}</strong> — last checked {humanDate(rung.debt.balanceAsOf)},{' '}
                {freshness.ageDays} days ago.
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {warnings.length > 0 ? (
        <Card className="mb-4 bg-[var(--color-behind-soft)]">
          <h2 className="font-semibold text-[var(--color-behind)]">A deal is about to end</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {warnings.map((warning) => (
              <li key={warning.debt.id}>
                <strong>{warning.debt.name}</strong> stops being cheap on {warning.untilDate}. It
                needs <Money cents={warning.monthlyToClearCents} /> a month from here to clear in
                time.
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {ladder.length === 0 ? (
        <>
          <Empty title="No debts recorded.">
            <p>Add one below and Ballast will work out the payoff order.</p>
          </Empty>
          <div className="mt-4">
            <DebtTable rows={rows} />
          </div>
        </>
      ) : (
        <>
          <Card className="mb-4">
            <form method="GET" className="space-y-2">
              <label className="block text-sm font-medium">
                What matters more right now?
                <input
                  type="range"
                  name="w"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue={String(weight)}
                  className="mt-2 w-full"
                />
              </label>
              <div className="flex justify-between text-xs text-[var(--color-ink-soft)]">
                <span>Free up cash now</span>
                <span>Pay the least interest</span>
              </div>
              {amount ? <input type="hidden" name="amount" value={amount} /> : null}
              <button
                type="submit"
                className="w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium"
              >
                Re-sort ({Math.round(weight * 100)}% interest / {Math.round((1 - weight) * 100)}% cash flow)
              </button>
            </form>

            {isPreview ? (
              <form action={setPriorityWeightAction} className="mt-3">
                <input type="hidden" name="weight" value={weight} />
                <button
                  type="submit"
                  className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
                >
                  Make this the normal setting
                </button>
              </form>
            ) : null}
          </Card>

          <DebtTable rows={rows} />

          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Where should a lump sum go?
          </h2>

          <Card>
            <form method="GET" className="space-y-3">
              <input type="hidden" name="w" value={weight} />
              <label className="block text-sm font-medium">
                If you had this much to put at debt
                <input
                  name="amount"
                  inputMode="decimal"
                  defaultValue={amount ?? ''}
                  placeholder="1075"
                  className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
                />
              </label>
              <button
                type="submit"
                className="w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium"
              >
                Work out where it goes
              </button>
            </form>

            {optimisation ? (
              <div className="mt-4 border-t border-[var(--color-line)] pt-4">
                <p className="text-sm">{optimisation.why}</p>
                <div className="mt-3">
                  <PayoffImpact result={optimisation} />
                </div>

                <ul className="mt-3 divide-y divide-[var(--color-line)]">
                  {optimisation.allocations.map((allocation) => (
                    <li key={allocation.debtId} className="py-3 text-sm last:pb-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">{allocation.debtName}</span>
                          {allocation.clearsIt ? <Pill tone="ahead">Paid off</Pill> : null}
                        </span>
                        <span className="shrink-0 font-semibold tabular">
                          <Money cents={allocation.amountCents} />
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-snug text-[var(--color-ink-soft)]">
                        {allocation.reason}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        </>
      )}

    </>
  )
}
