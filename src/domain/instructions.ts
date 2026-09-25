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
import { accrualWeeksBetween, compareDates, minDate, type CivilDate } from './dates'
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
    const shortened = stopAdjustment(adjustment, stoppedOn)
    if (shortened) accepted.push(shortened)
  }
  return { accepted, pending }
}

/** The part of a bump or cut that ran before it was stopped, or null if none did. */
function stopAdjustment(a: DriftAdjustment, stoppedOn: CivilDate): DriftAdjustment | null {
  const endDate = minDate(a.endDate, stoppedOn)
  if (compareDates(endDate, a.startDate) <= 0) return null
  const amountCents = componentDeliveredBy(driftAdjustmentComponent(a), endDate)
  if (amountCents === 0) return null
  return { ...a, endDate, amountCents }
}

/**
 * Everything still on the way into (or out of) one account that a check-in
 * must not offer again (D18): bumps and cuts running or waiting, and one-time
 * catch-up moves and move-outs still on the to-do list. A one-time move
 * already marked done is not here: that money is in the bank, and the next
 * balance the person reads includes it.
 */
export interface OpenCommitments {
  reserveAccountId: Id
  /** Confirmed bumps and cuts, shortened if stopped. */
  running: DriftAdjustment[]
  /** Offered bumps and cuts nobody has acted on yet. */
  pending: DriftAdjustment[]
  /** One-time catch-up moves (positive) and move-outs (negative) still open, at their full amount. */
  pendingMoves: { instructionId: Id; amountCents: Cents }[]
}

export function openCommitmentsFor(args: {
  reserveAccountId: Id
  accepted: readonly DriftAdjustment[]
  pending: readonly DriftAdjustment[]
  outstanding: readonly OutstandingInstruction[]
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
  }
}

/** What a bump or cut will still put into (positive) or take out of (negative) the account after `from`. */
export function adjustmentRemainingAfter(a: DriftAdjustment, from: CivilDate): Cents {
  return a.amountCents - componentDeliveredBy(driftAdjustmentComponent(a), from)
}

/**
 * What the open commitments will still deliver after the day a balance was
 * read (D18): the signed sum of every bump or cut's undelivered remainder past
 * that day, plus every open one-time move in full. A check-in adds this to
 * the raw gap, so a catch-up already running or already offered is never
 * offered a second time.
 */
export function committedAfter(args: { commitments: OpenCommitments; from: CivilDate }): Cents {
  const { commitments, from } = args
  const dated = [...commitments.running, ...commitments.pending].reduce(
    (sum, a) => sum + adjustmentRemainingAfter(a, from),
    0,
  )
  const moves = commitments.pendingMoves.reduce((sum, m) => sum + m.amountCents, 0)
  return dated + moves
}

/**
 * What is waiting on the to-do list for this account, by kind and at full
 * amount, every figure positive. A fresh offer of the same kind replaces the
 * waiting one (D18), so the offer is sized to carry it; see `catchUpOptions`.
 */
export interface PendingByKind {
  bumpCents: Cents
  cutCents: Cents
  moveCents: Cents
  moveOutCents: Cents
}

export function pendingByKind(commitments: OpenCommitments): PendingByKind {
  const totals: PendingByKind = { bumpCents: 0, cutCents: 0, moveCents: 0, moveOutCents: 0 }
  for (const a of commitments.pending) {
    if (a.amountCents > 0) totals.bumpCents += a.amountCents
    else totals.cutCents += -a.amountCents
  }
  for (const m of commitments.pendingMoves) {
    if (m.amountCents > 0) totals.moveCents += m.amountCents
    else totals.moveOutCents += -m.amountCents
  }
  return totals
}

/** The weekly figure a bump or cut reads at: the same rounding the transfer instruction uses. */
export function adjustmentPerWeekCents(a: DriftAdjustment): Cents {
  return componentRatePerWeekCents(driftAdjustmentComponent(a))
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
}): RunningAdjustment[] {
  return args.running
    .filter((a) => isComponentActive(driftAdjustmentComponent(a), args.today))
    .map((a) => ({
      instructionId: a.id,
      perWeekCents: adjustmentPerWeekCents(a),
      endDate: a.endDate,
      remainingCents: adjustmentRemainingAfter(a, args.today),
    }))
    .sort((a, b) => compareDates(a.endDate, b.endDate))
}

/**
 * What to put first when a fresh balance reads AHEAD on an account with a
 * catch-up bump running (D18): stop that bump today. The count, ease-off and
 * move-out choices then apply to what is left of the extra once the bump's
 * undelivered remainder is taken off it. If the remainder is more than the
 * extra, stopping leaves the account short by the difference, which the
 * next check-in picks up; the sentence says so rather than hiding it.
 *
 * With more than one bump running, the one ending last is offered: it is
 * the most recent catch-up, and the next check-in offers the next.
 */
export interface StopCatchUpOffer extends RunningAdjustment {
  /** The extra still to deal with once this bump stops. */
  leftCents: Cents
  /** How far short stopping leaves the account, when the bump had more to add than the extra. */
  shortAfterCents: Cents
}

export function stopCatchUpOffer(args: {
  running: readonly DriftAdjustment[]
  today: CivilDate
  extraCents: Cents
}): StopCatchUpOffer | null {
  if (args.extraCents <= 0) return null
  const bump = runningAdjustments(args)
    .filter((a) => a.perWeekCents > 0)
    .at(-1)
  if (!bump) return null
  return {
    ...bump,
    leftCents: Math.max(0, args.extraCents - bump.remainingCents),
    shortAfterCents: Math.max(0, bump.remainingCents - args.extraCents),
  }
}

/** The sentence for that offer. Plain language (PRD §9). */
export function stopCatchUpSentence(offer: StopCatchUpOffer): string {
  return `Stop the ${formatCents(offer.perWeekCents)} a week catch-up (it was going to run until ${offer.endDate})`
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
