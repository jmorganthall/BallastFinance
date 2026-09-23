/**
 * Reshuffle: re-spread what an account's plans count as held across its parts.
 *
 * Money lands on parts for reasons that have nothing to do with the weekly
 * transfer: a spreadsheet's "reserved now", an opening typed at commit, a
 * check-in that counted an extra toward whichever parts came soonest. The
 * account's total is right; where it is counted may not be, and where it is
 * counted is exactly what sets each part's weekly figure.
 *
 * The spread that keeps the weekly figure steady is the one rule in
 * `spread.ts`: every part to its pace soonest first, the rest onto the
 * one-offs, and nothing above pace on a part that comes round again. What
 * the parts should not count stays in the account as extra, where the
 * check-in offers a dated ease-off or leaves it as a cushion.
 *
 * It changes where money is counted, and only by leaving some uncounted
 * does it change how much (PRD §6): nothing moves in the bank and nothing
 * needs confirming. The result is priced by the same derivation every screen
 * uses, as if each changed part's new figure were recorded today, so the
 * preview is what the person will see afterwards.
 */

import type { CivilDate } from './dates'
import type { Cents } from './money'
import type { Id, LineItemCycle } from './types'
import { accountViews, type DerivationInput, type LineItemView } from './rollup'
import { placeMoney, soonestFirst, spreadPartOf } from './spread'

export interface ReshuffleLine {
  lineItemId: Id
  label: string
  dueDate: CivilDate
  totalCents: Cents
  paceCents: Cents
  /** What the part counts as holding today, and what it would after. */
  holdsNowCents: Cents
  holdsAfterCents: Cents
  /** Its weekly set-aside today, and after. */
  perWeekNowCents: Cents
  perWeekAfterCents: Cents
}

export interface Reshuffle {
  accountId: Id
  accountName: string
  /** What the account's parts count as held between them: the money being re-spread. */
  potCents: Cents
  /**
   * The part of the pot no part should count afterwards: more than the
   * one-offs can take and above pace on everything that comes round again.
   * It stays in the account and shows as extra at the next check-in.
   */
  uncountedCents: Cents
  /** Every live part in the account, soonest due first. */
  lines: ReshuffleLine[]
  /** The parts whose counted money changes, with what each would hold. Empty when nothing would change. */
  openings: { lineItemId: Id; openingCents: Cents }[]
  /** The account's exact weekly figure, before and after. */
  perWeekNowCents: Cents
  perWeekAfterCents: Cents
  /** Parts short of their pace, before and after. */
  behindNowCount: number
  behindAfterCount: number
}

const isBehind = (v: Pick<LineItemView, 'totalCents' | 'shouldHaveSavedCents' | 'paceCents'>) =>
  v.shouldHaveSavedCents < v.totalCents && v.shouldHaveSavedCents < v.paceCents

export function reshuffleAccount(input: DerivationInput, accountId: Id): Reshuffle | null {
  const before = accountViews(input).find((v) => v.account.id === accountId)
  if (!before || before.items.length === 0) return null

  const ordered = [...before.items].sort((a, b) => soonestFirst(a.lineItem, b.lineItem))
  const potCents = ordered.reduce((sum, v) => sum + v.shouldHaveSavedCents, 0)

  // Every part starts from nothing and the whole pot is placed by the one rule.
  const { holdingsById: target, uncountedCents } = placeMoney(
    ordered.map((v) => spreadPartOf(v, 0)),
    potCents,
  )

  const openings = ordered
    .filter((v) => (target.get(v.lineItem.id) ?? 0) !== v.shouldHaveSavedCents)
    .map((v) => ({ lineItemId: v.lineItem.id, openingCents: target.get(v.lineItem.id) ?? 0 }))

  // Price the result as the screens will: each changed part restated today.
  const cycles = input.cycleStarts ?? []
  const nextOrder = cycles.reduce((max, c) => Math.max(max, c.recordedOrder ?? 0), cycles.length) + 1
  const restated: LineItemCycle[] = openings.map((o, index) => ({
    lineItemId: o.lineItemId,
    startDate: input.today,
    openingCents: o.openingCents,
    recordedOrder: nextOrder + index,
    origin: 'counted',
  }))
  const after =
    openings.length === 0
      ? before
      : (accountViews({ ...input, cycleStarts: [...cycles, ...restated] }).find(
          (v) => v.account.id === accountId,
        ) ?? before)
  const afterById = new Map(after.items.map((v) => [v.lineItem.id, v]))

  const lines: ReshuffleLine[] = ordered.map((v) => {
    const a = afterById.get(v.lineItem.id) ?? v
    return {
      lineItemId: v.lineItem.id,
      label: v.lineItem.label,
      dueDate: v.lineItem.dueDate,
      totalCents: v.totalCents,
      paceCents: v.paceCents,
      holdsNowCents: v.shouldHaveSavedCents,
      holdsAfterCents: a.shouldHaveSavedCents,
      perWeekNowCents: v.weekly.totalPerWeekCents,
      perWeekAfterCents: a.weekly.totalPerWeekCents,
    }
  })

  return {
    accountId,
    accountName: before.account.name,
    potCents,
    uncountedCents,
    lines,
    openings,
    perWeekNowCents: before.weekly.totalPerWeekCents,
    perWeekAfterCents: after.weekly.totalPerWeekCents,
    behindNowCount: ordered.filter(isBehind).length,
    behindAfterCount: after.items.filter(isBehind).length,
  }
}
