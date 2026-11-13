/**
 * Check-in (PRD §9, screen 4; D35).
 *
 * The user tells Ballast what each account actually holds. The count
 * replaces the likely balance as the account's money today, and the one
 * position runs forward again from it. Each account is one card
 * (`AccountCheckCard`): how it stands, what it likely holds, what the bank
 * moves a week, and the box -- every figure the position's, the same ones
 * This week reads, so the two can never disagree. There is no drift
 * figure and nothing to choose -- a gap becomes a changed weekly amount or a
 * one-time move, both as to-dos on This week.
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, PageHeader } from '@/components/ui'
import { BalancesRecorded, ItsForms } from '@/components/count-field'
import { AccountCheckCard } from '@/components/account-check-card'
import { confirmBalancesAction } from '@/server/actions'

export const dynamic = 'force-dynamic'

export default async function CheckInPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>
}) {
  const { done } = await searchParams
  const { engine } = await requireEngine()
  const today = engine.today()
  const position = await engine.position()

  const live = position.accounts.filter((a) => a.parts.length > 0)

  return (
    <>
      <PageHeader
        title="Check in"
        subtitle="Open Capital One and tell Ballast what each account really holds today."
      />

      {done !== undefined ? (
        <BalancesRecorded count={Number(done) || 0} after="Everything below has been worked out again from them." />
      ) : null}

      {live.length === 0 ? (
        <Card>
          <p>Nothing to check yet — commit a plan first.</p>
        </Card>
      ) : (
        <>
          <form action={confirmBalancesAction} className="space-y-4">
            {live.map((a) => (
              <AccountCheckCard key={a.account.id} account={a} today={today} />
            ))}
            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-[var(--color-on-fill)]"
            >
              Record these balances
            </button>
            <p className="text-center text-xs text-[var(--color-ink-soft)]">
              Leave a box empty to skip that account.{' '}
              <Link href="/" className="text-[var(--color-accent)] underline underline-offset-2">
                What to do is on This week.
              </Link>
            </p>
          </form>
          <ItsForms accountIds={live.map((a) => a.account.id)} action={confirmBalancesAction} />
        </>
      )}
    </>
  )
}
