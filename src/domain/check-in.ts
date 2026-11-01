/**
 * What a balance form records (PRD D57 (1)): a count is a figure someone
 * checked. Each account's box is empty, with the likely balance as a hint,
 * and beside it "It's $X", which records exactly the figure that was shown.
 *
 * - A box typed into records what was typed; one that is not an amount is
 *   skipped, so the other accounts still record.
 * - "It's $X" records the likely balance it showed, for its own account; it
 *   wins over anything typed in that account's box, because pressing it is
 *   the explicit act.
 * - An empty box with its button not pressed records nothing.
 *
 * The button posts the account and the figure it showed, so what is
 * recorded is what the person saw, even if the likely balance moved since.
 */

import { parseAmountOrNull, type Cents } from './money'
import type { Id } from './types'

/** The name of the "It's $X" button; its value says which account and what figure. */
export const ITS_FIELD = 'its'

/** The value "It's $X" posts for an account. */
export function itsValue(accountId: Id, cents: Cents): string {
  return `${accountId}:${cents}`
}

/** The name of an account's box. */
export const balanceField = (accountId: Id) => `balance_${accountId}`

/** The counts a submitted balance form records, one per account at most. */
export function countsFromForm(args: {
  accountIds: readonly Id[]
  /** What the form posted under a name, or null. */
  field: (name: string) => string | null
}): { accountId: Id; amountCents: Cents }[] {
  const its = args.field(ITS_FIELD)
  const pressed = (() => {
    if (!its) return null
    const at = its.lastIndexOf(':')
    const cents = Number(its.slice(at + 1))
    return at > 0 && Number.isInteger(cents) ? { accountId: its.slice(0, at), cents } : null
  })()
  return args.accountIds.flatMap((accountId) => {
    if (pressed?.accountId === accountId) return [{ accountId, amountCents: pressed.cents }]
    const raw = (args.field(balanceField(accountId)) ?? '').trim()
    if (raw === '') return []
    const cents = parseAmountOrNull(raw)
    return cents === null ? [] : [{ accountId, amountCents: cents }]
  })
}
