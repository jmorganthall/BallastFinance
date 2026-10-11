/**
 * How a plan's money builds up (PRD §5, capability 6; D40).
 *
 * Server-rendered inline SVG: no chart library, no client JavaScript.
 *
 * Form: one quantity over time, from today to the plan's last due date. The
 * solid line is what will happen on the transfer set up now, in the soft ink
 * of the tick: each transfer paying the account's dates soonest first. When
 * the plan is Short it ends below the total, and a second line, dashed in the
 * on-track green, shows the same after the fix This week asks for: "this is
 * where it is heading; this is where the fix takes it". The dot is today's
 * figure. Both lines are labelled directly, so identity never depends on
 * colour alone, and the colours are tokens with separate light and dark
 * values.
 *
 * Stepped, not smoothed: money moves on the transfer day, and a smooth curve
 * would claim the balance rises continuously in between. Every point comes
 * from the domain (`planChart`); this only draws it.
 */

import { formatCents, type PlanChart, type PlanChartPoint } from '@/domain'

const WIDTH = 320
const HEIGHT = 168
const PAD = { top: 14, right: 12, bottom: 26, left: 46 }

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / 86_400_000
}

export function AccrualChart({ chart, today }: { chart: PlanChart; today: string }) {
  const points = chart.actual
  if (points.length < 2) return null

  const first = points[0]!
  const last = points.at(-1)!
  const x0 = Math.min(dayNumber(first.date), dayNumber(today))
  const x1 = dayNumber(last.date)
  const span = Math.max(1, x1 - x0)
  const yMax = Math.max(chart.targetCents, 1)

  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const sx = (iso: string) => PAD.left + ((dayNumber(iso) - x0) / span) * plotW
  const sy = (cents: number) => PAD.top + plotH - (Math.min(cents, yMax) / yMax) * plotH

  // Stepped path: hold the value, then rise on the transfer date.
  const stepped = (series: readonly PlanChartPoint[]) => {
    const steps: string[] = [`M ${sx(series[0]!.date)} ${sy(series[0]!.cents)}`]
    for (let i = 1; i < series.length; i += 1) {
      const point = series[i]!
      steps.push(`L ${sx(point.date)} ${sy(series[i - 1]!.cents)}`)
      steps.push(`L ${sx(point.date)} ${sy(point.cents)}`)
    }
    return steps.join(' ')
  }
  const actualLine = stepped(points)
  const area = `${actualLine} L ${sx(last.date)} ${sy(0)} L ${sx(first.date)} ${sy(0)} Z`
  const fixLine = chart.afterFix && chart.afterFix.length > 1 ? stepped(chart.afterFix) : null
  const endsShort = last.cents < chart.targetCents
  const todayX = dayNumber(today) >= x0 && dayNumber(today) <= x1 ? sx(today) : null

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${formatCents(chart.countedToday.cents)} is here today. On the transfer set up now this plan reaches ${formatCents(last.cents)} of ${formatCents(chart.targetCents)} by ${shortDate(last.date)}${fixLine ? `; after the fix on This week it reaches ${formatCents(chart.afterFix!.at(-1)!.cents)}` : ''}.`}
      >
        {/* Recessive frame: a baseline and one reference line, nothing more. */}
        <line
          x1={PAD.left}
          y1={sy(chart.targetCents)}
          x2={WIDTH - PAD.right}
          y2={sy(chart.targetCents)}
          stroke="var(--color-line)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <line x1={PAD.left} y1={sy(0)} x2={WIDTH - PAD.right} y2={sy(0)} stroke="var(--color-line)" strokeWidth="1" />

        <text x="2" y={sy(chart.targetCents) + 4} fontSize="9" fill="var(--color-ink-soft)">
          {formatCents(chart.targetCents)}
        </text>
        <text x="2" y={sy(0) + 4} fontSize="9" fill="var(--color-ink-soft)">
          $0
        </text>

        <path d={area} fill="var(--color-ink-soft)" opacity="0.10" />
        <path
          d={actualLine}
          fill="none"
          stroke="var(--color-ink-soft)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {fixLine ? (
          <path
            d={fixLine}
            fill="none"
            stroke="var(--color-ahead)"
            strokeDasharray="5 4"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {todayX !== null ? (
          <>
            <line
              x1={todayX}
              y1={PAD.top - 6}
              x2={todayX}
              y2={sy(0)}
              stroke="var(--color-ink-soft)"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <text x={todayX} y={PAD.top - 8} fontSize="9" textAnchor="middle" fill="var(--color-ink-soft)">
              today
            </text>
            <circle
              cx={todayX}
              cy={sy(chart.countedToday.cents)}
              r="4"
              fill="var(--color-ink)"
              stroke="var(--color-card)"
              strokeWidth="2"
            >
              {/* One string: React renders a <title> with several children empty on the server. */}
              <title>{`Today: ${formatCents(chart.countedToday.cents)} here`}</title>
            </circle>
          </>
        ) : null}

        <text x={PAD.left} y={HEIGHT - 8} fontSize="9" fill="var(--color-ink-soft)">
          {shortDate(first.date)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} fontSize="9" textAnchor="end" fill="var(--color-ink-soft)">
          {shortDate(last.date)}
        </text>
      </svg>

      {/* Direct labels rather than a legend box, so identity is never colour alone. */}
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 rounded-full bg-[var(--color-ink-soft)]" />
          On the transfer set up now{endsShort ? ` (ends ${formatCents(chart.targetCents - last.cents)} short)` : ''}
        </span>
        {fixLine ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-[var(--color-ahead)]" />
            After the fix on This week
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-[var(--color-ink)] ring-2 ring-[var(--color-card)]"
          />
          Here today
        </span>
      </figcaption>
    </figure>
  )
}
