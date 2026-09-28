/**
 * The one position (PRD §5, D35). Every money figure a screen, the digest or a
 * to-do shows comes from here, per household and date; nothing else derives a
 * figure it shows.
 *
 * It exists because Ballast once had two ideas of "behind": a plan card
 * measured a part against an even save since it last came round, while the
 * account measured its balance against components that restarted at every
 * count. Each was right by its own rule, so one screen could say "on track"
 * while another said "$311.33 behind". The fix is not a third rule but one
 * question, asked of each account:
 *
 *     Run forward on the transfer actually set up at the bank, does this
 *     account ever run dry when something is due?
 *
 * Money may cover one plan early and another late; what matters is that it is
 * there on the day. Everything else is read off that one run.
 *
 * STEP 1, money today (B0). The last count, plus each transfer day's transfer
 * since it (at the transfer in force that day), plus moves marked done since
 * (D34), minus spends confirmed since. The first transfer ever confirmed for
 * an account is taken as running since that count. An account never counted
 * starts from the openings stated when its plans were committed, as of the
 * latest such commit, or at $0 on its first commit. The engine decides which
 * events came after the count (that is a question of recorded order); this
 * module only sums.
 *
 * STEP 2, what goes out. Every live part at its next due date -- today when it
 * is overdue and not yet confirmed spent, because it is still owed -- and a
 * repeating part again at each later occurrence, up to the horizon H: the
 * furthest next due date among the account's parts.
 *
 * STEP 3, what must be there. At each due date t, everything due by t:
 * Need(t). At H also the steady share of the cycle each repeating part is in
 * on that day, so a level transfer just big enough to reach H does not leave
 * the next cycle short.
 *
 * STEP 4, the weekly amount. W is the smallest level weekly transfer that
 * meets every Need from money today, and never below the steady run-rate of
 * the repeating parts:
 *
 *     W = max( Σ total_p ÷ transfers per cycle_p ,
 *              max over n(t) > NEAR_TRANSFERS of (Need(t) − B0 − M) ÷ n(t) )
 *
 * where n(t) is the number of transfer days after today up to and including
 * t. A due date NEAR_TRANSFERS transfers away or fewer never sets W: whatever
 * W cannot cover there is a one-time move M, the smallest with which every
 * date passes. That is what keeps the transfer from spiking for a few weeks
 * and dropping back. W is rounded up to the household's step; M is not.
 *
 * STEP 5, the account's status, judged on the transfer actually set up at the
 * bank and never on a to-do not yet done: Short if some date fails (with the
 * first such date and the amount), otherwise On track. Extra is what could
 * leave the account today with every date still passing. An account whose
 * transfer has never been confirmed has no status yet ("unconfirmed"); its
 * figures are shown as they would be at W.
 *
 * STEP 6, the to-dos it derives: set the transfer (to confirm it the first
 * time, to raise it when the account is Short without it, or to lower it once
 * the saving is a whole step), and a one-time move when one is needed. They
 * are derived here, not issued ahead of time.
 *
 * STEP 7, the parts. Each has a steady line from its Saving since date to its
 * due date at total ÷ the transfers between; its slope is the part's steady
 * share per week and its height today is "saved for this". The account's
 * money is counted to its parts on every read -- first every part up to its
 * steady line, soonest due first, then every part up to its total, soonest
 * due first -- and never recorded. A part is On track at or above its steady
 * line, Catching up below it, and Short when its account is Short on or
 * before the part is due.
 *
 * STEP 8, plans and the household. A plan adds up its parts and takes its
 * worst part's status. The household is All caught up when every account with
 * a plan is On track on its confirmed transfer, which means no to-do the
 * run-forward depends on is open.
 *
 * Pure: no I/O, `today` is a parameter, and the transfer day is the
 * household's (D31).
 */

import { componentDeliveredBetween, driftAdjustmentComponent, evenPaceCents } from './accrual'
import {
  accrualWeeksBetween,
  addDays,
  compareDates,
  DEFAULT_TRANSFER_WEEKDAY,
  maxDate,
  nextTransferDay,
  transferWeeksBetween,
  type CivilDate,
  type Weekday,
} from './dates'
import { ceilDiv, formatCents, roundUpToStep, type Cents } from './money'
import { isRecurring, nextOccurrence, previousOccurrence } from './recurrence'
import {
  lineItemTotalCents,
  type DriftAdjustment,
  type Id,
  type LineItem,
  type LineItemCycle,
  type Package,
  type ReserveAccount,
} from './types'

/**
 * A due date this many transfers away or fewer never sets the weekly amount;
 * what level transfers cannot cover there is a one-time move (D35).
 */
export const NEAR_TRANSFERS = 4

/**
 * The most occurrences of one part the run-forward will generate. A part due
 * every day for forty years is 14,600; anything past this is a typo, and the
 * bound stops a bad input becoming a hang.
 */
const MAX_OCCURRENCES = 20_000

// ---------------------------------------------------------------- inputs

/** A count of an account: what it held on a day (`balance_confirmed`). */
export interface AccountCount {
  accountId: Id
  amountCents: Cents
  on: CivilDate
}

/** The recurring transfer a person said is set up at the bank, from the day they said so. */
export interface ConfirmedTransfer {
  accountId: Id
  perWeekCents: Cents
  confirmedOn: CivilDate
}

/** A signed amount that moved in or out of an account since its last count. */
export interface AccountMovement {
  accountId: Id
  /** Into the account positive, out of it negative. */
  amountCents: Cents
}

export interface PositionInput {
  today: CivilDate
  accounts: readonly ReserveAccount[]
  packages: readonly Package[]
  lineItems: readonly LineItem[]
  /** Cycle starts per part: commit openings, adds, rolls. Counts restating a part are ignored. */
  cycleStarts?: readonly LineItemCycle[]
  /** Each account's latest count, if it has one. */
  counts?: readonly AccountCount[]
  /** Every confirmed "set the transfer" for every account, oldest first. */
  transfers?: readonly ConfirmedTransfer[]
  /** Bumps and cuts confirmed before D35 (shortened if stopped). They still run until they end. */
  adjustments?: readonly DriftAdjustment[]
  /** One-time moves marked done since each account's last count (D34), signed. */
  movesSinceCount?: readonly AccountMovement[]
  /** Spends confirmed since each account's last count, as money out (positive amounts). */
  spendsSinceCount?: readonly AccountMovement[]
  /**
   * Catch-up moves into an account still open on the to-do list from before
   * D35. They count against the one-time move this derives, so the same
   * money is never asked for twice.
   */
  openMovesIn?: readonly AccountMovement[]
  /** The household's step the bank figure is rounded up to; zero for exact. */
  transferRoundUpCents?: Cents
  /** The day the recurring transfer runs (D31). Absent is the default, for pure tests. */
  transferWeekday?: Weekday
}

// ---------------------------------------------------------------- outputs

/** The three words, everywhere (D35). */
export type PartStatus = 'on_track' | 'catching_up' | 'short'
/** An account is fine or it is not; "unconfirmed" until its transfer is known. */
export type AccountStatus = 'on_track' | 'short' | 'unconfirmed'

/** Why a part's steady line starts where it does, for the words on screen. */
export type SteadySinceReason = 'last_occurrence' | 'plan_started' | 'added' | 'typed' | 'spent'

export interface PartPosition {
  lineItem: LineItem
  packageId: Id
  accountId: Id
  totalCents: Cents
  /** When it goes out: its due date, or today when it is overdue and still owed. */
  outflowDate: CivilDate
  isOverdue: boolean
  /** The day its steady line starts, and why. What the screen calls "Saving since". */
  savingSince: { date: CivilDate; reason: SteadySinceReason }
  /** The slope of the steady line: its share of the transfer, rounded up. */
  steadyPerWeekCents: Cents
  /** The height of the steady line today: "saved for this". */
  savedForCents: Cents
  /** What the account's money counts toward it today. */
  countedCents: Cents
  /**
   * Below its steady line, the gap in two: what the account's money is
   * holding for plans due sooner (at most what those plans count), and what
   * is simply not in the account yet. Both zero unless catching up.
   */
  coveringSoonerCents: Cents
  notYetHereCents: Cents
  status: PartStatus
}

export interface AccountMoneyToday {
  /** Where the figure starts: a count, the openings stated at commit, or nothing. */
  from: 'count' | 'openings' | 'nothing'
  /** The day it starts from. Null only when there is nothing to start from at all. */
  on: CivilDate | null
  startCents: Cents
  transfersSinceCents: Cents
  movesSinceCents: Cents
  spendsSinceCents: Cents
  /** The likely balance: start + transfers + moves − spends. */
  totalCents: Cents
}

export interface BankTransfer {
  /** The recurring transfer as last confirmed. */
  perWeekCents: Cents
  confirmedOn: CivilDate
  /** What moves on the next transfer day still to come, with any running bump or cut from before D35. */
  nextWeekCents: Cents
}

export interface AccountShort {
  /** The first due date the money is not there. */
  on: CivilDate
  /** How much is missing that day. */
  byCents: Cents
}

export type TransferChangeReason = 'confirm' | 'raise' | 'lower'

export interface AccountPosition {
  account: ReserveAccount
  /** Every live part in the account, soonest due first. */
  parts: PartPosition[]
  money: AccountMoneyToday
  /** The furthest next due date: how far the run-forward looks. Null with no parts. */
  horizon: CivilDate | null
  /** The parts' steady shares added up. */
  steadyPerWeekCents: Cents
  /**
   * How far the exact weekly amount is from the steady shares: positive when
   * the account is catching up, negative when money already held covers
   * some of the steady shares. The decomposition a screen shows (D2).
   */
  catchUpPerWeekCents: Cents
  /** How many parts are catching up. */
  catchingUpParts: number
  /** The smallest level weekly amount that keeps the account afloat, exact. */
  weeklyExactCents: Cents
  /** That, rounded up to the household's step: the transfer Ballast asks for. */
  weeklyCents: Cents
  /**
   * What the account needs a week, as its card says it: the ask when it is
   * not fine; when it is, the least it can run on with nothing else asked
   * (never more than the bank already moves). With the exact figure beside
   * it and the steady / catching-up split of that same figure.
   */
  neededPerWeekCents: Cents
  neededExactPerWeekCents: Cents
  /** A one-time move level transfers cannot make in time, net of open catch-up moves. */
  oneTimeMove: { amountCents: Cents; byDate: CivilDate } | null
  /** What is set up at the bank, or null when nobody has confirmed it yet. */
  bank: BankTransfer | null
  status: AccountStatus
  short: AccountShort | null
  /** What could leave the account today with every date still passing. */
  extraCents: Cents
  /** A change to the transfer this account asks for, or null. */
  transferChange: { fromCents: Cents | null; toCents: Cents; reason: TransferChangeReason } | null
}

export interface PlanPosition {
  package: Package
  /** Its live parts, soonest due first. */
  parts: PartPosition[]
  totalCents: Cents
  steadyPerWeekCents: Cents
  savedForCents: Cents
  countedCents: Cents
  coveringSoonerCents: Cents
  notYetHereCents: Cents
  /** The earliest day any live part's steady line starts: the plan's "Saving since". */
  savingSince: CivilDate | null
  /** Its worst part's status; on track with no live part. */
  status: PartStatus
}

/** A to-do the position derives, never issued ahead of time. */
export type DerivedTodo =
  | {
      kind: 'set_transfer'
      accountId: Id
      accountName: string
      fromCents: Cents | null
      toCents: Cents
      reason: TransferChangeReason
      /** True when the run-forward needs it done: every reason but lowering. */
      blocking: boolean
    }
  | {
      kind: 'move_in'
      accountId: Id
      accountName: string
      amountCents: Cents
      byDate: CivilDate
      blocking: true
    }

export interface HouseholdPosition {
  today: CivilDate
  accounts: AccountPosition[]
  plans: PlanPosition[]
  todos: DerivedTodo[]
  /** Every account with a plan is On track on its confirmed transfer. */
  allCaughtUp: boolean
  /** The furthest horizon: "every account covers everything due through <date>". */
  coveredThrough: CivilDate | null
  /** What the bank moves on the next transfer day, where it is known. */
  bankPerWeekCents: Cents
  /** What Ballast asks the transfers to be. */
  weeklyPerWeekCents: Cents
}

// ---------------------------------------------------------------- the parts

const isLive = (pkg: Package | undefined, item: LineItem) =>
  pkg !== undefined && pkg.state === 'active' && item.state !== 'retired'

/** The latest cycle start of one origin on or before today, for one part. */
function latestStart(
  cycles: readonly LineItemCycle[],
  lineItemId: Id,
  origin: LineItemCycle['origin'],
  today: CivilDate,
): CivilDate | null {
  let latest: CivilDate | null = null
  for (const c of cycles) {
    if (c.lineItemId !== lineItemId || c.origin !== origin) continue
    if (compareDates(c.startDate, today) > 0) continue
    if (latest === null || compareDates(c.startDate, latest) > 0) latest = c.startDate
  }
  return latest
}

/**
 * Where a part's steady line starts (D33 as amended by D35). The person's
 * choice decides: the last time it came round, the day the plan started (or
 * the part was added to it), or a day typed. After a spend the new cycle
 * starts on the spend date, whatever the choice, since that is when it last
 * came round. A count, a reshuffle or an opening never moves it: money
 * placed on a part says nothing about when saving for it began.
 */
export function steadyLineStart(args: {
  lineItem: LineItem
  pkg: Package
  cycles: readonly LineItemCycle[]
  today: CivilDate
}): { date: CivilDate; reason: SteadySinceReason } {
  const { lineItem, pkg, cycles, today } = args
  const added = latestStart(cycles, lineItem.id, 'added', today)
  const commit = pkg.committedAt ?? today
  const started =
    added && compareDates(added, commit) > 0
      ? { date: added, reason: 'added' as const }
      : { date: commit, reason: 'plan_started' as const }

  let chosen: { date: CivilDate; reason: SteadySinceReason } = started
  if (isRecurring(lineItem.recurrence)) {
    if (
      lineItem.timelineStart === 'typed' &&
      lineItem.timelineStartDate &&
      compareDates(lineItem.timelineStartDate, lineItem.dueDate) < 0
    ) {
      chosen = { date: lineItem.timelineStartDate, reason: 'typed' }
    } else if (lineItem.timelineStart !== 'commit') {
      const last = previousOccurrence(lineItem.dueDate, lineItem.recurrence)
      if (last) chosen = { date: last, reason: 'last_occurrence' }
    }
  }

  const rolled = latestStart(cycles, lineItem.id, 'rolled', today)
  if (rolled && compareDates(rolled, chosen.date) > 0) return { date: rolled, reason: 'spent' }
  return chosen
}

interface PartFrame {
  lineItem: LineItem
  packageId: Id
  accountId: Id
  totalCents: Cents
  outflowDate: CivilDate
  isOverdue: boolean
  savingSince: { date: CivilDate; reason: SteadySinceReason }
  steadyPerWeekCents: Cents
  savedForCents: Cents
}

function frameOf(args: {
  lineItem: LineItem
  pkg: Package
  cycles: readonly LineItemCycle[]
  today: CivilDate
  transferWeekday: Weekday
}): PartFrame {
  const { lineItem, pkg, today, transferWeekday } = args
  const totalCents = lineItemTotalCents(lineItem)
  const isOverdue = compareDates(lineItem.dueDate, today) < 0
  const savingSince = steadyLineStart(args)
  const from =
    compareDates(savingSince.date, lineItem.dueDate) < 0 ? savingSince.date : lineItem.dueDate
  return {
    lineItem,
    packageId: pkg.id,
    accountId: lineItem.reserveAccountId,
    totalCents,
    outflowDate: isOverdue ? today : lineItem.dueDate,
    isOverdue,
    savingSince,
    steadyPerWeekCents: ceilDiv(
      Math.max(0, totalCents),
      accrualWeeksBetween(from, lineItem.dueDate, transferWeekday),
    ),
    savedForCents: evenPaceCents({
      totalCents,
      fromDate: from,
      dueDate: lineItem.dueDate,
      today,
      transferWeekday,
    }),
  }
}

/**
 * Count an account's money toward its parts (D35): every part up to its
 * steady line, soonest due first, then every part up to its total, soonest
 * due first. Never recorded and never chosen; it only decides what each part
 * card shows, because the weekly amount comes from the run-forward.
 */
export function countTowardParts(
  parts: readonly Pick<PartFrame, 'lineItem' | 'outflowDate' | 'totalCents' | 'savedForCents'>[],
  moneyCents: Cents,
): Map<Id, Cents> {
  const ordered = [...parts].sort(
    (a, b) =>
      compareDates(a.outflowDate, b.outflowDate) || a.lineItem.label.localeCompare(b.lineItem.label),
  )
  const counted = new Map<Id, Cents>(ordered.map((p) => [p.lineItem.id, 0]))
  let left = Math.max(0, moneyCents)
  for (const ceiling of [
    (p: (typeof ordered)[number]) => Math.min(p.savedForCents, p.totalCents),
    (p: (typeof ordered)[number]) => p.totalCents,
  ]) {
    for (const p of ordered) {
      if (left <= 0) break
      const has = counted.get(p.lineItem.id) ?? 0
      const take = Math.max(0, Math.min(ceiling(p) - has, left))
      counted.set(p.lineItem.id, has + take)
      left -= take
    }
  }
  return counted
}

// ---------------------------------------------------------------- the run-forward

/** One date the account must hold a figure by: everything due by then. */
interface Requirement {
  on: CivilDate
  /** Transfer days after today up to and including this date. */
  transfers: number
  needCents: Cents
}

/**
 * Every outflow the account will see up to the horizon, and what it must
 * hold on each such date (Steps 2 and 3). Also the steady run-rate of the
 * repeating parts, which W never goes below.
 */
export function requirementsFor(args: {
  parts: readonly Pick<PartFrame, 'lineItem' | 'outflowDate' | 'totalCents'>[]
  today: CivilDate
  transferWeekday: Weekday
  /**
   * Run further than the horizon, to this day, with no steady shares added
   * at the end: only what goes out. How the status finds the day a transfer
   * below the run-rate would run the account dry (Step 5).
   */
  until?: CivilDate
}): { horizon: CivilDate | null; requirements: Requirement[]; runRatePerWeekCents: Cents } {
  const { parts, today, transferWeekday } = args
  if (parts.length === 0) return { horizon: null, requirements: [], runRatePerWeekCents: 0 }

  const horizon = parts.reduce<CivilDate>((h, p) => maxDate(h, p.outflowDate), parts[0]!.outflowDate)
  const runTo = args.until ?? horizon

  const outflows = new Map<CivilDate, Cents>()
  const add = (on: CivilDate, cents: Cents) => outflows.set(on, (outflows.get(on) ?? 0) + cents)
  let terminalCents = 0
  let runRatePerWeekCents = 0

  for (const p of parts) {
    add(p.outflowDate, p.totalCents)
    const recurrence = p.lineItem.recurrence
    if (!isRecurring(recurrence)) continue

    // Later occurrences come round from the due date as written, the same
    // way a spend rolls it forward, whether or not the first is overdue.
    let occurrence = p.lineItem.dueDate
    let next = nextOccurrence(occurrence, recurrence)
    for (let guard = 0; next && guard < MAX_OCCURRENCES; guard += 1) {
      if (compareDates(next, occurrence) <= 0) break
      if (compareDates(next, runTo) > 0) break
      occurrence = next
      add(compareDates(occurrence, today) < 0 ? today : occurrence, p.totalCents)
      next = nextOccurrence(occurrence, recurrence)
    }
    if (!next) continue

    // At the horizon the part is part-way into a cycle that runs from its
    // last occurrence on or before H to its next one after: that share must
    // be there too, or the level transfer would run the next cycle short.
    const cycleStart = previousOccurrence(next, recurrence) ?? occurrence
    if (!args.until) {
      terminalCents += evenPaceCents({
        totalCents: p.totalCents,
        fromDate: cycleStart,
        dueDate: next,
        today: horizon,
        transferWeekday,
      })
    }
    runRatePerWeekCents += ceilDiv(
      Math.max(0, p.totalCents),
      accrualWeeksBetween(cycleStart, next, transferWeekday),
    )
  }

  const requirements: Requirement[] = []
  let needCents = 0
  for (const on of [...outflows.keys()].sort(compareDates)) {
    needCents += outflows.get(on) ?? 0
    requirements.push({ on, transfers: transferWeeksBetween(today, on, transferWeekday), needCents })
  }
  const last = requirements.at(-1)
  if (last) last.needCents += terminalCents
  return { horizon, requirements, runRatePerWeekCents }
}

/**
 * The smallest level weekly amount, and the one-time move with it (Step 4).
 *
 * W is the larger of the run-rate and what each far date needs spread over
 * the transfers before it. A near date never sets W; M is the smallest move
 * with which every near date passes at the W that move leaves. Raising M
 * lowers the far ratios by less than it lowers a near date's need (a near
 * date has fewer transfers than any far one), so "every near date passes"
 * only ever gets truer as M grows, and a binary search finds the smallest.
 * The search is in real numbers so it is exact about that; the weekly amount
 * is then rounded up to whole cents, which only adds money.
 */
export function levelWeekly(args: {
  moneyCents: Cents
  requirements: readonly Requirement[]
  runRatePerWeekCents: Cents
}): { weeklyExactCents: Cents; moveCents: Cents; moveBy: CivilDate | null } {
  const { moneyCents, requirements, runRatePerWeekCents } = args
  const far = requirements.filter((r) => r.transfers > NEAR_TRANSFERS)
  const near = requirements.filter((r) => r.transfers <= NEAR_TRANSFERS)

  const weeklyAt = (move: number): number =>
    far.reduce(
      (w, r) => Math.max(w, (r.needCents - moneyCents - move) / r.transfers),
      Math.max(0, runRatePerWeekCents),
    )
  const nearPasses = (move: number): boolean => {
    const w = weeklyAt(move)
    return near.every((r) => r.needCents - moneyCents - move - w * r.transfers <= 1e-6)
  }

  let moveCents = 0
  if (!nearPasses(0)) {
    let low = 0
    let high = near.reduce((m, r) => Math.max(m, r.needCents - moneyCents), 0)
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if (nearPasses(mid)) high = mid
      else low = mid
    }
    moveCents = high
  }

  const weeklyExactCents = far.reduce(
    (w, r) => Math.max(w, ceilDiv(r.needCents - moneyCents - moveCents, r.transfers)),
    Math.max(0, runRatePerWeekCents),
  )
  // The first near date the move is for: the day it has to be there by.
  const moveBy =
    moveCents > 0
      ? (near.find((r) => r.needCents - moneyCents - weeklyExactCents * r.transfers > 0)?.on ??
        near[0]?.on ??
        null)
      : null
  return { weeklyExactCents, moveCents, moveBy }
}

/**
 * The bank's transfers: the amount in force on each transfer day, plus any
 * bump or cut confirmed before D35 while it runs. A "set the transfer"
 * confirmed later replaces the whole transfer, so an adjustment stops the
 * day one is confirmed after it began.
 */
export interface BankSchedule {
  /** Confirmations for one account, oldest first. */
  confirmations: readonly ConfirmedTransfer[]
  adjustments: readonly DriftAdjustment[]
  transferWeekday: Weekday
}

function clippedAdjustments(schedule: BankSchedule): DriftAdjustment[] {
  return schedule.adjustments.flatMap((a) => {
    const reset = schedule.confirmations.find((c) => compareDates(c.confirmedOn, a.startDate) > 0)
    if (!reset || compareDates(reset.confirmedOn, a.endDate) >= 0) return [a]
    const component = driftAdjustmentComponent(a, schedule.transferWeekday)
    const amountCents = componentDeliveredBetween(
      component,
      a.startDate,
      reset.confirmedOn,
      schedule.transferWeekday,
    )
    return amountCents === 0 ? [] : [{ ...a, endDate: reset.confirmedOn, amountCents }]
  })
}

/**
 * What the bank moves into the account on transfer days in (from, to]. The
 * first confirmation is taken as running since before it: the transfer was
 * there before anyone told Ballast its amount.
 */
export function bankTransfersBetween(schedule: BankSchedule, from: CivilDate, to: CivilDate): Cents {
  const { confirmations, transferWeekday } = schedule
  if (compareDates(to, from) <= 0) return 0
  let total = 0
  if (confirmations.length > 0) {
    // Each amount moves on the transfer days after the day it was confirmed;
    // the first also stands in for before it. A change confirmed on a
    // transfer day starts with the next one: that day's transfer had most
    // likely already run, and a confirmation never rewrites money that has
    // already moved.
    let cursor = from
    let amount = confirmations[0]!.perWeekCents
    for (const c of confirmations) {
      if (compareDates(c.confirmedOn, to) >= 0) break
      const segmentEnd = c.confirmedOn
      if (compareDates(segmentEnd, cursor) > 0) {
        total += amount * transferWeeksBetween(cursor, segmentEnd, transferWeekday)
        cursor = segmentEnd
      }
      amount = c.perWeekCents
    }
    total += amount * transferWeeksBetween(cursor, to, transferWeekday)
  }
  for (const a of clippedAdjustments(schedule)) {
    total += componentDeliveredBetween(
      driftAdjustmentComponent(a, transferWeekday),
      from,
      to,
      transferWeekday,
    )
  }
  return total
}


/**
 * Run the account forward on a transfer schedule and report the first date
 * the money is not there, and the least slack over every date: what could
 * leave today with every date still passing.
 */
function runForward(args: {
  moneyCents: Cents
  requirements: readonly Requirement[]
  arrivedBy: (r: Requirement) => Cents
}): { short: AccountShort | null; slackCents: Cents } {
  let short: AccountShort | null = null
  let slackCents = Number.POSITIVE_INFINITY
  for (const r of args.requirements) {
    const slack = args.moneyCents + args.arrivedBy(r) - r.needCents
    if (slack < 0 && short === null) short = { on: r.on, byCents: -slack }
    slackCents = Math.min(slackCents, slack)
  }
  return {
    short,
    slackCents: Number.isFinite(slackCents) ? Math.max(0, slackCents) : Math.max(0, args.moneyCents),
  }
}

/**
 * Run the account forward on the bank's transfers (Step 5). Up to the
 * horizon every due date must pass. Past it only the repeating parts go on,
 * and a transfer below their run-rate lets the account drift down there: it
 * runs dry some day even when every date up to the horizon passes, and the
 * weekly amount -- never below the run-rate -- would ask for more. So the
 * run goes on, further each time, until it finds that day (or a century
 * passes), and the status and the ask can never disagree.
 */
function judgeOnBank(args: {
  moneyCents: Cents
  requirements: readonly Requirement[]
  frames: readonly PartFrame[]
  horizon: CivilDate | null
  runRatePerWeekCents: Cents
  schedule: BankSchedule
  bankPerWeekCents: Cents
  today: CivilDate
  transferWeekday: Weekday
}): { short: AccountShort | null; slackCents: Cents } {
  const arrivedBy = (r: Requirement) => bankTransfersBetween(args.schedule, args.today, r.on)
  const judged = runForward({ moneyCents: args.moneyCents, requirements: args.requirements, arrivedBy })
  if (judged.short || !args.horizon || args.bankPerWeekCents >= args.runRatePerWeekCents) return judged
  for (const years of [2, 4, 8, 16, 32, 64, 100]) {
    const { requirements } = requirementsFor({
      parts: args.frames,
      today: args.today,
      transferWeekday: args.transferWeekday,
      until: addDays(args.horizon, Math.round(years * 365.25)),
    })
    const later = runForward({ moneyCents: args.moneyCents, requirements, arrivedBy })
    if (later.short) return { short: later.short, slackCents: 0 }
  }
  return judged
}

// ---------------------------------------------------------------- step 1

/**
 * Money today (Step 1). A count is where the figure starts; without one, the
 * openings stated when the account's plans were committed; without those,
 * $0 on the first commit. Moves and spends arrive already filtered to "since
 * the count" by the engine.
 */
export function moneyToday(args: {
  accountId: Id
  count: AccountCount | null
  /** Every part ever saved in this account, live or not: a spent part's opening is still money that was there. */
  everyPart: readonly LineItem[]
  packagesById: ReadonlyMap<Id, Package>
  cycles: readonly LineItemCycle[]
  schedule: BankSchedule
  movesSinceCount: readonly AccountMovement[]
  spendsSinceCount: readonly AccountMovement[]
  today: CivilDate
}): AccountMoneyToday {
  let from: AccountMoneyToday['from'] = 'nothing'
  let on: CivilDate | null = null
  let startCents = 0
  let laterOpeningsCents = 0

  if (args.count) {
    from = 'count'
    on = args.count.on
    startCents = args.count.amountCents
  } else {
    // Never counted: the account starts on the first day a plan in it was
    // committed, with what was said to be set aside that day. An opening
    // stated at a later commit is money put in on that day, like a move.
    // Spends are every spend since, so the parts whose openings count are
    // every part ever in the account, spent or not, or a spent part's
    // opening would vanish while its spend still came off.
    const committed = args.everyPart
      .map((li) => args.packagesById.get(li.packageId))
      .filter((pkg): pkg is Package => pkg !== undefined && pkg.state !== 'simulated' && pkg.committedAt !== null)
    on = committed.map((pkg) => pkg.committedAt!).sort(compareDates)[0] ?? null
    const ids = new Set(args.everyPart.map((li) => li.id))
    for (const c of args.cycles) {
      if (c.origin !== 'commit' || !ids.has(c.lineItemId) || c.openingCents <= 0) continue
      if (on !== null && compareDates(c.startDate, on) <= 0) startCents += c.openingCents
      else laterOpeningsCents += c.openingCents
    }
    if (startCents > 0 || laterOpeningsCents > 0) from = 'openings'
  }

  const transfersSinceCents =
    on === null ? 0 : bankTransfersBetween(args.schedule, on, args.today)
  const movesSinceCents =
    laterOpeningsCents +
    args.movesSinceCount
      .filter((m) => m.accountId === args.accountId)
      .reduce((s, m) => s + m.amountCents, 0)
  const spendsSinceCents = args.spendsSinceCount
    .filter((m) => m.accountId === args.accountId)
    .reduce((s, m) => s + m.amountCents, 0)

  return {
    from,
    on,
    startCents,
    transfersSinceCents,
    movesSinceCents,
    spendsSinceCents,
    totalCents: startCents + transfersSinceCents + movesSinceCents - spendsSinceCents,
  }
}

// ---------------------------------------------------------------- the position

const worst = (statuses: readonly PartStatus[]): PartStatus =>
  statuses.includes('short') ? 'short' : statuses.includes('catching_up') ? 'catching_up' : 'on_track'

function accountPosition(args: {
  account: ReserveAccount
  frames: readonly PartFrame[]
  input: PositionInput
  packagesById: ReadonlyMap<Id, Package>
  transferWeekday: Weekday
}): AccountPosition {
  const { account, frames, input, transferWeekday } = args
  const today = input.today
  const cycles = input.cycleStarts ?? []
  const schedule: BankSchedule = {
    confirmations: (input.transfers ?? []).filter((t) => t.accountId === account.id),
    adjustments: (input.adjustments ?? []).filter((a) => a.reserveAccountId === account.id),
    transferWeekday,
  }
  const count = (input.counts ?? []).find((c) => c.accountId === account.id) ?? null

  const money = moneyToday({
    accountId: account.id,
    count,
    everyPart: input.lineItems.filter((li) => li.reserveAccountId === account.id),
    packagesById: args.packagesById,
    cycles,
    schedule,
    movesSinceCount: input.movesSinceCount ?? [],
    spendsSinceCount: input.spendsSinceCount ?? [],
    today,
  })

  const { horizon, requirements, runRatePerWeekCents } = requirementsFor({
    parts: frames,
    today,
    transferWeekday,
  })
  const level = levelWeekly({ moneyCents: money.totalCents, requirements, runRatePerWeekCents })
  const weeklyCents = roundUpToStep(level.weeklyExactCents, input.transferRoundUpCents ?? 0)

  const latest = schedule.confirmations.at(-1) ?? null
  const bank: BankTransfer | null = latest
    ? {
        perWeekCents: latest.perWeekCents,
        confirmedOn: latest.confirmedOn,
        // The next transfer that has not run yet: a count or a confirmation
        // today already includes today's.
        nextWeekCents: (() => {
          const day = nextTransferDay(today, transferWeekday)
          return bankTransfersBetween(schedule, addDays(day, -1), day)
        })(),
      }
    : null

  // The run the status is judged on: the bank as it is set up, or -- until
  // anyone has said what that is -- the amount Ballast asks for, with the
  // move made, so the figures still read as they would.
  const onTheBank = (moneyCents: Cents) =>
    judgeOnBank({
      moneyCents,
      requirements,
      frames,
      horizon,
      runRatePerWeekCents,
      schedule,
      bankPerWeekCents: bank?.perWeekCents ?? 0,
      today,
      transferWeekday,
    })
  const judged = bank
    ? onTheBank(money.totalCents)
    : runForward({
        moneyCents: money.totalCents + level.moveCents,
        requirements,
        arrivedBy: (r) => weeklyCents * r.transfers,
      })
  const status: AccountStatus =
    frames.length === 0 && !bank ? 'on_track' : !bank ? 'unconfirmed' : judged.short ? 'short' : 'on_track'

  // A Short account always says what fixes it, and an account that is fine
  // is asked for nothing it depends on. When a one-time move alone puts it
  // right on the bank's own transfer, that is the ask, sized on that
  // transfer: the smallest move with which every date passes, due by the
  // first date that fails. Otherwise the transfer is set to what Ballast
  // asks -- which also replaces any bump or cut from before D35 still
  // running -- with the move W was worked out with, if it needs one.
  // Lowering is offered only to an account that is fine, once the saving is
  // a whole step.
  // The smallest level transfer that works with no move at all: every date
  // with a transfer before it met by the transfers, never below the
  // run-rate. It is what an account that is fine can be lowered to without
  // being asked for anything else; below it, a date in the next few weeks
  // would fail. A date before the next transfer is money-only either way.
  const withoutMoveExactCents = requirements.reduce(
    (w, r) => (r.transfers > 0 ? Math.max(w, ceilDiv(r.needCents - money.totalCents, r.transfers)) : w),
    Math.max(0, runRatePerWeekCents),
  )
  const step = input.transferRoundUpCents ?? 0
  const lowerToCents = roundUpToStep(withoutMoveExactCents, step)

  let moveNeeded: { amountCents: Cents; byDate: CivilDate } | null = null
  let transferChange: AccountPosition['transferChange'] = null
  if (!bank) {
    if (frames.length > 0) {
      transferChange = { fromCents: null, toCents: weeklyCents, reason: 'confirm' }
      // What the suggested transfer depends on is asked now too, not only
      // once the transfer is confirmed.
      if (level.moveCents > 0 && level.moveBy) {
        moveNeeded = { amountCents: level.moveCents, byDate: level.moveBy }
      }
    }
  } else if (judged.short) {
    const firstShort = judged.short
    if (level.moveCents > 0 && !onTheBank(money.totalCents + level.moveCents).short) {
      let low = 0
      let high = level.moveCents
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2)
        if (onTheBank(money.totalCents + mid).short) low = mid
        else high = mid
      }
      moveNeeded = { amountCents: high, byDate: firstShort.on }
    } else {
      transferChange = { fromCents: bank.perWeekCents, toCents: weeklyCents, reason: 'raise' }
      if (level.moveCents > 0 && level.moveBy) {
        moveNeeded = { amountCents: level.moveCents, byDate: level.moveBy }
      }
    }
  } else if (bank.perWeekCents - lowerToCents >= Math.max(1, step)) {
    transferChange = { fromCents: bank.perWeekCents, toCents: lowerToCents, reason: 'lower' }
  }

  // What the account needs a week, as the card says it: what Ballast asks
  // for an account that is not fine; for one that is, the least it can run
  // on with nothing else asked -- or the bank's own figure when that is less
  // than a step above it.
  const needed =
    bank && !judged.short
      ? { cents: Math.min(bank.perWeekCents, lowerToCents), exactCents: withoutMoveExactCents }
      : { cents: weeklyCents, exactCents: level.weeklyExactCents }

  // A catch-up move still open from before D35 counts against it, so the
  // same money is never asked for twice.
  const openIn = (input.openMovesIn ?? [])
    .filter((m) => m.accountId === account.id)
    .reduce((s, m) => s + m.amountCents, 0)
  const oneTimeMove =
    moveNeeded && moveNeeded.amountCents - openIn > 0
      ? { amountCents: moveNeeded.amountCents - openIn, byDate: moveNeeded.byDate }
      : null

  const counted = countTowardParts(frames, money.totalCents)
  let countedSooner = 0
  const parts: PartPosition[] = [...frames]
    .sort(
      (a, b) =>
        compareDates(a.outflowDate, b.outflowDate) || a.lineItem.label.localeCompare(b.lineItem.label),
    )
    .map((f) => {
      const countedCents = counted.get(f.lineItem.id) ?? 0
      const steady = Math.min(f.savedForCents, f.totalCents)
      // A part is Short when the day the account runs dry is one it still
      // needs money on: a one-off due on or after it, or a part that comes
      // round again, which goes on needing money every cycle after.
      const partStatus: PartStatus =
        status === 'short' &&
        judged.short &&
        (isRecurring(f.lineItem.recurrence) || compareDates(f.outflowDate, judged.short.on) >= 0)
          ? 'short'
          : countedCents >= steady
            ? 'on_track'
            : 'catching_up'
      const gap = Math.max(0, steady - countedCents)
      const coveringSoonerCents = Math.min(gap, countedSooner)
      countedSooner += countedCents
      return {
        ...f,
        countedCents,
        coveringSoonerCents,
        notYetHereCents: gap - coveringSoonerCents,
        status: partStatus,
      }
    })

  const steadyPerWeekCents = parts.reduce((s, p) => s + p.steadyPerWeekCents, 0)
  return {
    account,
    parts,
    money,
    horizon,
    steadyPerWeekCents,
    // Each part's steady share is rounded up on its own and counts the
    // transfers in its own year, 52 or 53 of them; a difference that small
    // is the calendar, not catching up, and reads as none.
    catchUpPerWeekCents:
      Math.abs(needed.exactCents - steadyPerWeekCents) <=
      Math.max(parts.length, Math.ceil(steadyPerWeekCents * 0.02))
        ? 0
        : needed.exactCents - steadyPerWeekCents,
    catchingUpParts: parts.filter((p) => p.status === 'catching_up').length,
    weeklyExactCents: level.weeklyExactCents,
    neededPerWeekCents: needed.cents,
    neededExactPerWeekCents: needed.exactCents,
    weeklyCents,
    oneTimeMove,
    bank,
    status,
    short: status === 'short' ? judged.short : null,
    // What could leave today: never more than is there today, and never
    // what a later date still needs once the transfers up to it are in.
    extraCents: judged.short ? 0 : Math.max(0, Math.min(money.totalCents, judged.slackCents)),
    transferChange,
  }
}


/** The position: every account run forward, every part counted, every plan and the household rolled up. */
export function position(input: PositionInput): HouseholdPosition {
  const transferWeekday = input.transferWeekday ?? DEFAULT_TRANSFER_WEEKDAY
  const today = input.today
  const cycles = input.cycleStarts ?? []
  const packagesById = new Map(input.packages.map((p) => [p.id, p]))

  const frames: PartFrame[] = []
  for (const lineItem of input.lineItems) {
    const pkg = packagesById.get(lineItem.packageId)
    if (!pkg || !isLive(pkg, lineItem)) continue
    frames.push(frameOf({ lineItem, pkg, cycles, today, transferWeekday }))
  }

  const accounts = input.accounts.map((account) =>
    accountPosition({
      account,
      frames: frames.filter((f) => f.accountId === account.id),
      input,
      packagesById,
      transferWeekday,
    }),
  )

  const partsById = new Map(accounts.flatMap((a) => a.parts.map((p) => [p.lineItem.id, p] as const)))
  const plans: PlanPosition[] = input.packages
    .filter((p) => p.state === 'active')
    .map((pkg) => {
      const parts = input.lineItems
        .map((li) => partsById.get(li.id))
        .filter((p): p is PartPosition => p !== undefined && p.packageId === pkg.id)
        .sort(
          (a, b) =>
            compareDates(a.outflowDate, b.outflowDate) ||
            a.lineItem.label.localeCompare(b.lineItem.label),
        )
      return {
        package: pkg,
        parts,
        totalCents: parts.reduce((s, p) => s + p.totalCents, 0),
        steadyPerWeekCents: parts.reduce((s, p) => s + p.steadyPerWeekCents, 0),
        savedForCents: parts.reduce((s, p) => s + p.savedForCents, 0),
        countedCents: parts.reduce((s, p) => s + p.countedCents, 0),
        coveringSoonerCents: parts.reduce((s, p) => s + p.coveringSoonerCents, 0),
        notYetHereCents: parts.reduce((s, p) => s + p.notYetHereCents, 0),
        savingSince: parts.reduce<CivilDate | null>(
          (d, p) => (d === null || compareDates(p.savingSince.date, d) < 0 ? p.savingSince.date : d),
          null,
        ),
        status: worst(parts.map((p) => p.status)),
      }
    })

  const todos: DerivedTodo[] = []
  for (const a of accounts) {
    if (a.transferChange) {
      todos.push({
        kind: 'set_transfer',
        accountId: a.account.id,
        accountName: a.account.name,
        fromCents: a.transferChange.fromCents,
        toCents: a.transferChange.toCents,
        reason: a.transferChange.reason,
        blocking: a.transferChange.reason !== 'lower',
      })
    }
    if (a.oneTimeMove) {
      todos.push({
        kind: 'move_in',
        accountId: a.account.id,
        accountName: a.account.name,
        amountCents: a.oneTimeMove.amountCents,
        byDate: a.oneTimeMove.byDate,
        blocking: true,
      })
    }
  }

  const withPlans = accounts.filter((a) => a.parts.length > 0)
  const coveredThrough = withPlans.reduce<CivilDate | null>(
    (d, a) => (a.horizon && (d === null || compareDates(a.horizon, d) > 0) ? a.horizon : d),
    null,
  )

  return {
    today,
    accounts,
    plans,
    todos,
    allCaughtUp:
      withPlans.every((a) => a.status === 'on_track') && !todos.some((t) => t.blocking),
    coveredThrough,
    bankPerWeekCents: accounts.reduce((s, a) => s + (a.bank?.nextWeekCents ?? 0), 0),
    weeklyPerWeekCents: accounts.reduce((s, a) => s + a.weeklyCents, 0),
  }
}

// ---------------------------------------------------------------- what a screen draws

/**
 * The progress bar's reading, so a screen draws and works nothing out: how
 * full the bar is (what is counted, as a whole-number share of the total)
 * and where the tick sits (the steady line today). Both capped at 100.
 */
export function barOf(v: { totalCents: Cents; countedCents: Cents; savedForCents: Cents }): {
  fillPercent: number
  tickPercent: number
  fullyFunded: boolean
} {
  const total = Math.max(0, v.totalCents)
  const percent = (cents: Cents) =>
    total === 0 ? 100 : Math.round((Math.max(0, Math.min(cents, total)) / total) * 100)
  return {
    fillPercent: percent(v.countedCents),
    tickPercent: percent(v.savedForCents),
    fullyFunded: v.countedCents >= total,
  }
}

/** The words for a part's or plan's status (D35): three, everywhere. */
export const PART_STATUS_WORDS: Record<PartStatus, string> = {
  on_track: 'On track',
  catching_up: 'Catching up',
  short: 'Short',
}

/** The words for an account's status. */
export const ACCOUNT_STATUS_WORDS: Record<AccountStatus, string> = {
  on_track: 'On track',
  short: 'Short',
  unconfirmed: 'Confirm the transfer',
}

/** Why a part's steady line starts where it does, in plain words. */
export function steadySinceWords(reason: SteadySinceReason): string {
  switch (reason) {
    case 'last_occurrence':
      return 'the last time it came round'
    case 'plan_started':
      return 'the day the plan started'
    case 'added':
      return 'the day it was added to the plan'
    case 'typed':
      return 'the day you gave'
    case 'spent':
      return 'the day it was last spent'
  }
}

/**
 * The sentence for a derived to-do (D35), in the same pieces as
 * `instructionSentenceParts` so a screen can set the account apart (D34).
 * Plain language (PRD §9); the words live here, not on a screen.
 */
export function derivedTodoSentenceParts(
  todo: DerivedTodo,
  humanDate: (d: CivilDate) => string = (d) => d,
): { text: string; target?: true }[] {
  const t = (text: string) => ({ text })
  const target = { text: todo.accountName, target: true as const }
  if (todo.kind === 'move_in') {
    return [
      t(`Move ${formatCents(todo.amountCents)} into `),
      target,
      t(` once, by ${humanDate(todo.byDate)}. It is too soon for the weekly transfer to cover.`),
    ]
  }
  const to = formatCents(todo.toCents)
  switch (todo.reason) {
    case 'confirm':
      return [
        t('Tell Ballast what the recurring transfer into '),
        target,
        t(todo.toCents > 0 ? ` moves each week. It needs ${to}.` : ' moves each week. It needs none for now.'),
      ]
    case 'raise':
      return [
        t('In Capital One 360, set the recurring transfer into '),
        target,
        t(` to ${to} per week (it is ${formatCents(todo.fromCents ?? 0)} now), so every date is covered.`),
      ]
    case 'lower':
      return [
        t('You can lower the recurring transfer into '),
        target,
        t(` from ${formatCents(todo.fromCents ?? 0)} to ${to} per week; less now does the job.`),
      ]
  }
}

export function derivedTodoSentence(
  todo: DerivedTodo,
  humanDate?: (d: CivilDate) => string,
): string {
  return derivedTodoSentenceParts(todo, humanDate)
    .map((p) => p.text)
    .join('')
}

// ---------------------------------------------------------------- the plan's chart

export interface PlanChartPoint {
  date: CivilDate
  cents: Cents
}

export interface PlanChart {
  /**
   * The steady line: every part saved steadily from its Saving since date to
   * its due date, added up, from the plan's Saving since to its last due date.
   */
  steady: PlanChartPoint[]
  /**
   * Where the money goes from here while the plan is catching up: from what
   * is counted today up to each part's total by its due date. Null when the
   * plan is on its steady line, where the two would be the same line.
   */
  catchUp: PlanChartPoint[] | null
  /** What is counted today, for the dot on the chart. */
  countedToday: PlanChartPoint
  targetCents: Cents
}

/**
 * The plan's chart (D35), sampled on transfer days: nothing changes between
 * them, and a daily curve would claim the money rises continuously.
 */
export function planChart(args: {
  plan: PlanPosition
  today: CivilDate
  transferWeekday?: Weekday
  maxPoints?: number
}): PlanChart | null {
  const { plan, today } = args
  const transferWeekday = args.transferWeekday ?? DEFAULT_TRANSFER_WEEKDAY
  if (plan.parts.length === 0 || !plan.savingSince) return null
  const from = plan.savingSince
  const to = plan.parts.reduce<CivilDate>((d, p) => maxDate(d, p.lineItem.dueDate), plan.parts[0]!.lineItem.dueDate)

  const steadyAt = (date: CivilDate) =>
    plan.parts.reduce(
      (s, p) =>
        s +
        evenPaceCents({
          totalCents: p.totalCents,
          fromDate: p.savingSince.date,
          dueDate: p.lineItem.dueDate,
          today: date,
          transferWeekday,
        }),
      0,
    )
  const catchUpAt = (date: CivilDate) =>
    plan.parts.reduce(
      (s, p) =>
        s +
        p.countedCents +
        evenPaceCents({
          totalCents: Math.max(0, p.totalCents - p.countedCents),
          fromDate: today,
          dueDate: p.lineItem.dueDate,
          today: date,
          transferWeekday,
        }),
      0,
    )

  const sample = (start: CivilDate, value: (d: CivilDate) => Cents): PlanChartPoint[] => {
    const weeks = transferWeeksBetween(start, to, transferWeekday)
    const stride = Math.max(1, Math.ceil(weeks / (args.maxPoints ?? 60)))
    const points: PlanChartPoint[] = [{ date: start, cents: value(start) }]
    for (let week = stride; week <= weeks; week += stride) {
      const date = addDays(nextTransferDay(start, transferWeekday), (week - 1) * 7)
      points.push({ date, cents: value(date) })
    }
    if (points.at(-1)!.date !== to) points.push({ date: to, cents: value(to) })
    return points
  }

  return {
    steady: sample(compareDates(from, to) < 0 ? from : today, steadyAt),
    catchUp: plan.status === 'on_track' || compareDates(today, to) >= 0 ? null : sample(today, catchUpAt),
    countedToday: { date: today, cents: plan.countedCents },
    targetCents: plan.totalCents,
  }
}
