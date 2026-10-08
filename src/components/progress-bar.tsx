/**
 * A part's or plan's progress (D35): what the account's money counts toward
 * it, against its total, with a tick at its steady line -- where it would be
 * today, saving steadily since its Saving since date. The status is the
 * position's; the colour follows it and never stands alone: the pill says the
 * word and the line under the bar says the numbers. The reading comes from
 * the domain; this only draws it.
 */

import { Hint, humanDate } from '@/components/ui'
import { PartStatusPill, STATUS_FILL } from '@/components/status'
import { barOf, formatCents, PART_STATUS_WORDS, type Cents, type CivilDate, type PartStatus } from '@/domain'

export function ProgressBar({
  totalCents,
  countedCents,
  savedForCents,
  coveringSoonerCents,
  notYetHereCents,
  status,
  savingSince,
  dueDate,
  shortOn,
  className = '',
}: {
  totalCents: Cents
  countedCents: Cents
  savedForCents: Cents
  coveringSoonerCents: Cents
  notYetHereCents: Cents
  status: PartStatus
  /** Where the steady line starts, and why in words; shown as the tick's explanation. */
  savingSince?: { date: CivilDate; words: string }
  dueDate?: CivilDate
  /** The first date the account runs short, when the status is Short. */
  shortOn?: CivilDate | null
  className?: string
}) {
  const bar = barOf({ totalCents, countedCents, savedForCents })
  const goal = dueDate
    ? `${formatCents(totalCents)} by ${humanDate(dueDate)}`
    : `${formatCents(totalCents)} in all`
  const tickDetail = savingSince
    ? `Saving steadily since ${humanDate(savingSince.date)} (${savingSince.words})${dueDate ? ` to ${humanDate(dueDate)}` : ''}, ${formatCents(savedForCents)} would be here by today. That is the tick on the bar.`
    : `Saving steadily over each part's own stretch, ${formatCents(savedForCents)} would be here by today. That is the tick on the bar.`

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <PartStatusPill status={status} />
        <span className="tabular text-xs text-[var(--color-ink-soft)]">{goal}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={bar.fillPercent}
        aria-label={`${formatCents(countedCents)} of ${formatCents(totalCents)} here, ${PART_STATUS_WORDS[status].toLowerCase()}`}
        className="relative mt-2 h-2 w-full rounded-full bg-[var(--color-line)]"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${bar.fillPercent}%`, background: STATUS_FILL[status] }}
        />
        {!bar.fullyFunded ? (
          <div
            aria-hidden="true"
            className="absolute -top-1 h-4 w-0.5 rounded-sm bg-[var(--color-ink)]"
            style={{ left: `calc(${bar.tickPercent}% - 1px)` }}
          />
        ) : null}
      </div>
      <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
        {formatCents(countedCents)} here
        {status === 'short' ? (
          <>
            {' · '}
            on the transfer set up now the account runs short
            {shortOn ? ` on ${humanDate(shortOn)}` : ''}; This week says what fixes it
          </>
        ) : bar.fullyFunded ? (
          ' · nothing more to save'
        ) : status === 'catching_up' ? (
          <>
            {' · '}
            <Hint detail={`${tickDetail} The account's money goes first to what is due soonest. The weekly transfer is set so the account has everything on the day it is due.`}>
              {coveringSoonerCents > 0
                ? `${formatCents(coveringSoonerCents)} of what you saved for this is covering plans due sooner`
                : null}
              {coveringSoonerCents > 0 && notYetHereCents > 0 ? ', and ' : null}
              {notYetHereCents > 0
                ? `${formatCents(notYetHereCents)} ${coveringSoonerCents > 0 ? 'more ' : ''}is not in the account yet`
                : null}
            </Hint>
            {dueDate ? `; the account has it by ${humanDate(dueDate)}` : ''}
          </>
        ) : (
          <>
            {' · '}
            <Hint detail={tickDetail}>on its steady line, {formatCents(savedForCents)} by now</Hint>
          </>
        )}
      </p>
    </div>
  )
}
