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
import { Card, Empty, Hint, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import {
  confirmDebtPaymentAction,
  createDebtAction,
  setPriorityWeightAction,
  updateDebtBalanceAction,
} from '@/server/actions'
import {
  balanceFreshness,
  debtFormValuesOf,
  formatCents,
  parseAmountToCents,
  projectPayoff,
} from '@/domain'
import { PayoffImpact } from '@/components/payoff-impact'
import { DebtEditor } from './debt-editor'
import { DebtForm } from './debt-form'

const smallField =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-2 text-base text-[var(--color-ink)]'

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
        <Empty title="No debts recorded.">
          <p>Add one below and Ballast will work out the payoff order.</p>
        </Empty>
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

          <ol className="space-y-3">
            {ladder.map((rung) => {
              const projection = projectPayoff({ debt: rung.debt, today })
              const freshness = balanceFreshness(rung.debt, today)
              return (
                <li key={rung.debt.id}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="font-semibold">
                          {rung.rank}. {rung.debt.name}
                        </h2>
                        <p className="mt-0.5 text-xs capitalize text-[var(--color-ink-soft)]">
                          {rung.debt.category}
                        </p>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        {freshness.stale ? <Pill tone="accent">Check the balance</Pill> : null}
                        <Pill tone={rung.rank === 1 ? 'accent' : 'neutral'}>
                          {rung.rank === 1 ? 'Next' : `#${rung.rank}`}
                        </Pill>
                      </div>
                    </div>

                    <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">Balance</dt>
                        <dd className="font-medium">
                          <Money cents={rung.debt.balanceCents} />
                        </dd>
                        <dd
                          className={`mt-0.5 text-xs ${freshness.stale ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-soft)]'}`}
                        >
                          <Hint detail="The date this balance was last confirmed: when the debt was added, a payment was recorded, or a statement balance was typed in.">
                            {freshness.ageDays === 0
                              ? 'Checked today'
                              : `As of ${humanDate(rung.debt.balanceAsOf)}, ${freshness.ageDays} days ago`}
                          </Hint>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">
                          <Hint detail="The rate it really costs right now, accounting for any promotional rate and how close that is to ending. A 0% deal you cannot clear in time is priced at the rate that comes after it.">
                            What it really costs
                          </Hint>
                        </dt>
                        <dd className="font-medium">
                          {(rung.effectiveAprBasisPoints / 100).toFixed(2)}%
                          {rung.effectiveAprBasisPoints !== rung.debt.aprBasisPoints ? (
                            <span className="ml-1 text-xs text-[var(--color-ink-soft)]">
                              (listed {(rung.debt.aprBasisPoints / 100).toFixed(2)}%)
                            </span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">Minimum each month</dt>
                        <dd className="font-medium">
                          <Money cents={rung.minimumPaymentCents} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">Paid off by</dt>
                        <dd className="font-medium">
                          {projection.payoffDate ?? 'Never, at this rate'}
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-xs text-[var(--color-ink-soft)]">
                      Clearing everything down to here costs{' '}
                      <Money cents={rung.cumulativeCostCents} /> and frees{' '}
                      <Money cents={rung.cumulativeFreedPerMonthCents} /> a month
                      {rung.breakEvenMonths !== null
                        ? ` — it pays for itself in ${rung.breakEvenMonths} months.`
                        : '.'}
                    </p>

                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <form action={confirmDebtPaymentAction} className="flex items-end gap-2">
                        <input type="hidden" name="debt_id" value={rung.debt.id} />
                        <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
                          I paid
                          <input
                            name="amount"
                            inputMode="decimal"
                            placeholder={formatCents(rung.minimumPaymentCents).replace('$', '')}
                            className={smallField}
                          />
                        </label>
                        <button
                          type="submit"
                          className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm"
                        >
                          Record
                        </button>
                      </form>

                      {/*
                        * A statement balance, as opposed to a payment: the way to
                        * bring a stale balance up to date without pretending money
                        * moved. Interest and new spending change a balance too.
                        */}
                      <form
                        action={updateDebtBalanceAction}
                        className={`flex items-end gap-2 ${freshness.stale ? 'rounded-lg bg-[var(--color-accent-soft)] p-2 sm:-m-2' : ''}`}
                      >
                        <input type="hidden" name="debt_id" value={rung.debt.id} />
                        <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
                          The statement says it is
                          <input
                            name="balance"
                            inputMode="decimal"
                            placeholder={formatCents(rung.debt.balanceCents).replace('$', '')}
                            className={smallField}
                          />
                        </label>
                        <button
                          type="submit"
                          className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm"
                        >
                          Update
                        </button>
                      </form>
                    </div>

                    <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                      <DebtEditor
                        debt={{ id: rung.debt.id, name: rung.debt.name }}
                        initial={debtFormValuesOf(rung.debt)}
                      />
                    </div>
                  </Card>
                </li>
              )
            })}
          </ol>

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

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        Add a debt
      </h2>
      <DebtForm action={createDebtAction} />
    </>
  )
}
