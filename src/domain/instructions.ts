/**
 * Instructions and confirmations (PRD §5, capability 5).
 *
 * Every recommendation the system makes is an instruction with a stable id.
 * Nothing is treated as done until a human confirms it happened -- the app
 * cannot move money, so the only thing that makes a transfer real is somebody
 * saying they did it.
 *
 * Outstanding-ness is derived, not stored: fold the issued events against the
 * confirmed ones. That way a confirmation can never drift out of sync with the
 * instruction it answers, and the history of what was asked and what was done
 * survives intact (D9).
 */

import { accrualWeeksBetween, compareDates, type CivilDate } from './dates'
import { ceilDiv, formatCents, type Cents } from './money'
import type { Id } from './types'

export type InstructionType =
  | 'set_weekly_transfer'
  | 'one_time_move'
  /** Money the account holds beyond the plan, moved back out. */
  | 'one_time_move_out'
  /** A temporary addition to the weekly amount, ending on a chosen date. */
  | 'rate_bump'
  /** A temporary reduction of the weekly amount, ending on a chosen date. */
  | 'rate_cut'
  | 'debt_payment'
  | 'spend_confirmation'

/**
 * Why a one-time move was asked for. The same move reads differently: money
 * to catch an account up, an account's share of what was spare, covering
 * what a plan is behind, or a share that had nowhere useful to go. Absent
 * means a catch-up, which is what every move was before purposes existed.
 */
export type InstructionPurpose = 'catch_up' | 'share_out' | 'cover' | 'left_over'

export interface IssuedInstruction {
  instructionId: Id
  type: InstructionType
  issuedOn: CivilDate
  amountCents: Cents
  /** The reserve account, debt or line item this concerns. */
  targetId: Id
  targetLabel: string
  /** Optional human sentence, stored with the instruction so it reads the same later. */
  note?: string
  purpose?: InstructionPurpose
  /**
   * Not before this day. The second half of the fun money is released later
   * so it is not spent all at once; it carries the day it becomes available,
   * the to-do list holds it under "coming up" until then, and its sentence
   * names the day. Absent means now.
   */
  availableOn?: CivilDate
  /**
   * When a rate bump stops. A real field rather than something encoded into the
   * note, because the accrual math reads it: the change ladder says reach for a
   * field before reaching for glue that parses one back out of a string.
   */
  endsOn?: CivilDate
}

export interface ConfirmedInstruction {
  instructionId: Id
  confirmedOn: CivilDate
  /** What actually happened, when it differs from what was asked. */
  actualAmountCents?: Cents
}

export interface OutstandingInstruction extends IssuedInstruction {
  /** Days it has been waiting -- counted from the day it became available, not the day it was asked. */
  ageInDays: number
  /** False while its available-from day is still ahead. */
  dueNow: boolean
}

/** The open asks: issued, not yet confirmed, oldest first. */
export function outstandingInstructions(args: {
  issued: readonly IssuedInstruction[]
  confirmed: readonly ConfirmedInstruction[]
  today: CivilDate
}): OutstandingInstruction[] {
  const done = new Set(args.confirmed.map((c) => c.instructionId))

  // A later instruction of the same type for the same target supersedes an
  // earlier one: "set the transfer to $210" replaces "set it to $180". Without
  // this the home screen accumulates stale asks nobody will ever action.
  const latestByTarget = new Map<string, IssuedInstruction>()
  for (const instruction of args.issued) {
    if (instruction.type !== 'set_weekly_transfer') continue
    const key = `${instruction.type}:${instruction.targetId}`
    const current = latestByTarget.get(key)
    if (!current || compareDates(instruction.issuedOn, current.issuedOn) >= 0) {
      latestByTarget.set(key, instruction)
    }
  }

  return args.issued
    .filter((instruction) => {
      if (done.has(instruction.instructionId)) return false
      if (instruction.type !== 'set_weekly_transfer') return true
      const key = `${instruction.type}:${instruction.targetId}`
      return latestByTarget.get(key)?.instructionId === instruction.instructionId
    })
    .map((instruction) => {
      const from =
        instruction.availableOn && compareDates(instruction.availableOn, instruction.issuedOn) > 0
          ? instruction.availableOn
          : instruction.issuedOn
      return {
        ...instruction,
        ageInDays: daysBetween(from, args.today),
        dueNow: compareDates(from, args.today) <= 0,
      }
    })
    // Oldest ask first; anything not yet available sits at the end.
    .sort((a, b) => Number(b.dueNow) - Number(a.dueNow) || b.ageInDays - a.ageInDays)
}

function daysBetween(from: CivilDate, to: CivilDate): number {
  return Math.max(0, Math.round(compareDates(to, from)))
}

/**
 * A dated bump or cut stores its TOTAL over the window (that is what the
 * accrual math delivers), but a person sets a weekly figure. The same rounding
 * as the weekly breakdown: a bump rounds up so it never under-funds, a cut
 * rounds down so it never over-cuts.
 */
export function perWeekOf(instruction: IssuedInstruction): Cents {
  const weeks = accrualWeeksBetween(instruction.issuedOn, instruction.endsOn ?? instruction.issuedOn)
  return instruction.type === 'rate_cut'
    ? -ceilDiv(-instruction.amountCents, weeks)
    : ceilDiv(instruction.amountCents, weeks)
}

/** The sentence a human reads and acts on. Plain language (PRD §9). */
export function instructionSentence(instruction: IssuedInstruction): string {
  switch (instruction.type) {
    case 'set_weekly_transfer':
      return `In Capital One 360, set the recurring transfer into ${instruction.targetLabel} to ${formatCents(instruction.amountCents)} per week.`
    case 'one_time_move': {
      const later =
        instruction.availableOn && compareDates(instruction.availableOn, instruction.issuedOn) > 0
          ? instruction.availableOn
          : null
      switch (instruction.purpose ?? 'catch_up') {
        case 'share_out':
          return later
            ? `On ${later}, move ${formatCents(instruction.amountCents)} into ${instruction.targetLabel}.`
            : `Move ${formatCents(instruction.amountCents)} into ${instruction.targetLabel}, its share of what was spare.`
        case 'cover':
          return `Move ${formatCents(instruction.amountCents)} into ${instruction.targetLabel} once, to cover what it is behind.`
        case 'left_over':
          return `Decide where ${formatCents(instruction.amountCents)} goes; it was the debt share with nowhere useful to go.`
        case 'catch_up':
          return `Move ${formatCents(instruction.amountCents)} into ${instruction.targetLabel} once, to catch up.`
      }
    }
    case 'one_time_move_out':
      return `Move ${formatCents(instruction.amountCents)} out of ${instruction.targetLabel} once; it holds more than the plan needs.`
    case 'rate_bump':
      return `Add ${formatCents(perWeekOf(instruction))} a week to the ${instruction.targetLabel} transfer until ${instruction.endsOn}, to catch up.`
    case 'rate_cut':
      return `Take ${formatCents(perWeekOf(instruction))} a week off the ${instruction.targetLabel} transfer until ${instruction.endsOn}; the extra you already hold covers it.`
    case 'debt_payment':
      return `Pay ${formatCents(instruction.amountCents)} toward ${instruction.targetLabel}.`
    case 'spend_confirmation':
      return `Did the ${instruction.targetLabel} money get spent from your savings?`
  }
}
