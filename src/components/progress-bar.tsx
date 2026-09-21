/**
 * Progress to goal: how much is set aside against the total, with a tick at
 * the pace -- where the money would be by today had it been saved evenly.
 * Green at or past the tick is on track; yellow short of it is behind; a
 * solid green bar with no tick is fully funded. The colour never stands
 * alone: the pill says the word and the line under the bar says the numbers.
 * The reading comes from the domain; this only draws it.
 */

import { Hint, humanDate, Pill } from '@/components/ui'
import { formatCents, progressOf, type Cents, type CivilDate } from '@/domain'

const STATUS = {
  funded: { label: 'Fully funded', tone: 'ahead' as const, fill: 'var(--color-ahead)' },
  on_track: { label: 'On track', tone: 'ahead' as const, fill: 'var(--color-ahead)' },
  behind: { label: 'Behind', tone: 'caution' as const, fill: 'var(--color-caution)' },
}

export function ProgressBar({
  totalCents,
  setAsideCents,
  paceCents,
  paceSince,
  dueDate,
  className = '',
}: {
  totalCents: Cents
  setAsideCents: Cents
  paceCents: Cents
  /** When the even save the pace assumes would have started; shown as the tick's explanation. */
  paceSince?: CivilDate
  dueDate?: CivilDate
  className?: string
}) {
  const progress = progressOf({ totalCents, shouldHaveSavedCents: setAsideCents, paceCents })
  const status = STATUS[progress.status]
  const goal = dueDate
    ? `${formatCents(totalCents)} by ${humanDate(dueDate)}`
    : `${formatCents(totalCents)} in all`
  const paceWords =
    progress.status === 'on_track'
      ? `should be ${formatCents(paceCents)} by now`
      : `${formatCents(progress.behindByCents)} behind where it should be by now`
  const paceDetail = paceSince
    ? `Saved evenly from ${humanDate(paceSince)}${dueDate ? ` to ${humanDate(dueDate)}` : ''}, ${formatCents(paceCents)} would be set aside by today. That is the tick on the bar.`
    : `Saved evenly over each part's own stretch, ${formatCents(paceCents)} would be set aside by today. That is the tick on the bar.`

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <Pill tone={status.tone}>{status.label}</Pill>
        <span className="tabular text-xs text-[var(--color-ink-soft)]">{goal}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.fillPercent}
        aria-label={`${formatCents(setAsideCents)} of ${formatCents(totalCents)} set aside, ${status.label.toLowerCase()}`}
        className="relative mt-2 h-2 w-full rounded-full bg-[var(--color-line)]"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${progress.fillPercent}%`, background: status.fill }}
        />
        {progress.status !== 'funded' ? (
          <div
            aria-hidden="true"
            className="absolute -top-1 h-4 w-0.5 rounded-sm bg-[var(--color-ink)]"
            style={{ left: `calc(${progress.pacePercent}% - 1px)` }}
          />
        ) : null}
      </div>
      <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
        {formatCents(setAsideCents)} set aside
        {progress.status === 'funded' ? (
          ' · nothing more to save'
        ) : (
          <>
            {' · '}
            <Hint detail={paceDetail}>{paceWords}</Hint>
          </>
        )}
      </p>
    </div>
  )
}
