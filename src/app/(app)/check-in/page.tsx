/**
 * Check-in (PRD §9, screen 4; D35).
 *
 * The user tells Ballast what each account actually holds. The count
 * replaces the likely balance as the account's money today, and the one
 * position runs forward again from it. What the screen says afterwards is
 * the same account card This week draws, so the two can never disagree:
 * On track, or Short with the first date and the fix. There is no drift
 * figure and nothing to choose -- a gap becomes a changed weekly amount or a
 * one-time move, both as to-dos on This week.
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Hint, humanDate, Money, PageHeader } from '@/components/ui'
import { AccountPositionCard } from '@/components/account-position'
import { confirmBalancesAction } from '@/server/actions'
import { doneMovesSummary, formatCents } from '@/domain'

export const dynamic = 'force-dynamic'

const plain = (cents: number) => formatCents(cents).replace('$', '').replace(/,/g, '')

export default async function CheckInPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>
}) {
  const { done } = await searchParams
  const { engine } = await requireEngine()
  const [position, confirmed, commitments] = await Promise.all([
    engine.position(),
    engine.latestConfirmedBalances(),
    engine.openCommitmentsByAccount(),
  ])

  const live = position.accounts.filter((a) => a.parts.length > 0)

  return (
    <>
      <PageHeader
        title="Check in"
        subtitle="Open Capital One and tell Ballast what each account really holds today."
      />

      {done ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <p className="text-sm font-medium text-[var(--color-ahead)]">
            Balances recorded. Everything below has been worked out again from them.
          </p>
        </Card>
      ) : null}

      {live.length === 0 ? (
        <Card>
          <p>Nothing to check yet — commit a plan first.</p>
        </Card>
      ) : (
        <>
          <form action={confirmBalancesAction} className="space-y-4">
            {live.map((a) => {
              const last = confirmed.get(a.account.id)
              // Moves marked done since the last count (D34), in words; the
              // likely balance is the position's and is offered in the box.
              const moved = doneMovesSummary(commitments.get(a.account.id)?.doneMoves ?? [])
              return (
                <Card key={a.account.id}>
                  <h2 className="font-semibold">{a.account.name}</h2>
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                    <Hint detail="The last count, plus the transfers since at what the bank is set to, plus moves marked done, less anything confirmed spent. What you type is the fact; this is only a guess.">
                      Likely holds <Money cents={a.money.totalCents} />
                    </Hint>
                    {last ? (
                      <>
                        {' · '}last counted {humanDate(last.on)} at <Money cents={last.amountCents} />
                      </>
                    ) : (
                      ' · never counted'
                    )}
                    {moved.inCents > 0 || moved.outCents > 0 ? (
                      <>
                        {' · '}since then you moved
                        {moved.inCents > 0 ? (
                          <>
                            {' '}
                            <Money cents={moved.inCents} /> in
                          </>
                        ) : null}
                        {moved.inCents > 0 && moved.outCents > 0 ? ' and' : null}
                        {moved.outCents > 0 ? (
                          <>
                            {' '}
                            <Money cents={moved.outCents} /> out
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </p>
                  <label className="mt-3 block text-sm font-medium">
                    What it actually holds
                    <input
                      name={`balance_${a.account.id}`}
                      inputMode="decimal"
                      placeholder={plain(a.money.totalCents)}
                      className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
                    />
                  </label>
                </Card>
              )
            })}

            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
            >
              Record these balances
            </button>
            <p className="text-center text-xs text-[var(--color-ink-soft)]">
              Leave any box empty to skip that account.
            </p>
          </form>

          <section className="mt-8">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
              Where you stand
            </h2>
            <p className="mb-3 text-sm text-[var(--color-ink-soft)]">
              Each account is run forward on the transfer the bank has: is the money there on
              every date something is due? A plan below its steady line is fine as long as its
              account has it on the day.{' '}
              <Link href="/" className="text-[var(--color-accent)] underline underline-offset-4">
                What to do is on This week.
              </Link>
            </p>
            <ul className="space-y-4">
              {live.map((a) => (
                <li key={a.account.id}>
                  <AccountPositionCard account={a} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  )
}
