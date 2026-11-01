/**
 * The ledger: the household's recorded events, put in order once, so every
 * figure is derived from the same facts read the same way.
 *
 * This is the middle layer between what is stored and what is shown. The
 * engine reads the events as they are (no arithmetic, no filtering beyond
 * the household) and hands them here; the position, the debt statuses, the
 * rounds and the histories all read what this returns, and nothing reads the
 * events another way. The questions of order and of what counts are
 * answered here and only here:
 *
 * - **Order** is the order recorded: `recorded_at`, then the event's id, the
 *   tie-break the database used before. Two events written in one
 *   transaction share a `recorded_at`, so an instruction's confirmation can
 *   sort before its issue; every lookup by instruction is made over the
 *   whole log, never "issued so far".
 * - **A count** of an account includes everything recorded before it: the
 *   moves and spends since a count are the ones recorded after the latest.
 * - **"Done" counts once.** An instruction's first confirmation is the one;
 *   a second (a double tap, or a press recorded before the engine refused
 *   them) is ignored everywhere -- account money, debt payments, history.
 * - **Taken back** (`event_undone`) means gone: a spend, a finish or a save
 *   back up that was undone is in no figure, only in the round log.
 * - **A spend belongs to the account it came out of**: the account recorded
 *   on the spend, never the one its part happens to be in now. A spend
 *   recorded before spends carried their account is in the account its
 *   part was in when it was recorded, read from the part's own moves
 *   (`partAccountHistory`).
 * - **A debt payment** counts toward the balance only when it was recorded
 *   after the balance was last stated, compared to the microsecond (the
 *   engine passes both as exact microsecond counts, so nothing is rounded).
 *
 * Pure: no database, no clock. `today` is not needed; nothing here depends
 * on it.
 */

import type { CloseOutSnooze } from './closeout'
import type { CivilDate } from './dates'
import type { DebtHistoryEntry, DebtPaymentMade } from './debt'
import { debtTermsChanged } from './debt'
import { compareDates } from './dates'
import {
  doneMoveOf,
  type ConfirmedInstruction,
  type EndedInstruction,
  type InstructionPurpose,
  type InstructionType,
  type IssuedInstruction,
} from './instructions'
import type { Cents } from './money'
import type { AccountMovement, ConfirmedTransfer } from './position'
import type { RoundEvent } from './rounds'
import type { Id, LineItemCycle } from './types'

/** One row of the event log, as stored. */
export interface RecordedEvent {
  id: Id
  kind: string
  /** The day it happened (`occurred_at`). */
  on: CivilDate
  /**
   * When it was recorded, as whole microseconds since the epoch in decimal:
   * exact, so two events a microsecond apart never compare equal.
   */
  recordedAtMicros: string
  payload: Record<string, unknown>
}

/** What the ledger needs besides the events: where each part is, and when each debt's balance was stated. */
export interface LedgerFacts {
  /** In any order: the ledger puts them in the order recorded. */
  events: readonly RecordedEvent[]
  lineItems: readonly { id: Id; reserveAccountId: Id }[]
  debts: readonly {
    id: Id
    balanceRecordedAtMicros: string
    /** The stated balance on the row, and the day it was true; for a debt's opening (see `debtPayments`). */
    statedBalanceCents?: Cents
    balanceAsOf?: CivilDate
    /** The day it was entered in Ballast. */
    enteredOn?: CivilDate
  }[]
}

/** A round event with whether it was taken back, for the plan's "What went out". */
export interface RoundLogEntry extends RoundEvent {
  undone: boolean
}

export interface Ledger {
  /** Every instruction issued, oldest first. */
  issued: IssuedInstruction[]
  /** One confirmation per instruction, the first, oldest first. */
  confirmed: ConfirmedInstruction[]
  ended: EndedInstruction[]
  /** Commit openings, adds, rolls and counted openings, oldest first. */
  cycleStarts: LineItemCycle[]
  /** Spends, finishes and saves back up still standing, oldest first. */
  roundEvents: RoundEvent[]
  /** The ids of every event taken back. */
  undone: ReadonlySet<Id>
  /** Every round event, undone ones included, oldest first. */
  roundLog: RoundLogEntry[]
  /** Snoozes of "did this get spent?", oldest first. */
  snoozes: CloseOutSnooze[]
  /** Each account's latest count. */
  counts: { accountId: Id; amountCents: Cents; on: CivilDate }[]
  /** Every confirmed "set the transfer", oldest first. */
  transfers: ConfirmedTransfer[]
  /** Moves marked done since each account's latest count, one entry per move, signed. */
  movesSinceCount: AccountMovement[]
  /** Spends since each account's latest count, summed per account, positive. */
  spendsSinceCount: AccountMovement[]
  /** Per debt, the payments recorded after its balance was last stated. */
  debtPaymentsSinceStated: Map<Id, DebtPaymentMade[]>
  /** Per debt, what its page lists: balances stated, payments, changes of terms. */
  debtHistory: Map<Id, DebtHistoryEntry[]>
}

const ROUND_KINDS = { spend_recorded: 'spend', round_finished: 'finish', round_saved_back_up: 'save_back_up' } as const

/** Recorded order: when recorded, then the id. */
function byRecorded(a: RecordedEvent, b: RecordedEvent): number {
  const at = BigInt(a.recordedAtMicros) - BigInt(b.recordedAtMicros)
  if (at !== 0n) return at < 0n ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function ledgerOf(facts: LedgerFacts): Ledger {
  const log = [...facts.events].sort(byRecorded)
  const accountOfItem = new Map(facts.lineItems.map((li) => [li.id, li.reserveAccountId]))

  // ---- instructions, over the whole log first (see "Order" above)
  const issued: IssuedInstruction[] = []
  const confirmedById = new Map<Id, ConfirmedInstruction>()
  const confirmedOnce: ConfirmedInstruction[] = []
  const ended: EndedInstruction[] = []
  const undone = new Set<Id>()
  for (const row of log) {
    const p = row.payload
    if (row.kind === 'instruction_issued') issued.push(issuedOf(row))
    else if (row.kind === 'instruction_confirmed') {
      const id = p.instruction_id as Id
      if (confirmedById.has(id)) continue
      const confirmation: ConfirmedInstruction = {
        instructionId: id,
        confirmedOn: row.on,
        actualAmountCents: (p.actual_amount_cents as Cents | null) ?? undefined,
      }
      confirmedById.set(id, confirmation)
      confirmedOnce.push(confirmation)
    } else if (row.kind === 'instruction_ended') {
      ended.push({ instructionId: p.instruction_id as Id, endedOn: row.on })
    } else if (row.kind === 'event_undone') undone.add(p.event_id as Id)
  }
  const issuedById = new Map(issued.map((i) => [i.instructionId, i]))
  /** The event that first confirmed each instruction: only that one counts. */
  const firstConfirmation = new Map<Id, Id>()
  for (const row of log) {
    if (row.kind !== 'instruction_confirmed') continue
    const id = row.payload.instruction_id as Id
    if (!firstConfirmation.has(id)) firstConfirmation.set(id, row.id)
  }

  // ---- one pass in recorded order for everything else
  const cycleStarts: LineItemCycle[] = []
  const roundEvents: RoundEvent[] = []
  const roundLog: RoundLogEntry[] = []
  const snoozes: CloseOutSnooze[] = []
  const counts = new Map<Id, { amountCents: Cents; on: CivilDate }>()
  const moves = new Map<Id, Cents[]>()
  const spends = new Map<Id, Cents>()
  const transfers: ConfirmedTransfer[] = []
  const addSpend = (accountId: Id | undefined, cents: Cents) => {
    if (accountId) spends.set(accountId, (spends.get(accountId) ?? 0) + cents)
  }
  const accountAt = partAccountHistory(log, accountOfItem)
  // The account the spend came out of: recorded on it, or -- for one recorded
  // before spends carried it -- the account its part was in when it was
  // recorded, read from the part's own moves.
  const spendAccount = (p: Record<string, unknown>, row: RecordedEvent) =>
    (p.reserve_account_id as Id | undefined) ?? accountAt(p.line_item_id as Id, row)

  for (const row of log) {
    const p = row.payload
    switch (row.kind) {
      case 'package_committed':
        for (const o of (p.openings as { line_item_id: Id; amount_cents: Cents }[] | undefined) ?? []) {
          if (o.amount_cents > 0) {
            cycleStarts.push({
              lineItemId: o.line_item_id,
              startDate: row.on,
              openingCents: o.amount_cents,
              recordedOrder: cycleStarts.length,
              origin: 'commit',
            })
          }
        }
        break
      case 'line_item_added':
        cycleStarts.push({
          lineItemId: p.line_item_id as Id,
          startDate: row.on,
          openingCents: 0,
          recordedOrder: cycleStarts.length,
          origin: 'added',
        })
        break
      case 'opening_recorded':
        cycleStarts.push({
          lineItemId: p.line_item_id as Id,
          startDate: row.on,
          openingCents: p.opening_cents as Cents,
          recordedOrder: cycleStarts.length,
          origin: 'counted',
        })
        break
      case 'balance_confirmed': {
        const accountId = p.reserve_account_id as Id
        counts.set(accountId, { amountCents: p.amount_cents as Cents, on: row.on })
        // A count includes everything recorded before it.
        moves.delete(accountId)
        spends.delete(accountId)
        break
      }
      // A spend from before D53, rolling a repeating part on.
      case 'spend_confirmed':
        addSpend(spendAccount(p, row), p.actual_amount_cents as Cents)
        if (p.rolled_to) {
          cycleStarts.push({
            lineItemId: p.line_item_id as Id,
            startDate: row.on,
            openingCents: 0,
            recordedOrder: cycleStarts.length,
            origin: 'rolled',
          })
        }
        break
      case 'spend_recorded':
      case 'round_finished':
      case 'round_saved_back_up': {
        const entry: RoundLogEntry = {
          eventId: row.id,
          kind: ROUND_KINDS[row.kind],
          lineItemId: p.line_item_id as Id,
          roundDue: p.round_due as CivilDate,
          amountCents: (p.amount_cents as Cents | undefined) ?? 0,
          on: row.on,
          undone: undone.has(row.id),
        }
        roundLog.push(entry)
        if (entry.undone) break
        const { undone: _undone, ...event } = entry
        roundEvents.push(event)
        if (row.kind === 'spend_recorded') addSpend(spendAccount(p, row), entry.amountCents)
        break
      }
      case 'close_out_snoozed':
        snoozes.push({
          lineItemId: p.line_item_id as Id,
          dueDate: p.due_date as CivilDate,
          until: p.until as CivilDate,
        })
        break
      case 'instruction_confirmed': {
        if (firstConfirmation.get(p.instruction_id as Id) !== row.id) break
        const instruction = issuedById.get(p.instruction_id as Id)
        const confirmation = confirmedById.get(p.instruction_id as Id)
        if (!instruction || !confirmation) break
        if (instruction.type === 'set_weekly_transfer') {
          transfers.push({
            accountId: instruction.targetId,
            perWeekCents: confirmation.actualAmountCents ?? instruction.amountCents,
            confirmedOn: row.on,
          })
          break
        }
        // One entry per move, so the position can say what went in and what
        // went out, not only the net.
        const move = doneMoveOf(instruction, confirmation)
        if (move) moves.set(instruction.targetId, [...(moves.get(instruction.targetId) ?? []), move.amountCents])
        break
      }
      default:
        break
    }
  }

  const { sinceStated, history } = debtPayments(log, facts.debts, issuedById, firstConfirmation)

  return {
    issued,
    confirmed: confirmedOnce,
    ended,
    cycleStarts,
    roundEvents,
    undone,
    roundLog,
    snoozes,
    counts: [...counts].map(([accountId, c]) => ({ accountId, ...c })),
    transfers,
    movesSinceCount: [...moves].flatMap(([accountId, list]) => list.map((amountCents) => ({ accountId, amountCents }))),
    spendsSinceCount: [...spends].map(([accountId, amountCents]) => ({ accountId, amountCents })),
    debtPaymentsSinceStated: sinceStated,
    debtHistory: history,
  }
}

/**
 * Which account a part was in at the moment an event was recorded. Every
 * move of a part between accounts is a `line_item_changed` with the account
 * before and after (since migration 0004), so: the account after its last
 * move recorded before the event; else the account before its first move
 * after it; else, never moved, the account it is in now -- or, for a part
 * since deleted with its plan, the one `package_deleted` recorded, or the
 * one `package_created` recorded.
 */
function partAccountHistory(
  log: readonly RecordedEvent[],
  accountOfItem: ReadonlyMap<Id, Id>,
): (lineItemId: Id, at: RecordedEvent) => Id | undefined {
  const moves = new Map<Id, { row: RecordedEvent; before: Id; after: Id }[]>()
  const lastKnown = new Map<Id, Id>()
  for (const row of log) {
    const p = row.payload
    if (row.kind === 'line_item_changed') {
      const before = (p.before as { reserveAccountId?: Id } | undefined)?.reserveAccountId
      const after = (p.after as { reserveAccountId?: Id } | undefined)?.reserveAccountId
      if (before && after) {
        const id = p.line_item_id as Id
        moves.set(id, [...(moves.get(id) ?? []), { row, before, after }])
      }
    } else if (row.kind === 'package_created' || row.kind === 'package_deleted') {
      for (const item of (p.line_items as { line_item_id: Id; reserve_account_id?: Id }[] | undefined) ?? []) {
        // A deletion says where it ended; a creation only where it began.
        if (item.reserve_account_id && (row.kind === 'package_deleted' || !lastKnown.has(item.line_item_id))) {
          lastKnown.set(item.line_item_id, item.reserve_account_id)
        }
      }
    }
  }
  return (lineItemId, at) => {
    const mine = moves.get(lineItemId) ?? []
    const before = mine.filter((m) => byRecorded(m.row, at) < 0)
    if (before.length > 0) return before[before.length - 1]!.after
    if (mine.length > 0) return mine[0]!.before
    return accountOfItem.get(lineItemId) ?? lastKnown.get(lineItemId)
  }
}

function issuedOf(row: RecordedEvent): IssuedInstruction {
  const p = row.payload as {
    instruction_id: Id
    type: InstructionType
    amount_cents: Cents
    target_id: Id
    target_label: string
    note?: string | null
    ends_on?: CivilDate | null
    purpose?: InstructionPurpose | null
    available_on?: CivilDate | null
  }
  return {
    instructionId: p.instruction_id,
    type: p.type,
    issuedOn: row.on,
    amountCents: p.amount_cents,
    targetId: p.target_id,
    targetLabel: p.target_label,
    note: p.note ?? undefined,
    endsOn: p.ends_on ?? undefined,
    purpose: p.purpose ?? undefined,
    availableOn: p.available_on ?? undefined,
  }
}

/**
 * Debt payments (D49 (1)-(3)): one from the payment form (the regular
 * payment) or "Done" on a "Pay $X toward" to-do (money on top), at the
 * amount the person said. The balance reads those recorded after it was
 * stated; the history reads all of them.
 */
function debtPayments(
  log: readonly RecordedEvent[],
  debts: LedgerFacts['debts'],
  issuedById: ReadonlyMap<Id, IssuedInstruction>,
  firstConfirmation: ReadonlyMap<Id, Id>,
): { sinceStated: Map<Id, DebtPaymentMade[]>; history: Map<Id, DebtHistoryEntry[]> } {
  const statedAt = new Map(debts.map((d) => [d.id, BigInt(d.balanceRecordedAtMicros)]))
  // Debts whose entry is in the log, and those whose stated balance anything
  // has changed since they were entered (a statement, a payment of either kind).
  const added = new Set<Id>()
  const touched = new Set<Id>()
  const sinceStated = new Map<Id, DebtPaymentMade[]>()
  const own = new Map<Id, DebtHistoryEntry[]>()
  const todo = new Map<Id, DebtHistoryEntry[]>()
  const push = <T>(map: Map<Id, T[]>, id: Id, value: T) => map.set(id, [...(map.get(id) ?? []), value])
  const afterStated = (debtId: Id, row: RecordedEvent) => {
    const at = statedAt.get(debtId)
    return at !== undefined && BigInt(row.recordedAtMicros) > at
  }

  for (const row of log) {
    const p = row.payload
    // The balance stated when the debt was entered, and each one stated since.
    // The zero a clearing payment records is the payment's, already listed.
    if (row.kind === 'debt_added') added.add(p.debt_id as Id)
    if (row.kind === 'debt_balance_updated' || row.kind === 'payment_confirmed') touched.add(p.debt_id as Id)
    if (row.kind === 'instruction_confirmed') {
      const instruction = issuedById.get(p.instruction_id as Id)
      if (instruction?.type === 'debt_payment') touched.add(instruction.targetId)
    }
    if (row.kind === 'debt_added') {
      // Dated by the day the balance was true, which may be before it was typed.
      push(own, p.debt_id as Id, {
        on: (p.as_of as CivilDate | undefined) ?? row.on,
        kind: 'stated',
        amountCents: p.balance_cents as Cents,
      })
    } else if (row.kind === 'debt_balance_updated' && !p.cleared_by_payment) {
      push(own, p.debt_id as Id, { on: row.on, kind: 'stated', amountCents: p.balance_cents as Cents })
    } else if (row.kind === 'payment_confirmed') {
      const debtId = p.debt_id as Id
      push(own, debtId, { on: row.on, kind: 'paid', amountCents: p.amount_cents as Cents })
      if (afterStated(debtId, row)) {
        push(sinceStated, debtId, { on: row.on, amountCents: p.amount_cents as Cents, regular: true })
      }
    } else if (row.kind === 'debt_updated') {
      const changed = debtTermsChanged(
        (p.before as Record<string, unknown>) ?? {},
        (p.after as Record<string, unknown>) ?? {},
      )
      if (changed.length > 0) push(own, p.debt_id as Id, { on: row.on, kind: 'terms', changed })
    } else if (row.kind === 'instruction_confirmed') {
      const instructionId = p.instruction_id as Id
      if (firstConfirmation.get(instructionId) !== row.id) continue
      const instruction = issuedById.get(instructionId)
      if (instruction?.type !== 'debt_payment') continue
      const amountCents = (p.actual_amount_cents as Cents | null) ?? instruction.amountCents
      push(todo, instruction.targetId, { on: row.on, kind: 'paid_todo', amountCents })
      if (afterStated(instruction.targetId, row)) {
        push(sinceStated, instruction.targetId, { on: row.on, amountCents, regular: false })
      }
    }
  }

  // A debt entered before its creation was recorded opens with what can still
  // be known of it: untouched since, its row holds exactly the balance it was
  // entered with; changed since (restated, paid, or rewritten by migration
  // 0018 or a pre-Phase-4 payoff), that balance is gone, and it opens with
  // the day it was entered, never a guessed figure.
  const opening = new Map<Id, DebtHistoryEntry>()
  for (const d of debts) {
    if (added.has(d.id)) continue
    if (!touched.has(d.id) && d.statedBalanceCents !== undefined && d.balanceAsOf) {
      opening.set(d.id, { on: d.balanceAsOf, kind: 'stated', amountCents: d.statedBalanceCents })
    } else if (d.enteredOn) {
      opening.set(d.id, { on: d.enteredOn, kind: 'entered' })
    }
  }

  // A debt's own events, then its to-do payments, merged by day; within a
  // day, each list in the order recorded.
  const history = new Map<Id, DebtHistoryEntry[]>()
  for (const id of new Set([...opening.keys(), ...own.keys(), ...todo.keys()])) {
    const first = opening.get(id)
    const entries = [...(first ? [first] : []), ...(own.get(id) ?? []), ...(todo.get(id) ?? [])]
    history.set(
      id,
      entries.sort((a, b) => compareDates(a.on, b.on)),
    )
  }
  return { sinceStated, history }
}
