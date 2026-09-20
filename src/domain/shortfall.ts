/**
 * What is short, before spare money gets shared out.
 *
 * A share-out splits spare money by the household's standing rules. But the
 * rules assume everything else is where it should be, and it often is not:
 * a reserve account is behind pace, or a deal-rate balance will still be
 * there when its rate ends. Sharing out on top of that is putting fun money
 * ahead of a hole. So the first step of a share-out is optional and comes
 * before the split: cover what is short, then share the rest.
 *
 * Two kinds of short, both figures the app already stands behind:
 *
 *   - A plan is short when the account holds less than its plans say it
 *     should by now (the check-in's "behind").
 *   - A debt is short when a promotional-rate balance cannot be cleared by
 *     the monthly payments (what the household actually pays, else the
 *     minimum) before the rate ends -- the same test the ladder uses to
 *     decide a promo is a cliff. The shortfall is what those payments will
 *     not have covered by the deadline.
 *
 * Nothing here decides for anyone. It names what is short; the person ticks
 * what to cover; the split takes the rest.
 */

import { compareDates, monthsBetween, type CivilDate } from './dates'
import { formatCents, type Cents } from './money'
import type { Id } from './types'
import { computeDrift, type AccountView } from './rollup'
import { monthlyPaymentCents, type Debt } from './debt'

export interface Shortfall {
  kind: 'plan' | 'debt'
  targetId: Id
  label: string
  shortCents: Cents
  /** Why, in plain words. */
  reason: string
}

/** A shortfall the person chose to cover, and what this run puts toward it. */
export interface TopUp {
  kind: 'plan' | 'debt'
  targetId: Id
  label: string
  shortCents: Cents
  amountCents: Cents
}

export function findShortfalls(args: {
  accounts: readonly { view: AccountView; confirmedCents: Cents | null }[]
  debts: readonly Debt[]
  today: CivilDate
}): Shortfall[] {
  const debts: Shortfall[] = []
  for (const debt of args.debts) {
    if (debt.state !== 'open' || debt.balanceCents <= 0) continue
    const payment = monthlyPaymentCents(debt)
    let unallocated = debt.balanceCents
    const live = debt.promoRules
      .filter((rule) => compareDates(rule.untilDate, args.today) > 0)
      .sort((a, b) => compareDates(a.untilDate, b.untilDate))
    for (const rule of live) {
      if (unallocated <= 0) break
      const amountCents =
        rule.appliesTo === 'full' ? unallocated : Math.min(rule.amountCents ?? 0, unallocated)
      if (amountCents <= 0) continue
      unallocated -= amountCents
      const monthsLeft = monthsBetween(args.today, rule.untilDate)
      const covered = monthsLeft * payment
      const short = amountCents - covered
      if (short <= 0) continue
      debts.push({
        kind: 'debt',
        targetId: debt.id,
        label: debt.name,
        shortCents: short,
        reason: `Its ${(rule.rateBasisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}% deal ends ${rule.untilDate}, and the monthly payments leave ${formatCents(short)} of the ${formatCents(amountCents)} still there at the full rate.`,
      })
      // One entry per debt: the soonest cliff is the one that matters.
      break
    }
  }
  debts.sort((a, b) => b.shortCents - a.shortCents)

  const plans: Shortfall[] = []
  for (const { view, confirmedCents } of args.accounts) {
    if (confirmedCents === null || view.items.length === 0) continue
    const drift = computeDrift({ account: view, confirmedCents })
    if (drift.driftCents >= 0) continue
    plans.push({
      kind: 'plan',
      targetId: view.account.id,
      label: view.account.name,
      shortCents: -drift.driftCents,
      reason: `Holds ${formatCents(confirmedCents)}, and its plans say it should hold ${formatCents(view.shouldHaveSavedCents)} by now.`,
    })
  }
  plans.sort((a, b) => b.shortCents - a.shortCents)

  // A deadline before a pace: the deal ends whether or not the plan catches up.
  return [...debts, ...plans]
}

/**
 * Turn the shortfalls a person ticked into what this run can actually put
 * toward them, in the order given, each taking what it is short until the
 * money runs out. What is left is what the split shares.
 */
export function takeTopUps(
  chosen: readonly Shortfall[],
  availableCents: Cents,
): { topUps: TopUp[]; remainingCents: Cents } {
  let remaining = Math.max(0, availableCents)
  const topUps: TopUp[] = []
  for (const short of chosen) {
    const amountCents = Math.min(short.shortCents, remaining)
    if (amountCents <= 0) continue
    remaining -= amountCents
    topUps.push({
      kind: short.kind,
      targetId: short.targetId,
      label: short.label,
      shortCents: short.shortCents,
      amountCents,
    })
  }
  return { topUps, remainingCents: remaining }
}
