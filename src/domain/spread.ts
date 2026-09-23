/**
 * Where a sum of money is counted across an account's parts (PRD §6).
 *
 * The weekly figure is the sum of each part's rate, and a part's rate is what
 * it still needs over the weeks it has left. So where money is counted decides
 * not just this week's figure but every later one, and the aim is a figure
 * that stays put. Ballast is named for what keeps a boat steady, not for what
 * makes it sit low for a while.
 *
 * The rule, in order:
 *
 *   1. Every part up to its pace, soonest due first. At its pace a part costs
 *      exactly its steady rate, so the figure is the household's run-rate and
 *      does not climb when a part comes round again. A shortfall therefore
 *      lands on the parts due furthest out, where it costs least per week.
 *   2. What is left onto the one-off parts, soonest due first, up to each
 *      one's total. A one-off funded early only ever takes a step OUT of the
 *      figure, when it ends; it never puts one back in.
 *   3. Nothing is counted toward a repeating part above its pace. Counted
 *      there, money lowers the figure now and raises it again the day the
 *      part comes round and starts over at zero: a low number for a while
 *      that becomes a high one, which is the wave this product exists to
 *      remove. What is left after step 2 is returned uncounted, for the
 *      person to ease off with by a chosen date or to keep as a cushion.
 *
 * A reshuffle starts every part from zero and places the account's whole
 * counted total; a check-in extra starts from what each part already holds
 * and places only the extra, so it can add and never take away. One rule,
 * two starting points.
 */

import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import type { Id } from './types'
import type { LineItemView } from './rollup'

export interface SpreadPart {
  id: Id
  label: string
  dueDate: CivilDate
  totalCents: Cents
  /** Where an even save since the part's window opened would be by today. */
  paceCents: Cents
  /** What it counts as holding before this money is placed. */
  heldCents: Cents
  /** True for a part that does not come round again. */
  oneOff: boolean
}

export interface Spread {
  /** What each part counts as holding afterwards, by part id. */
  holdingsById: Map<Id, Cents>
  /** What no part should count without storing up a wave: left in the account as extra. */
  uncountedCents: Cents
}

export const soonestFirst = (a: Pick<SpreadPart, 'dueDate' | 'label'>, b: Pick<SpreadPart, 'dueDate' | 'label'>) =>
  compareDates(a.dueDate, b.dueDate) || a.label.localeCompare(b.label)

/** The most this rule will ever count toward a part: its total for a one-off, its pace otherwise. */
export function ceilingCents(part: Pick<SpreadPart, 'totalCents' | 'paceCents' | 'oneOff'>): Cents {
  return part.oneOff ? Math.max(0, part.totalCents) : Math.max(0, Math.min(part.paceCents, part.totalCents))
}

/** How much more this rule could count toward a part than it already holds. */
export function roomCents(part: SpreadPart): Cents {
  return Math.max(0, ceilingCents(part) - Math.max(0, part.heldCents))
}

export function spreadPartOf(
  view: Pick<LineItemView, 'lineItem' | 'totalCents' | 'paceCents'>,
  heldCents: Cents,
): SpreadPart {
  return {
    id: view.lineItem.id,
    label: view.lineItem.label,
    dueDate: view.lineItem.dueDate,
    totalCents: view.totalCents,
    paceCents: view.paceCents,
    heldCents,
    oneOff: view.lineItem.recurrence === null,
  }
}

export function placeMoney(parts: readonly SpreadPart[], amountCents: Cents): Spread {
  const held = new Map<Id, Cents>(
    parts.map((p) => [p.id, Math.max(0, Math.min(p.heldCents, Math.max(0, p.totalCents)))]),
  )
  let remaining = Math.max(0, amountCents)
  const ordered = [...parts].sort(soonestFirst)

  // 1. Every part up to its pace, soonest first.
  for (const p of ordered) {
    if (remaining <= 0) break
    const ceiling = Math.max(0, Math.min(p.paceCents, p.totalCents))
    const take = Math.max(0, Math.min(ceiling - (held.get(p.id) ?? 0), remaining))
    held.set(p.id, (held.get(p.id) ?? 0) + take)
    remaining -= take
  }

  // 2. What is left onto the one-offs, soonest first, up to each one's total.
  for (const p of ordered) {
    if (remaining <= 0) break
    if (!p.oneOff) continue
    const take = Math.max(0, Math.min(p.totalCents - (held.get(p.id) ?? 0), remaining))
    held.set(p.id, (held.get(p.id) ?? 0) + take)
    remaining -= take
  }

  // 3. The rest stays uncounted.
  return { holdingsById: held, uncountedCents: remaining }
}
