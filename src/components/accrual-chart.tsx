/**
 * How a plan's money builds up (PRD §5, capability 6; D40, D50).
 *
 * Server-rendered inline SVG: no chart library, no client JavaScript.
 *
 * Form: one quantity over time, from today to the plan's last due date. The
 * solid line is what will happen on the transfer set up now: each transfer
 * paying the account's dates soonest first. Beside it, dashed in the soft
 * ink, saving it on its own (D50 (2)): each part saving evenly from its
 * Saving since. Where the plan's line is below that one the space between is
 * shaded: money paying sooner bills first, or still to come, and the two
 * meet on the day. A dot marks the turning point, when a sooner bill is paid
 * and the transfers start coming here. When the plan is Short it ends below
 * the total, and a second line, dashed in the on-track green, shows the same
 * after the fix This week asks for. Every line is named in the caption, so
 * identity never depends on colour alone, and the colours are tokens with
 * separate light and dark values. Blue is kept for Ready to spend (D38 (5)).
 *
 * The plan's line is stepped, not smoothed: money moves on the transfer day.
 * Saving it on its own is drawn straight, as the even pace it is. Every
 * point comes from the domain (`planChart`); this only draws it.
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
  const straight = (series: readonly PlanChartPoint[]) =>
    series.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.date)} ${sy(p.cents)}`).join(' ')
  const underneath = (line: string, series: readonly PlanChartPoint[]) =>
    `${line} L ${sx(series.at(-1)!.date)} ${sy(0)} L ${sx(series[0]!.date)} ${sy(0)} Z`
  const ownLine = chart.onItsOwn.length > 1 ? straight(chart.onItsOwn) : null
  const fixLine = chart.afterFix && chart.afterFix.length > 1 ? stepped(chart.afterFix) : null
  const endsShort = last.cents < chart.targetCents
  const todayX = dayNumber(today) >= x0 && dayNumber(today) <= x1 ? sx(today) : null
  const turn = chart.story.turn
  const below = chart.dipsBelow

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${formatCents(chart.countedToday.cents)} is here today; saving it on its own would have ${formatCents(chart.story.now.onItsOwnCents)}. On the transfer set up now this plan reaches ${formatCents(last.cents)} of ${formatCents(chart.targetCents)} by ${shortDate(last.date)}${turn ? `, climbing faster from ${shortDate(turn.on)}` : ''}${fixLine ? `; after the fix on This week it reaches ${formatCents(chart.afterFix!.at(-1)!.cents)}` : ''}.`}
      >
        {/*
          * The shading: everything under saving it on its own, then the
          * area under the plan's line painted over in the card colour, so
          * only the space where the plan is below its own pace stays shaded.
          */}
        {ownLine && below ? (
          <>
            <path d={underneath(ownLine, chart.onItsOwn)} fill="var(--color-ink-soft)" opacity="0.16" />
            <path d={underneath(actualLine, points)} fill="var(--color-card)" />
          </>
        ) : null}

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

        {ownLine ? (
          <path
            d={ownLine}
            fill="none"
            stroke="var(--color-ink-soft)"
            strokeDasharray="4 3"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        <path
          d={actualLine}
          fill="none"
          stroke="var(--color-ink)"
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

        {turn ? (
          <circle
            cx={sx(turn.on)}
            cy={sy(turn.cents)}
            r="3.5"
            fill="var(--color-ink)"
            stroke="var(--color-card)"
            strokeWidth="2"
          >
            <title>{`${shortDate(turn.on)}: from then about ${formatCents(turn.perWeekAfterCents)} a week comes here`}</title>
          </circle>
        ) : null}
        {!endsShort ? (
          <circle
            cx={sx(last.date)}
            cy={sy(last.cents)}
            r="4"
            fill="var(--color-ahead)"
            stroke="var(--color-card)"
            strokeWidth="2"
          >
            <title>{`${formatCents(chart.targetCents)} there on ${shortDate(last.date)}`}</title>
          </circle>
        ) : null}

        <text x={PAD.left} y={HEIGHT - 8} fontSize="9" fill="var(--color-ink-soft)">
          {/* The chart starts today (D40 (5)), so its left edge is today. */}
          {first.date === today ? 'Today' : shortDate(first.date)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} fontSize="9" textAnchor="end" fill="var(--color-ink-soft)">
          {shortDate(last.date)}
        </text>
      </svg>

      {/* Direct labels rather than a legend box, so identity is never colour alone. */}
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 rounded-full bg-[var(--color-ink)]" />
          On the transfer set up now{endsShort ? ` (ends ${formatCents(chart.targetCents - last.cents)} short)` : ''}
        </span>
        {ownLine ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-[var(--color-ink-soft)]" />
            Saving it on its own
          </span>
        ) : null}
        {below ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm bg-[var(--color-ink-soft)] opacity-30" />
            {endsShort
              ? 'Below saving it on its own'
              : turn || chart.story.now.coveringCents > 0
                ? 'Paying sooner bills first'
                : 'Still to come from the transfer'}
          </span>
        ) : null}
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
