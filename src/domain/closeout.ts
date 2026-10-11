/**
 * Deadline close-out (PRD §5, capability 4).
 *
 * When a due date passes, the item does not quietly disappear. It enters Due and
 * keeps asking whether the money was actually spent, and it stays in the
 * expected-balance totals until a human confirms. An item that fell out of the
 * math on a date alone would make every account total a guess: the money might
 * still be sitting there, or it might be gone.
 */

import {
  addDays,
  addMonths,
  compareDates,
  nextTransferDay,
  type CivilDate,
  type Weekday,
} from './dates'
import type { Cents } from './money'
import type { Id, LineItem, LineItemState } from './types'

export interface CloseOutPrompt {
  lineItemId: Id
  label: string
  reserveAccountId: Id
  dueDate: CivilDate
  plannedCents: Cents
  daysOverdue: number
  /**
   * The day the question comes back while it is snoozed (D38), else null.
   * A snoozed question is off This week and the digest; its money is held
   * all the same, because nothing about a snooze reaches the position.
   */
  snoozedUntil: CivilDate | null
}

/**
 * A snooze as recorded (D38): which part, the due date it was asked about,
 * and the day it wakes. A later snooze of the same part replaces it, and
 * "Wake it up" is one that wakes today. A snooze for an earlier due date
 * means nothing once the part has rolled on.
 */
export interface CloseOutSnooze {
  lineItemId: Id
  dueDate: CivilDate
  until: CivilDate
}

/**
 * The state a line item should be in today, given its stored state and the
 * calendar. Only a human confirmation moves an item to retired.
 */
export function dueState(item: LineItem, today: CivilDate): LineItemState {
  if (item.state === 'retired' || item.state === 'planned') return item.state
  return compareDates(today, item.dueDate) >= 0 ? 'due' : 'accruing'
}

export function closeOutPrompts(args: {
  lineItems: readonly LineItem[]
  today: CivilDate
  /** Only items in committed packages are prompted about. */
  isLive: (item: LineItem) => boolean
  /** Every snooze recorded, oldest first; the latest for a part's due date decides. */
  snoozes?: readonly CloseOutSnooze[]
}): CloseOutPrompt[] {
  const latest = new Map<Id, CloseOutSnooze>()
  for (const s of args.snoozes ?? []) latest.set(`${s.lineItemId}:${s.dueDate}`, s)
  return args.lineItems
    .filter((item) => args.isLive(item) && dueState(item, args.today) === 'due')
    .map((item) => ({
      lineItemId: item.id,
      label: item.label,
      reserveAccountId: item.reserveAccountId,
      dueDate: item.dueDate,
      plannedCents: item.unitAmountCents * item.quantity,
      daysOverdue: Math.max(0, Math.round(compareDates(args.today, item.dueDate))),
      snoozedUntil: (() => {
        const snooze = latest.get(`${item.id}:${item.dueDate}`)
        return snooze && compareDates(snooze.until, args.today) > 0 ? snooze.until : null
      })(),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
}

/**
 * Closing out at a different amount than planned is normal, and the difference
 * is real: it is money still sitting in the account, or money that had to come
 * from somewhere else. Either way it surfaces as drift rather than vanishing.
 */
export function closeOutDrift(args: { plannedCents: Cents; actualCents: Cents }): Cents {
  return args.plannedCents - args.actualCents
}

/** The questions still asking today: everything not snoozed (D38). */
export function awakeCloseOuts(prompts: readonly CloseOutPrompt[]): CloseOutPrompt[] {
  return prompts.filter((p) => p.snoozedUntil === null)
}

// ---------------------------------------------------------------- snooze (D38)

export type SnoozeChoice = 'tomorrow' | 'transfer_day' | 'week' | 'month' | 'date'

/** The furthest a snooze may reach: six months, so nothing is put off for good. */
export const SNOOZE_MAX_MONTHS = 6

export const SNOOZE_CHOICE_WORDS: Record<SnoozeChoice, string> = {
  tomorrow: 'Tomorrow',
  transfer_day: 'Next transfer day',
  week: '1 week',
  month: '1 month',
  date: 'Pick a date',
}

export function isSnoozeChoice(v: unknown): v is SnoozeChoice {
  return typeof v === 'string' && v in SNOOZE_CHOICE_WORDS
}

/** The latest day a snooze may wake. */
export function latestSnoozeDay(today: CivilDate): CivilDate {
  return addMonths(today, SNOOZE_MAX_MONTHS)
}

/**
 * The day a snooze wakes, for each choice but a picked date: the screen
 * shows these beside the words, and the engine records the same day.
 */
export function snoozeDays(
  today: CivilDate,
  transferWeekday: Weekday,
): Record<Exclude<SnoozeChoice, 'date'>, CivilDate> {
  return {
    tomorrow: addDays(today, 1),
    transfer_day: nextTransferDay(today, transferWeekday),
    week: addDays(today, 7),
    month: addMonths(today, 1),
  }
}

/**
 * The day a snooze wakes, or the plain words for why it cannot: a picked
 * day must be after today and no more than six months out. One set of
 * words for the engine and the form.
 */
export function resolveSnoozeUntil(args: {
  choice: SnoozeChoice
  today: CivilDate
  transferWeekday: Weekday
  pickedDate?: CivilDate | null
}): { ok: true; until: CivilDate } | { ok: false; reason: string } {
  if (args.choice !== 'date') {
    return { ok: true, until: snoozeDays(args.today, args.transferWeekday)[args.choice] }
  }
  const picked = args.pickedDate
  if (!picked) return { ok: false, reason: 'Pick the day to ask again.' }
  if (compareDates(picked, args.today) <= 0) {
    return { ok: false, reason: 'Pick a day after today.' }
  }
  if (compareDates(picked, latestSnoozeDay(args.today)) > 0) {
    return { ok: false, reason: `A snooze can be at most ${SNOOZE_MAX_MONTHS} months.` }
  }
  return { ok: true, until: picked }
}
