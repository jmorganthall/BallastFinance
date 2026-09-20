/**
 * The should-have-saved curve (PRD §5, capability 6).
 *
 * Server-rendered inline SVG: no chart library, no client JavaScript, and it
 * renders in the email digest's browser preview as readily as in the PWA.
 *
 * Form: change over time for one quantity, so a line -- with the confirmed
 * balances drawn as observations on top of it rather than as a second series.
 * They are the same quantity measured two ways (what the plan says, what the
 * account holds), and drawing them as two coloured series would imply two
 * things being compared rather than one being checked.
 *
 * Colour: one categorical hue for the plan; observations in ink with a surface
 * ring so they stay legible where they sit on the line. Both are direct-labelled,
 * so identity never depends on colour alone. Light and dark are separate token
 * values, not an automatic flip.
 *
 * The curve is stepped, not smoothed: money moves on Saturdays, and a smooth
 * curve would claim the balance rises continuously in between.
 */

import { formatCents, type Cents, type CurvePoint } from '@/domain'

export interface ConfirmedPoint {
  date: string
  cents: Cents
}

const WIDTH = 320
const HEIGHT = 168
const PAD = { top: 14, right: 12, bottom: 26, left: 46 }

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / 86_400_000
}

export function AccrualChart({
  points,
  confirmed = [],
  today,
  targetCents,
  label = 'set aside',
}: {
  points: readonly CurvePoint[]
  confirmed?: readonly ConfirmedPoint[]
  today: string
  targetCents: Cents
  label?: string
}) {
  if (points.length < 2) return null

  const first = points[0]!
  const last = points.at(-1)!
  const x0 = dayNumber(first.date)
  const x1 = dayNumber(last.date)
  const span = Math.max(1, x1 - x0)

  const observed = confirmed.filter(
    (c) => dayNumber(c.date) >= x0 && dayNumber(c.date) <= x1,
  )
  const yMax = Math.max(targetCents, ...observed.map((c) => c.cents), 1)

  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const sx = (iso: string) => PAD.left + ((dayNumber(iso) - x0) / span) * plotW
  const sy = (cents: number) => PAD.top + plotH - (cents / yMax) * plotH

  // Stepped path: hold the value, then rise on the transfer date.
  const steps: string[] = [`M ${sx(first.date)} ${sy(first.cents)}`]
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!
    steps.push(`L ${sx(point.date)} ${sy(points[i - 1]!.cents)}`)
    steps.push(`L ${sx(point.date)} ${sy(point.cents)}`)
  }
  const line = steps.join(' ')
  const area = `${line} L ${sx(last.date)} ${sy(0)} L ${sx(first.date)} ${sy(0)} Z`

  const todayX = dayNumber(today) >= x0 && dayNumber(today) <= x1 ? sx(today) : null

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Money ${label} over time, rising to ${formatCents(targetCents)} by ${shortDate(last.date)}.`}
      >
        {/* Recessive frame: a baseline and one reference line, nothing more. */}
        <line
          x1={PAD.left}
          y1={sy(targetCents)}
          x2={WIDTH - PAD.right}
          y2={sy(targetCents)}
          stroke="var(--color-line)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <line
          x1={PAD.left}
          y1={sy(0)}
          x2={WIDTH - PAD.right}
          y2={sy(0)}
          stroke="var(--color-line)"
          strokeWidth="1"
        />

        <text x="2" y={sy(targetCents) + 4} fontSize="9" fill="var(--color-ink-soft)">
          {formatCents(targetCents)}
        </text>
        <text x="2" y={sy(0) + 4} fontSize="9" fill="var(--color-ink-soft)">
          $0
        </text>

        <path d={area} fill="var(--color-accent)" opacity="0.10" />
        <path
          d={line}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

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
            <text
              x={todayX}
              y={PAD.top - 8}
              fontSize="9"
              textAnchor="middle"
              fill="var(--color-ink-soft)"
            >
              today
            </text>
          </>
        ) : null}

        {/* Observations: ink, ringed in the surface colour so they read on the line. */}
        {observed.map((point) => (
          <circle
            key={point.date}
            cx={sx(point.date)}
            cy={sy(point.cents)}
            r="4"
            fill="var(--color-ink)"
            stroke="var(--color-card)"
            strokeWidth="2"
          >
            <title>
              {shortDate(point.date)}: {formatCents(point.cents)} actually there
            </title>
          </circle>
        ))}

        <text x={PAD.left} y={HEIGHT - 8} fontSize="9" fill="var(--color-ink-soft)">
          {shortDate(first.date)}
        </text>
        <text
          x={WIDTH - PAD.right}
          y={HEIGHT - 8}
          fontSize="9"
          textAnchor="end"
          fill="var(--color-ink-soft)"
        >
          {shortDate(last.date)}
        </text>
      </svg>

      {/* Direct labels rather than a legend box, so identity is never colour alone. */}
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-soft)]">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0.5 w-4 rounded-full bg-[var(--color-accent)]"
          />
          The plan
        </span>
        {observed.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-[var(--color-ink)] ring-2 ring-[var(--color-card)]"
            />
            What was actually there
          </span>
        ) : null}
      </figcaption>
    </figure>
  )
}
