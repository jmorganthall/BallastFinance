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
  isComponentActive,
  shouldHaveSaved,
  shouldHaveSavedForItem,
  evenPaceCents,
  weeklyBreakdown,
  type RateComponent,
  type WeeklyBreakdown,
} from './accrual'
import { previousOccurrence } from './recurrence'
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
import { ceilingCents, placeMoney, roomCents, soonestFirst, spreadPartOf } from './spread'

export interface DerivationInput {
  today: CivilDate
  accounts: readonly ReserveAccount[]
  packages: readonly Package[]
  lineItems: readonly LineItem[]
  changes?: readonly LineItemChange[]
  driftAdjustments?: readonly DriftAdjustment[]
  /**
   * Bumps and cuts offered but not yet marked done. They never touch a live
   * figure; they only price `AccountView.pendingWeekly`, the number the
   * transfer becomes once the person does what the to-do asks.
   */
  pendingDriftAdjustments?: readonly DriftAdjustment[]
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
  /**
   * The pace: where the money would be today had it been saved evenly since
   * the part last came round (or since it was confirmed spent and started
   * over, if that was later), or since the plan started for a one-off. Set
   * aside at or above this is on track; below it is behind that pace, which
   * is why the weekly figure runs above the steady one.
   */
  paceCents: Cents
  /** When that even save would have started. */
  paceSince: CivilDate
  weekly: WeeklyBreakdown
  /** Past its due date and not yet confirmed spent -- it keeps nagging (PRD §5). */
  isOverdue: boolean
}

export interface PackageView {
  package: Package
  items: LineItemView[]
  totalCents: Cents
  shouldHaveSavedCents: Cents
  /** The parts' paces added up: where the plan's money would be by today, saved evenly. */
  paceCents: Cents
  weekly: WeeklyBreakdown
}

export interface AccountView {
  account: ReserveAccount
  /** The number to set the recurring transfer to. */
  weekly: WeeklyBreakdown
  /**
   * What `weekly` becomes once every open bump or cut for this account is
   * marked done, or null when nothing is waiting. Shown next to the to-do so
   * "add $18.54 a week" and "set the transfer to $240" are one instruction,
   * not two; it moves nothing until the person confirms.
   */
  pendingWeekly: WeeklyBreakdown | null
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

/**
 * When a part's pace clock started. A part that repeats is measured from
 * the last time it came round -- the whole point of "should have been saving
 * since" -- or from the day it was actually confirmed spent and started over,
 * when that came later, so a spend confirmed a few days late does not read
 * as a cycle behind. A one-off is measured from the day it existed in a live
 * plan: the commit, or the day it was added to one. A check-in count only
 * restates what was already there and never moves the clock.
 */
function paceWindowStart(args: {
  lineItem: LineItem
  pkg: Package
  cycles: readonly LineItemCycle[]
  today: CivilDate
}): CivilDate {
  const mine = args.cycles.filter(
    (c) => c.lineItemId === args.lineItem.id && compareDates(c.startDate, args.today) <= 0,
  )
  const last = previousOccurrence(args.lineItem.dueDate, args.lineItem.recurrence)
  if (last) {
    const rolled = mine
      .filter((c) => c.origin === 'rolled')
      .map((c) => c.startDate)
      .sort()
      .at(-1)
    return rolled && compareDates(rolled, last) > 0 ? rolled : last
  }
  const commit = effectiveCommitDate(args.pkg, args.today)
  const added = mine
    .filter((c) => c.origin === 'added')
    .map((c) => c.startDate)
    .sort()[0]
  return added && compareDates(added, commit) > 0 ? added : commit
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
  const paceSince = paceWindowStart({ lineItem, pkg, cycles: args.cycles, today })
  const paceCents = evenPaceCents({ totalCents, fromDate: paceSince, dueDate: lineItem.dueDate, today })

  return {
    lineItem,
    components,
    totalCents,
    shouldHaveSavedCents,
    remainingCents: Math.max(0, totalCents - shouldHaveSavedCents),
    paceCents,
    paceSince,
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
      paceCents: live.reduce((s, v) => s + v.paceCents, 0),
      weekly: weeklyBreakdown(components, today),
    }
  })
}

export function accountViews(input: DerivationInput): AccountView[] {
  const { today, accounts, packages, lineItems } = input
  const changes = input.changes ?? []
  const adjustments = input.driftAdjustments ?? []
  const pendingAdjustments = input.pendingDriftAdjustments ?? []
  const cycles = input.cycleStarts ?? []
  const packagesById = new Map(packages.map((p) => [p.id, p]))
  const roundUp = input.transferRoundUpCents ?? 0

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

    // Priced separately and never merged into `components`: an open ask must
    // not move the live number, the should-hold figure, or a check-in's drift.
    const pending = pendingAdjustments
      .filter((a) => a.reserveAccountId === account.id)
      .map(driftAdjustmentComponent)
      .filter((c) => isComponentActive(c, today))

    return {
      account,
      weekly: weeklyBreakdown(components, today, roundUp),
      pendingWeekly:
        pending.length > 0 ? weeklyBreakdown([...components, ...pending], today, roundUp) : null,
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

/**
 * Where an account stands at a check-in: the confirmed balance against what
 * the plan says should be there, net of what is already on the way (D18).
 * A bump running or waiting, a cut, or an open one-time move will change the
 * balance without anyone being asked again, so the gap this reports is only
 * what nothing yet covers.
 */
export interface Drift {
  accountId: Id
  expectedCents: Cents
  confirmedCents: Cents
  /** What open bumps, cuts and one-time moves will still deliver after the balance date. */
  committedCents: Cents
  /** Negative = behind pace, positive = ahead, after `committedCents` is counted. */
  driftCents: Cents
}

export function computeDrift(args: {
  account: AccountView
  confirmedCents: Cents
  /** From `committedAfter`. Absent means nothing is on the way. */
  committedCents?: Cents
}): Drift {
  const committedCents = args.committedCents ?? 0
  return {
    accountId: args.account.account.id,
    expectedCents: args.account.shouldHaveSavedCents,
    confirmedCents: args.confirmedCents,
    committedCents,
    driftCents: args.confirmedCents - args.account.shouldHaveSavedCents + committedCents,
  }
}

/**
 * Catch-up options offered when a check-in finds the account behind (PRD §5).
 *
 * The shortfall arrives net of everything already on the way, including any
 * bump or one-time move still waiting on the to-do list. Accepting an option
 * of the same kind as a waiting ask REPLACES that ask (D18), so the option is
 * sized to cover the waiting one's amount as well as the extra -- otherwise
 * replacing "$18.54 a week" with "$6.46 a week" would lose the difference.
 * `replacesCents` says how much of the option is the ask it stands in for.
 */
export interface CatchUpOption {
  kind: 'one_time' | 'rate_bump'
  amountCents: Cents
  perWeekCents?: Cents
  weeks?: number
  endDate?: CivilDate
  /** The waiting ask of this kind that accepting this one replaces; zero when none. */
  replacesCents: Cents
}

export function catchUpOptions(args: {
  shortfallCents: Cents
  today: CivilDate
  overWeeks: number
  /** A bump still waiting on the to-do list, at its full amount. */
  pendingBumpCents?: Cents
  /** A one-time catch-up move still waiting, at its full amount. */
  pendingMoveCents?: Cents
}): CatchUpOption[] {
  const { shortfallCents, overWeeks } = args
  if (shortfallCents <= 0) return []
  const pendingBumpCents = Math.max(0, args.pendingBumpCents ?? 0)
  const pendingMoveCents = Math.max(0, args.pendingMoveCents ?? 0)
  const weeks = Math.max(1, overWeeks)
  const bumpCents = shortfallCents + pendingBumpCents
  const perWeekCents = Math.ceil(bumpCents / weeks)
  const endDate = addWeeks(args.today, weeks)
  return [
    { kind: 'one_time', amountCents: shortfallCents + pendingMoveCents, replacesCents: pendingMoveCents },
    {
      kind: 'rate_bump',
      amountCents: bumpCents,
      perWeekCents,
      weeks,
      endDate,
      replacesCents: pendingBumpCents,
    },
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
  /** The waiting ask of this kind that accepting this one replaces (D18); zero when none. */
  replacesCents: Cents
}

export function aheadOptions(args: {
  extraCents: Cents
  /** The account's current weekly set-aside. A cut can never take more than this. */
  weeklyCents: Cents
  today: CivilDate
  overWeeks: number
  /** The longest a pause is ever offered for. */
  maxWeeks?: number
  /** A cut still waiting on the to-do list, at its full (positive) amount. */
  pendingCutCents?: Cents
  /** A move-out still waiting on the to-do list, at its full (positive) amount. */
  pendingMoveOutCents?: Cents
}): AheadOption[] {
  const { extraCents, weeklyCents } = args
  if (extraCents <= 0) return []
  const pendingCutCents = Math.max(0, args.pendingCutCents ?? 0)
  const pendingMoveOutCents = Math.max(0, args.pendingMoveOutCents ?? 0)

  const options: AheadOption[] = [
    {
      kind: 'one_time_out',
      amountCents: extraCents + pendingMoveOutCents,
      replacesCents: pendingMoveOutCents,
    },
  ]
  // Nothing is being set aside, so there is nothing to ease off.
  if (weeklyCents <= 0) return options

  // A cut that replaces a waiting cut covers what that one was going to take
  // off as well, since the waiting one disappears once this is accepted.
  const toCut = extraCents + pendingCutCents
  const overWeeks = Math.max(1, args.overWeeks)
  const maxWeeks = Math.max(overWeeks, args.maxWeeks ?? 52)

  let perWeekCents: Cents
  let weeks: number
  if (toCut <= weeklyCents * overWeeks) {
    // A trim over the usual window. Rounded DOWN, the opposite of an accrual:
    // an under-cut leaves the account a few cents ahead, an over-cut would
    // leave it behind, and the household rule is to err on having more.
    weeks = overWeeks
    perWeekCents = Math.floor(toCut / weeks)
  } else {
    // More extra than the window can absorb: pause the set-aside entirely for
    // as many whole weeks as the extra covers, up to a limit. Whole weeks
    // only, so a pause is a real pause and never a transfer of a few cents.
    weeks = Math.min(maxWeeks, Math.floor(toCut / weeklyCents))
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
    leftoverCents: toCut - amountCents,
    replacesCents: pendingCutCents,
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
  /** True when this brings it to where an even save would have it by today. */
  atPace: boolean
}

export interface ExtraAssignment {
  assignments: OpeningAssignment[]
  /**
   * What no part here should count: more than the one-offs can take and
   * above pace on everything that comes round again. Counted early it would
   * lower the weekly figure now only to raise it later, so it stays in the
   * account as extra (see `spread.ts`).
   */
  leftoverCents: Cents
  /**
   * Parts that could take more but got none, because the extra ran out
   * before their turn. Named so the screen can say the list is not "the top
   * few" -- it is everything the extra could reach, soonest first.
   */
  stillShort: { lineItemId: Id; label: string; dueDate: CivilDate; shortCents: Cents }[]
  /** Parts with nothing to count toward: fully funded, or already at pace and repeating. Never listed. */
  nothingToAddCount: number
}

/**
 * Count an extra found at a check-in toward the account's parts, by the one
 * rule in `spread.ts`, starting from what each part already holds so it only
 * ever adds.
 */
export function assignExtraToPlans(args: {
  extraCents: Cents
  items: readonly Pick<LineItemView, 'lineItem' | 'totalCents' | 'shouldHaveSavedCents' | 'paceCents'>[]
}): ExtraAssignment {
  const parts = args.items.map((v) => spreadPartOf(v, v.shouldHaveSavedCents))
  const { holdingsById, uncountedCents } = placeMoney(parts, args.extraCents)

  const assignments: OpeningAssignment[] = []
  const stillShort: ExtraAssignment['stillShort'] = []
  let nothingToAddCount = 0

  for (const part of [...parts].sort(soonestFirst)) {
    const room = roomCents(part)
    if (room <= 0) {
      nothingToAddCount += 1
      continue
    }
    const openingCents = holdingsById.get(part.id) ?? part.heldCents
    const added = openingCents - part.heldCents
    if (added <= 0) {
      stillShort.push({ lineItemId: part.id, label: part.label, dueDate: part.dueDate, shortCents: room })
      continue
    }
    assignments.push({
      lineItemId: part.id,
      label: part.label,
      dueDate: part.dueDate,
      shortCents: room,
      addedCents: added,
      openingCents,
      fullyFunded: openingCents >= part.totalCents,
      atPace: openingCents >= ceilingCents({ ...part, oneOff: false }),
    })
  }

  return { assignments, leftoverCents: uncountedCents, stillShort, nothingToAddCount }
}

function addWeeks(d: CivilDate, weeks: number): CivilDate {
  const base = new Date(`${d}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + weeks * 7)
  return base.toISOString().slice(0, 10)
}

export function totalShouldHaveSaved(views: readonly AccountView[]): Cents {
  return views.reduce((s, v) => s + v.shouldHaveSavedCents, 0)
}

export type ProgressStatus = 'funded' | 'on_track' | 'behind'

export interface Progress {
  status: ProgressStatus
  /** How full the bar is: set aside as a whole-number share of the total. */
  fillPercent: number
  /** Where the pace tick sits, likewise. */
  pacePercent: number
  /** How far short of the pace, when behind; else zero. */
  behindByCents: Cents
}

/**
 * The progress bar's one reading (PRD §9): set aside against the pace and
 * the total. Fully funded when nothing more is to be set aside; on track at
 * or above the pace; behind below it. The screen draws what this says and
 * works nothing out for itself.
 */
export function progressOf(v: {
  totalCents: Cents
  shouldHaveSavedCents: Cents
  paceCents: Cents
}): Progress {
  const total = Math.max(0, v.totalCents)
  const held = Math.max(0, Math.min(v.shouldHaveSavedCents, total))
  const pace = Math.max(0, Math.min(v.paceCents, total))
  const percent = (cents: Cents) => (total === 0 ? 100 : Math.round((cents / total) * 100))
  const status: ProgressStatus = held >= total ? 'funded' : held >= pace ? 'on_track' : 'behind'
  return {
    status,
    fillPercent: percent(held),
    pacePercent: percent(pace),
    behindByCents: status === 'behind' ? pace - held : 0,
  }
}

export { shouldHaveSaved }
