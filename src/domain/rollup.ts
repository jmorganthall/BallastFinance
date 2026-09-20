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
}): LineItemView {
  const { lineItem, pkg, today, changes } = args
  const components = componentsForLineItem({
    lineItem,
    commitDate: effectiveCommitDate(pkg, today),
    changes,
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

  return packages.map((pkg) => {
    const items = lineItems
      .filter((li) => li.packageId === pkg.id)
      .map((lineItem) => viewLineItem({ lineItem, pkg, today, changes }))

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
  const packagesById = new Map(packages.map((p) => [p.id, p]))

  return accounts.map((account) => {
    const items: LineItemView[] = []

    for (const lineItem of lineItems) {
      if (lineItem.reserveAccountId !== account.id) continue
      const pkg = packagesById.get(lineItem.packageId)
      if (!pkg || !isLive(pkg, lineItem)) continue
      items.push(viewLineItem({ lineItem, pkg, today, changes }))
    }

    const components = [
      ...items.flatMap((v) => v.components),
      ...adjustments
        .filter((a) => a.reserveAccountId === account.id)
        .map(driftAdjustmentComponent),
    ]

    return {
      account,
      weekly: weeklyBreakdown(components, today),
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

function addWeeks(d: CivilDate, weeks: number): CivilDate {
  const base = new Date(`${d}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + weeks * 7)
  return base.toISOString().slice(0, 10)
}

export function totalShouldHaveSaved(views: readonly AccountView[]): Cents {
  return views.reduce((s, v) => s + v.shouldHaveSavedCents, 0)
}

export { shouldHaveSaved }
