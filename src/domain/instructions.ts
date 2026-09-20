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

import { compareDates, type CivilDate } from './dates'
import { formatCents, type Cents } from './money'
import type { Id } from './types'

export type InstructionType =
  | 'set_weekly_transfer'
  | 'one_time_move'
  /** A temporary addition to the weekly amount, ending on a chosen date. */
  | 'rate_bump'
  | 'debt_payment'
  | 'spend_confirmation'

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
  ageInDays: number
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
    .map((instruction) => ({
      ...instruction,
      ageInDays: daysBetween(instruction.issuedOn, args.today),
    }))
    .sort((a, b) => b.ageInDays - a.ageInDays)
}

function daysBetween(from: CivilDate, to: CivilDate): number {
  return Math.max(0, Math.round(compareDates(to, from)))
}

/** The sentence a human reads and acts on. Plain language (PRD §9). */
export function instructionSentence(instruction: IssuedInstruction): string {
  switch (instruction.type) {
    case 'set_weekly_transfer':
      return `In Capital One 360, set the recurring transfer into ${instruction.targetLabel} to ${formatCents(instruction.amountCents)} per week.`
    case 'one_time_move':
      return `Move ${formatCents(instruction.amountCents)} into ${instruction.targetLabel} once, to catch up.`
    case 'rate_bump':
      return `Add ${formatCents(instruction.amountCents)} to the ${instruction.targetLabel} transfer until ${instruction.endsOn}, to catch up.`
    case 'debt_payment':
      return `Pay ${formatCents(instruction.amountCents)} toward ${instruction.targetLabel}.`
    case 'spend_confirmation':
      return `Did the ${instruction.targetLabel} money get spent from your savings?`
  }
}
