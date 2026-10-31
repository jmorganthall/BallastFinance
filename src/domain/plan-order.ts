/**
 * The order of the plans list (PRD D41 (5)).
 *
 * Four sorts, each with the direction a person would expect first and
 * reversible by asking again: Next due (soonest first), Per week (the plan's
 * steady weekly cost, largest first), Total (this round, largest first) and
 * Most short (dollars missing today, largest first). The choice lives in the
 * address, never in a setting; a value that is not one of these reads as the
 * default, Next due soonest first.
 *
 * Live plans come first, then drafts, then done plans, each group in the
 * chosen order. A draft has no weekly cost and no shortfall (it costs
 * nothing yet), so under those two sorts it falls back to Next due. A plan
 * with no date comes last in its group whatever the sort; ties break by next
 * due, then name. Short plans are not pinned: the order is the one asked for.
 */

import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import { nextDue, type NextDue } from './next-due'
import type { PlanPosition } from './position'
import type { PackageView } from './rollup'
import type { PackageState } from './types'

export type PlanSort = 'due' | 'week' | 'total' | 'short'
export type SortDir = 'asc' | 'desc'

/** The chips, in the order they are shown, with the direction each starts in. */
export const PLAN_SORTS: readonly { key: PlanSort; label: string; defaultDir: SortDir }[] = [
  { key: 'due', label: 'Next due', defaultDir: 'asc' },
  { key: 'week', label: 'Per week', defaultDir: 'desc' },
  { key: 'total', label: 'Total', defaultDir: 'desc' },
  { key: 'short', label: 'Most short', defaultDir: 'desc' },
]

export const DEFAULT_PLAN_SORT: PlanSort = 'due'

export interface PlanOrder {
  sort: PlanSort
  dir: SortDir
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** The order the address asks for; anything it does not recognise is the default. */
export function readPlanOrder(params: { sort?: string | string[]; dir?: string | string[] }): PlanOrder {
  const asked = first(params.sort)
  const spec = PLAN_SORTS.find((s) => s.key === asked) ?? PLAN_SORTS.find((s) => s.key === DEFAULT_PLAN_SORT)!
  const dir = first(params.dir)
  return { sort: spec.key, dir: dir === 'asc' || dir === 'desc' ? dir : spec.defaultDir }
}

/** Where a chip leads: the same sort reversed when it is the one in force, else that sort in its own direction. */
export function planOrderAfterTap(current: PlanOrder, key: PlanSort): PlanOrder {
  if (current.sort === key) return { sort: key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: PLAN_SORTS.find((s) => s.key === key)!.defaultDir }
}

/** What the list needs to know of a plan to place it; every figure is the position's. */
export interface PlanOrderRow {
  name: string
  state: PackageState
  /** Its next due date, or null when nothing is left to come out. */
  nextDue: CivilDate | null
  /** The plan's steady weekly cost; null for a draft or a done plan. */
  perWeekCents: Cents | null
  /** This round's total. */
  totalCents: Cents
  /** What it is missing today; null for a draft or a done plan. */
  shortByCents: Cents | null
}

const GROUP: Record<PackageState, number> = { active: 0, simulated: 1, retired: 2 }

export function orderPlans<T extends PlanOrderRow>(rows: readonly T[], order: PlanOrder): T[] {
  const sign = order.dir === 'asc' ? 1 : -1
  // The figure the chosen sort compares, or null where a plan has none (a
  // draft's weekly cost or shortfall), which falls back to Next due.
  const figure = (r: T): number | null => {
    switch (order.sort) {
      case 'due':
        return null
      case 'total':
        return r.totalCents
      case 'week':
        return r.perWeekCents
      case 'short':
        return r.shortByCents
    }
  }
  const byDue = (a: T, b: T) =>
    a.nextDue === null || b.nextDue === null ? 0 : compareDates(a.nextDue, b.nextDue)
  return [...rows].sort((a, b) => {
    const group = GROUP[a.state] - GROUP[b.state]
    if (group !== 0) return group
    // No date: last in its group, whatever the sort and its direction.
    if ((a.nextDue === null) !== (b.nextDue === null)) return a.nextDue === null ? 1 : -1
    const fa = figure(a)
    const fb = figure(b)
    const chosen =
      order.sort === 'due' ? sign * byDue(a, b) : fa !== null && fb !== null ? sign * (fa - fb) : byDue(a, b)
    return chosen || byDue(a, b) || a.name.localeCompare(b.name)
  })
}

/** A plan as the plans list shows and orders it (D41), every figure worked out here. */
export interface PlanRow extends PlanOrderRow {
  view: PackageView
  /** The position's reading of a live plan; absent for a draft or a done plan. */
  plan: PlanPosition | undefined
  next: NextDue | null
}

/**
 * The plans list's rows (D41, D56 (6)): each plan with the figures its card
 * shows and the list is ordered by. A live plan's are the position's, its
 * next date its rounds' (D53): the round saving now for a date ahead, so a
 * round still open past its date never holds the plan back. A draft or a
 * done plan has only what it costs.
 */
export function planRows(args: {
  views: readonly PackageView[]
  plans: readonly PlanPosition[]
  today: CivilDate
}): PlanRow[] {
  const byId = new Map(args.plans.map((p) => [p.package.id, p]))
  return args.views.map((view) => {
    const plan = view.package.state === 'active' ? byId.get(view.package.id) : undefined
    const live = plan && plan.parts.length > 0 ? plan : undefined
    const ahead = live ? live.parts.filter((x) => !x.round.past) : []
    const next =
      view.package.state === 'retired'
        ? null
        : nextDue(
            live ? (ahead.length > 0 ? ahead : live.parts).map((x) => x.lineItem) : view.items.map((i) => i.lineItem),
            args.today,
          )
    return {
      view,
      plan,
      next,
      name: view.package.name,
      state: view.package.state,
      nextDue: next?.dueDate ?? null,
      perWeekCents: plan ? plan.steadyPerWeekCents : null,
      totalCents: live ? live.totalCents : view.totalCents,
      shortByCents: plan ? plan.shortByCents : null,
    }
  })
}
