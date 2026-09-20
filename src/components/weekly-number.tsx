/**
 * The weekly number, decomposed.
 *
 * PRD §5 makes this decomposition mandatory everywhere a weekly figure appears:
 * "Move $W/week: $X ongoing + $Y catch-up until {date}." Showing only a blended
 * total is what the spreadsheet did, and it is exactly what hides why a number
 * moved.
 */

import { formatCents, type WeeklyBreakdown } from '@/domain'
import { Hint, Money } from './ui'

function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function WeeklyNumber({
  weekly,
  respreadCents,
  size = 'large',
}: {
  weekly: WeeklyBreakdown
  /** The single blended figure, for the tooltip only. */
  respreadCents?: number
  size?: 'large' | 'small'
}) {
  const hasCatchUp = weekly.catchUp.length > 0

  return (
    <div>
      <div className={size === 'large' ? 'text-3xl font-semibold' : 'text-lg font-semibold'}>
        <Money cents={weekly.totalPerWeekCents} />
        <span className="text-[var(--color-ink-soft)] font-normal text-base"> / week</span>
      </div>

      {hasCatchUp ? (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          <Hint detail="The steady part of your weekly set-aside: the plan as first committed. It stays put when things change.">
            <Money cents={weekly.ongoingPerWeekCents} /> ongoing
          </Hint>
          {weekly.catchUp.map((group) => (
            <span key={group.endDate}>
              {' + '}
              <Hint detail="Added when the plan changed. It stops on its own at the date shown, and the ongoing amount is what remains.">
                <Money cents={group.perWeekCents} /> extra until {humanDate(group.endDate)}
              </Hint>
            </span>
          ))}
        </p>
      ) : (
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Steady — nothing extra to catch up on.
        </p>
      )}

      {respreadCents !== undefined && hasCatchUp ? (
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
          <Hint detail={`Spreading everything still owed evenly over the weeks left would be ${formatCents(respreadCents)}/week. Ballast keeps the ongoing amount steady instead, so your bank transfer does not change every time a plan does.`}>
            Why not one blended number?
          </Hint>
        </p>
      ) : null}
    </div>
  )
}
