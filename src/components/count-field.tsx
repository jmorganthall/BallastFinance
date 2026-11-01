/**
 * One account's box in a balance form (PRD D57 (1)): empty, with the likely
 * balance as a grey hint, and beside it "It's $X", which records exactly
 * that figure as the count. Typing records what was typed; leaving it empty
 * records nothing. What a submitted form records is `countsFromForm`.
 *
 * "It's $X" belongs to a small form of its own (`ItsForms`, drawn after the
 * balance form), never to the balance form: pressing Enter in a box submits
 * a form with its first submit button, and were "It's $X" in it, Enter after
 * typing would record the first account's likely figure and drop what was
 * typed. In its own form, Enter can only press "Record these balances".
 */

import { balanceField, formatCents, ITS_FIELD, itsValue, type Cents, type Id } from '@/domain'

/** The id of the form an account's "It's $X" submits. */
const itsFormId = (accountId: Id) => `its-${accountId}`

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
          form={itsFormId(accountId)}
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

/**
 * The small forms the "It's $X" buttons submit, one an account: drawn after
 * (never inside) the balance form, each posting only that account's figure,
 * to the same action, landing back where the balance form would.
 */
export function ItsForms({
  accountIds,
  action,
  back,
}: {
  accountIds: readonly Id[]
  action: (formData: FormData) => Promise<void>
  back?: string
}) {
  return (
    <>
      {accountIds.map((id) => (
        <form key={id} id={itsFormId(id)} action={action} hidden>
          {back ? <input type="hidden" name="back" value={back} /> : null}
        </form>
      ))}
    </>
  )
}
