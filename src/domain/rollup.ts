/**
 * Rollups: item -> package -> reserve account (PRD §5).
 *
 * The per-account weekly figure produced here IS the Capital One recurring
 * transfer instruction, and the per-account should-have-saved total is what a
 * check-in compares a confirmed balance against.
 *
 * Simulated packages are excluded from every live total (PRD §5); they are
 * priced separately by the what-if overlay so a draft can never move a real
 * transfer.
 */

import {
  componentsForLineItem,
  driftAdjustmentComponent,
  shouldHaveSaved,
  shouldHaveSavedForItem,
  weeklyBreakdown,
  type RateComponent,
  type WeeklyBreakdown,
} from './accrual'
import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import {
  lineItemTotalCents,
  type DriftAdjustment,
  type Id,
  type LineItem,
  type LineItemChange,
  type LineItemCycle,
  type Package,
  type ReserveAccount,
} from './types'

export interface DerivationInput {
  today: CivilDate
  accounts: readonly ReserveAccount[]
  packages: readonly Package[]
  lineItems: readonly LineItem[]
  changes?: readonly LineItemChange[]
  driftAdjustments?: readonly DriftAdjustment[]
  /** Cycle starts and opening balances, per item. Absent means "since commit, from $0". */
  cycleStarts?: readonly LineItemCycle[]
  /**
   * Round each account's bank figure up to this step (a household setting,
   * nearest $10 by default). Only the account total is rounded -- it is the
   * one number that becomes a Capital One transfer; a part's or a plan's
   * weekly figure stays exact so the parts still add up.
   */
  transferRoundUpCents?: Cents
}

/**
 * The cycle an item is in today: the latest start on or before today. An
 * item with no recorded start is in its first cycle, from the commit, at $0.
 *
 * Two starts on the same day are decided by which was recorded later, not by
 * the order they happened to be read in. A plan imported with its "reserved
 * now" and counted toward at a check-in the same afternoon has exactly that
 * tie, and the afternoon's figure is the one the person just confirmed.
 */
export function currentCycle(
  lineItemId: Id,
  cycles: readonly LineItemCycle[],
  today: CivilDate,
): LineItemCycle | null {
  return (
    cycles
      .filter((c) => c.lineItemId === lineItemId && compareDates(c.startDate, today) <= 0)
      .sort(
        (a, b) =>
          compareDates(b.startDate, a.startDate) || (b.recordedOrder ?? 0) - (a.recordedOrder ?? 0),
      )[0] ?? null
  )
}

export interface LineItemView {
  lineItem: LineItem
  components: RateComponent[]
  totalCents: Cents
  shouldHaveSavedCents: Cents
  remainingCents: Cents
  weekly: WeeklyBreakdown
  /** Past its due date and not yet confirmed spent -- it keeps nagging (PRD §5). */
  isOverdue: boolean
}

export interface PackageView {
  package: Package
  items: LineItemView[]
  totalCents: Cents
  shouldHaveSavedCents: Cents
  weekly: WeeklyBreakdown
}

export interface AccountView {
  account: ReserveAccount
  /** The number to set the recurring transfer to. */
  weekly: WeeklyBreakdown
  /** What this account should hold today across all active packages. */
  shouldHaveSavedCents: Cents
  /** Still to be set aside before every active item in this account is funded. */
  outstandingCents: Cents
  items: LineItemView[]
}

/**
 * A line item accrues only once its package is committed. For a simulated
 * package we price it as if committed today, which is what the what-if overlay
 * needs; a live package uses its real committed_at.
 */
function effectiveCommitDate(pkg: Package, today: CivilDate): CivilDate {
  return pkg.committedAt ?? today
}

function viewLineItem(args: {
  lineItem: LineItem
  pkg: Package
  today: CivilDate
  changes: readonly LineItemChange[]
  cycles: readonly LineItemCycle[]
}): LineItemView {
  const { lineItem, pkg, today, changes } = args
  const cycle = currentCycle(lineItem.id, args.cycles, today)
  const components = componentsForLineItem({
    lineItem,
    commitDate: effectiveCommitDate(pkg, today),
    changes,
    cycleStartDate: cycle?.startDate,
    openingCents: cycle?.openingCents,
  })
  const totalCents = lineItemTotalCents(lineItem)
  const shouldHaveSavedCents = shouldHaveSavedForItem(components, today, totalCents)

  return {
    lineItem,
    components,
    totalCents,
    shouldHaveSavedCents,
    remainingCents: Math.max(0, totalCents - shouldHaveSavedCents),
    weekly: weeklyBreakdown(components, today),
    isOverdue: compareDates(today, lineItem.dueDate) > 0 && lineItem.state !== 'retired',
  }
}

/** Items that count toward live totals: committed package, not yet retired. */
function isLive(pkg: Package, item: LineItem): boolean {
  return pkg.state === 'active' && item.state !== 'retired'
}

export function packageViews(input: DerivationInput): PackageView[] {
  const { today, packages, lineItems } = input
  const changes = input.changes ?? []
  const cycles = input.cycleStarts ?? []

  return packages.map((pkg) => {
    const items = lineItems
      .filter((li) => li.packageId === pkg.id)
      .map((lineItem) => viewLineItem({ lineItem, pkg, today, changes, cycles }))

    const live = items.filter((v) => v.lineItem.state !== 'retired')
    const components = live.flatMap((v) => v.components)

    return {
      package: pkg,
      items,
      totalCents: live.reduce((s, v) => s + v.totalCents, 0),
      shouldHaveSavedCents: live.reduce((s, v) => s + v.shouldHaveSavedCents, 0),
      weekly: weeklyBreakdown(components, today),
    }
  })
}

export function accountViews(input: DerivationInput): AccountView[] {
  const { today, accounts, packages, lineItems } = input
  const changes = input.changes ?? []
  const adjustments = input.driftAdjustments ?? []
  const cycles = input.cycleStarts ?? []
  const packagesById = new Map(packages.map((p) => [p.id, p]))

  return accounts.map((account) => {
    const items: LineItemView[] = []

    for (const lineItem of lineItems) {
      if (lineItem.reserveAccountId !== account.id) continue
      const pkg = packagesById.get(lineItem.packageId)
      if (!pkg || !isLive(pkg, lineItem)) continue
      items.push(viewLineItem({ lineItem, pkg, today, changes, cycles }))
    }

    const components = [
      ...items.flatMap((v) => v.components),
      ...adjustments
        .filter((a) => a.reserveAccountId === account.id)
        .map(driftAdjustmentComponent),
    ]

    return {
      account,
      weekly: weeklyBreakdown(components, today, input.transferRoundUpCents ?? 0),
      shouldHaveSavedCents: items.reduce((s, v) => s + v.shouldHaveSavedCents, 0),
      outstandingCents: items.reduce((s, v) => s + v.remainingCents, 0),
      items,
    }
  })
}

/**
 * What committing a simulated package would add to each account's weekly number.
 * Answers "what happens if this Disney trip becomes a commitment?" without
 * touching live rates (PRD §5).
 */
export interface WhatIfLine {
  accountId: Id
  accountName: string
  currentPerWeekCents: Cents
  addedPerWeekCents: Cents
  projectedPerWeekCents: Cents
}

export function whatIfCommit(input: DerivationInput, packageId: Id): WhatIfLine[] {
  const { today, accounts, packages, lineItems } = input
  const target = packages.find((p) => p.id === packageId)
  if (!target) return []

  const current = accountViews(input)
  const currentByAccount = new Map(current.map((v) => [v.account.id, v.weekly.totalPerWeekCents]))

  const committed: Package = { ...target, state: 'active', committedAt: today }
  const projected = accountViews({
    ...input,
    packages: packages.map((p) => (p.id === packageId ? committed : p)),
  })

  return projected
    .map((view) => {
      const currentPerWeekCents = currentByAccount.get(view.account.id) ?? 0
      return {
        accountId: view.account.id,
        accountName: view.account.name,
        currentPerWeekCents,
        addedPerWeekCents: view.weekly.totalPerWeekCents - currentPerWeekCents,
        projectedPerWeekCents: view.weekly.totalPerWeekCents,
      }
    })
    .filter((line) => line.addedPerWeekCents !== 0)
    .sort((a, b) => b.addedPerWeekCents - a.addedPerWeekCents)
}

/** Drift at a check-in: confirmed balance minus what the plan says should be there. */
export interface Drift {
  accountId: Id
  expectedCents: Cents
  confirmedCents: Cents
  /** Negative = behind pace, positive = ahead. */
  driftCents: Cents
}

export function computeDrift(args: {
  account: AccountView
  confirmedCents: Cents
}): Drift {
  return {
    accountId: args.account.account.id,
    expectedCents: args.account.shouldHaveSavedCents,
    confirmedCents: args.confirmedCents,
    driftCents: args.confirmedCents - args.account.shouldHaveSavedCents,
  }
}

/** Catch-up options offered when a check-in finds the account behind (PRD §5). */
export interface CatchUpOption {
  kind: 'one_time' | 'rate_bump'
  amountCents: Cents
  perWeekCents?: Cents
  weeks?: number
  endDate?: CivilDate
}

export function catchUpOptions(args: {
  shortfallCents: Cents
  today: CivilDate
  overWeeks: number
}): CatchUpOption[] {
  const { shortfallCents, overWeeks } = args
  if (shortfallCents <= 0) return []
  const weeks = Math.max(1, overWeeks)
  const perWeekCents = Math.ceil(shortfallCents / weeks)
  const endDate = addWeeks(args.today, weeks)
  return [
    { kind: 'one_time', amountCents: shortfallCents },
    { kind: 'rate_bump', amountCents: shortfallCents, perWeekCents, weeks, endDate },
  ]
}

/**
 * What to offer when a check-in finds the account AHEAD: holding more than the
 * plan says it should. Two ways back on track, mirroring the catch-up pair:
 * move the extra back out now, or ease off the weekly set-aside until the
 * extra has been used up. Leaving it as a cushion is always the third choice,
 * and needs no instruction.
 */
export interface AheadOption {
  kind: 'one_time_out' | 'rate_cut'
  /**
   * The extra this option uses up. For a cut, the total the cut removes over
   * its window: exactly perWeekCents × weeks, so what the bank is told and what
   * the accrual math applies are the same number.
   */
  amountCents: Cents
  perWeekCents?: Cents
  weeks?: number
  endDate?: CivilDate
  /** The cut is the whole weekly set-aside: a pause, not a trim. */
  pauses?: boolean
  /** Extra this option does not use up, which simply stays as a cushion. */
  leftoverCents?: Cents
}

export function aheadOptions(args: {
  extraCents: Cents
  /** The account's current weekly set-aside. A cut can never take more than this. */
  weeklyCents: Cents
  today: CivilDate
  overWeeks: number
  /** The longest a pause is ever offered for. */
  maxWeeks?: number
}): AheadOption[] {
  const { extraCents, weeklyCents } = args
  if (extraCents <= 0) return []

  const options: AheadOption[] = [{ kind: 'one_time_out', amountCents: extraCents }]
  // Nothing is being set aside, so there is nothing to ease off.
  if (weeklyCents <= 0) return options

  const overWeeks = Math.max(1, args.overWeeks)
  const maxWeeks = Math.max(overWeeks, args.maxWeeks ?? 52)

  let perWeekCents: Cents
  let weeks: number
  if (extraCents <= weeklyCents * overWeeks) {
    // A trim over the usual window. Rounded DOWN, the opposite of an accrual:
    // an under-cut leaves the account a few cents ahead, an over-cut would
    // leave it behind, and the household rule is to err on having more.
    weeks = overWeeks
    perWeekCents = Math.floor(extraCents / weeks)
  } else {
    // More extra than the window can absorb: pause the set-aside entirely for
    // as many whole weeks as the extra covers, up to a limit. Whole weeks
    // only, so a pause is a real pause and never a transfer of a few cents.
    weeks = Math.min(maxWeeks, Math.floor(extraCents / weeklyCents))
    perWeekCents = weeklyCents
  }
  if (perWeekCents <= 0 || weeks <= 0) return options

  const amountCents = perWeekCents * weeks
  options.push({
    kind: 'rate_cut',
    amountCents,
    perWeekCents,
    weeks,
    endDate: addWeeks(args.today, weeks),
    pauses: perWeekCents === weeklyCents,
    leftoverCents: extraCents - amountCents,
  })
  return options
}

/**
 * The best thing to do with money an account holds beyond what its plans have
 * accrued: count it toward those plans. Soonest due first, because the plan
 * that needs its money first is the one a shortfall would hurt, and each part
 * takes at most what it still lacks. What every part is then holding becomes
 * its new opening balance, so the weekly number drops and "should hold"
 * rises to match what is actually there. Anything left after every part is
 * fully funded is a genuine surplus, which the caller decides about.
 */
export interface OpeningAssignment {
  lineItemId: Id
  label: string
  dueDate: CivilDate
  /** What the part still needed before any of the extra was counted. */
  shortCents: Cents
  /** Money from the extra counted toward this part. */
  addedCents: Cents
  /** What the part holds after that: its new opening balance. */
  openingCents: Cents
  /** True when this finishes it: nothing more to set aside for this part. */
  fullyFunded: boolean
}

export interface ExtraAssignment {
  assignments: OpeningAssignment[]
  /** What no plan here could use: a genuine surplus. */
  leftoverCents: Cents
  /**
   * Parts that still need money but got none, because the extra ran out
   * before their turn. Named so the screen can say the list is not "the top
   * few" -- it is everything the extra could reach, soonest first.
   */
  stillShort: { lineItemId: Id; label: string; dueDate: CivilDate; shortCents: Cents }[]
  /** Parts already fully funded, which are never listed: nothing to count toward. */
  alreadyFundedCount: number
}

export function assignExtraToPlans(args: {
  extraCents: Cents
  items: readonly Pick<LineItemView, 'lineItem' | 'totalCents' | 'shouldHaveSavedCents'>[]
}): ExtraAssignment {
  let remaining = Math.max(0, args.extraCents)
  const assignments: OpeningAssignment[] = []
  const stillShort: ExtraAssignment['stillShort'] = []
  let alreadyFundedCount = 0

  const ordered = [...args.items].sort(
    (a, b) =>
      compareDates(a.lineItem.dueDate, b.lineItem.dueDate) ||
      a.lineItem.label.localeCompare(b.lineItem.label),
  )
  for (const item of ordered) {
    const lacks = Math.max(0, item.totalCents - item.shouldHaveSavedCents)
    // Already funded: nothing to count toward, so it is not offered.
    if (lacks <= 0) {
      alreadyFundedCount += 1
      continue
    }
    const added = Math.min(lacks, remaining)
    if (added <= 0) {
      stillShort.push({
        lineItemId: item.lineItem.id,
        label: item.lineItem.label,
        dueDate: item.lineItem.dueDate,
        shortCents: lacks,
      })
      continue
    }
    remaining -= added
    const openingCents = item.shouldHaveSavedCents + added
    assignments.push({
      lineItemId: item.lineItem.id,
      label: item.lineItem.label,
      dueDate: item.lineItem.dueDate,
      shortCents: lacks,
      addedCents: added,
      openingCents,
      fullyFunded: openingCents >= item.totalCents,
    })
  }

  return { assignments, leftoverCents: remaining, stillShort, alreadyFundedCount }
}

function addWeeks(d: CivilDate, weeks: number): CivilDate {
  const base = new Date(`${d}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + weeks * 7)
  return base.toISOString().slice(0, 10)
}

export function totalShouldHaveSaved(views: readonly AccountView[]): Cents {
  return views.reduce((s, v) => s + v.shouldHaveSavedCents, 0)
}

export { shouldHaveSaved }
