/**
 * The debt slice of a share-out, opened up: what it does (two figures), then
 * exactly where it goes, debt by debt. The same optimizer call the confirm
 * button makes, so what is previewed is what gets issued.
 */

import Link from 'next/link'
import type { OptimizerResult } from '@/domain'
import { Money, Pill } from '@/components/ui'
import { PayoffImpact } from '@/components/payoff-impact'

export function DebtShare({ optimised }: { optimised: OptimizerResult | null }) {
  if (!optimised) return null
  if (optimised.allocations.length === 0) {
    // Nothing placed: either there are no debts, or every one is on a deal
    // the household is on track to clear and paying early saves nothing.
    // The optimizer says which; a plan with debts must never read as "none".
    const noDebts = optimised.consideredDebts === 0
    return (
      <p className="mt-3 rounded-xl bg-[var(--color-surface)] p-3 text-sm text-[var(--color-ink-soft)]">
        {noDebts ? (
          <>
            No debts recorded yet, so this has nowhere specific to go.{' '}
            <Link href="/debts" className="underline">
              Add your debts
            </Link>{' '}
            and Ballast will name which one to pay.
          </>
        ) : (
          <>{optimised.why} You will be asked where it goes.</>
        )}
      </p>
    )
  }

  return (
    <div className="mt-4 space-y-4">
      <PayoffImpact result={optimised} />

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
          Where it goes
        </h3>
        <ul className="mt-2 divide-y divide-[var(--color-line)]">
          {optimised.allocations.map((allocation) => (
            <li key={allocation.debtId} className="py-3 first:pt-1 last:pb-1">
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

      {optimised.unallocatedCents > 0 ? (
        <p className="text-xs text-[var(--color-ink-soft)]">
          <Money cents={optimised.unallocatedCents} /> is left over — you will be asked where it
          goes.
        </p>
      ) : null}

      <p className="text-xs text-[var(--color-ink-soft)]">
        Same order as the Debts screen, at your normal setting.{' '}
        <Link href="/debts" className="underline">
          Change the order
        </Link>
      </p>
    </div>
  )
}
