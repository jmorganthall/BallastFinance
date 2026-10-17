/**
 * What an account likely holds and why (D34, D35), in the one sentence the
 * domain words (`moneySinceParts`): the last count, the transfers, moves and
 * spends since, and the likely balance. Check-in and This week both draw it,
 * so a spend or a move changes the words wherever it changes the number.
 */

import { moneySinceParts, type AccountMoneyToday, type CivilDate } from '@/domain'
import { When } from '@/components/ui'

export function MoneySince({ money, today }: { money: AccountMoneyToday; today: CivilDate }) {
  return (
    <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
      {moneySinceParts(money).map((part, i) =>
        part.date ? <When key={i} date={part.date.on} today={today} as={part.date.as} /> : <span key={i}>{part.text}</span>,
      )}
    </p>
  )
}
