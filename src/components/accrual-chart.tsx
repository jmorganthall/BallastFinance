/**
 * How a plan's money builds up (PRD §5, capability 6; D40, D50).
 *
 * Server-rendered inline SVG: no chart library, no client JavaScript.
 *
 * Form: one quantity over time, from today to the plan's last due date. The
 * solid line is what will happen on the transfer set up now: each transfer
 * paying the account's dates soonest first. Beside it, dashed in the soft
 * ink, saving it on its own (D50 (2)): each part saving evenly from its
 * Saving since. Where the plan's line is below that one the space between
 * is shaded. Numbered badges above the plot mark the stretches of transfers
 * ahead (D50 (4)): a filled badge where money comes here, a hollow one
 * where the transfers pay other plans first; `PlanStory` says what each
 * number means, so the picture and the words point at the same weeks. Each
 * stretch's first day is marked on the axis. When the plan is Short it ends
 * below the total, and a second line, dashed in the on-track green, shows
 * the same after the fix This week asks for. Every line is named in the
 * caption, so identity never depends on colour alone, and the colours are
 * tokens with separate light and dark values. Blue is kept for Ready to
 * spend (D38 (5)).
 *
 * The plan's line is stepped, not smoothed: money moves on the transfer day.
 * Saving it on its own is drawn straight, as the even pace it is. Every
 * point comes from the domain (`planChart`); this only draws it.
 */

import { Tip } from '@/components/tip'
import { formatCents, type ChartDueMark, type PlanChart, type PlanChartPoint } from '@/domain'

const WIDTH = 600
const HEIGHT = 250
const PAD = { top: 34, right: 16, bottom: 32, left: 78 }
const FONT = 14
/** The least room between two date labels on the axis, so none overlap. */
const LABEL_GAP = 64
/** The least room between two badge centres. */
const BADGE_GAP = 22
/** A due pin's centre above the axis, and how far a pin crowding the one before it is lifted. */
const PIN_ABOVE = 13
const PIN_LIFT = 22

/** "Ian Birthday · $500.00 · Oct 1, 2027", one line a part. */
function pinWords(mark: ChartDueMark): string {
  return mark.parts.map((p) => `${p.label} · ${formatCents(p.cents)} · ${shortDate(mark.date)}`).join('\n')
}

/** A part's due pin, drawn the same on the timeline and in the caption. */
export function DuePin({ n }: { n: number | string }) {
  return (
    <span
      aria-hidden
      className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-[var(--color-card)] bg-[var(--color-ahead)] text-[11px] font-semibold text-[var(--color-card)]"
    >
      {n}
    </span>
  )
}

function shortDate(iso: string, withYear = true): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  })
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** A stretch's number, drawn the same here and beside its words in `PlanStory`. */
export function StretchBadge({ n, waiting }: { n: number; waiting: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
        waiting
          ? 'border border-[var(--color-ink-soft)] text-[var(--color-ink-soft)]'
          : 'bg-[var(--color-ink)] text-[var(--color-card)]'
      }`}
    >
      {n}
    </span>
  )
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
  const endsShort = !chart.story.due.reachesTotal
  const below = chart.dipsBelow
  const phases = chart.story.phases

  // A stretch is drawn from the week before its first transfer (when the
  // money starts changing) to its last transfer.
  const phaseStart = (from: string) => Math.max(PAD.left, sx(from) - plotW * (7 / span))
  let lastBadge = -Infinity
  const badges = phases.map((p, i) => {
    const x = Math.max((phaseStart(p.from) + sx(p.to)) / 2, lastBadge + BADGE_GAP)
    lastBadge = x
    return { n: i + 1, x: Math.min(x, WIDTH - PAD.right - 9), waiting: p.kind === 'waiting' }
  })
  // Date labels at each stretch's start, kept clear of one another and of
  // Today and the due date at the two ends.
  const labels: { x: number; text: string }[] = []
  let lastLabel = PAD.left
  for (const p of phases.slice(1)) {
    const x = phaseStart(p.from)
    if (x - lastLabel >= LABEL_GAP && WIDTH - PAD.right - x >= LABEL_GAP * 1.4) {
      labels.push({ x, text: shortDate(p.from, false) })
      lastLabel = x
    }
  }

  // A numbered pin on the axis where each part is due (multi-part plans
  // only: the domain leaves the list empty otherwise). One that would
  // crowd the pin before it sits higher, so each stays readable.
  let lastPin = -Infinity
  let lastLifted = false
  const pins = chart.dueMarks.map((m) => {
    const x = Math.min(Math.max(sx(m.date), PAD.left), WIDTH - PAD.right)
    const lifted = x - lastPin < PIN_LIFT && !lastLifted
    lastLifted = lifted
    lastPin = x
    return { mark: m, x, y: sy(0) - PIN_ABOVE - (lifted ? PIN_LIFT : 0) }
  })

  return (
    <figure className="m-0">
      {/* On a phone the chart keeps a readable size and scrolls sideways inside its card. */}
      <div className="overflow-x-auto">
      <div className="relative min-w-[520px]">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full min-w-[520px]"
        role="img"
        aria-label={`${formatCents(chart.countedToday.cents)} is here today; saving it on its own would have ${formatCents(chart.story.now.onItsOwnCents)}. On the transfer set up now this plan reaches ${formatCents(last.cents)} of ${formatCents(chart.targetCents)} by ${shortDate(last.date)}, in ${phases.length} stretches described below${fixLine ? `; after the fix on This week it reaches ${formatCents(chart.afterFix!.at(-1)!.cents)}` : ''}.`}
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

        {/* Recessive frame: a baseline, the total, and where each stretch begins. */}
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
        {phases.slice(1).map((p) => (
          <line
            key={p.from}
            x1={phaseStart(p.from)}
            y1={PAD.top - 6}
            x2={phaseStart(p.from)}
            y2={sy(0)}
            stroke="var(--color-line)"
            strokeWidth="1"
          />
        ))}

        <text x={PAD.left - 8} y={sy(chart.targetCents) + 4} fontSize={FONT} textAnchor="end" fill="var(--color-ink-soft)">
          {formatCents(chart.targetCents)}
        </text>
        <text x={PAD.left - 8} y={sy(0) + 4} fontSize={FONT} textAnchor="end" fill="var(--color-ink-soft)">
          $0
        </text>

        {ownLine ? (
          <path
            d={ownLine}
            fill="none"
            stroke="var(--color-chart-pace)"
            strokeDasharray="5 4"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        <path
          d={actualLine}
          fill="none"
          stroke="var(--color-ink)"
          strokeWidth="2.25"
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

        {/* The stretches, numbered as the words below number them. */}
        {badges.map((b) => (
          <g key={b.n}>
            <circle
              cx={b.x}
              cy={PAD.top - 18}
              r="9"
              fill={b.waiting ? 'var(--color-card)' : 'var(--color-ink)'}
              stroke={b.waiting ? 'var(--color-ink-soft)' : 'var(--color-ink)'}
              strokeWidth="1"
            />
            <text
              x={b.x}
              y={PAD.top - 14}
              fontSize="11"
              fontWeight="600"
              textAnchor="middle"
              fill={b.waiting ? 'var(--color-ink-soft)' : 'var(--color-card)'}
            >
              {b.n}
            </text>
          </g>
        ))}

        <circle
          cx={sx(first.date)}
          cy={sy(chart.countedToday.cents)}
          r="5"
          fill="var(--color-ink)"
          stroke="var(--color-card)"
          strokeWidth="2"
        >
          {/* One string: React renders a <title> with several children empty on the server. */}
          <title>{`Today: ${formatCents(chart.countedToday.cents)} here`}</title>
        </circle>
        {!endsShort ? (
          <circle
            cx={sx(last.date)}
            cy={sy(last.cents)}
            r="5"
            fill="var(--color-ahead)"
            stroke="var(--color-card)"
            strokeWidth="2"
          >
            <title>{`${formatCents(chart.targetCents)} there on ${shortDate(last.date)}`}</title>
          </circle>
        ) : null}

        <text x={PAD.left} y={HEIGHT - 8} fontSize={FONT} fill="var(--color-ink-soft)">
          {/* The chart starts today (D40 (5)), so its left edge is today. */}
          {first.date === today ? 'Today' : shortDate(first.date)}
        </text>
        {labels.map((l) => (
          <text key={l.text} x={l.x} y={HEIGHT - 8} fontSize={FONT} textAnchor="middle" fill="var(--color-ink-soft)">
            {l.text}
          </text>
        ))}
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} fontSize={FONT} textAnchor="end" fill="var(--color-ink-soft)">
          {shortDate(last.date)}
        </text>
        {pins.map((p) => (
          <line
            key={p.mark.n}
            x1={p.x}
            x2={p.x}
            y1={p.y}
            y2={sy(0)}
            stroke="var(--color-ahead)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        ))}
      </svg>
      {/* The pins are HTML over the drawing, so their words open on a hover and on a tap. */}
      {pins.map((p) => (
        <span
          key={p.mark.n}
          className="absolute z-0 -translate-x-1/2 -translate-y-1/2 text-xs hover:z-20 focus-within:z-20"
          style={{ left: `${(p.x / WIDTH) * 100}%`, top: `${(p.y / HEIGHT) * 100}%` }}
        >
          <Tip detail={pinWords(p.mark)} above plain>
            <DuePin n={p.mark.n} />
          </Tip>
        </span>
      ))}
      </div>
      </div>

      {/* Direct labels rather than a legend box, so identity is never colour alone. */}
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 rounded-full bg-[var(--color-ink)]" />
          This plan, on the transfer set up now
          {chart.endsShortCents > 0 ? ` (ends ${formatCents(chart.endsShortCents)} short)` : ''}
        </span>
        {ownLine ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-[var(--color-chart-pace)]" />
            Saving it on its own
          </span>
        ) : null}
        {below ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm bg-[var(--color-ink-soft)] opacity-30" />
            Below saving it on its own
          </span>
        ) : null}
        {fixLine ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-[var(--color-ahead)]" />
            After the fix on This week
          </span>
        ) : null}
        {pins.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <DuePin n={1} />
            When each part is due: hover or tap a pin
          </span>
        ) : null}
        {phases.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <StretchBadge n={1} waiting={false} />
            <StretchBadge n={2} waiting />
            Money comes here, or pays other plans first: see below
          </span>
        ) : null}
      </figcaption>
    </figure>
  )
}
