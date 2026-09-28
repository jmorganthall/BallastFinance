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

import {
  componentDeliveredBy,
  componentRatePerWeekCents,
  driftAdjustmentComponent,
  isComponentActive,
} from './accrual'
import {
  accrualWeeksBetween,
  compareDates,
  DEFAULT_TRANSFER_WEEKDAY,
  minDate,
  type CivilDate,
  type Weekday,
} from './dates'
import { ceilDiv, formatCents, type Cents } from './money'
import type { DriftAdjustment, Id } from './types'

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

/**
 * An instruction a person ended early (PRD D18, rev 28). For an open ask it
 * is a withdrawal: "not doing this". For a confirmed bump or cut it is a stop:
 * the transfer was changed back in the bank that day, so the adjustment's
 * window closes on `endedOn` rather than the day it was going to run to.
 * Nothing is edited in place; this is one more fact folded in.
 */
export interface EndedInstruction {
  instructionId: Id
  endedOn: CivilDate
}

/**
 * Which asks replace each other (D18). A newer ask of the same kind on the
 * same account supersedes the older one, so a stale to-do never accumulates:
 * "set the transfer to $210" replaces "set it to $180", and a fresh catch-up
 * bump replaces the one still waiting. A one-time move only does so when it
 * is a catch-up: a share-out or cover move is its own ask, sized by a
 * different rule, and must never make a catch-up move disappear (or the
 * reverse). Everything else is an ask in its own right.
 */
function supersedeKey(instruction: IssuedInstruction): string | null {
  switch (instruction.type) {
    case 'set_weekly_transfer':
    case 'rate_bump':
    case 'rate_cut':
    case 'one_time_move_out':
      return `${instruction.type}:${instruction.targetId}`
    case 'one_time_move':
      return (instruction.purpose ?? 'catch_up') === 'catch_up'
        ? `one_time_move:catch_up:${instruction.targetId}`
        : null
    default:
      return null
  }
}

/**
 * The asks a newer one of the same kind has replaced. Every issued ask is a
 * candidate to do the replacing, done or not: a newer ask that was already
 * confirmed, or later withdrawn, still makes the older open one stale --
 * withdrawing the replacement never brings the replaced one back. On the
 * same day the later-recorded one wins, so `issued` must arrive in the
 * order it was recorded.
 */
export function supersededInstructionIds(issued: readonly IssuedInstruction[]): Set<Id> {
  const latestByKey = new Map<string, IssuedInstruction>()
  for (const instruction of issued) {
    const key = supersedeKey(instruction)
    if (key === null) continue
    const current = latestByKey.get(key)
    if (!current || compareDates(instruction.issuedOn, current.issuedOn) >= 0) {
      latestByKey.set(key, instruction)
    }
  }
  const superseded = new Set<Id>()
  for (const instruction of issued) {
    const key = supersedeKey(instruction)
    if (key === null) continue
    if (latestByKey.get(key)?.instructionId !== instruction.instructionId) {
      superseded.add(instruction.instructionId)
    }
  }
  return superseded
}

export interface OutstandingInstruction extends IssuedInstruction {
  /** Days it has been waiting -- counted from the day it became available, not the day it was asked. */
  ageInDays: number
  /** False while its available-from day is still ahead. */
  dueNow: boolean
}

/**
 * The open asks: issued, not yet confirmed, not withdrawn, not replaced by a
 * newer ask of the same kind (see `supersededInstructionIds`); oldest first.
 */
export function outstandingInstructions(args: {
  issued: readonly IssuedInstruction[]
  confirmed: readonly ConfirmedInstruction[]
  ended?: readonly EndedInstruction[]
  today: CivilDate
}): OutstandingInstruction[] {
  const done = new Set(args.confirmed.map((c) => c.instructionId))
  const ended = new Set((args.ended ?? []).map((e) => e.instructionId))
  const superseded = supersededInstructionIds(args.issued)

  return args.issued
    .filter(
      (instruction) =>
        !done.has(instruction.instructionId) &&
        !ended.has(instruction.instructionId) &&
        !superseded.has(instruction.instructionId),
    )
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
 * Dated bumps and cuts as account-level catch-up components, split by whether
 * a human has said they did it.
 *
 * Only `accepted` moves the weekly number: an offer nobody acted on must not
 * change a transfer in either direction (PRD: nothing is done until a human
 * confirms it). `pending` exists so a screen can say what the number BECOMES
 * once the open ask is done -- otherwise the to-do ("add $18.54 a week") and
 * the account card ("set the transfer to $240") read as two instructions that
 * do not add up, and the person cannot tell whether doing one changed anything.
 * An open ask a newer one has replaced, or one withdrawn, is not pending.
 *
 * A cut is the same component with its sign flipped: the instruction stores a
 * positive "take this much off", the accrual math sees a negative delivery.
 *
 * A confirmed bump or cut the person stopped early (D18) keeps only the
 * window it actually ran: its end becomes the earlier of the planned end and
 * the day it was stopped, and its total becomes what it had delivered by then,
 * so the shortened component still delivers exactly its total by its end date
 * and reads at the same weekly rate for the weeks it ran. Stopped before its
 * first transfer, it delivered nothing and is dropped.
 */
export function driftAdjustmentsFrom(args: {
  issued: readonly IssuedInstruction[]
  confirmed: readonly ConfirmedInstruction[]
  ended?: readonly EndedInstruction[]
  /** The household's transfer day (D31): what a stopped bump delivered is counted on it. */
  transferWeekday?: Weekday
}): { accepted: DriftAdjustment[]; pending: DriftAdjustment[] } {
  const done = new Set(args.confirmed.map((c) => c.instructionId))
  const endedOn = new Map((args.ended ?? []).map((e) => [e.instructionId, e.endedOn]))
  const superseded = supersededInstructionIds(args.issued)
  const accepted: DriftAdjustment[] = []
  const pending: DriftAdjustment[] = []
  for (const i of args.issued) {
    if (i.type !== 'rate_bump' && i.type !== 'rate_cut') continue
    if (!i.endsOn) continue
    const adjustment: DriftAdjustment = {
      id: i.instructionId,
      reserveAccountId: i.targetId,
      amountCents: i.type === 'rate_cut' ? -i.amountCents : i.amountCents,
      startDate: i.issuedOn,
      endDate: i.endsOn,
    }
    const stoppedOn = endedOn.get(i.instructionId)
    if (!done.has(i.instructionId)) {
      if (stoppedOn === undefined && !superseded.has(i.instructionId)) pending.push(adjustment)
      continue
    }
    if (stoppedOn === undefined) {
      accepted.push(adjustment)
      continue
    }
    const shortened = stopAdjustment(adjustment, stoppedOn, args.transferWeekday ?? DEFAULT_TRANSFER_WEEKDAY)
    if (shortened) accepted.push(shortened)
  }
  return { accepted, pending }
}

/** The part of a bump or cut that ran before it was stopped, or null if none did. */
function stopAdjustment(
  a: DriftAdjustment,
  stoppedOn: CivilDate,
  transferWeekday: Weekday,
): DriftAdjustment | null {
  const endDate = minDate(a.endDate, stoppedOn)
  if (compareDates(endDate, a.startDate) <= 0) return null
  const amountCents = componentDeliveredBy(
    driftAdjustmentComponent(a, transferWeekday),
    endDate,
    transferWeekday,
  )
  if (amountCents === 0) return null
  return { ...a, endDate, amountCents }
}

/**
 * Everything still on the way into (or out of) one account that a check-in
 * must not offer again (D18): bumps and cuts running or waiting, and one-time
 * catch-up moves and move-outs still on the to-do list, and the one-time
 * moves marked done since the account was last counted (D34): that money is
 * in the bank, and until a count includes it the math must carry it too.
 */
export interface OpenCommitments {
  reserveAccountId: Id
  /** Confirmed bumps and cuts, shortened if stopped. */
  running: DriftAdjustment[]
  /** Offered bumps and cuts nobody has acted on yet. */
  pending: DriftAdjustment[]
  /** One-time catch-up moves (positive) and move-outs (negative) still open, at their full amount. */
  pendingMoves: { instructionId: Id; amountCents: Cents }[]
  /**
   * One-time moves marked done since this account's balance was last counted
   * (D34): money the person says is in the account that no count has seen
   * yet. Signed like `pendingMoves`, at the amount it was confirmed at. Which
   * moves came after the last count is settled by the order the events were
   * recorded, which the engine answers; the domain only sums.
   */
  doneMoves: DoneMove[]
}

/** A one-time move a person marked done, signed: into the account positive, out of it negative. */
export interface DoneMove {
  instructionId: Id
  amountCents: Cents
  confirmedOn: CivilDate
}

export function openCommitmentsFor(args: {
  reserveAccountId: Id
  accepted: readonly DriftAdjustment[]
  pending: readonly DriftAdjustment[]
  outstanding: readonly OutstandingInstruction[]
  /** This account's moves marked done since its last count, from the engine. */
  doneMoves?: readonly DoneMove[]
}): OpenCommitments {
  const mine = (a: DriftAdjustment) => a.reserveAccountId === args.reserveAccountId
  const pendingMoves: OpenCommitments['pendingMoves'] = []
  for (const i of args.outstanding) {
    if (i.targetId !== args.reserveAccountId) continue
    if (i.type === 'one_time_move' && (i.purpose ?? 'catch_up') === 'catch_up') {
      pendingMoves.push({ instructionId: i.instructionId, amountCents: i.amountCents })
    } else if (i.type === 'one_time_move_out') {
      pendingMoves.push({ instructionId: i.instructionId, amountCents: -i.amountCents })
    }
  }
  return {
    reserveAccountId: args.reserveAccountId,
    running: args.accepted.filter(mine),
    pending: args.pending.filter(mine),
    pendingMoves,
    doneMoves: [...(args.doneMoves ?? [])],
  }
}

/**
 * A one-time move marked done is a fact about the instruction, not about the
 * account; whether it lands on an account's ledger is decided here (D34). A
 * move into a reserve account counts in full and positive, a move-out
 * negative, at the amount the person confirmed if they gave one. Since D35
 * that includes a share-out's or a cover's move: the account's money today
 * is what is physically in it, and that money is. Only a "left over" ask,
 * which names no account, is not a move on any ledger; a transfer change, a
 * bump or a cut lands week by week through the transfer, not here.
 */
export function doneMoveOf(
  instruction: IssuedInstruction,
  confirmation: ConfirmedInstruction,
): DoneMove | null {
  const amount = confirmation.actualAmountCents ?? instruction.amountCents
  if (instruction.type === 'one_time_move' && instruction.purpose !== 'left_over') {
    return { instructionId: instruction.instructionId, amountCents: amount, confirmedOn: confirmation.confirmedOn }
  }
  if (instruction.type === 'one_time_move_out') {
    return { instructionId: instruction.instructionId, amountCents: -amount, confirmedOn: confirmation.confirmedOn }
  }
  return null
}

/** What the done moves add up to, in and out, so a screen can say it in words. */
export function doneMovesSummary(moves: readonly DoneMove[]): {
  inCents: Cents
  outCents: Cents
  netCents: Cents
} {
  let inCents = 0
  let outCents = 0
  for (const m of moves) {
    if (m.amountCents >= 0) inCents += m.amountCents
    else outCents += -m.amountCents
  }
  return { inCents, outCents, netCents: inCents - outCents }
}

/**
 * What an account likely holds now: its last count plus every move marked
 * done since (D34). An offer to be confirmed, never a figure stored; with no
 * count ever recorded there is nothing to add to, so null.
 */
export function likelyBalanceCents(
  lastCountCents: Cents | null,
  moves: readonly DoneMove[],
): Cents | null {
  if (lastCountCents === null) return null
  return lastCountCents + doneMovesSummary(moves).netCents
}

/** What a bump or cut will still put into (positive) or take out of (negative) the account after `from`. */
export function adjustmentRemainingAfter(
  a: DriftAdjustment,
  from: CivilDate,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): Cents {
  return (
    a.amountCents -
    componentDeliveredBy(driftAdjustmentComponent(a, transferWeekday), from, transferWeekday)
  )
}

/** The weekly figure a bump or cut reads at: the same rounding the transfer instruction uses. */
export function adjustmentPerWeekCents(
  a: DriftAdjustment,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): Cents {
  return componentRatePerWeekCents(driftAdjustmentComponent(a, transferWeekday))
}

/**
 * A running bump or cut as the account card lists it, with the day it was
 * going to run to, so the person can stop it (D18). Only ones still asking
 * for transfers after today: a finished one is history.
 */
export interface RunningAdjustment {
  instructionId: Id
  /** Positive for a bump, negative for a cut. */
  perWeekCents: Cents
  endDate: CivilDate
  /** Still to come after today: what stopping it now would leave undelivered. */
  remainingCents: Cents
}

export function runningAdjustments(args: {
  running: readonly DriftAdjustment[]
  today: CivilDate
  transferWeekday?: Weekday
}): RunningAdjustment[] {
  const transferWeekday = args.transferWeekday ?? DEFAULT_TRANSFER_WEEKDAY
  return args.running
    .filter((a) =>
      isComponentActive(driftAdjustmentComponent(a, transferWeekday), args.today, transferWeekday),
    )
    .map((a) => ({
      instructionId: a.id,
      perWeekCents: adjustmentPerWeekCents(a, transferWeekday),
      endDate: a.endDate,
      remainingCents: adjustmentRemainingAfter(a, args.today, transferWeekday),
    }))
    .sort((a, b) => compareDates(a.endDate, b.endDate))
}

/**
 * A dated bump or cut stores its TOTAL over the window (that is what the
 * accrual math delivers), but a person sets a weekly figure. The same rounding
 * as the weekly breakdown: a bump rounds up so it never under-funds, a cut
 * rounds down so it never over-cuts.
 */
export function perWeekOf(
  instruction: IssuedInstruction,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): Cents {
  const weeks = accrualWeeksBetween(
    instruction.issuedOn,
    instruction.endsOn ?? instruction.issuedOn,
    transferWeekday,
  )
  return instruction.type === 'rate_cut'
    ? -ceilDiv(-instruction.amountCents, weeks)
    : ceilDiv(instruction.amountCents, weeks)
}

/**
 * The sentence a human reads and acts on. Plain language (PRD §9). A bump or
 * cut is spoken per week, so the household's transfer day decides its figure.
 */
export function instructionSentence(
  instruction: IssuedInstruction,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): string {
  return instructionSentenceParts(instruction, transferWeekday)
    .map((part) => part.text)
    .join('')
}

/**
 * A piece of the sentence. The account or debt the money goes to is marked
 * so a screen can set it apart (D34: bold, a gentle colour); the words are
 * exactly those of `instructionSentence`, which joins these.
 */
export interface SentencePart {
  text: string
  /** True on the piece that names where the money goes. */
  target?: true
}

export function instructionSentenceParts(
  instruction: IssuedInstruction,
  transferWeekday: Weekday = DEFAULT_TRANSFER_WEEKDAY,
): SentencePart[] {
  const t = (text: string): SentencePart => ({ text })
  const target: SentencePart = { text: instruction.targetLabel, target: true }
  const amount = formatCents(instruction.amountCents)
  switch (instruction.type) {
    case 'set_weekly_transfer':
      return [t('In Capital One 360, set the recurring transfer into '), target, t(` to ${amount} per week.`)]
    case 'one_time_move': {
      const later =
        instruction.availableOn && compareDates(instruction.availableOn, instruction.issuedOn) > 0
          ? instruction.availableOn
          : null
      switch (instruction.purpose ?? 'catch_up') {
        case 'share_out':
          return later
            ? [t(`On ${later}, move ${amount} into `), target, t('.')]
            : [t(`Move ${amount} into `), target, t(', its share of what was spare.')]
        case 'cover':
          return [t(`Move ${amount} into `), target, t(' once, to cover what it is behind.')]
        case 'left_over':
          return [t(`Decide where ${amount} goes; it was the debt share with nowhere useful to go.`)]
        case 'catch_up':
          return [t(`Move ${amount} into `), target, t(' once, to catch up.')]
      }
    }
    case 'one_time_move_out':
      return [t(`Move ${amount} out of `), target, t(' once; it holds more than the plan needs.')]
    case 'rate_bump':
      return [
        t(`Add ${formatCents(perWeekOf(instruction, transferWeekday))} a week to the `),
        target,
        t(` transfer until ${instruction.endsOn}, to catch up.`),
      ]
    case 'rate_cut':
      return [
        t(`Take ${formatCents(perWeekOf(instruction, transferWeekday))} a week off the `),
        target,
        t(` transfer until ${instruction.endsOn}; the extra you already hold covers it.`),
      ]
    case 'debt_payment':
      return [t(`Pay ${amount} toward `), target, t('.')]
    case 'spend_confirmation':
      return [t('Did the '), target, t(' money get spent from your savings?')]
  }
}
