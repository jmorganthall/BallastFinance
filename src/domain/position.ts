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
 * STEP 7, the parts (D40). An account is one pile: money held for a plan due
 * later pays a bill due sooner, and the weekly amount rebuilds it by the
 * later date. Each part's tick is what the account must hold for it today
 * so every date is met on the transfer set up at the bank: each due amount
 * (every round within the horizon counted to its part) less the transfers
 * that land on or before it and are not already spoken for, soonest first.
 * The ticks add up to the least the account must hold today. The money is
 * counted on every read -- first every slot up to its tick, soonest first,
 * then every part up to its total, soonest first -- and never recorded. A
 * part is On track at or above its tick and Short below it while its
 * account is Short; Catching up is retired. The steady line (an even save
 * since Saving since) is still worked out but measures nothing.
 *
 * Between accounts there is no lending, ever. An account On track with
 * money to spare is asked to move it into one that is Short, before any new
 * money is asked for; only what that cannot cover is a raise or a move.
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
import type { SentencePart } from './instructions'
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

/**
 * The status words, everywhere (D35, D40): On track, Short, and -- for a
 * part past its date with all its money there, waiting to be spent -- Ready
 * to spend (D38). Catching up is retired (D40).
 */
export type PartStatus = 'ready_to_spend' | 'on_track' | 'short'
/**
 * An account is fine or it is not; "unconfirmed" until its transfer is known.
 * Running down (D39): every bill this time round is covered, but the
 * transfer is less than the bills cost a year, so the money already there --
 * the household's ballast -- is being spent down and runs out on a later
 * time round. Short: a bill among the current dates cannot be paid.
 */
export type AccountStatus = 'on_track' | 'running_down' | 'short' | 'unconfirmed'

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
  /** The height of the steady line today: an even save since Saving since. Measures nothing (D40). */
  savedForCents: Cents
  /** What the account's money counts toward it today. */
  countedCents: Cents
  /**
   * The tick (D40): what the account must hold for this round of it today
   * so every date is met on the transfer set up at the bank. Below it on a
   * Short account, it is Short.
   */
  tickCents: Cents
  status: PartStatus
  /**
   * What it is missing today (D41): its tick less what is counted toward it,
   * while it is Short; 0 otherwise, so it is above zero exactly when Short.
   * What "+ $Y to make up" says.
   */
  shortByCents: Cents
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

/**
 * Why the transfer should change: confirm what it is, raise it so a current
 * date is met, keep it up with what the bills cost a year so the money
 * already there stops being spent down (D39), or lower it.
 */
export type TransferChangeReason = 'confirm' | 'raise' | 'keep_up' | 'lower'

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
  /** The least it must hold today for every date to pass on its transfer: its parts' ticks added up (D40). */
  mustHoldCents: Cents
  /** What it is missing today on its transfer: must hold − holds, while Short. */
  missingTodayCents: Cents
  /** What a plan's chart runs forward on (D40): every slot and what it holds, and what lands on each transfer day. */
  projection: AccountProjection
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
  /** The day the money runs out on the transfer set up now: Short, or Running down (on a later time round). */
  short: AccountShort | null
  /** What the repeating bills cost a week, steadily: the least a transfer must be not to run down (D39). */
  runRatePerWeekCents: Cents
  /** What could leave the account today with every date still passing. */
  extraCents: Cents
  /** A change to the transfer this account asks for, or null. */
  transferChange: { fromCents: Cents | null; toCents: Cents; reason: TransferChangeReason } | null
}

export interface AccountProjection {
  slots: (Slot & { tickCents: Cents; heldCents: Cents })[]
  /** Money that lands today: the move Ballast asks for while the transfer is unconfirmed. */
  startCents: Cents
  /** What lands on each transfer day from the next to the horizon. */
  transferDays: { on: CivilDate; cents: Cents }[]
}

/**
 * What fixes a Short account (D40), for the chart's second line: money in
 * today (a surplus move from another account and any one-time move) and
 * the weekly transfer Ballast asks for, if it asks for one.
 */
export interface AccountFix {
  nowCents: Cents
  perWeekCents: Cents | null
}

export interface PlanPosition {
  package: Package
  /** Its live parts, soonest due first. */
  parts: PartPosition[]
  totalCents: Cents
  steadyPerWeekCents: Cents
  savedForCents: Cents
  countedCents: Cents
  /** Its parts' ticks added up: where the plan's tick sits (D40). */
  tickCents: Cents
  /** The earliest day any live part's steady line starts: the plan's "Saving since". */
  savingSince: CivilDate | null
  /** Its worst part's status; on track with no live part. */
  status: PartStatus
  /** Its Short parts' shortfalls added up (D41): what "+ $Y to make up" says on its card. */
  shortByCents: Cents
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
  | {
      /**
       * Money one account has to spare, into one that is Short (D40): never
       * a loan -- the source keeps every one of its own dates on its own
       * transfer. Asked before any new money; marked done in one step that
       * records the move out and the move in together.
       */
      kind: 'move_between'
      fromAccountId: Id
      fromAccountName: string
      accountId: Id
      accountName: string
      amountCents: Cents
      /** The day the destination runs short without it. */
      byDate: CivilDate
      blocking: true
    }

export interface HouseholdPosition {
  today: CivilDate
  accounts: AccountPosition[]
  plans: PlanPosition[]
  todos: DerivedTodo[]
  /** What fixes each Short account, by account id, for the plan chart's second line (D40). */
  fixes: Map<Id, AccountFix>
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
 * Count an account's money toward its parts (D35, D40): every slot up to its
 * tick, soonest first -- what the account must hold for it today -- then
 * every part's current round up to its total, soonest first. Never recorded
 * and never chosen; it only decides what each part card shows, because the
 * weekly amount comes from the run-forward. A slot left below its tick is
 * where the money runs out; money held for a later round is in no part's
 * count.
 */
export function countTowardParts(
  slots: readonly (Pick<Slot, 'lineItemId' | 'cents' | 'current'> & { tickCents: Cents })[],
  moneyCents: Cents,
): { counted: Map<Id, Cents>; held: Cents[]; belowTick: Set<Id> } {
  const held = slots.map(() => 0)
  let left = Math.max(0, moneyCents)
  slots.forEach((slot, i) => {
    const take = Math.max(0, Math.min(slot.tickCents, left))
    held[i] = take
    left -= take
  })
  slots.forEach((slot, i) => {
    if (!slot.current) return
    const take = Math.max(0, Math.min(slot.cents - held[i]!, left))
    held[i] = held[i]! + take
    left -= take
  })
  const counted = new Map<Id, Cents>()
  const belowTick = new Set<Id>()
  slots.forEach((slot, i) => {
    if (slot.current) counted.set(slot.lineItemId, held[i]!)
    if (held[i]! < slot.tickCents) belowTick.add(slot.lineItemId)
  })
  return { counted, held, belowTick }
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
 * One amount a part needs by one date (D40): its current time round, or a
 * later round that comes within the horizon, or the share of the round
 * running at the horizon. The requirements are these added up by date.
 */
export interface Slot {
  lineItemId: Id
  on: CivilDate
  cents: Cents
  /** The round the part is saving for now; false for a later round. */
  current: boolean
  label: string
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
}): { horizon: CivilDate | null; requirements: Requirement[]; runRatePerWeekCents: Cents; slots: Slot[] } {
  const { parts, today, transferWeekday } = args
  if (parts.length === 0) return { horizon: null, requirements: [], runRatePerWeekCents: 0, slots: [] }

  const horizon = parts.reduce<CivilDate>((h, p) => maxDate(h, p.outflowDate), parts[0]!.outflowDate)
  const runTo = args.until ?? horizon

  const outflows = new Map<CivilDate, Cents>()
  const slots: Slot[] = []
  const add = (p: (typeof parts)[number], on: CivilDate, cents: Cents, current: boolean) => {
    outflows.set(on, (outflows.get(on) ?? 0) + cents)
    slots.push({ lineItemId: p.lineItem.id, on, cents, current, label: p.lineItem.label })
  }
  let terminalCents = 0
  let runRatePerWeekCents = 0

  for (const p of parts) {
    add(p, p.outflowDate, p.totalCents, true)
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
      add(p, compareDates(occurrence, today) < 0 ? today : occurrence, p.totalCents, false)
      next = nextOccurrence(occurrence, recurrence)
    }
    if (!next) continue

    // At the horizon the part is part-way into a cycle that runs from its
    // last occurrence on or before H to its next one after: that share must
    // be there too, or the level transfer would run the next cycle short.
    const cycleStart = previousOccurrence(next, recurrence) ?? occurrence
    if (!args.until) {
      const share = evenPaceCents({
        totalCents: p.totalCents,
        fromDate: cycleStart,
        dueDate: next,
        today: horizon,
        transferWeekday,
      })
      terminalCents += share
      if (share > 0) slots.push({ lineItemId: p.lineItem.id, on: horizon, cents: share, current: false, label: p.lineItem.label })
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
  return { horizon, requirements, runRatePerWeekCents, slots: sortSlots(slots) }
}

/** Soonest first; on one day, the round being saved for now before a later one, then by name. */
function sortSlots(slots: Slot[]): Slot[] {
  return slots.sort(
    (a, b) =>
      compareDates(a.on, b.on) ||
      Number(b.current) - Number(a.current) ||
      a.label.localeCompare(b.label) ||
      a.lineItemId.localeCompare(b.lineItemId),
  )
}

/**
 * What the account must hold today for each slot (D40): its amount less the
 * transfers that land on or before its date and are not already spoken for,
 * soonest first, a surplus of transfers carried on to the next slot. The
 * ticks add up to the least the account must hold today for every date to
 * pass on those transfers: the largest of (need by a date − arrived by it),
 * or nothing.
 */
export function slotTicks(slots: readonly Slot[], arrivedBy: (on: CivilDate) => Cents): Cents[] {
  let carried = 0
  let arrivedSoFar = 0
  return slots.map((slot) => {
    const arrived = arrivedBy(slot.on)
    carried += Math.max(0, arrived - arrivedSoFar)
    arrivedSoFar = Math.max(arrivedSoFar, arrived)
    const covered = Math.min(carried, slot.cents)
    carried -= covered
    return slot.cents - covered
  })
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

/**
 * A plan's status is its worst part's. Ready to spend is the best (D38): a
 * plan reads it only when every part does, so one part waiting to be spent
 * never hides another that is Short. No part at all is on track.
 */
const STATUS_ORDER: readonly PartStatus[] = ['short', 'on_track', 'ready_to_spend']
const worst = (statuses: readonly PartStatus[]): PartStatus =>
  statuses.length === 0 ? 'on_track' : STATUS_ORDER.find((s) => statuses.includes(s))!

function accountPosition(args: {
  account: ReserveAccount
  frames: readonly PartFrame[]
  input: PositionInput
  packagesById: ReadonlyMap<Id, Package>
  transferWeekday: Weekday
  /** Money a surplus move into (+) or out of (−) the account would make; for its to-dos only. */
  pendingCents?: Cents
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

  // A surplus move between accounts this read is asking for (D40): its to-dos
  // are worked out as if it were done, and nothing else is.
  if (args.pendingCents) {
    money.movesSinceCents += args.pendingCents
    money.totalCents += args.pendingCents
  }

  const { horizon, requirements, runRatePerWeekCents, slots } = requirementsFor({
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
  // The ticks (D40): what the account must hold today for each slot so that
  // every date is met on the transfer set up at the bank -- or, until one
  // is confirmed, on the transfer Ballast asks for with its move made, which
  // is how the figures read then.
  const arrivedBy = (on: CivilDate): Cents =>
    bank
      ? bankTransfersBetween(schedule, today, on)
      : level.moveCents + weeklyCents * transferWeeksBetween(today, on, transferWeekday)
  const ticks = slotTicks(slots, arrivedBy)
  const ticked = slots.map((slot, i) => ({ ...slot, tickCents: ticks[i]! }))
  const { counted, held } = countTowardParts(ticked, money.totalCents)
  const currentShort = ticked.some((x, i) => x.current && held[i]! < x.tickCents)
  const mustHoldCents = ticks.reduce((s, t) => s + t, 0)
  const tickOf = new Map(ticked.filter((x) => x.current).map((x) => [x.lineItemId, x.tickCents]))

  // Money that runs out only on a later time round -- after the last current
  // date, or on a round within it that comes after every current bill is
  // paid -- is an account Running down, not Short (D39, D40): every bill now
  // is paid, the transfer is not keeping up, and the ballast is what is
  // being spent. Short is a bill the account is saving for now that cannot
  // be paid: a current round below its tick, the money run out before it.
  const runsOutLater = judged.short !== null && !currentShort
  const status: AccountStatus =
    frames.length === 0 && !bank
      ? 'on_track'
      : !bank
        ? 'unconfirmed'
        : judged.short
          ? runsOutLater
            ? 'running_down'
            : 'short'
          : 'on_track'

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
      transferChange = {
        fromCents: bank.perWeekCents,
        toCents: weeklyCents,
        reason: runsOutLater ? 'keep_up' : 'raise',
      }
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

  const parts: PartPosition[] = [...frames]
    .sort(
      (a, b) =>
        compareDates(a.outflowDate, b.outflowDate) || a.lineItem.label.localeCompare(b.lineItem.label),
    )
    .map((f) => {
      const countedCents = counted.get(f.lineItem.id) ?? 0
      // Short exactly where the money runs out before this round of it has
      // what it needs today, on an account that is Short (D40): the bar
      // below its tick. A later round never makes it Short (D38 (6)). On or
      // past its date -- the day "did this get spent?" starts asking -- with
      // every cent of it counted, it is Ready to spend (D38), snoozed or
      // not; past its date and not all there, it goes out today with a tick
      // of its whole total, so it reads Short.
      const partStatus: PartStatus =
        status === 'short' && countedCents < (tickOf.get(f.lineItem.id) ?? 0)
          ? 'short'
          : compareDates(f.lineItem.dueDate, today) <= 0 && countedCents >= f.totalCents
            ? 'ready_to_spend'
            : 'on_track'
      const tickCents = Math.min(tickOf.get(f.lineItem.id) ?? 0, f.totalCents)
      return {
        ...f,
        countedCents,
        tickCents,
        status: partStatus,
        shortByCents: partStatus === 'short' ? Math.max(0, tickCents - countedCents) : 0,
      }
    })

  // What a plan's chart runs forward on: every slot with what it holds
  // today, and what lands in the account on each transfer day to come.
  const transferDays: { on: CivilDate; cents: Cents }[] = []
  if (horizon) {
    let before = arrivedBy(today)
    for (let d = nextTransferDay(today, transferWeekday); compareDates(d, horizon) <= 0; d = addDays(d, 7)) {
      const now = arrivedBy(d)
      transferDays.push({ on: d, cents: Math.max(0, now - before) })
      before = Math.max(before, now)
    }
  }

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
    mustHoldCents,
    missingTodayCents: status === 'short' ? Math.max(0, mustHoldCents - money.totalCents) : 0,
    projection: {
      slots: ticked.map((x, i) => ({ ...x, heldCents: held[i]! })),
      startCents: bank ? 0 : level.moveCents,
      transferDays,
    },
    weeklyExactCents: level.weeklyExactCents,
    neededPerWeekCents: needed.cents,
    neededExactPerWeekCents: needed.exactCents,
    weeklyCents,
    oneTimeMove,
    bank,
    status,
    short: status === 'short' || status === 'running_down' ? judged.short : null,
    runRatePerWeekCents,
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

  const framesOf = (id: Id) => frames.filter((f) => f.accountId === id)
  const accounts = input.accounts.map((account) =>
    accountPosition({ account, frames: framesOf(account.id), input, packagesById, transferWeekday }),
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
        tickCents: parts.reduce((s, p) => s + p.tickCents, 0),
        savingSince: parts.reduce<CivilDate | null>(
          (d, p) => (d === null || compareDates(p.savingSince.date, d) < 0 ? p.savingSince.date : d),
          null,
        ),
        status: worst(parts.map((p) => p.status)),
        shortByCents: parts.reduce((s, p) => s + p.shortByCents, 0),
      }
    })

  // Money one account has to spare goes to one that is Short before any new
  // money is asked for (D40). Never a loan: only an account On track on its
  // own confirmed transfer, at or above what its bills cost a year, lends,
  // and only its extra -- what could leave with every one of its own dates
  // still passing. Each Short account, the soonest to run short first, takes
  // the smaller of what is spare and what it is missing today.
  const moves = surplusMoves(accounts)
  const pending = new Map<Id, Cents>()
  for (const m of moves) {
    pending.set(m.from.account.id, (pending.get(m.from.account.id) ?? 0) - m.amountCents)
    pending.set(m.to.account.id, (pending.get(m.to.account.id) ?? 0) + m.amountCents)
  }
  // Each account's own asks, worked out as if the moves were made: what is
  // left to fix after the spare money is a raise or a one-time move, and a
  // lender's own offer to lower its transfer is sized on what it keeps.
  const asks = new Map(
    accounts.map((a) => {
      const by = pending.get(a.account.id)
      if (!by) return [a.account.id, a] as const
      const as = accountPosition({
        account: a.account,
        frames: framesOf(a.account.id),
        input,
        packagesById,
        transferWeekday,
        pendingCents: by,
      })
      // An account still Short with the money moved keeps its own fix; one
      // the move puts right is asked for nothing more until it is done
      // (not even to lower a transfer it may yet need).
      return [a.account.id, by > 0 && as.status === 'on_track' ? { ...as, transferChange: null, oneTimeMove: null } : as] as const
    }),
  )

  const todos: DerivedTodo[] = []
  for (const m of moves) {
    todos.push({
      kind: 'move_between',
      fromAccountId: m.from.account.id,
      fromAccountName: m.from.account.name,
      accountId: m.to.account.id,
      accountName: m.to.account.name,
      amountCents: m.amountCents,
      byDate: m.to.short!.on,
      blocking: true,
    })
  }
  const fixes = new Map<Id, AccountFix>()
  for (const actual of accounts) {
    const a = asks.get(actual.account.id) ?? actual
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
    if (actual.status === 'short') {
      const incoming = Math.max(0, pending.get(actual.account.id) ?? 0)
      const raise = a.transferChange && a.transferChange.reason !== 'lower' ? a.transferChange.toCents : null
      fixes.set(actual.account.id, {
        nowCents: incoming + (a.oneTimeMove?.amountCents ?? 0),
        perWeekCents: raise,
      })
    }
  }
  // The accounts carry their own asks: what This week and the card say.
  const shown = accounts.map((actual) => {
    const a = asks.get(actual.account.id)
    return a && a !== actual
      ? { ...actual, transferChange: a.transferChange, oneTimeMove: a.oneTimeMove }
      : actual
  })

  const withPlans = shown.filter((a) => a.parts.length > 0)
  const coveredThrough = withPlans.reduce<CivilDate | null>(
    (d, a) => (a.horizon && (d === null || compareDates(a.horizon, d) > 0) ? a.horizon : d),
    null,
  )

  return {
    today,
    accounts: shown,
    plans,
    todos,
    fixes,
    allCaughtUp:
      withPlans.every((a) => a.status === 'on_track') && !todos.some((t) => t.blocking),
    coveredThrough,
    bankPerWeekCents: accounts.reduce((s, a) => s + (a.bank?.nextWeekCents ?? 0), 0),
    weeklyPerWeekCents: accounts.reduce((s, a) => s + a.weeklyCents, 0),
  }
}

/**
 * The surplus moves between accounts (D40): each Short account, soonest to
 * run short first, takes from the accounts with the most to spare first,
 * the smaller of what is spare and what it is missing today. A lender is On
 * track on its own confirmed transfer and that transfer keeps up with what
 * its bills cost a year, so moving its extra never leaves it short later.
 */
function surplusMoves(
  accounts: readonly AccountPosition[],
): { from: AccountPosition; to: AccountPosition; amountCents: Cents }[] {
  const spare = new Map(
    accounts
      .filter(
        (a) =>
          a.status === 'on_track' &&
          a.bank !== null &&
          a.bank.perWeekCents >= a.runRatePerWeekCents &&
          a.extraCents > 0,
      )
      .map((a) => [a.account.id, a.extraCents]),
  )
  const lenders = accounts
    .filter((a) => spare.has(a.account.id))
    .sort((a, b) => b.extraCents - a.extraCents || a.account.name.localeCompare(b.account.name))
  const short = accounts
    .filter((a) => a.status === 'short' && a.missingTodayCents > 0)
    .sort((a, b) => compareDates(a.short!.on, b.short!.on) || a.account.name.localeCompare(b.account.name))
  const moves: { from: AccountPosition; to: AccountPosition; amountCents: Cents }[] = []
  for (const to of short) {
    let missing = to.missingTodayCents
    for (const from of lenders) {
      if (missing <= 0) break
      const has = spare.get(from.account.id) ?? 0
      const amountCents = Math.min(has, missing)
      if (amountCents <= 0) continue
      moves.push({ from, to, amountCents })
      spare.set(from.account.id, has - amountCents)
      missing -= amountCents
    }
  }
  return moves
}

// ---------------------------------------------------------------- what a screen draws

/**
 * The progress bar's reading, so a screen draws and works nothing out: how
 * full the bar is (what is counted, as a share of the total) and where the
 * tick sits (what the account must hold for it today, D40). Both are drawn
 * to a fraction of a percent, so a fill a few cents below its tick is not
 * drawn on top of it (D41 (6)), and capped at 100. `savedPercent` is the
 * whole-number share the card prints beside "$X of $Y", rounded down so it
 * reads 100 only when every cent is there (D41 (3)).
 */
export function barOf(v: { totalCents: Cents; countedCents: Cents; tickCents: Cents }): {
  fillPercent: number
  tickPercent: number
  savedPercent: number
  fullyFunded: boolean
} {
  const total = Math.max(0, v.totalCents)
  const clamp = (cents: Cents) => Math.max(0, Math.min(cents, total))
  const percent = (cents: Cents) => (total === 0 ? 100 : (clamp(cents) * 100) / total)
  return {
    fillPercent: percent(v.countedCents),
    tickPercent: percent(v.tickCents),
    savedPercent: total === 0 ? 100 : Math.floor((clamp(v.countedCents) * 100) / total),
    fullyFunded: v.countedCents >= total,
  }
}

/**
 * Why an account is Short and what fixes it (D40), for the line a Short plan
 * or part card shows without a tap: the account, the day it runs short, and
 * the to-dos This week asks for it, in short plain words.
 */
export interface ShortReason {
  accountId: Id
  accountName: string
  on: CivilDate
  fixes: string[]
}

export function shortReasons(p: Pick<HouseholdPosition, 'accounts' | 'todos'>): Map<Id, ShortReason> {
  const reasons = new Map<Id, ShortReason>()
  for (const a of p.accounts) {
    if (a.status !== 'short' || !a.short) continue
    const fixes = p.todos.flatMap((t): string[] => {
      if (t.accountId !== a.account.id) return []
      if (t.kind === 'move_between') return [`move ${formatCents(t.amountCents)} from ${t.fromAccountName}`]
      if (t.kind === 'move_in') return [`move ${formatCents(t.amountCents)} in once`]
      if (t.reason === 'raise' || t.reason === 'keep_up') return [`set its transfer to ${formatCents(t.toCents)} a week`]
      return []
    })
    reasons.set(a.account.id, { accountId: a.account.id, accountName: a.account.name, on: a.short.on, fixes })
  }
  return reasons
}

/** The words for a part's or plan's status (D35, D38), everywhere. */
export const PART_STATUS_WORDS: Record<PartStatus, string> = {
  ready_to_spend: 'Ready to spend',
  on_track: 'On track',
  short: 'Short',
}

/** The words for an account's status. */
export const ACCOUNT_STATUS_WORDS: Record<AccountStatus, string> = {
  on_track: 'On track',
  running_down: 'Running down',
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
): SentencePart[] {
  const t = (text: string): SentencePart => ({ text })
  const target: SentencePart = { text: todo.accountName, target: true }
  if (todo.kind === 'move_between') {
    return [
      t(`Move ${formatCents(todo.amountCents)} from ${todo.fromAccountName} into `),
      target,
      t(', '),
      { text: `by ${humanDate(todo.byDate)}`, date: { on: todo.byDate, as: 'due' } },
      t(`. ${todo.fromAccountName} has it to spare, and `),
      { text: todo.accountName },
      t(' needs it so every date is covered.'),
    ]
  }
  if (todo.kind === 'move_in') {
    return [
      t(`Move ${formatCents(todo.amountCents)} into `),
      target,
      t(' once, '),
      { text: `by ${humanDate(todo.byDate)}`, date: { on: todo.byDate, as: 'due' } },
      t('. It is too soon for the weekly transfer to cover.'),
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
    case 'keep_up':
      return [
        t('In Capital One 360, set the recurring transfer into '),
        target,
        t(
          ` to ${to} per week (it is ${formatCents(todo.fromCents ?? 0)} now), so it keeps up with what its bills cost and stops using up what is already set aside.`,
        ),
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
   * What will happen on the transfer set up now (D40): from what is counted
   * today, each transfer paying the account's dates soonest first, to the
   * plan's last due date. Below the total at the end when the plan is Short.
   */
  actual: PlanChartPoint[]
  /** The same with the fix This week asks for made, while the plan is Short; otherwise null. */
  afterFix: PlanChartPoint[] | null
  /** What is counted today, for the dot on the chart. */
  countedToday: PlanChartPoint
  targetCents: Cents
}

/**
 * Run one account forward for a chart (D40): what each slot holds after each
 * transfer day, every transfer poured into the slots still to come, soonest
 * first, up to what each needs. A slot whose date has passed keeps what it
 * had: the money went out that day, or what was missing was missing.
 */
function runSlots(args: {
  projection: AccountProjection
  nowCents: Cents
  perWeekCents: Cents | null
  days: readonly CivilDate[]
}): Cents[][] {
  const { projection } = args
  const held = projection.slots.map((x) => x.heldCents)
  const arriving = new Map(projection.transferDays.map((d) => [d.on, d.cents]))
  const pour = (cents: Cents, from: CivilDate) => {
    let left = cents
    projection.slots.forEach((slot, i) => {
      if (left <= 0 || compareDates(slot.on, from) < 0) return
      const take = Math.min(slot.cents - held[i]!, left)
      if (take > 0) {
        held[i] = held[i]! + take
        left -= take
      }
    })
  }
  return args.days.map((day, i) => {
    const landing =
      (args.perWeekCents ?? arriving.get(day) ?? 0) + (i === 0 ? projection.startCents + args.nowCents : 0)
    pour(landing, day)
    return [...held]
  })
}

/**
 * The plan's chart (D40), sampled on transfer days: nothing changes between
 * them, and a daily curve would claim the money rises continuously. It runs
 * from today: the even-pace steady line is no longer something a plan is
 * measured against, so it is not drawn.
 */
export function planChart(args: {
  plan: PlanPosition
  household: Pick<HouseholdPosition, 'accounts' | 'fixes'>
  today: CivilDate
  transferWeekday?: Weekday
  maxPoints?: number
}): PlanChart | null {
  const { plan, today } = args
  const transferWeekday = args.transferWeekday ?? DEFAULT_TRANSFER_WEEKDAY
  if (plan.parts.length === 0) return null
  const to = plan.parts.reduce<CivilDate>((d, p) => maxDate(d, p.lineItem.dueDate), plan.parts[0]!.lineItem.dueDate)
  if (compareDates(today, to) >= 0) return null

  const days: CivilDate[] = []
  for (let d = nextTransferDay(today, transferWeekday); compareDates(d, to) <= 0; d = addDays(d, 7)) days.push(d)
  const accountIds = [...new Set(plan.parts.map((p) => p.accountId))]
  const partIds = new Set(plan.parts.map((p) => p.lineItem.id))
  const accounts = args.household.accounts.filter((a) => accountIds.includes(a.account.id))

  const line = (fixed: boolean): PlanChartPoint[] => {
    const totals = days.map(() => 0)
    for (const a of accounts) {
      const fix = fixed ? args.household.fixes.get(a.account.id) : undefined
      const run = runSlots({
        projection: a.projection,
        nowCents: fix?.nowCents ?? 0,
        perWeekCents: fix?.perWeekCents ?? null,
        days,
      })
      run.forEach((held, i) => {
        a.projection.slots.forEach((slot, j) => {
          if (slot.current && partIds.has(slot.lineItemId)) totals[i] = totals[i]! + held[j]!
        })
      })
    }
    const points: PlanChartPoint[] = [{ date: today, cents: plan.countedCents }]
    const stride = Math.max(1, Math.ceil(days.length / (args.maxPoints ?? 60)))
    days.forEach((date, i) => {
      if (i % stride === stride - 1 || i === days.length - 1) points.push({ date, cents: totals[i]! })
    })
    if (points.at(-1)!.date !== to) points.push({ date: to, cents: points.at(-1)!.cents })
    return points
  }

  const fixable = plan.status === 'short' && accounts.some((a) => args.household.fixes.has(a.account.id))
  return {
    actual: line(false),
    afterFix: fixable ? line(true) : null,
    countedToday: { date: today, cents: plan.countedCents },
    targetCents: plan.totalCents,
  }
}
