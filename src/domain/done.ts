/**
 * What a person marked done on This week, and whether it can still be taken
 * back (PRD D62).
 *
 * A savings to-do (set the transfer, a one-time move in, a move between
 * accounts) is derived, never issued ahead; "Done" records the instruction
 * and its confirmation together, and since D62 every instruction recorded by
 * one press carries the same `group_id`. Everything here is read from those
 * events: nothing about a Done is stored but the events themselves.
 *
 * - **Done lately** is every press of the last `DONE_LATELY_DAYS` days that
 *   was not undone, newest first, with who pressed it.
 * - **Undo** is offered until the household's next transfer day after the
 *   press (the bank acts on a transfer change from then), and never once
 *   any account it touched has been counted since: a count measured the
 *   real money, so undoing behind it would move a figure someone checked.
 *   Undoing records `event_undone` for each of the press's instructions, and
 *   the ledger then reads them as never recorded.
 * - **A to-do already done.** The to-do a form was shown is named by
 *   `todoKey`; if it is no longer in the list when the press arrives,
 *   someone else got there first and nothing is recorded.
 */

import { compareDates, transferWeeksBetween, type CivilDate, type Weekday } from './dates'
import { formatCents, parseAmountOrNull, type Cents } from './money'
import type { DerivedTodo } from './position'
import type { Id } from './types'

export const DONE_LATELY_DAYS = 7

/** The field a "Done: it's $X" button posts: the figure it shows, in whole cents. */
export const DONE_ITS_FIELD = 'its'

/** A savings to-do's identity, stable while it asks for the same thing of the same accounts. */
export function todoKey(todo: DerivedTodo): string {
  return todo.kind === 'move_between'
    ? `move_between:${todo.fromAccountId}:${todo.accountId}`
    : `${todo.kind}:${todo.accountId}`
}

/**
 * The amount a to-do's form records: the button's figure when the button was
 * pressed (its own small form, so Enter in the box never sends it), else
 * what was typed. An empty box records nothing; so does anything that is not
 * an amount.
 */
export function doneAmountFromForm(args: { typed: string | null; its: string | null }): Cents | null {
  const its = (args.its ?? '').trim()
  if (its !== '') return /^\d+$/.test(its) ? Number(its) : null
  const typed = (args.typed ?? '').trim()
  if (typed === '') return null
  const cents = parseAmountOrNull(typed)
  return cents === null || cents < 0 ? null : cents
}

/** An event row as the engine reads it for Done lately: the log's own fields and who recorded it. */
export interface DoneEventRow {
  id: Id
  kind: string
  on: CivilDate
  /** Whole microseconds since the epoch, in decimal (see `RecordedEvent`). */
  recordedAtMicros: string
  actorUserId: Id | null
  payload: Record<string, unknown>
}

export interface DoneInstructionLine {
  instructionId: Id
  /** The event that issued it: what an undo names. */
  issuedEventId: Id
  type: string
  amountCents: Cents
  targetId: Id
  targetLabel: string
}

export interface DonePress {
  groupId: Id
  on: CivilDate
  actorUserId: Id | null
  /** One line for a transfer or a move in; two (out, then in) for a move between accounts. */
  lines: DoneInstructionLine[]
  /** Every account it touched. */
  accountIds: Id[]
  undoable: boolean
}

/**
 * Every press of the last `DONE_LATELY_DAYS` days still standing, newest
 * first. `rows` is the household's log (any order); only instructions that
 * carry a `group_id` are presses.
 */
export function donePressesOf(args: {
  rows: readonly DoneEventRow[]
  today: CivilDate
  transferWeekday?: Weekday
}): DonePress[] {
  const undone = new Set<Id>()
  for (const r of args.rows) {
    if (r.kind === 'event_undone' && typeof r.payload.instruction_id === 'string') undone.add(r.payload.instruction_id)
  }
  const confirmed = new Set<Id>()
  for (const r of args.rows) {
    if (r.kind === 'instruction_confirmed') confirmed.add(r.payload.instruction_id as Id)
  }
  // The latest count of each account, by when it was recorded.
  const lastCount = new Map<Id, bigint>()
  for (const r of args.rows) {
    if (r.kind !== 'balance_confirmed') continue
    const account = r.payload.reserve_account_id as Id
    const at = BigInt(r.recordedAtMicros)
    if ((lastCount.get(account) ?? -1n) < at) lastCount.set(account, at)
  }

  const groups = new Map<Id, { press: DonePress; recordedAt: bigint }>()
  for (const r of args.rows) {
    if (r.kind !== 'instruction_issued') continue
    const p = r.payload
    const groupId = p.group_id
    const instructionId = p.instruction_id as Id
    if (typeof groupId !== 'string' || undone.has(instructionId) || !confirmed.has(instructionId)) continue
    const daysAgo = compareDates(args.today, r.on)
    if (daysAgo < 0 || daysAgo >= DONE_LATELY_DAYS) continue
    const at = BigInt(r.recordedAtMicros)
    const line: DoneInstructionLine = {
      instructionId,
      issuedEventId: r.id,
      type: String(p.type),
      amountCents: p.amount_cents as Cents,
      targetId: p.target_id as Id,
      targetLabel: String(p.target_label ?? ''),
    }
    const group = groups.get(groupId)
    if (group) {
      group.press.lines.push(line)
      if (!group.press.accountIds.includes(line.targetId)) group.press.accountIds.push(line.targetId)
      if (at > group.recordedAt) group.recordedAt = at
    } else {
      groups.set(groupId, {
        recordedAt: at,
        press: { groupId, on: r.on, actorUserId: r.actorUserId, lines: [line], accountIds: [line.targetId], undoable: false },
      })
    }
  }

  const presses = [...groups.values()]
  for (const { press, recordedAt } of presses) {
    // A move between accounts reads out, then in.
    press.lines.sort((a, b) => (a.type === 'one_time_move_out' ? -1 : b.type === 'one_time_move_out' ? 1 : 0))
    const counted = press.accountIds.some((id) => (lastCount.get(id) ?? -1n) > recordedAt)
    press.undoable = !counted && transferWeeksBetween(press.on, args.today, args.transferWeekday) === 0
  }
  return presses
    .sort((a, b) => (a.recordedAt === b.recordedAt ? 0 : a.recordedAt > b.recordedAt ? -1 : 1))
    .map((g) => g.press)
}

/** What a press recorded, in a sentence: "Annual Expenses moves $420.00 a week", "Moved $43.46 from Annual Expenses into Car & Home". */
export function donePressSentence(press: Pick<DonePress, 'lines'>): string {
  const transfer = press.lines.find((l) => l.type === 'set_weekly_transfer')
  if (transfer) return `${transfer.targetLabel} moves ${formatCents(transfer.amountCents)} a week`
  const into = press.lines.find((l) => l.type === 'one_time_move')
  const out = press.lines.find((l) => l.type === 'one_time_move_out')
  if (into && out) return `Moved ${formatCents(into.amountCents)} from ${out.targetLabel} into ${into.targetLabel}`
  if (into) return `Moved ${formatCents(into.amountCents)} into ${into.targetLabel}`
  if (out) return `Moved ${formatCents(out.amountCents)} out of ${out.targetLabel}`
  return 'Marked done'
}
