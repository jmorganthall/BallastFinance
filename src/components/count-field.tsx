/**
 * One account's box in a balance form (PRD D57 (1)): empty, with the likely
 * balance as a grey hint, and beside it "It's $X", which records exactly
 * that figure as the count. Typing records what was typed; leaving it empty
 * records nothing. What a submitted form records is `countsFromForm`.
 */

import { balanceField, formatCents, ITS_FIELD, itsValue, type Cents, type Id } from '@/domain'

const plain = (cents: Cents) => formatCents(cents).replace('$', '').replace(/,/g, '')

export function CountField({ accountId, likelyCents }: { accountId: Id; likelyCents: Cents }) {
  return (
    <div className="mt-3">
      <label htmlFor={balanceField(accountId)} className="block text-sm font-medium">
        What it actually holds
      </label>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          id={balanceField(accountId)}
          name={balanceField(accountId)}
          inputMode="decimal"
          placeholder={plain(likelyCents)}
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
        />
        <button
          type="submit"
          name={ITS_FIELD}
          value={itsValue(accountId, likelyCents)}
          className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
        >
          It&apos;s {formatCents(likelyCents)}
        </button>
      </div>
    </div>
  )
}
