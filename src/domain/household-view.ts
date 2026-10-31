/**
 * The household view (PRD D56): the one thing This week, the digest and
 * the share-out read for what to do and whether the household is caught up.
 *
 * It puts together the position's to-dos (D35, D40), the debts' to-dos
 * (D49) and the asks still open (a share-out's, or one from before D35),
 * in one order, each saying whether "All caught up" waits on it. No screen
 * adds a to-do, drops one, counts them or orders them for itself.
 *
 * - **Order**: the position's to-dos, then the debts' that block, then the
 *   asks still open, then the debts' housekeeping. Asks not yet available
 *   (the second half of the fun money) are listed apart, as coming up.
 * - **An open ask blocks** exactly when the account or debt it concerns is,
 *   on what has been done, not On track: the to-dos for it were worked out
 *   as if the ask is done (D56 (2)), so the run-forward depends on it. One
 *   that lowered nothing -- fun money, a left-over, a move into an account
 *   already fine, a payment toward a debt already on track -- is optional.
 * - **All caught up** is D35 (6): every account On track on its confirmed
 *   transfer, every deal cleared in time, and nothing that blocks open.
 * - **Needs attention** counts the accounts "All caught up" judges (those
 *   with plans) that are not On track, and the debts that are not, so the
 *   headline and the verdict never disagree.
 *
 * Pure; nothing about it is stored.
 */

import { attentionHeadline, householdCaughtUp, type DebtStatuses, type DebtTodo } from './debt-status'
import type { OutstandingInstruction } from './instructions'
import type { DerivedTodo, HouseholdPosition } from './position'

/** An ask open this many days or more reads as waiting too long. */
export const ASK_STALE_AFTER_DAYS = 7

export type HouseholdTodo =
  | { from: 'position'; key: string; blocking: boolean; todo: DerivedTodo }
  | { from: 'debt'; key: string; blocking: boolean; todo: DebtTodo }
  | { from: 'ask'; key: string; blocking: boolean; ask: OutstandingInstruction; stale: boolean }

export interface HouseholdView {
  /** Everything to do now, in the order every screen shows it. */
  todos: HouseholdTodo[]
  /** Asks open but not available yet: listed apart, never blocking. */
  comingUp: OutstandingInstruction[]
  /** D35 (6), with every open ask that blocks counted. */
  caughtUp: boolean
  /** To-dos listed while nothing blocks: what "optional to-dos" counts. */
  optionalCount: number
  /** How many to-dos block "All caught up". */
  blockingCount: number
  /**
   * Anything listed that moves money (every position to-do, a debt's that
   * blocks, any open ask): the count of what accounts hold is asked for
   * only once none is left (D34).
   */
  moneyToDo: boolean
  needsAttention: { accounts: number; debts: number }
  /** "One account needs you", "Nothing needs you", ... for the headline. */
  headline: string
}

export function householdView(args: {
  position: HouseholdPosition
  debts: DebtStatuses
  open: readonly OutstandingInstruction[]
}): HouseholdView {
  const { position, debts } = args
  const accountStatus = new Map(position.accounts.map((a) => [a.account.id, a.status]))
  const debtStatus = new Map(debts.debts.map((d) => [d.debt.id, d.status]))
  const askBlocks = (ask: OutstandingInstruction) => {
    if (ask.type === 'one_time_move' && ask.purpose === 'left_over') return false
    const status = ask.type === 'debt_payment' ? debtStatus.get(ask.targetId) : accountStatus.get(ask.targetId)
    return status !== undefined && status !== 'on_track'
  }

  const now = args.open.filter((i) => i.dueNow)
  const todos: HouseholdTodo[] = [
    ...position.todos.map(
      (todo): HouseholdTodo => ({
        from: 'position',
        key: todo.kind === 'move_between' ? `${todo.kind}:${todo.fromAccountId}:${todo.accountId}` : `${todo.kind}:${todo.accountId}`,
        blocking: todo.blocking,
        todo,
      }),
    ),
    ...debts.todos
      .filter((t) => t.blocking)
      .map((todo): HouseholdTodo => ({ from: 'debt', key: `${todo.kind}:${todo.debtId}`, blocking: true, todo })),
    ...now.map(
      (ask): HouseholdTodo => ({
        from: 'ask',
        key: ask.instructionId,
        blocking: askBlocks(ask),
        ask,
        stale: ask.ageInDays >= ASK_STALE_AFTER_DAYS,
      }),
    ),
    ...debts.todos
      .filter((t) => !t.blocking)
      .map((todo): HouseholdTodo => ({ from: 'debt', key: `${todo.kind}:${todo.debtId}`, blocking: false, todo })),
  ]

  const blockingCount = todos.filter((t) => t.blocking).length
  const caughtUp = householdCaughtUp(position, debts) && blockingCount === 0
  const needsAttention = {
    accounts: position.accounts.filter((a) => a.parts.length > 0 && a.status !== 'on_track').length,
    debts: debts.debts.filter((d) => d.status !== 'on_track').length,
  }
  return {
    todos,
    comingUp: args.open.filter((i) => !i.dueNow),
    caughtUp,
    optionalCount: caughtUp ? todos.length : 0,
    blockingCount,
    moneyToDo: todos.some((t) => t.from === 'position' || t.from === 'ask' || t.blocking),
    needsAttention,
    headline: attentionWords(needsAttention.accounts, needsAttention.debts, caughtUp),
  }
}

function attentionWords(accounts: number, debts: number, caughtUp: boolean): string {
  // Not caught up with every account and debt fine: an ask still open is what waits.
  if (accounts + debts === 0 && !caughtUp) return 'A to-do needs you'
  return attentionHeadline(accounts, debts)
}
