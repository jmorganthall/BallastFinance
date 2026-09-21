/**
 * Reshuffle: re-spread what an account's plans count as held across its parts.
 *
 * Money lands on parts for reasons that have nothing to do with the weekly
 * transfer: a spreadsheet's "reserved now", an opening typed at commit, a
 * check-in that counted an extra toward whichever parts came soonest. The
 * account's total is right; where it is counted may not be, and where it is
 * counted is exactly what sets each part's weekly figure.
 *
 * The spread that costs least per week without storing up a jump for later:
 *
 *   1. Every part up to its pace, soonest due first. A part at its pace is
 *      saving at its steady rate, so the weekly figure is the household's
 *      run-rate and does not climb when a part comes round again.
 *   2. Whatever is left, soonest due first, each part taking up to its total.
 *      A dollar on the part due soonest takes the most off this week's
 *      transfer, because it has the fewest weeks left to be spread over.
 *
 * It changes where money is counted, never how much (PRD §6): the account's
 * total, its behind or ahead, and any accepted catch-up are the same after
 * as before. Nothing moves in the bank. The result is priced by the same
 * derivation every screen uses, as if each changed part's new figure were
 * recorded today, so the preview is what the person will see afterwards.
 */

import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import type { Id, LineItemCycle } from './types'
import { accountViews, type DerivationInput, type LineItemView } from './rollup'

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

const soonestFirst = (a: LineItemView, b: LineItemView) =>
  compareDates(a.lineItem.dueDate, b.lineItem.dueDate) || a.lineItem.label.localeCompare(b.lineItem.label)

const isBehind = (v: Pick<LineItemView, 'totalCents' | 'shouldHaveSavedCents' | 'paceCents'>) =>
  v.shouldHaveSavedCents < v.totalCents && v.shouldHaveSavedCents < v.paceCents

export function reshuffleAccount(input: DerivationInput, accountId: Id): Reshuffle | null {
  const before = accountViews(input).find((v) => v.account.id === accountId)
  if (!before || before.items.length === 0) return null

  const ordered = [...before.items].sort(soonestFirst)
  const potCents = ordered.reduce((sum, v) => sum + v.shouldHaveSavedCents, 0)

  const target = new Map<Id, Cents>()
  let remaining = potCents
  // 1. Each part up to its pace, soonest first.
  for (const v of ordered) {
    const take = Math.max(0, Math.min(v.paceCents, v.totalCents, remaining))
    target.set(v.lineItem.id, take)
    remaining -= take
  }
  // 2. The rest, soonest first, up to each part's total.
  for (const v of ordered) {
    if (remaining <= 0) break
    const held = target.get(v.lineItem.id) ?? 0
    const take = Math.max(0, Math.min(v.totalCents - held, remaining))
    target.set(v.lineItem.id, held + take)
    remaining -= take
  }

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
    lines,
    openings,
    perWeekNowCents: before.weekly.totalPerWeekCents,
    perWeekAfterCents: after.weekly.totalPerWeekCents,
    behindNowCount: ordered.filter(isBehind).length,
    behindAfterCount: after.items.filter(isBehind).length,
  }
}
