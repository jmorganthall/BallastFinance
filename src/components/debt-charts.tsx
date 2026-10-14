/**
 * A debt's page draws its payoff (PRD D49 (11)).
 *
 * Server-rendered inline SVG like the plan chart: no chart library, no client
 * JavaScript, every point from the domain (`payoffSchedule`), hover through
 * each mark's <title>.
 *
 * `BalanceChart` -- one quantity over time, today to payoff. Stepped, because
 * the balance moves on the payment day. The deal's end is a dashed rule,
 * labelled, so the cliff is where the eye lands. A what-if, when asked, is a
 * second line, dashed in the on-track green and labelled.
 *
 * `PaymentSplitChart` -- each payment as a part-of-whole: what paid the
 * balance down and what was interest, stacked, so a month's bar is the
 * payment (`paymentSplits`: past three years the bars are years). The two colours are a validated categorical pair on both card
 * surfaces (`--color-chart-paydown`, `--color-chart-interest`) and a legend
 * names them, so identity is never colour alone.
 */

import { formatCents, type PaymentSplit, type PayoffMonth } from '@/domain'

const WIDTH = 400
const PAD = { top: 18, right: 12, bottom: 26, left: 56 }

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / 86_400_000
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const dollars = (cents: number) => formatCents(cents).replace(/\.\d\d$/, '')

export function BalanceChart({
  today,
  balanceCents,
  months,
  dealEnds,
  whatIf,
}: {
  today: string
  balanceCents: number
  months: readonly PayoffMonth[]
  /** The deal's end and its words ("0% ends"), when it ends before payoff. */
  dealEnds: { on: string; label: string } | null
  whatIf: { label: string; months: readonly PayoffMonth[] } | null
}) {
  if (months.length === 0) return null
  const HEIGHT = 190
  const end = [months.at(-1)!.on, whatIf?.months.at(-1)?.on ?? today].sort().at(-1)!
  const x0 = dayNumber(today)
  const span = Math.max(1, dayNumber(end) - x0)
  const yMax = Math.max(balanceCents, ...months.map((m) => m.balanceAfterCents), 1)
  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const sx = (iso: string) => PAD.left + ((dayNumber(iso) - x0) / span) * plotW
  const sy = (cents: number) => PAD.top + plotH - (cents / yMax) * plotH

  const stepped = (series: readonly PayoffMonth[]) => {
    const parts = [`M ${sx(today)} ${sy(balanceCents)}`]
    let last = balanceCents
    for (const m of series) {
      parts.push(`L ${sx(m.on)} ${sy(last)}`, `L ${sx(m.on)} ${sy(m.balanceAfterCents)}`)
      last = m.balanceAfterCents
    }
    return parts.join(' ')
  }
  const line = stepped(months)
  const dealX = dealEnds && dayNumber(dealEnds.on) <= dayNumber(end) ? sx(dealEnds.on) : null

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${formatCents(balanceCents)} today, paid off by ${shortDate(months.at(-1)!.on)} on the payment set up now${dealEnds ? `; ${dealEnds.label} ${shortDate(dealEnds.on)}` : ''}${whatIf ? `; ${whatIf.label}, paid off by ${shortDate(whatIf.months.at(-1)!.on)}` : ''}.`}
      >
        <line x1={PAD.left} y1={sy(0)} x2={WIDTH - PAD.right} y2={sy(0)} stroke="var(--color-line)" strokeWidth="1" />
        <text x="2" y={sy(yMax) + 4} fontSize="11" fill="var(--color-ink-soft)">
          {dollars(yMax)}
        </text>
        <text x="2" y={sy(0) + 4} fontSize="11" fill="var(--color-ink-soft)">
          $0
        </text>

        {dealX !== null ? (
          <>
            <line
              x1={dealX}
              y1={PAD.top - 4}
              x2={dealX}
              y2={sy(0)}
              stroke="var(--color-caution)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text
              x={dealX}
              y={PAD.top - 6}
              fontSize="11"
              textAnchor={dealX > WIDTH - 70 ? 'end' : 'middle'}
              fill="var(--color-ink-soft)"
            >
              {dealEnds!.label}
            </text>
          </>
        ) : null}

        <path d={`${line} L ${sx(months.at(-1)!.on)} ${sy(0)} L ${sx(today)} ${sy(0)} Z`} fill="var(--color-ink-soft)" opacity="0.10" />
        <path d={line} fill="none" stroke="var(--color-ink-soft)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {whatIf && whatIf.months.length > 0 ? (
          <path
            d={stepped(whatIf.months)}
            fill="none"
            stroke="var(--color-ahead)"
            strokeWidth="2"
            strokeDasharray="5 4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* Hover: one invisible target a month, wider than the step it names. */}
        {months.map((m, i) => {
          const from = i === 0 ? sx(today) : sx(months[i - 1]!.on)
          return (
            <rect key={m.on} x={from} y={PAD.top} width={Math.max(1, sx(m.on) - from)} height={plotH} fill="transparent">
              <title>{`${shortDate(m.on)}: ${formatCents(m.balanceAfterCents)} left after a ${formatCents(m.paidCents)} payment`}</title>
            </rect>
          )
        })}
        <circle cx={sx(today)} cy={sy(balanceCents)} r="4" fill="var(--color-ink)" stroke="var(--color-card)" strokeWidth="2">
          <title>{`Today: ${formatCents(balanceCents)}`}</title>
        </circle>

        <text x={PAD.left} y={HEIGHT - 8} fontSize="11" fill="var(--color-ink-soft)">
          Today
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} fontSize="11" textAnchor="end" fill="var(--color-ink-soft)">
          {shortDate(end)}
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 rounded-full bg-[var(--color-ink-soft)]" />
          On the payment set up now
        </span>
        {whatIf ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-[var(--color-ahead)]" />
            {whatIf.label}
          </span>
        ) : null}
      </figcaption>
    </figure>
  )
}

const periodLabel = (period: string) => (period.length === 4 ? period : shortDate(`${period}-01`))

export function PaymentSplitChart({ splits }: { splits: readonly PaymentSplit[] }) {
  if (splits.length === 0) return null
  const bars = splits.map((split) => ({
    ...split,
    label: periodLabel(split.period),
    title: `${periodLabel(split.period)}: ${formatCents(split.paidCents)} paid, ${formatCents(split.paydownCents)} off the balance and ${formatCents(split.interestCents)} interest${split.chargedBackCents > 0 ? `, ${formatCents(split.chargedBackCents)} of it charged back` : ''}`,
  }))
  const HEIGHT = 160
  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const yMax = Math.max(1, ...bars.map((b) => b.interestCents + b.paydownCents))
  const slot = plotW / bars.length
  const gap = Math.min(2, slot * 0.25)
  const barW = Math.max(1, slot - gap)
  const h = (cents: number) => (cents / yMax) * plotH
  const base = PAD.top + plotH
  const spike = bars.find((b) => b.chargedBackCents > 0)

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Each ${bars[0]!.period.length === 4 ? "year's" : "month's"} payments, split into what pays the balance down and what is interest.`}
      >
        <line x1={PAD.left} y1={base} x2={WIDTH - PAD.right} y2={base} stroke="var(--color-line)" strokeWidth="1" />
        <text x="2" y={PAD.top + 4} fontSize="11" fill="var(--color-ink-soft)">
          {dollars(yMax)}
        </text>
        <text x="2" y={base + 4} fontSize="11" fill="var(--color-ink-soft)">
          $0
        </text>
        {bars.map((bar, i) => {
          const x = PAD.left + i * slot + gap / 2
          const paydownH = h(bar.paydownCents)
          const interestH = h(bar.interestCents)
          return (
            <g key={bar.label}>
              <rect x={x} y={base - paydownH} width={barW} height={paydownH} fill="var(--color-chart-paydown)" />
              {interestH > 0 ? (
                <rect
                  x={x}
                  // A 2px surface gap between the two parts of the bar.
                  y={base - paydownH - interestH - (paydownH > 0 ? 1 : 0)}
                  width={barW}
                  height={interestH}
                  fill="var(--color-chart-interest)"
                />
              ) : null}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent">
                <title>{bar.title}</title>
              </rect>
            </g>
          )
        })}
        {spike ? (
          <text
            x={Math.min(WIDTH - PAD.right, PAD.left + bars.indexOf(spike) * slot + slot / 2)}
            y={PAD.top - 4}
            fontSize="11"
            textAnchor={bars.indexOf(spike) > bars.length / 2 ? 'end' : 'middle'}
            fill="var(--color-ink-soft)"
          >
            interest charged back
          </text>
        ) : null}
        <text x={PAD.left} y={HEIGHT - 8} fontSize="11" fill="var(--color-ink-soft)">
          {bars[0]!.label}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} fontSize="11" textAnchor="end" fill="var(--color-ink-soft)">
          {bars.at(-1)!.label}
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--color-chart-paydown)]" />
          Pays the balance down
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--color-chart-interest)]" />
          Interest
        </span>
      </figcaption>
    </figure>
  )
}
