/**
 * One status per debt (PRD D49 (4)-(6)), the way the one position gives one
 * per account (D35): every screen, the digest and the share-out read a debt's
 * status, its words and its to-dos from here, and none works them out again.
 *
 * - **On track**: nothing to do.
 * - **Misses its 0%** ("Misses its deal" when the deal rate is not 0%): the
 *   payments set up now will not clear the deal balance before the deal
 *   ends. Calm amber, the way Running down is (D39): it is a later problem
 *   with a small fix in the household's hands. Its figures are the one cliff
 *   (`promoCliff`, PRD §6), so the ranking, the shortfall step and this can
 *   never disagree.
 * - **Short**: the same, inside the promo lead window (`promo_lead_weeks`),
 *   where it is no longer a later problem. Red, as an account's Short is.
 *
 * The fix is a to-do: raise the monthly payment to what clears the deal in
 * time, rounded up to the cent, which marking done records as the debt's
 * planned payment. A balance a person has not stated for more than
 * `BALANCE_STALE_AFTER_DAYS` is a to-do too, but housekeeping: it never holds
 * back "All caught up" (PRD §6).
 */

import {
  balanceFreshness,
  chargedBackInterestCents,
  DEFAULT_PROMO_LEAD_WEEKS,
  monthlyPaymentCents,
  promoCliff,
  type Debt,
} from './debt'
import type { CivilDate } from './dates'
import type { SentencePart } from './instructions'
import { formatCents, type Cents } from './money'
import type { Id } from './types'

const WEEKS_PER_MONTH = 52 / 12

export type DebtStatus = 'on_track' | 'misses_deal' | 'short'

/** A deal the payments set up now will not clear before it ends. */
export interface DebtDealMiss {
  untilDate: CivilDate
  dealRateBasisPoints: number
  /** The balance on the deal today. */
  onDealCents: Cents
  monthsLeft: number
  /** What will still be owed on the deal when it ends: the cliff. Above zero. */
  owedAtEndCents: Cents
  /** What is paid each month now: the planned payment, else the minimum. */
  paymentNowCents: Cents
  /** The monthly payment that clears the deal balance in time, rounded up. */
  clearPerMonthCents: Cents
  /**
   * The interest the deal charges back to its start when it ends unpaid
   * (D49 (9)), about; null when its terms charge nothing back.
   */
  chargedBackCents: Cents | null
}

export interface DebtView {
  debt: Debt
  status: DebtStatus
  miss: DebtDealMiss | null
  balanceAgeDays: number
  /** Its stated balance is older than `BALANCE_STALE_AFTER_DAYS`. */
  balanceStale: boolean
}

export type DebtTodo =
  | {
      kind: 'raise_debt_payment'
      debtId: Id
      debtName: string
      fromCents: Cents
      toCents: Cents
      untilDate: CivilDate
      blocking: true
    }
  | {
      /**
       * A deal entered before Ballast asked whether its interest is charged
       * back (D49 (9)): taken as yes until a person checks the card's terms.
       * Asked once; housekeeping.
       */
      kind: 'check_deal_terms'
      debtId: Id
      debtName: string
      untilDate: CivilDate
      blocking: false
    }
  | {
      kind: 'update_debt_balance'
      debtId: Id
      debtName: string
      ageDays: number
      /** The likely balance, for the box. */
      likelyCents: Cents
      blocking: false
    }

export interface DebtStatuses {
  debts: DebtView[]
  todos: DebtTodo[]
  /** No open debt Misses its deal or is Short. Stale balances never count. */
  caughtUp: boolean
}

export function debtStatuses(args: {
  debts: readonly Debt[]
  today: CivilDate
  promoLeadWeeks?: number
}): DebtStatuses {
  const leadWeeks = args.promoLeadWeeks ?? DEFAULT_PROMO_LEAD_WEEKS
  const views: DebtView[] = args.debts
    .filter((debt) => debt.state === 'open' && debt.balanceCents > 0)
    .map((debt) => {
      const freshness = balanceFreshness(debt, args.today)
      const cliff = promoCliff(debt, args.today)
      let miss: DebtDealMiss | null = null
      if (cliff && cliff.shortCents > 0) {
        miss = {
          untilDate: cliff.untilDate,
          dealRateBasisPoints: cliff.promoRateBasisPoints,
          onDealCents: cliff.amountCents,
          monthsLeft: cliff.monthsLeft,
          owedAtEndCents: cliff.shortCents,
          paymentNowCents: monthlyPaymentCents(debt, args.today),
          clearPerMonthCents:
            cliff.monthsLeft <= 0 ? cliff.amountCents : Math.ceil(cliff.amountCents / cliff.monthsLeft),
          chargedBackCents: chargedBackInterestCents(debt, args.today),
        }
      }
      const status: DebtStatus =
        miss === null ? 'on_track' : miss.monthsLeft * WEEKS_PER_MONTH <= leadWeeks ? 'short' : 'misses_deal'
      return { debt, status, miss, balanceAgeDays: freshness.ageDays, balanceStale: freshness.stale }
    })

  const todos: DebtTodo[] = []
  for (const view of views) {
    if (view.miss) {
      todos.push({
        kind: 'raise_debt_payment',
        debtId: view.debt.id,
        debtName: view.debt.name,
        fromCents: view.miss.paymentNowCents,
        toCents: view.miss.clearPerMonthCents,
        untilDate: view.miss.untilDate,
        blocking: true,
      })
    }
  }
  for (const view of views) {
    const unasked = view.debt.promoRules.find(
      (rule) => rule.chargedBack === undefined && rule.untilDate > args.today,
    )
    if (unasked) {
      todos.push({
        kind: 'check_deal_terms',
        debtId: view.debt.id,
        debtName: view.debt.name,
        untilDate: unasked.untilDate,
        blocking: false,
      })
    }
  }
  for (const view of views) {
    if (view.balanceStale) {
      todos.push({
        kind: 'update_debt_balance',
        debtId: view.debt.id,
        debtName: view.debt.name,
        ageDays: view.balanceAgeDays,
        likelyCents: view.debt.balanceCents,
        blocking: false,
      })
    }
  }

  return { debts: views, todos, caughtUp: views.every((v) => v.status === 'on_track') }
}

const percent = (basisPoints: number) => `${(basisPoints / 100).toFixed(2).replace(/\.00$/, '')}%`

/** The status in a word or three, for a pill (PRD §9). */
export function debtStatusLabel(view: Pick<DebtView, 'status' | 'miss'>): string {
  if (view.status === 'on_track' || !view.miss) return 'On track'
  if (view.status === 'short') return 'Short'
  return view.miss.dealRateBasisPoints === 0 ? 'Misses its 0%' : 'Misses its deal'
}

/**
 * The line under a debt that Misses its deal or is Short: when the deal ends,
 * what will still be owed, what that costs, and the payment that clears it.
 */
export function debtStatusLine(view: DebtView): SentencePart[] {
  const miss = view.miss
  if (!miss) return []
  const t = (text: string): SentencePart => ({ text })
  const deal = miss.dealRateBasisPoints === 0 ? 'The 0%' : `The ${percent(miss.dealRateBasisPoints)} deal`
  return [
    t(`${deal} ends `),
    { text: miss.untilDate, date: { on: miss.untilDate, as: 'plain' } },
    t(
      miss.chargedBackCents !== null
        ? ` with ${formatCents(miss.owedAtEndCents)} still owed, which brings back about ${formatCents(miss.chargedBackCents)} of interest. `
        : ` with ${formatCents(miss.owedAtEndCents)} still owed, charged ${percent(view.debt.aprBasisPoints)} from then. `,
    ),
    t(`Pay ${formatCents(miss.clearPerMonthCents)} a month to clear it in time.`),
  ]
}

export function debtTodoSentenceParts(todo: DebtTodo): SentencePart[] {
  const t = (text: string): SentencePart => ({ text })
  const target: SentencePart = { text: todo.debtName, target: true }
  if (todo.kind === 'raise_debt_payment') {
    return [
      t('Raise the monthly payment on '),
      target,
      t(` to ${formatCents(todo.toCents)}`),
      t(todo.fromCents > 0 ? ` (it is ${formatCents(todo.fromCents)} now)` : ''),
      t(', so its deal is cleared before it ends '),
      { text: todo.untilDate, date: { on: todo.untilDate, as: 'plain' } },
      t('.'),
    ]
  }
  if (todo.kind === 'check_deal_terms') {
    return [
      t('Check the terms of the deal on '),
      target,
      t(': if it is not paid off by the time it ends, is the interest charged back to when it started?'),
    ]
  }
  return [
    t('Check the balance on '),
    target,
    t(` against its statement: it was last checked ${todo.ageDays} days ago.`),
  ]
}

/** The same sentence as plain text, for the digest. */
export function debtTodoSentence(todo: DebtTodo): string {
  return debtTodoSentenceParts(todo)
    .map((p) => p.text)
    .join('')
}

/**
 * "All caught up" for the household (D35, D49): every account covers its
 * dates on its confirmed transfer and no debt Misses its deal or is Short.
 * A balance to check is housekeeping and never holds it back.
 */
export function householdCaughtUp(position: { allCaughtUp: boolean }, debts: Pick<DebtStatuses, 'caughtUp'>): boolean {
  return position.allCaughtUp && debts.caughtUp
}

/** "One account needs you", "2 accounts and one debt need you". */
export function attentionHeadline(accounts: number, debts: number): string {
  const count = (n: number, one: string, many: string) => (n === 1 ? `one ${one}` : `${n} ${many}`)
  const parts = [
    ...(accounts > 0 ? [count(accounts, 'account', 'accounts')] : []),
    ...(debts > 0 ? [count(debts, 'debt', 'debts')] : []),
  ]
  if (parts.length === 0) return 'Nothing needs you'
  const words = parts.join(' and ')
  const verb = accounts + debts === 1 ? 'needs' : 'need'
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${verb} you`
}
