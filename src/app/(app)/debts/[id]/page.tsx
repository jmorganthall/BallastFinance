/**
 * One debt (PRD D49 (11), §9 "debt detail").
 *
 * What a person asks of a single loan, top to bottom: how it stands and its
 * deal; when it is gone, on the payment set up now, with the deal's end
 * marked; what paying more would do; how much of each payment is interest;
 * and what has happened to it. Every figure is the domain's -- the status
 * from `debtStatuses`, the months from `payoffSchedule`, the what-if from
 * `debtWhatIf` -- and nothing is stored for any of it.
 *
 * The what-if is a GET form, like the payoff-order slider: trying a number
 * changes nothing, and the result is an address that can be shared.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireEngine } from '@/server/session'
import { Card, Hint, humanDate, Money, PageHeader, Pill, When } from '@/components/ui'
import { BalanceChart, PaymentSplitChart } from '@/components/debt-charts'
import { setSimplifiNamesAction } from '@/server/actions'
import {
  debtStatusLabel,
  debtStatusLine,
  debtWhatIf,
  formatCents,
  parseAmountOrNull,
  paymentSplits,
  payoffSchedule,
  currentDeal,
  dealEndMark,
  isPaidOff,
  type DebtHistoryEntry,
} from '@/domain'

export const dynamic = 'force-dynamic'

const KIND: Record<string, string> = {
  consumer: 'Credit card or loan',
  auto: 'Car',
  mortgage: 'Mortgage',
}

const percent = (basisPoints: number) => `${(basisPoints / 100).toFixed(2)}%`

function historyWords(entry: DebtHistoryEntry): string {
  switch (entry.kind) {
    case 'stated':
      return `Balance checked: ${formatCents(entry.amountCents)}`
    case 'paid':
      return `Paid ${formatCents(entry.amountCents)}`
    case 'paid_todo':
      return `Paid ${formatCents(entry.amountCents)} (a share-out to-do)`
    case 'terms':
      return `Changed its ${entry.changed.join(', ')}`
  }
}

export default async function DebtPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ extra?: string; once?: string; saved?: string; error?: string }>
}) {
  const [{ id }, { extra, once, saved, error }] = await Promise.all([params, searchParams])
  const { engine } = await requireEngine()
  const [debts, debtState, ladder, history, targets] = await Promise.all([
    engine.listDebts(),
    engine.debtStatuses(),
    engine.debtLadder(),
    engine.debtHistory(id),
    engine.simplifiTargets(),
  ])
  const simplifiNames = targets.find((t) => t.kind === 'debt' && t.id === id)?.simplifiNames ?? []
  const debt = debts.find((d) => d.id === id)
  if (!debt) notFound()
  const today = engine.today()
  const view = debtState.debts.find((v) => v.debt.id === id) ?? null
  const rung = ladder.find((r) => r.debt.id === id) ?? null

  // Every figure about where it is headed is its one status's (D49 (4), D56 (6)).
  // No status: it is paid off (isPaidOff), and nothing is left to project.
  const paidOff = isPaidOff(debt)
  const projection = view?.payoff ?? { months: 0, payoffDate: today, totalInterestCents: 0 }
  const months = payoffSchedule({ debt, today })

  // A what-if is tried, never kept: only what was typed in the address.
  const extraCents = extra ? parseAmountOrNull(extra) : null
  const onceCents = once ? parseAmountOrNull(once) : null
  const trying = (extraCents ?? 0) > 0 || (onceCents ?? 0) > 0
  const whatIf = trying
    ? debtWhatIf({ debt, today, extraPerMonthCents: extraCents ?? 0, onceCents: onceCents ?? 0 })
    : null
  const whatIfLabel = [
    (extraCents ?? 0) > 0 ? `${formatCents(extraCents!)} more a month` : null,
    (onceCents ?? 0) > 0 ? `${formatCents(onceCents!)} once` : null,
  ]
    .filter(Boolean)
    .join(' and ')

  const deal = currentDeal(debt, today)
  const dealEnds = paidOff ? null : dealEndMark(debt, projection.payoffDate, today)

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/debts" className="text-[var(--color-accent)] underline underline-offset-4">
          ← Payoff order
        </Link>
      </p>
      <PageHeader
        title={debt.name}
        subtitle={`${KIND[debt.category] ?? debt.category}${rung ? ` · number ${rung.rank} in the payoff order` : ''}`}
      />

      {/* How it stands, and its deal. */}
      <Card className="mb-4">
        {view && view.status !== 'on_track' ? (
          <div className="mb-3">
            <Pill tone={view.status === 'short' ? 'behind' : 'caution'}>{debtStatusLabel(view)}</Pill>
            <p className="mt-2 text-sm">
              {debtStatusLine(view).map((part, i) =>
                part.date ? <When key={i} date={part.date.on} today={today} /> : <span key={i}>{part.text}</span>,
              )}{' '}
              <Link href="/" className="text-[var(--color-accent)] underline underline-offset-4">
                The fix is on This week.
              </Link>
            </p>
          </div>
        ) : paidOff ? (
          <p className="mb-3 text-sm font-medium text-[var(--color-ahead)]">Paid off.</p>
        ) : (
          <p className="mb-3">
            <Pill tone="ahead">On track</Pill>
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--color-ink-soft)]">Balance</dt>
            <dd className="font-medium tabular">
              <Money cents={debt.balanceCents} />
              {debt.statedBalanceCents !== undefined && debt.statedBalanceCents !== debt.balanceCents ? (
                <span className="block text-xs font-normal text-[var(--color-ink-soft)]">
                  <Hint
                    detail={`The statement said ${formatCents(debt.statedBalanceCents)} on ${humanDate(debt.balanceAsOf)}; this is that less the payments since.`}
                  >
                    likely
                  </Hint>
                </span>
              ) : (
                <span className="block text-xs font-normal text-[var(--color-ink-soft)]">
                  checked <When date={debt.balanceAsOf} today={today} />
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-soft)]">
              <Hint detail="What it really costs right now, which is what the payoff order ranks by.">Rate</Hint>
            </dt>
            <dd className="font-medium tabular">
              {rung ? percent(rung.effectiveAprBasisPoints) : percent(debt.aprBasisPoints)}
              {rung && rung.effectiveAprBasisPoints !== debt.aprBasisPoints ? (
                <span className="block text-xs font-normal text-[var(--color-ink-soft)]">
                  listed {percent(debt.aprBasisPoints)}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-soft)]">Per month</dt>
            <dd className="font-medium tabular">
              {rung ? <Money cents={rung.paymentPerMonthCents} /> : '—'}
              {debt.paymentDay ? (
                <span className="block text-xs font-normal text-[var(--color-ink-soft)]">on the {ordinal(debt.paymentDay)}</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-soft)]">Paid off by</dt>
            <dd className="font-medium">
              {projection.payoffDate ? humanDate(projection.payoffDate) : 'Never, at this payment'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-soft)]">Interest left to pay</dt>
            <dd className="font-medium tabular">
              {projection.payoffDate ? <Money cents={projection.totalInterestCents} /> : '—'}
            </dd>
          </div>
          {deal ? (
            <div>
              <dt className="text-xs text-[var(--color-ink-soft)]">Deal</dt>
              <dd className="font-medium">
                {percent(deal.rateBasisPoints)} until {humanDate(deal.untilDate)}
                <span className="block text-xs font-normal text-[var(--color-ink-soft)]">
                  {deal.chargedBack === false
                    ? 'Interest is not charged back'
                    : deal.chargedBack === true
                      ? 'Interest is charged back if missed'
                      : 'Charged back? Not checked yet'}
                  {deal.startDate ? `, started ${humanDate(deal.startDate)}` : ''}
                </span>
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {/* When it is gone. */}
      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
          The balance from today
        </h2>
        <Card>
          {months.length > 0 ? (
            <BalanceChart
              today={today}
              balanceCents={debt.balanceCents}
              months={months}
              dealEnds={dealEnds}
              whatIf={whatIf ? { label: `With ${whatIfLabel}`, months: whatIf.thenMonths } : null}
            />
          ) : (
            <p className="text-sm">
              {debt.balanceCents === 0
                ? 'Nothing is owed.'
                : 'At the payment set up now, the interest each month is as much as the payment, so it is never paid off.'}
            </p>
          )}
        </Card>
      </section>

      {/* What paying more would do. */}
      {debt.balanceCents > 0 ? (
        <section className="mb-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            What if we paid more?
          </h2>
          <Card>
            <form method="GET" className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="block text-sm font-medium">
                More each month
                <input
                  name="extra"
                  inputMode="decimal"
                  defaultValue={extra ?? ''}
                  placeholder="50"
                  className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
                />
              </label>
              <label className="block text-sm font-medium">
                Once, today
                <input
                  name="once"
                  inputMode="decimal"
                  defaultValue={once ?? ''}
                  placeholder="1000"
                  className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
                />
              </label>
              <button
                type="submit"
                className="min-h-11 rounded-xl border border-[var(--color-line)] px-4 text-sm font-medium"
              >
                Try it
              </button>
            </form>
            {whatIf ? (
              <p className="mt-3 text-sm">
                {whatIf.then.months === null
                  ? `Even with ${whatIfLabel}, it is never paid off.`
                  : whatIf.monthsSooner === null
                    ? `With ${whatIfLabel}, it is paid off by ${humanDate(whatIf.then.payoffDate!)}, when the payment set up now never would be.`
                    : `With ${whatIfLabel}, it is paid off ${whatIf.monthsSooner === 0 ? 'in the same month' : `${whatIf.monthsSooner} ${whatIf.monthsSooner === 1 ? 'month' : 'months'} sooner`}, by ${whatIf.then.payoffDate ? humanDate(whatIf.then.payoffDate) : 'today'}, and ${formatCents(whatIf.interestSavedCents ?? 0)} less interest is paid.`}{' '}
                <span className="text-[var(--color-ink-soft)]">Nothing is saved: this only shows what it would do.</span>
              </p>
            ) : null}
          </Card>
        </section>
      ) : null}

      {/* How much of each payment is interest. */}
      {months.length > 0 ? (
        <section className="mb-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Where each payment goes
          </h2>
          <Card>
            <PaymentSplitChart splits={paymentSplits(months)} />
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-[var(--color-accent)]">See the numbers</summary>
              <table className="mt-2 w-full text-xs tabular">
                <thead>
                  <tr className="text-left text-[var(--color-ink-soft)]">
                    <th className="py-1 font-medium">When</th>
                    <th className="py-1 text-right font-medium">Paid</th>
                    <th className="py-1 text-right font-medium">Interest</th>
                    <th className="py-1 text-right font-medium">Left after</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.on} className="border-t border-[var(--color-line)]">
                      <td className="py-1">{humanDate(m.on)}</td>
                      <td className="py-1 text-right">{formatCents(m.paidCents)}</td>
                      <td className="py-1 text-right">
                        {formatCents(m.interestCents)}
                        {m.chargedBackCents > 0 ? ' (charged back)' : ''}
                      </td>
                      <td className="py-1 text-right">{formatCents(m.balanceAfterCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Card>
        </section>
      ) : null}

      {/* What has happened to it. */}
      {/* The payment's name in Simplifi's recurring list (D52): its figure is then checked against this debt's. */}
      <Card className="mb-4">
        <form action={setSimplifiNamesAction} className="flex items-end gap-2">
          <input type="hidden" name="target" value={`debt:${debt.id}`} />
          <input type="hidden" name="back" value={`/debts/${debt.id}`} />
          <label className="flex-1 text-sm font-medium">
            Known in Simplifi as
            <input
              name="names"
              defaultValue={simplifiNames.join(', ')}
              placeholder="The payment's name in Simplifi"
              className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base font-normal text-[var(--color-ink)]"
            />
          </label>
          <button type="submit" className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium">
            Save
          </button>
        </form>
        {error ? <p className="mt-2 text-sm text-[var(--color-behind)]">{error}</p> : saved ? <p className="mt-2 text-sm text-[var(--color-ahead)]">Saved.</p> : null}
      </Card>

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
          History
        </h2>
        <Card>
          <ul className="space-y-2 text-sm">
            {[...history].reverse().map((entry, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{historyWords(entry)}</span>
                <span className="shrink-0 text-[var(--color-ink-soft)]">{humanDate(entry.on)}</span>
              </li>
            ))}
            {debt.enteredOn ? (
              <li className="flex justify-between gap-3 text-[var(--color-ink-soft)]">
                <span>Entered in Ballast</span>
                <span className="shrink-0">{humanDate(debt.enteredOn)}</span>
              </li>
            ) : null}
          </ul>
        </Card>
      </section>
    </>
  )
}

function ordinal(day: number): string {
  const tens = day % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'
  return `${day}${suffix}`
}
