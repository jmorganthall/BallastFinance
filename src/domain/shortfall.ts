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
 *   - A plan is short when its account needs a one-time move: money the
 *     weekly transfer cannot put there in time for something due soon
 *     (the one position's move, D35). A gap the transfer can close is a
 *     transfer change, not a shortfall, so it never takes spare money.
 *   - A debt is short when a promotional-rate balance cannot be cleared by
 *     the monthly payments (what the household actually pays, else the
 *     minimum) before the rate ends -- the same test the ladder uses to
 *     decide a promo is a cliff. The shortfall is what those payments will
 *     not have covered by the deadline.
 *
 * Nothing here decides for anyone. It names what is short; the person ticks
 * what to cover; the split takes the rest.
 */

import { formatCents, type Cents } from './money'
import type { Id } from './types'
import type { AccountPosition } from './position'
import { debtStatusLine, type DebtView } from './debt-status'

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
  accounts: readonly Pick<AccountPosition, 'account' | 'oneTimeMove' | 'money'>[]
  /** The debts' one status (D49 (5)), with the payments still asked for (D56 (2)). */
  debts: readonly DebtView[]
}): Shortfall[] {
  const debts: Shortfall[] = []
  for (const view of args.debts) {
    // What is still missing once the payments already asked for are made, so
    // a second share-out never covers the same deal again (D56 (2)).
    const miss = view.missAfterAsks
    if (!miss) continue
    debts.push({
      kind: 'debt',
      targetId: view.debt.id,
      label: view.debt.name,
      shortCents: miss.owedAtEndCents,
      // The debt's own status line (D49 (5)): the same words as Debts and This week.
      reason: debtStatusLine({ ...view, miss })
        .map((part) => part.text)
        .join(''),
    })
  }
  debts.sort((a, b) => b.shortCents - a.shortCents)

  const plans: Shortfall[] = []
  for (const a of args.accounts) {
    if (!a.oneTimeMove) continue
    plans.push({
      kind: 'plan',
      targetId: a.account.id,
      label: a.account.name,
      shortCents: a.oneTimeMove.amountCents,
      reason: `Likely holds ${formatCents(a.money.totalCents)}, and needs ${formatCents(a.oneTimeMove.amountCents)} more by ${a.oneTimeMove.byDate}: too soon for the weekly transfer to cover.`,
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
