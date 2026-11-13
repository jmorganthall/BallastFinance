/**
 * Is a transfer worth it? (PRD D61)
 *
 * Asked about a debt's standing offer (`?debt=<id>`), or about a card that
 * is not in Ballast (Try a card, its boxes in the address). Every figure is
 * `transferCheck`'s; this page only says them. It is a GET page, like the
 * what-if on a debt's page: trying an amount, a credit limit or a card
 * changes nothing, and nothing here is stored or suggested on its own.
 * One column: it reads top to bottom, the answer first.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { requireEngine } from '@/server/session'
import { Card, humanDate, Money, PageHeader, Problem } from '@/components/ui'
import {
  compareDates,
  EMPTY_DEBT_FORM,
  formatCents,
  monthsInWords,
  offerWords,
  parseAmountOrNull,
  parseTryCard,
  rateWords,
  transferCheck,
  type Debt,
  type DebtFormProblem,
  type DebtFormValues,
  type LeftOutReason,
  type TransferCheck,
  type TransferRefusal,
  type TransferResult,
} from '@/domain'

export const dynamic = 'force-dynamic'

type Query = Record<string, string | string[] | undefined>

const boxClass =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const linkClass = 'text-[var(--color-accent)] underline underline-offset-4'

/** The boxes Try a card carries in its address, so every later form keeps them. */
const CARD_FIELDS: (keyof DebtFormValues)[] = [
  'name',
  'apr',
  'credit_limit',
  'monthly_payment',
  'min_type',
  'min_amount',
  'min_percent',
  'min_floor',
  'offer_ends',
  'offer_rate',
  'offer_months',
  'offer_until',
  'offer_fee',
  'offer_fee_min',
  'offer_charged_back',
]

export default async function TransferPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams
  const one = (name: string) => {
    const value = query[name]
    return typeof value === 'string' ? value : undefined
  }
  const { engine } = await requireEngine()
  const debts = await engine.reading((e) => e.listDebts())
  const today = engine.today()

  const debtId = one('debt')
  let target: Debt | null = null
  let cardValues: DebtFormValues | null = null
  let cardProblems: DebtFormProblem[] = []
  if (debtId) {
    target = debts.find((d) => d.id === debtId) ?? null
    if (!target) notFound()
  } else if (one('card') === '1') {
    const tried = parseTryCard((name) => one(name) ?? null, today)
    cardValues = tried.values
    if (tried.ok) target = tried.card
    else cardProblems = tried.problems
  }

  const amountCents = one('amount') ? parseAmountOrNull(one('amount')) : null
  const limitCents = one('limit') ? parseAmountOrNull(one('limit')) : null
  const check = target ? transferCheck({ debts, target, today, amountCents, limitCents }) : null

  // Every form on the page carries what it was asked about.
  const keep: Record<string, string> = debtId
    ? { debt: debtId, ...(one('limit') ? { limit: one('limit')! } : {}) }
    : cardValues
      ? { card: '1', ...Object.fromEntries(CARD_FIELDS.map((f) => [f, String(cardValues![f] ?? '')])) }
      : {}

  return (
    <div>
      <p className="mb-2 text-sm">
        <Link href={debtId ? `/debts/${debtId}` : '/debts'} className={linkClass}>
          ← {debtId && target ? target.name : 'Payoff order'}
        </Link>
      </p>
      <PageHeader
        title="Is a transfer worth it?"
        subtitle={
          target?.transferOffer
            ? `${target.name}: ${offerWords(target.transferOffer, target.aprBasisPoints, formatCents, humanDate)}`
            : 'Try a card or line of credit that is not in Ballast yet.'
        }
      />

      {debtId && target?.transferOffer?.transferBy && compareDates(target.transferOffer.transferBy, today) < 0 ? (
        <p className="-mt-4 mb-4 text-sm text-[var(--color-ink-soft)]">
          The offer said transfers by {humanDate(target.transferOffer.transferBy)}. Check it is still open.
        </p>
      ) : null}

      {check ? <Answer check={check} target={target!} keep={keep} /> : null}

      {!debtId ? (
        <TryACard values={cardValues ?? { ...EMPTY_DEBT_FORM, min_type: 'percent_with_floor' }} problems={cardProblems} />
      ) : null}

      <p className="mt-6 text-xs text-[var(--color-ink-soft)]">
        Both sides run on today&rsquo;s payments: each debt&rsquo;s monthly payment as Debts has it, and what the
        old debts stop paying goes to the new one. Nothing is stored and nothing moves: you make the transfer at the
        bank, then update both debts here.
      </p>
    </div>
  )
}

function Answer({ check, target, keep }: { check: TransferCheck; target: Debt; keep: Record<string, string> }) {
  if (check.refused) {
    return (
      <Card className="mb-4">
        <p>{refusalWords(check.refused, target)}</p>
        {check.refused.kind === 'needs_limit' ? <LimitForm keep={keep} /> : null}
      </Card>
    )
  }
  const r = check.result
  return (
    <>
      <Card className="mb-4">
        {r === null ? (
          <p className="text-lg">
            {check.sources.length === 0
              ? 'Nothing here can move onto it.'
              : 'No transfer fits: the fee alone is more than the room left on the card.'}
          </p>
        ) : (
          <Headline check={check} r={r} target={target} />
        )}
      </Card>

      {r ? <Figures r={r} target={target} /> : null}
      {r?.deal ? <DealCard r={r} target={target} /> : null}
      {check.leftOut.length > 0 ? <LeftOut check={check} /> : null}
      {r ? <AmountForm check={check} keep={keep} /> : null}
    </>
  )
}

function Headline({ check, r, target }: { check: TransferCheck; r: TransferResult; target: Debt }) {
  const from = r.moves.map((m, i) => (
    <span key={m.debt.id}>
      {i === 0 ? '' : i === r.moves.length - 1 ? ' and ' : ', '}
      <Money cents={m.amountCents} /> from <strong>{m.debt.name}</strong>
    </span>
  ))
  const asked = check.typed !== null && check.typed.problem === null
  const sooner =
    r.monthsSooner === null
      ? null
      : r.monthsSooner > 0
        ? `Paid off ${monthsInWords(r.monthsSooner)} sooner.`
        : r.monthsSooner < 0
          ? `Paid off ${monthsInWords(-r.monthsSooner)} later.`
          : 'Paid off in the same month.'
  if (!asked && check.recommendedCents === null) {
    return (
      <>
        <p className="text-lg font-semibold">Not worth it at today&rsquo;s payments.</p>
        <p className="mt-1 text-sm">
          Moving the most that fits, <Money cents={r.amountCents} />, saves <Money cents={r.interestSavedCents} /> in
          interest and costs <Money cents={r.feeCents} /> in fees.
        </p>
      </>
    )
  }
  return (
    <>
      <p className="text-lg">
        {asked ? 'Moving ' : 'Move '}
        {from} to <strong>{target.name}</strong>
        {asked ? (r.netSavingsCents > 0 ? ' saves ' : ' costs ') : '. Saves '}
        <Money cents={Math.abs(r.netSavingsCents)} className="font-semibold" /> after the <Money cents={r.feeCents} /> fee.
        {sooner ? ` ${sooner}` : ''}
      </p>
      {asked && check.recommendedCents !== null && check.recommendedCents !== r.amountCents ? (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Ballast would move <Money cents={check.recommendedCents} />, the amount that saves the most.
        </p>
      ) : null}
      {check.typed?.problem === 'over_most' ? (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          <Money cents={check.typed.cents} /> does not fit with its fee: these are the figures for the most that does,{' '}
          <Money cents={check.mostCents} />.
        </p>
      ) : null}
      {r.horizonMonths !== null ? (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          At today&rsquo;s payments a debt here is never paid off, so the interest is compared over the next{' '}
          {monthsInWords(r.horizonMonths)}.
        </p>
      ) : null}
    </>
  )
}

function Figures({ r, target }: { r: TransferResult; target: Debt }) {
  const months = (n: number | null) => (n === null ? 'never' : n === 0 ? '—' : monthsInWords(n))
  // A debt moved in full has nothing left to pay off.
  const after = (d: TransferResult['perDebt'][number]) =>
    d.monthsWith === 0 && d.monthsWithout !== 0 ? 'moved' : months(d.monthsWith)
  const row = (label: ReactNode, value: ReactNode, strong = false) => (
    <div className={`flex items-baseline justify-between gap-4 py-2 ${strong ? 'font-semibold' : ''}`}>
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  )
  const freedFrom = r.moves.filter((m) => m.paymentBeforeCents > m.paymentAfterCents)
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-sm font-medium">The figures</h2>
      <dl className="divide-y divide-[var(--color-line)] text-sm">
        {row(r.horizonMonths === null ? 'Interest without the move' : `Interest without, next ${monthsInWords(r.horizonMonths)}`, <Money cents={r.interestWithoutCents} />)}
        {row(r.horizonMonths === null ? 'Interest with the move' : `Interest with, next ${monthsInWords(r.horizonMonths)}`, <Money cents={r.interestWithCents} />)}
        {r.interestSavedCents >= 0
          ? row('Interest saved', <Money cents={r.interestSavedCents} />)
          : row('Extra interest', <Money cents={-r.interestSavedCents} />)}
        {row('Transfer fee', <Money cents={r.feeCents} />)}
        {row(r.netSavingsCents >= 0 ? 'Saves after the fee' : 'Costs after the fee', <Money cents={Math.abs(r.netSavingsCents)} />, true)}
      </dl>
      <p className="mt-3 text-sm">
        {r.freedPerMonthCents > 0 ? (
          <>
            The <Money cents={r.freedPerMonthCents} /> a month{' '}
            {freedFrom.map((m) => m.debt.name).join(' and ')} stop{freedFrom.length === 1 ? 's' : ''} asking for goes to{' '}
            {target.name}.
          </>
        ) : (
          <>
            {r.moves.map((m) => m.debt.name).join(' and ')} still ask{r.moves.length === 1 ? 's' : ''} for the same payment,
            so {target.name} gets only its own.
          </>
        )}
      </p>
      <h3 className="mt-4 text-sm font-medium">Paid off in</h3>
      <table className="mt-1 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--color-ink-soft)]">
            <th className="py-1 font-normal">Debt</th>
            <th className="py-1 text-right font-normal">Without</th>
            <th className="py-1 text-right font-normal">With</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {r.perDebt.map((d) => (
            <tr key={d.name}>
              <td className="py-2">{d.name}</td>
              <td className="py-2 text-right">{months(d.monthsWithout)}</td>
              <td className="py-2 text-right">{after(d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function DealCard({ r, target }: { r: TransferResult; target: Debt }) {
  const deal = r.deal!
  return (
    <Card className="mb-4">
      <h2 className="mb-1 text-sm font-medium">Paid off before the {rateWords(deal.rateBasisPoints)} ends?</h2>
      {deal.leftAtEndCents <= 0 ? (
        <p className="text-sm">Yes: on these payments it is gone before {humanDate(deal.endsOn)}.</p>
      ) : (
        <p className="text-sm">
          No: about <Money cents={deal.leftAtEndCents} /> would be left on {humanDate(deal.endsOn)}, when the rate goes to{' '}
          {rateWords(target.aprBasisPoints)}
          {target.transferOffer?.chargedBack ? ', and the interest is charged back to the day of the transfer' : ''}.
          {deal.clearsAtPerMonthCents !== null ? (
            <>
              {' '}Paying <Money cents={deal.clearsAtPerMonthCents} /> a month clears it in time.
            </>
          ) : null}
        </p>
      )}
    </Card>
  )
}

function LeftOut({ check }: { check: TransferCheck }) {
  const words = (reason: LeftOutReason) => {
    switch (reason.kind) {
      case 'on_deal':
        return `On its ${rateWords(reason.rateBasisPoints)} deal until ${humanDate(reason.until)}, so it stays where it is.`
      case 'not_consumer':
        return 'A car loan or a mortgage: card offers do not take these.'
      case 'cheaper':
        return `Charges ${rateWords(reason.aprBasisPoints)}, no more than the offer.`
    }
  }
  return (
    <Card className="mb-4">
      <h2 className="mb-2 text-sm font-medium">Left where they are</h2>
      <ul className="divide-y divide-[var(--color-line)] text-sm">
        {check.leftOut.map(({ debt, reason }) => (
          <li key={debt.id} className="py-2">
            <strong>{debt.name}</strong> — {words(reason)}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Hidden({ keep }: { keep: Record<string, string> }) {
  return (
    <>
      {Object.entries(keep).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  )
}

function AmountForm({ check, keep }: { check: TransferCheck; keep: Record<string, string> }) {
  return (
    <Card className="mb-4">
      <form method="GET" className="space-y-2">
        <Hidden keep={keep} />
        <label className="block text-sm font-medium">
          Try a different amount
          <input
            name="amount"
            inputMode="decimal"
            defaultValue={check.typed ? (check.typed.cents / 100).toFixed(2) : ''}
            placeholder={((check.recommendedCents ?? check.mostCents) / 100).toFixed(2)}
            className={boxClass}
          />
        </label>
        <p className="text-xs text-[var(--color-ink-soft)]">
          The most that fits with its fee is {formatCents(check.mostCents)}.
        </p>
        {check.typed?.problem === 'not_positive' ? (
          <p className="text-xs text-[var(--color-behind)]">Enter an amount above zero.</p>
        ) : null}
        <button type="submit" className="w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium">
          Work it out
        </button>
      </form>
    </Card>
  )
}

function LimitForm({ keep }: { keep: Record<string, string> }) {
  return (
    <form method="GET" className="mt-3 space-y-2">
      <Hidden keep={Object.fromEntries(Object.entries(keep).filter(([name]) => name !== 'limit'))} />
      <label className="block text-sm font-medium">
        Its credit limit
        <input name="limit" inputMode="decimal" placeholder="10000" className={boxClass} />
      </label>
      <p className="text-xs text-[var(--color-ink-soft)]">Used for this one answer and not saved. To keep it, edit the debt.</p>
      <button type="submit" className="w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium">
        Work it out
      </button>
    </form>
  )
}

function refusalWords(refused: TransferRefusal, target: Debt): string {
  switch (refused.kind) {
    case 'no_offer':
      return `${target.name} has no transfer offer. Add one on its form under Debts.`
    case 'not_consumer':
      return 'Only a credit card or a line of credit can take a transfer.'
    case 'on_deal':
      return `${target.name} is already on a deal until ${humanDate(refused.until)}. A second transfer would put two end dates on one card.`
    case 'mixes_rates':
      return `${target.name} already carries ${formatCents(refused.balanceCents)} at ${rateWords(refused.aprBasisPoints)}. Moving money onto it would leave two rates on one card.`
    case 'needs_limit':
      return `Ballast does not know ${target.name}'s credit limit, so it cannot tell how much fits.`
    case 'no_room':
      return `There is no room left on ${target.name}: it holds ${formatCents(refused.balanceCents)} of its ${formatCents(refused.limitCents)} limit.`
    case 'offer_over':
      return `The offer's rate ended on ${humanDate(refused.until)}.`
  }
}

function TryACard({ values, problems }: { values: DebtFormValues; problems: DebtFormProblem[] }) {
  const problemFor = (field: string) => problems.find((p) => p.field === field)?.message
  const box = (name: keyof DebtFormValues, label: string, opts: { placeholder?: string; hint?: string; type?: string } = {}) => (
    <label className="block text-sm font-medium">
      {label}
      <input
        name={name}
        type={opts.type ?? 'text'}
        inputMode={opts.type ? undefined : 'decimal'}
        defaultValue={String(values[name] ?? '')}
        placeholder={opts.placeholder}
        aria-invalid={problemFor(name) ? true : undefined}
        className={boxClass}
      />
      {problemFor(name) ? (
        <span className="mt-1 block text-xs font-normal text-[var(--color-behind)]">{problemFor(name)}</span>
      ) : opts.hint ? (
        <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">{opts.hint}</span>
      ) : null}
    </label>
  )
  const select = (name: keyof DebtFormValues, label: string, options: [string, string][]) => (
    <label className="block text-sm font-medium">
      {label}
      <select name={name} defaultValue={String(values[name] ?? '')} className={boxClass}>
        {options.map(([value, words]) => (
          <option key={value} value={value}>
            {words}
          </option>
        ))}
      </select>
      {problemFor(name) ? (
        <span className="mt-1 block text-xs font-normal text-[var(--color-behind)]">{problemFor(name)}</span>
      ) : null}
    </label>
  )
  const other = problems.filter((p) => !['apr', 'credit_limit', 'monthly_payment', 'min_type', 'min_amount', 'min_percent', 'min_floor', 'offer_ends', 'offer_rate', 'offer_months', 'offer_until', 'offer_fee', 'offer_fee_min'].includes(p.field))
  return (
    <Card className="mb-4">
      <h2 className="mb-3 font-semibold">Try a card</h2>
      {other.length > 0 ? (
        <Problem className="mb-3">
          {other.map((p) => (
            <p key={p.field}>{p.message}</p>
          ))}
        </Problem>
      ) : null}
      <form method="GET" className="space-y-4">
        <input type="hidden" name="card" value="1" />
        {box('name', 'Name (optional)', { placeholder: 'Citi Diamond' })}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {box('credit_limit', 'Credit limit', { placeholder: '10000' })}
          {box('apr', 'Its rate after the offer (%)', { placeholder: '24.99', hint: "A line of credit's rate, if that is what it is." })}
        </div>
        {select('offer_ends', "How long the offer's rate lasts", [
          ['months', 'A number of months from the transfer'],
          ['until', 'Until a date'],
          ['never', 'It does not end (a line of credit)'],
        ])}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {box('offer_rate', 'Rate on what is moved (%)', { placeholder: '0' })}
          {box('offer_months', 'Months', { placeholder: '18', hint: 'For an offer of months.' })}
          {box('offer_until', 'Or until', { type: 'date', hint: 'For an offer until a date.' })}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {box('offer_fee', 'Transfer fee (%)', { placeholder: '3', hint: '0 if there is none.' })}
          {box('offer_fee_min', 'Least the fee can be (optional)', { placeholder: '5' })}
        </div>
        {select('offer_charged_back', 'If it is not paid off by the end, is the interest charged back?', [
          ['no', 'No, only on what is left'],
          ['yes', 'Yes, back to the day of the transfer'],
        ])}
        {select('min_type', 'Its minimum payment', [
          ['percent_with_floor', 'Interest plus a percentage, never below a floor'],
          ['percent', 'Interest plus a percentage'],
          ['fixed', 'A set amount'],
        ])}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {box('min_percent', 'Percentage (%)', { placeholder: '1' })}
          {box('min_floor', 'Floor', { placeholder: '25' })}
          {box('min_amount', 'Or a set amount', { placeholder: '35' })}
        </div>
        {box('monthly_payment', 'What you would pay a month, if more than the minimum (optional)')}
        <button
          type="submit"
          className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-[var(--color-on-fill)]"
        >
          Is a transfer worth it?
        </button>
      </form>
    </Card>
  )
}
