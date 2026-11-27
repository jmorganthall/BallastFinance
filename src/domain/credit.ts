/**
 * Paid on credit: money a plan spent that went on a card or a line of
 * credit, and the two steps that put it right (asked for by the household on
 * Nov 27, 2026):
 *
 * 1. **Move** what the plan spent out of the plan's account into the account
 *    the household pays bills from (the bills account), one move per account
 *    however many charges it covers.
 * 2. **Pay** the card from the bills account, one payment per card however
 *    many charges it covers.
 *
 * A charge is a spend like any other (it comes off the plan's round and the
 * account's money today the moment it is recorded); what it adds is the card
 * it went on. Until it is paid it sits on the card, which shows it, but it
 * is never part of what the debts' payoff order, statuses or share-out work
 * on: it is the plan's money, already set aside, on its way to the card.
 * It is always paid in full, never in part.
 *
 * Facts (all events, never edited):
 * - `spend_recorded` with a `debt_id`: the charge.
 * - `credit_moved`: the move done, naming the charges it covered.
 * - `credit_paid`: the payment done, naming the charges it covered.
 * - the `bills_account` setting: where the money goes before the card.
 *
 * Pure; nothing about it is stored.
 */

import { z } from 'zod'
import type { CivilDate } from './dates'
import { formatCents, type Cents } from './money'
import type { SentencePart } from './instructions'
import type { Id } from './types'

// ---------------------------------------------------------------- the facts

const id = z.string().min(1)
const cents = z.number().int().positive()

/** The payload of a `credit_moved` event. */
export const creditMovedPayload = z.object({
  /** The account the money came out of (the plans' account). */
  from_reserve_account_id: id,
  /**
   * The bills account it went into, when that is an account in Ballast;
   * null when the household pays bills from an account Ballast does not
   * hold (or had not said which when the move was done).
   */
  to_reserve_account_id: id.nullable(),
  /** The charges (their `spend_recorded` event ids) the move covered. */
  charge_ids: z.array(id).min(1),
  amount_cents: cents,
})
export type CreditMovedPayload = z.infer<typeof creditMovedPayload>

/** The payload of a `credit_paid` event. */
export const creditPaidPayload = z.object({
  debt_id: id,
  /** The charges (their `spend_recorded` event ids) the payment covered. */
  charge_ids: z.array(id).min(1),
  amount_cents: cents,
})
export type CreditPaidPayload = z.infer<typeof creditPaidPayload>

/**
 * The account the household pays bills from, the `bills_account` setting:
 * one of Ballast's accounts, or one Ballast does not hold, by the name the
 * household knows it by. No setting at all (null where it is read) means
 * they have not said yet; the to-dos then say "the account you pay bills
 * from".
 */
export const billsAccountSetting = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reserve_account'), accountId: id }),
  z.object({ kind: z.literal('named'), name: z.string().trim().min(1).max(80) }),
])
export type BillsAccount = z.infer<typeof billsAccountSetting>

/** A stored `bills_account` value, read; anything else reads as not said yet. */
export function billsAccountOf(stored: unknown): BillsAccount | null {
  const parsed = billsAccountSetting.safeParse(stored)
  return parsed.success ? parsed.data : null
}

/** One charge: a plan's spend that went on a card. */
export interface CreditCharge {
  /** The `spend_recorded` event's id. */
  chargeId: Id
  lineItemId: Id
  roundDue: CivilDate
  /**
   * The account the plan's money is in, the one the move comes out of.
   * Undefined only for a part whose account can no longer be known (never
   * for a charge recorded since paying on credit was added: every spend
   * records its account).
   */
  accountId: Id | undefined
  debtId: Id
  amountCents: Cents
  on: CivilDate
  /** When it was recorded, in exact microseconds (see `RecordedEvent`). */
  recordedAtMicros: string
  /**
   * The move into the bills account that covered it; null while it has not
   * been moved (still in the plan's account, or never needing a move because
   * the plan's account is the bills account).
   */
  moved: { on: CivilDate; toAccountId: Id | null } | null
  /** The day the card was paid for it; null while it is still on the card. */
  paidOn: CivilDate | null
  /** When that payment was recorded, in exact microseconds; null while it is still on the card. */
  paidAtMicros: string | null
}

// ---------------------------------------------------------------- the to-dos

/** What the screens need to name things; the engine fills it from rows. */
export interface CreditNames {
  accounts: ReadonlyMap<Id, string>
  debts: ReadonlyMap<Id, string>
  /** Each part's label, "Plan · Part". */
  parts: ReadonlyMap<Id, string>
}

/** One charge as a to-do lists it. */
export interface CreditChargeLine {
  chargeId: Id
  partLabel: string
  debtName: string
  amountCents: Cents
  on: CivilDate
}

export type CreditTodo =
  | {
      kind: 'move_to_bills'
      /** The plans' account the money comes out of. */
      fromAccountId: Id
      fromAccountName: string
      /** Where it goes, in words (a Ballast account, a named one, or "the account you pay bills from"). */
      toName: string
      amountCents: Cents
      charges: CreditChargeLine[]
    }
  | {
      kind: 'pay_card'
      debtId: Id
      debtName: string
      /** Where the payment comes from, in words. */
      fromName: string
      amountCents: Cents
      charges: CreditChargeLine[]
    }

/** The words for the bills account when the household has not said which. */
export const UNSAID_BILLS_ACCOUNT = 'the account you pay bills from'

export function billsAccountName(bills: BillsAccount | null, accounts: ReadonlyMap<Id, string>): string {
  if (!bills) return UNSAID_BILLS_ACCOUNT
  if (bills.kind === 'named') return bills.name
  return accounts.get(bills.accountId) ?? UNSAID_BILLS_ACCOUNT
}

/**
 * The to-dos the charges still open call for, in a fixed order (moves by
 * account name, then payments by card name):
 *
 * - **Move**: every charge not yet moved or paid whose plan's account is not
 *   the bills account, summed per account, so seven charges out of one
 *   account are one move.
 * - **Pay**: once nothing on a card still waits to be moved, every charge on
 *   it not yet paid, summed per card, so it is one payment. A charge whose
 *   plan's account is the bills account needs no move and goes straight to
 *   the payment.
 */
export function creditTodos(args: {
  charges: readonly CreditCharge[]
  bills: BillsAccount | null
  names: CreditNames
}): CreditTodo[] {
  const { charges, bills, names } = args
  const billsAccountId = bills?.kind === 'reserve_account' ? bills.accountId : null
  const billsName = billsAccountName(bills, names.accounts)
  const open = charges.filter((c) => c.paidOn === null)
  const needsMove = (c: CreditCharge) => c.moved === null && (c.accountId === undefined || c.accountId !== billsAccountId)
  const line = (c: CreditCharge): CreditChargeLine => ({
    chargeId: c.chargeId,
    partLabel: names.parts.get(c.lineItemId) ?? 'A part since removed',
    debtName: names.debts.get(c.debtId) ?? 'A debt since removed',
    amountCents: c.amountCents,
    on: c.on,
  })
  const sum = (list: readonly CreditCharge[]) => list.reduce((total, c) => total + c.amountCents, 0)

  const moves = new Map<Id, CreditCharge[]>()
  for (const c of open.filter(needsMove)) {
    // A charge whose account cannot be known has nowhere to move from; it
    // waits on nothing and goes to the payment like one in the bills account.
    if (c.accountId === undefined) continue
    moves.set(c.accountId, [...(moves.get(c.accountId) ?? []), c])
  }
  const waitingOnMove = new Set([...moves.values()].flat().map((c) => c.debtId))
  const payments = new Map<Id, CreditCharge[]>()
  for (const c of open) {
    if (waitingOnMove.has(c.debtId)) continue
    payments.set(c.debtId, [...(payments.get(c.debtId) ?? []), c])
  }

  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
  return [
    ...[...moves]
      .map(([accountId, list]) => ({ name: names.accounts.get(accountId) ?? 'An account since removed', accountId, list }))
      .sort(byName)
      .map(
        ({ name, accountId, list }): CreditTodo => ({
          kind: 'move_to_bills',
          fromAccountId: accountId,
          fromAccountName: name,
          toName: billsName,
          amountCents: sum(list),
          charges: list.map(line),
        }),
      ),
    ...[...payments]
      .map(([debtId, list]) => ({ name: names.debts.get(debtId) ?? 'A debt since removed', debtId, list }))
      .sort(byName)
      .map(
        ({ name, debtId, list }): CreditTodo => ({
          kind: 'pay_card',
          debtId,
          debtName: name,
          fromName: billsName,
          amountCents: sum(list),
          charges: list.map(line),
        }),
      ),
  ]
}

/** A stable key for a to-do, for lists and for the household view. */
export function creditTodoKey(todo: CreditTodo): string {
  return todo.kind === 'move_to_bills' ? `credit_move:${todo.fromAccountId}` : `credit_pay:${todo.debtId}`
}

/** The to-do's sentence, the piece naming where the money goes set apart. */
export function creditTodoSentenceParts(todo: CreditTodo): SentencePart[] {
  const t = (text: string): SentencePart => ({ text })
  const amount = formatCents(todo.amountCents)
  if (todo.kind === 'move_to_bills') {
    const cards = [...new Set(todo.charges.map((c) => c.debtName))]
    return [
      t(`Move ${amount} from ${todo.fromAccountName} into `),
      { text: todo.toName, target: true },
      t(` to pay off what went on ${joinNames(cards)}.`),
    ]
  }
  return [
    t(`Pay ${amount} to `),
    { text: todo.debtName, target: true },
    t(` from ${todo.fromName}, for what went on it from plans.`),
  ]
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The to-do in one line of words, for the digest. */
export function creditTodoSentence(todo: CreditTodo): string {
  return creditTodoSentenceParts(todo)
    .map((part) => part.text)
    .join('')
}

// ---------------------------------------------------------------- the card

/**
 * What a debt's figures are made of, once its charges from plans are
 * counted (Josh's answers 1 and 2): the card shows them the moment they are
 * recorded and drops them when they are paid; the payoff order, the statuses
 * and the share-out never see them.
 *
 * `likelyCents` is the debt's likely balance from its stated one and its
 * payments (D49 (2)-(3)). Charges and payments for them recorded before the
 * balance was stated are already in it; those after are added and taken off
 * here.
 */
export function debtWithCharges(args: {
  likelyCents: Cents
  /** Charges on it recorded after its balance was stated, paid or not. */
  chargedSinceStatedCents: Cents
  /** Payments for charges recorded after its balance was stated. */
  paidSinceStatedCents: Cents
  /** Charges on it not yet paid, whenever recorded. */
  onCardCents: Cents
}): { balanceCents: Cents; onCardFromPlansCents: Cents } {
  const shown = Math.max(0, args.likelyCents + args.chargedSinceStatedCents - args.paidSinceStatedCents)
  return {
    balanceCents: Math.max(0, shown - args.onCardCents),
    onCardFromPlansCents: args.onCardCents,
  }
}
