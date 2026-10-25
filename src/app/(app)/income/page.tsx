/**
 * Income (PRD §14, D10-D11, D52): what each job brings home, laid out as the
 * household's income sheet is. Every figure is a paystub line a person typed;
 * the take-home and every column come from `householdIncome` in the domain.
 * Bonuses are a log beside base pay, never planned income: each shows its
 * spending share, and the yearly figure is per day since the job started.
 */

import { requireEngine } from '@/server/session'
import { Card, Hint, Money, PageHeader, Pill, humanDate } from '@/components/ui'
import { PaymentForm, SourceForm, type Member } from './forms'
import {
  endIncomeSourceAction,
  removeIncomePaymentAction,
} from '@/server/actions'
import {
  FREQUENCY_WORDS,
  INCOME_COLUMNS,
  INCOME_COLUMN_WORDS,
  formatCents,
  formatRate,
  type IncomeColumns,
  type LinkCheck,
  type SourceView,
} from '@/domain'

export const dynamic = 'force-dynamic'

const small =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-ink)]'
const heading = 'mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'

/** One row of the sheet: a label and the figure in every column. */
function SheetRow({
  label,
  cols,
  strong = false,
  minus = false,
}: {
  label: string
  cols: IncomeColumns
  strong?: boolean
  minus?: boolean
}) {
  return (
    <tr className={strong ? 'border-t border-[var(--color-line)] font-semibold' : ''}>
      <th scope="row" className="py-1 pr-3 text-left font-normal whitespace-nowrap">
        {strong ? <span className="font-semibold">{label}</span> : label}
      </th>
      {INCOME_COLUMNS.map((c) => (
        <td key={c} className="tabular py-1 pl-3 text-right whitespace-nowrap">
          {minus ? '−' : ''}
          {formatCents(cols[c])}
        </td>
      ))}
    </tr>
  )
}

function SheetTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="text-xs text-[var(--color-ink-soft)]">
            <th />
            {INCOME_COLUMNS.map((c) => (
              <th key={c} scope="col" className="pb-1 pl-3 text-right font-medium whitespace-nowrap">
                {INCOME_COLUMN_WORDS[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function SourceCard({
  view,
  today,
  check,
  members,
  viewerId,
}: {
  view: SourceView
  today: string
  check?: LinkCheck
  members: Member[]
  viewerId: string
}) {
  const { source, paycheck } = view
  return (
    <Card className="mb-4">
      <div id={`source-${source.id}`} className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{source.name}</p>
          <p className="text-xs text-[var(--color-ink-soft)]">
            Paid {FREQUENCY_WORDS[source.frequency]}
            {source.startedOn ? `, since ${humanDate(source.startedOn)}` : ''}
          </p>
        </div>
        <p className="text-right">
          <Money cents={paycheck.netCents} className="text-lg font-semibold" />
          <span className="block text-xs text-[var(--color-ink-soft)]">take-home a check</span>
        </p>
      </div>

      <SheetTable>
        {view.gross && paycheck.grossCents !== null ? (
          <>
            <SheetRow label="Gross" cols={view.gross} />
            {view.lines.pretax.map((l, i) => (
              <SheetRow key={`p${i}`} label={l.label} cols={l.cols} minus />
            ))}
            {view.lines.afterPretax ? <SheetRow label="After taken out before taxes" cols={view.lines.afterPretax} strong /> : null}
            {view.lines.taxes.map((l, i) => (
              <SheetRow
                key={`t${i}`}
                label={paycheck.taxRateBasisPoints !== null && view.lines.taxes.length === 1 ? `${l.label} (${formatRate(paycheck.taxRateBasisPoints)})` : l.label}
                cols={l.cols}
                minus
              />
            ))}
          </>
        ) : null}
        <SheetRow label="Take-home" cols={view.net} strong />
      </SheetTable>
      {paycheck.taxRateBasisPoints !== null && source.netPerCheckCents !== null ? (
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
          Taxes and withholding take {formatRate(paycheck.taxRateBasisPoints)} of the pay left after the deductions,
          worked out from the take-home on the stub.
        </p>
      ) : null}

      {check ? (
        <p className={`mt-3 text-sm ${check.differs ? 'text-[var(--color-caution)]' : 'text-[var(--color-ink-soft)]'}`}>
          {check.differs
            ? `Simplifi expects ${check.items.map((i) => `${formatCents(i.amountCents)} ${FREQUENCY_WORDS[i.frequency]}`).join(' + ')}: ${formatCents(Math.abs(check.differenceYearlyCents))} a year ${check.differenceYearlyCents > 0 ? 'more' : 'less'} than these paystub figures. These are the ones that count; update Simplifi, or the stub lines here.`
            : `Simplifi agrees (${check.items.map((i) => i.name).join(', ')}).`}
        </p>
      ) : source.simplifiNames.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--color-ink-soft)]">Not linked to Simplifi yet: give its name under Change.</p>
      ) : null}

      <div className="mt-4 border-t border-[var(--color-line)] pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">Bonuses and commission</p>
          {view.bonus ? (
            <Hint
              detail={`What the log adds up to before tax, ${formatCents(view.bonus.pretaxTotalCents)}, over the ${view.bonus.days} days since the job started, times 365. What landed, at the same rate: ${formatCents(view.bonus.landedYearlyCents)} a year.`}
            >
              <span className="text-sm">
                <Money cents={view.bonus.pretaxYearlyCents} /> a year before tax
              </span>
            </Hint>
          ) : null}
        </div>
        {view.payments.length > 0 ? (
          <div className="-mx-4 mt-2 overflow-x-auto px-4">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-xs text-[var(--color-ink-soft)]">
                  <th className="pb-1 text-left font-medium">Landed on</th>
                  <th className="pb-1 text-right font-medium">Landed</th>
                  <th className="pb-1 text-right font-medium">Before tax</th>
                  <th className="pb-1 text-right font-medium">
                    To spending ({source.spendingShareBasisPoints / 100}%)
                  </th>
                  <th className="pb-1 text-right font-medium">Kept</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.payments.map(({ payment, spendingCents, keptCents }) => (
                  <tr key={payment.id}>
                    <td className="py-1">
                      {humanDate(payment.paidOn)}
                      {payment.note ? <span className="block text-xs text-[var(--color-ink-soft)]">{payment.note}</span> : null}
                    </td>
                    <td className="tabular py-1 text-right">{formatCents(payment.landedCents)}</td>
                    <td className="tabular py-1 text-right">{payment.pretaxEstimateCents === null ? '—' : formatCents(payment.pretaxEstimateCents)}</td>
                    <td className="tabular py-1 text-right">{formatCents(spendingCents)}</td>
                    <td className="tabular py-1 text-right">{formatCents(keptCents)}</td>
                    <td className="py-1 pl-2 text-right">
                      <form action={removeIncomePaymentAction}>
                        <input type="hidden" name="id" value={payment.id} />
                        <input type="hidden" name="income_source_id" value={source.id} />
                        <button type="submit" className="text-xs text-[var(--color-ink-soft)] underline">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">None logged.</p>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer text-sm underline">Log one that landed</summary>
          <PaymentForm sourceId={source.id} today={today} />
        </details>
      </div>

      <details className="mt-4 border-t border-[var(--color-line)] pt-3">
        <summary className="cursor-pointer text-sm underline">Change</summary>
        <div className="mt-3">
          <SourceForm source={source} takeHomeCents={paycheck.netCents} members={members} viewerId={viewerId} />
          <form action={endIncomeSourceAction} className="mt-2">
            <input type="hidden" name="id" value={source.id} />
            <button type="submit" className="text-sm text-[var(--color-behind)] underline">
              This job has ended
            </button>
          </form>
        </div>
      </details>
    </Card>
  )
}

export default async function IncomePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const { saved, error } = await searchParams
  const { engine, viewer } = await requireEngine()
  const today = engine.today()
  const [income, view, members] = await Promise.all([
    engine.householdIncome(),
    engine.recurringView(),
    engine.householdMembers(),
  ])
  const checkOf = new Map(view.checks.filter((c) => c.target.kind === 'income').map((c) => [c.target.id, c]))

  return (
    <div data-wide>
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Income" subtitle="What each job brings home, from its paystub. Bonuses sit beside it, never in it." />

        {saved ? (
          <Card className="mb-4 bg-[var(--color-ahead-soft)]">
            <p className="text-sm font-medium text-[var(--color-ahead)]">Saved.</p>
          </Card>
        ) : null}
        {error ? (
          <Card className="mb-4 bg-[var(--color-behind-soft)]">
            <p className="text-sm text-[var(--color-behind)]">{error}</p>
          </Card>
        ) : null}

        {income.people.length > 0 ? (
          <>
            <h2 className={heading}>What we bring home</h2>
            <Card className="mb-6">
              <SheetTable>
                {income.people.map((p) => (
                  <SheetRow key={p.person} label={p.person} cols={p.net} />
                ))}
                <SheetRow label="Combined take-home" cols={income.net} strong />
                {income.hasBonus ? <SheetRow label="With bonuses at the rate so far" cols={income.netWithBonus} /> : null}
              </SheetTable>
            </Card>
          </>
        ) : null}

        {income.people.map((p) => (
          <section key={p.person} className="mb-2">
            <h2 className={heading}>{p.person}</h2>
            {p.sources.map((s) => (
              <SourceCard
                key={s.source.id}
                view={s}
                today={today}
                check={checkOf.get(s.source.id)}
                members={members}
                viewerId={viewer.userId}
              />
            ))}
          </section>
        ))}

        <h2 className={heading}>Add income</h2>
        <Card className="mb-6">
          <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
            One per job. Type the lines off a real paystub: Ballast only adds and subtracts them, it never works out tax.
          </p>
          <SourceForm members={members} viewerId={viewer.userId} />
        </Card>
        {income.people.length === 0 ? null : (
          <p className="mb-6 text-xs text-[var(--color-ink-soft)]">
            <Pill tone="neutral">Rounding</Pill> Every column is the year&apos;s figure divided down and rounded down, so
            take-home is never overstated.
          </p>
        )}
      </div>
    </div>
  )
}
