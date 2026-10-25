/**
 * Rounds (PRD D53, rev 105). Each time a repeating part comes round is a
 * round, named by its due date; a one-off has one round.
 *
 * A round does not wait to be answered. On its due date it stays open and
 * the next round starts saving at once, from that date, whether or not
 * anyone has said the money was spent. A round is finished when the spends
 * recorded against it reach its total, or when a person presses Finish;
 * until then it is open, still holds what it needs, and keeps asking "did
 * this get spent?". Nothing closes on its own.
 *
 * A spend can be recorded at any time and as often as needed. Each one
 * lowers what its round still needs by the same amount it takes out of the
 * account, so on its own a spend never moves a weekly amount. "Save back up"
 * puts the round's target back to its full total: the spends before it stay
 * spent, but no longer count against what the round needs.
 *
 * Which rounds are open, what each still needs and when the next one
 * started saving are worked out here from the part and its events, never
 * stored. The part's stored due date is its oldest open round; the engine
 * keeps it there. Undone events never reach this module: the engine leaves
 * them out.
 *
 * Pure: no I/O, `today` is a parameter.
 */

import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import { isRecurring, nextOccurrence, previousOccurrence, type Recurrence } from './recurrence'
import { lineItemTotalCents, type Id, type LineItem } from './types'

/**
 * The most rounds of one part worked through on a read. A weekly part left
 * unanswered for years is still well inside it; past it is a typo, and the
 * bound stops a bad date becoming a hang.
 */
const MAX_ROUNDS = 2_000

/** One fact about a round, as recorded (D53 (9)), undone ones already left out. */
export interface RoundEvent {
  eventId: Id
  kind: 'spend' | 'finish' | 'save_back_up'
  lineItemId: Id
  /** The round's due date. */
  roundDue: CivilDate
  /** What went out, for a spend; 0 otherwise. */
  amountCents: Cents
  /** The day it was recorded. */
  on: CivilDate
}

export interface Round {
  lineItemId: Id
  dueDate: CivilDate
  /** The part's total: what the round needs before anything is spent. */
  fullCents: Cents
  /** Every spend recorded against it. */
  spentCents: Cents
  /** The spends since the last "Save back up": what lowers the target. */
  countedSpentCents: Cents
  /** What it still needs: its total less the counted spends, never below zero. */
  needsCents: Cents
  finished: boolean
  /** The day it was finished: the Finish, or the spend that reached the total. */
  finishedOn: CivilDate | null
  /**
   * On or past its due date: the round "did this get spent?" asks about.
   * The round still saving for a date ahead is not past.
   */
  past: boolean
}

export interface PartRounds {
  /** Open rounds on or past their date, oldest first. */
  past: Round[]
  /** The round saving now for a date ahead; null for a one-off on or past its date. */
  current: Round | null
  /**
   * The day the current round started saving, when a round before it was
   * in Ballast: the last round's date, or the day that round was finished
   * if that was earlier (D53 (3)). Null when the current round is the first
   * one, whose start is the person's own choice (D33).
   */
  currentSavingFrom: CivilDate | null
  /** The oldest open round's date: where the engine keeps the stored due date. Null when none is open. */
  oldestOpen: CivilDate | null
  /**
   * The first round ahead of today when it was finished early and so is not
   * the current one, else null. Until its date passes the run-forward still
   * measures the part from it, with nothing left to need there: finishing
   * early then never asks for more a week than waiting for the date would
   * (D53 (3)) -- otherwise the next cycle, a few transfer days longer or
   * shorter, would set the run-rate a round sooner.
   */
  finishedAhead: CivilDate | null
}

/** One round's standing, from its events alone. */
export function roundState(args: {
  lineItem: Pick<LineItem, 'id' | 'unitAmountCents' | 'quantity'>
  dueDate: CivilDate
  events: readonly RoundEvent[]
  today: CivilDate
}): Round {
  const fullCents = lineItemTotalCents(args.lineItem)
  const mine = args.events.filter((e) => e.lineItemId === args.lineItem.id && e.roundDue === args.dueDate)
  // Spends after the last save back up are what lower the target; the
  // events arrive in the order they were recorded.
  let lastSave = -1
  mine.forEach((e, i) => {
    if (e.kind === 'save_back_up') lastSave = i
  })
  let spentCents = 0
  let countedSpentCents = 0
  let reachedOn: CivilDate | null = null
  mine.forEach((e, i) => {
    if (e.kind !== 'spend') return
    spentCents += e.amountCents
    if (i < lastSave) return
    countedSpentCents += e.amountCents
    if (reachedOn === null && countedSpentCents >= fullCents) reachedOn = e.on
  })
  const finish = mine.find((e) => e.kind === 'finish') ?? null
  const finishedOn = finish?.on ?? reachedOn
  return {
    lineItemId: args.lineItem.id,
    dueDate: args.dueDate,
    fullCents,
    spentCents,
    countedSpentCents,
    needsCents: Math.max(0, fullCents - countedSpentCents),
    finished: finishedOn !== null,
    finishedOn,
    past: compareDates(args.dueDate, args.today) <= 0,
  }
}

/**
 * A part's open rounds (D53 (1)): from its stored due date, every round on
 * or past its date not yet finished, and the first round ahead not yet
 * finished, which is the one saving now. A round finished before its date
 * moves the part on to the next at once.
 */
export function roundsOf(args: {
  lineItem: Pick<LineItem, 'id' | 'unitAmountCents' | 'quantity' | 'dueDate' | 'recurrence'>
  events: readonly RoundEvent[]
  today: CivilDate
}): PartRounds {
  const { lineItem, events, today } = args
  const stateOf = (dueDate: CivilDate) => roundState({ lineItem, dueDate, events, today })

  if (!isRecurring(lineItem.recurrence)) {
    const only = stateOf(lineItem.dueDate)
    const none = { currentSavingFrom: null, finishedAhead: null }
    if (only.finished) return { past: [], current: null, oldestOpen: null, ...none }
    return only.past
      ? { past: [only], current: null, oldestOpen: only.dueDate, ...none }
      : { past: [], current: only, oldestOpen: only.dueDate, ...none }
  }

  const past: Round[] = []
  let current: Round | null = null
  let finishedAhead: CivilDate | null = null
  let date: CivilDate | null = lineItem.dueDate
  for (let guard = 0; date && guard < MAX_ROUNDS; guard += 1) {
    const round = stateOf(date)
    if (round.past) {
      if (!round.finished) past.push(round)
    } else if (!round.finished) {
      current = round
      break
    } else if (finishedAhead === null) {
      finishedAhead = round.dueDate
    }
    const next = nextOccurrence(date, lineItem.recurrence)
    if (!next || compareDates(next, date) <= 0) break
    date = next
  }

  // The round saving now started on the last round's date -- or the day
  // that round was finished, when that was earlier -- once there was a last
  // round in Ballast: one this read stepped past, or one finished here that
  // the stored date has already moved on from.
  let currentSavingFrom: CivilDate | null = null
  const last = current ? previousOccurrence(current.dueDate, lineItem.recurrence) : null
  if (current && last) {
    const before = stateOf(last)
    if (current.dueDate !== lineItem.dueDate || before.finished) {
      currentSavingFrom =
        before.finishedOn && compareDates(before.finishedOn, last) < 0 ? before.finishedOn : last
    }
  }
  return {
    past,
    current,
    currentSavingFrom,
    oldestOpen: past[0]?.dueDate ?? current?.dueDate ?? null,
    finishedAhead: current ? finishedAhead : null,
  }
}

/**
 * Where the engine keeps a part's stored due date after a round changes
 * (D53 (9)): its oldest open round, looked for from `from` -- the stored
 * date, or the earlier round an undo has just reopened. Null for a one-off
 * with nothing open: it is finished.
 */
export function oldestOpenRound(args: {
  lineItem: Pick<LineItem, 'id' | 'unitAmountCents' | 'quantity' | 'dueDate' | 'recurrence'>
  from: CivilDate
  events: readonly RoundEvent[]
  today: CivilDate
}): CivilDate | null {
  return roundsOf({ lineItem: { ...args.lineItem, dueDate: args.from }, events: args.events, today: args.today })
    .oldestOpen
}

/** The id a past round goes by in the position, beside its part's own (which is the current round's). */
export function roundKey(lineItemId: Id, dueDate: CivilDate): Id {
  return `${lineItemId}@${dueDate}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The suffix that tells two rounds of a part apart (D53 (8)), from the due
 * date and never stored: the year for a part that comes round yearly or less
 * often, the month and year for one that comes round monthly or every few
 * months, the day for one that comes round weekly or daily -- with the year
 * too when it is not the year of `today`.
 */
export function roundSuffix(dueDate: CivilDate, recurrence: Recurrence | null, today: CivilDate): string {
  const [y, m, d] = dueDate.split('-')
  const month = MONTHS[Number(m) - 1] ?? m
  if (!recurrence || recurrence.unit === 'year' || (recurrence.unit === 'month' && recurrence.every >= 12)) {
    return y!
  }
  if (recurrence.unit === 'month' || (recurrence.unit === 'week' && recurrence.every >= 5) || (recurrence.unit === 'day' && recurrence.every >= 28)) {
    return `${month} ${y}`
  }
  return y === today.slice(0, 4) ? `${month} ${Number(d)}` : `${month} ${Number(d)}, ${y}`
}

/** A round's name: the part's own, with the suffix while more than one of its rounds is open. */
export function roundLabel(args: {
  label: string
  dueDate: CivilDate
  recurrence: Recurrence | null
  openRounds: number
  today: CivilDate
}): string {
  return args.openRounds > 1
    ? `${args.label} (${roundSuffix(args.dueDate, args.recurrence, args.today)})`
    : args.label
}
