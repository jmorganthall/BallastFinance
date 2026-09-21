/**
 * Ordering the payoff table for reading. The rows arrive in payoff order (the
 * ladder's rank), and that is the default; clicking a heading re-orders the
 * same rows. Nothing is computed here, only compared, and the `#` column keeps
 * showing the ladder rank whatever the table is sorted by, so the payoff order
 * never disappears.
 */

export type SortKey = 'rank' | 'name' | 'balance' | 'rate' | 'payment' | 'payoff'
export type SortDirection = 'asc' | 'desc'
export interface Sort {
  key: SortKey
  direction: SortDirection
}

/** The fields a row must carry to be sortable; the table's rows carry more. */
export interface SortableDebtRow {
  rank: number
  name: string
  balanceCents: number
  effectiveAprBasisPoints: number
  paymentCents: number
  /** A CivilDate, or null for "never, at this rate". */
  payoffDate: string | null
}

export const DEFAULT_SORT: Sort = { key: 'rank', direction: 'asc' }

/** Ascending comparators. "Never, at this rate" sorts after every real date. */
const COMPARE: Record<SortKey, (a: SortableDebtRow, b: SortableDebtRow) => number> = {
  rank: (a, b) => a.rank - b.rank,
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  balance: (a, b) => a.balanceCents - b.balanceCents,
  rate: (a, b) => a.effectiveAprBasisPoints - b.effectiveAprBasisPoints,
  payment: (a, b) => a.paymentCents - b.paymentCents,
  payoff: (a, b) => {
    if (a.payoffDate === b.payoffDate) return 0
    if (a.payoffDate === null) return 1
    if (b.payoffDate === null) return -1
    // CivilDate strings (YYYY-MM-DD) order correctly as text.
    return a.payoffDate < b.payoffDate ? -1 : 1
  },
}

/** A new array in the requested order; ties keep the payoff order. */
export function sortDebtRows<T extends SortableDebtRow>(rows: readonly T[], sort: Sort): T[] {
  const compare = COMPARE[sort.key]
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => sign * compare(a, b) || a.rank - b.rank)
}

/** Clicking the current column flips it; clicking another starts ascending. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return { key, direction: 'asc' }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}
