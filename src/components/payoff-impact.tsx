/**
 * What a payoff does, as two figures a person can feel: the cash that comes
 * back every month, and the interest that is never paid. A figure each, with
 * the plain sentence that qualifies it underneath -- not a paragraph of
 * numbers.
 *
 * Nothing here is computed; the optimizer produced every figure (PRD §10).
 */

import type { OptimizerResult } from '@/domain'
import { formatCents } from '@/domain'

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * The line under "Freed up each month": where that cash comes from. A cleared
 * debt frees its whole minimum; a card whose minimum is a share of the balance
 * frees a little even when it is only dented; a set payment frees nothing
 * until the debt is gone.
 */
function freedSentence(cleared: readonly string[], eased: readonly string[]): string {
  const paidOff =
    cleared.length > 0
      ? `once ${joinNames(cleared)} ${cleared.length === 1 ? 'is' : 'are'} paid off`
      : ''
  const smaller =
    eased.length > 0
      ? `the minimum on ${joinNames(eased)} ${eased.length === 1 ? 'falls' : 'fall'} with the balance`
      : ''
  if (paidOff && smaller) return `${paidOff}, and ${smaller}`
  if (paidOff) return paidOff
  if (smaller) return smaller
  return 'nothing is paid off outright, and a set payment stays the same until it is'
}

export function PayoffImpact({ result }: { result: OptimizerResult }) {
  const cleared = result.allocations.filter((a) => a.clearsIt).map((a) => a.debtName)
  // Not paid off, but its minimum follows its balance down, so it still frees cash.
  const eased = result.allocations
    .filter((a) => !a.clearsIt && a.monthlyFreedCents > 0)
    .map((a) => a.debtName)
  const lifetime = result.lifetimeInterestAvoidedCents

  return (
    <dl className="grid grid-cols-2 gap-3">
      <div className="rounded-xl bg-[var(--color-surface)] p-3 sm:p-4">
        <dt className="text-xs text-[var(--color-ink-soft)]">Freed up each month</dt>
        <dd className="mt-1 text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
          {formatCents(result.monthlyFreedCents)}
        </dd>
        <dd className="mt-1 text-xs leading-snug text-[var(--color-ink-soft)]">
          {freedSentence(cleared, eased)}
        </dd>
      </div>

      <div className="rounded-xl bg-[var(--color-surface)] p-3 sm:p-4">
        <dt className="text-xs text-[var(--color-ink-soft)]">Interest you never pay</dt>
        <dd className="mt-1 text-2xl font-semibold tracking-tight text-[var(--color-ink)]">
          {formatCents(lifetime ?? result.interestAvoidedCents)}
        </dd>
        <dd className="mt-1 text-xs leading-snug text-[var(--color-ink-soft)]">
          {lifetime !== null
            ? 'over the life of these debts, at their minimum payments'
            : 'in the next year alone: at its minimum, one of these would never be paid off'}
        </dd>
      </div>
    </dl>
  )
}
