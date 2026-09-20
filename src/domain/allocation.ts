/**
 * The Allocation Engine (PRD §6).
 *
 * Drop in one number -- what Simplifi says is left over after everything that is
 * already spoken for -- and the household's standing rules turn it into a set of
 * concrete, separately confirmable instructions.
 *
 * Rounding here is deliberately the opposite of the accrual math. Accruals round
 * UP because being a few cents over on savings is safe. An allocation divides
 * money that actually exists, so rounding every share up would hand out more
 * than was put in. Shares are apportioned by largest remainder instead: they sum
 * to exactly the net, every time, and the odd cents go where they help most.
 */

import { addDays, type CivilDate } from './dates'
import type { Cents } from './money'

export type AllocationDestination = 'debt' | 'lifestyle' | 'long_term_savings' | 'emergency'

export interface AllocationRule {
  destination: AllocationDestination
  /** Percentage points. The set must sum to 100. */
  percent: number
  label: string
}

/** The family's standing rules (PRD §6). Configurable, not hard-coded. */
export const DEFAULT_ALLOCATION_RULES: AllocationRule[] = [
  { destination: 'debt', percent: 50, label: 'Paying off debt' },
  { destination: 'lifestyle', percent: 25, label: 'Fun money' },
  { destination: 'long_term_savings', percent: 15, label: 'Long Term Savings' },
  { destination: 'emergency', percent: 10, label: '911 Fund' },
]

export const DEFAULT_BUFFER_CENTS = 35_000 // $350

export class AllocationError extends Error {}

export interface AllocationShare {
  destination: AllocationDestination
  label: string
  percent: number
  amountCents: Cents
}

export interface AllocationPlan {
  floorCents: Cents
  bufferCents: Cents
  netCents: Cents
  shares: AllocationShare[]
  /** Lifestyle is released in two halves so it is not spent all at once. */
  lifestyleReleases: { amountCents: Cents; releaseOn: CivilDate }[]
}

/**
 * Apportion `total` across weights so the parts sum to exactly `total`.
 *
 * Largest remainder: floor every share, then hand the leftover cents out one at
 * a time, biggest fractional part first. Ties go to the earlier rule, so the
 * result is stable rather than dependent on sort order.
 */
export function apportion(totalCents: Cents, weights: readonly number[]): Cents[] {
  const totalWeight = weights.reduce((s, w) => s + w, 0)
  if (totalWeight <= 0) throw new AllocationError('Allocation percentages must add up to more than zero')

  const exact = weights.map((w) => (totalCents * w) / totalWeight)
  const floors = exact.map((value) => Math.floor(value))
  let remainder = totalCents - floors.reduce((s, v) => s + v, 0)

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)

  const result = [...floors]
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] = (result[index] ?? 0) + 1
    remainder -= 1
  }
  return result
}

export function validateRules(rules: readonly AllocationRule[]): void {
  const sum = rules.reduce((s, r) => s + r.percent, 0)
  if (Math.abs(sum - 100) > 0.001) {
    throw new AllocationError(`Allocation percentages add up to ${sum}%, not 100%.`)
  }
  if (rules.some((r) => r.percent < 0)) {
    throw new AllocationError('An allocation percentage cannot be negative.')
  }
}

export function planAllocation(args: {
  floorCents: Cents
  bufferCents?: Cents
  rules?: readonly AllocationRule[]
  today: CivilDate
  /** Days until the second half of the fun money is released (~one pay period). */
  secondHalfAfterDays?: number
}): AllocationPlan {
  const rules = args.rules ?? DEFAULT_ALLOCATION_RULES
  validateRules(rules)

  const bufferCents = args.bufferCents ?? DEFAULT_BUFFER_CENTS
  const netCents = args.floorCents - bufferCents

  if (netCents <= 0) {
    return {
      floorCents: args.floorCents,
      bufferCents,
      netCents: 0,
      shares: rules.map((rule) => ({ ...rule, amountCents: 0 })),
      lifestyleReleases: [],
    }
  }

  const amounts = apportion(
    netCents,
    rules.map((r) => r.percent),
  )
  const shares: AllocationShare[] = rules.map((rule, index) => ({
    destination: rule.destination,
    label: rule.label,
    percent: rule.percent,
    amountCents: amounts[index] ?? 0,
  }))

  const lifestyle = shares.find((s) => s.destination === 'lifestyle')?.amountCents ?? 0
  const [firstHalf, secondHalf] = apportion(lifestyle, [1, 1])

  return {
    floorCents: args.floorCents,
    bufferCents,
    netCents,
    shares,
    lifestyleReleases:
      lifestyle > 0
        ? [
            { amountCents: firstHalf ?? 0, releaseOn: args.today },
            {
              amountCents: secondHalf ?? 0,
              releaseOn: addDays(args.today, args.secondHalfAfterDays ?? 14),
            },
          ]
        : [],
  }
}
