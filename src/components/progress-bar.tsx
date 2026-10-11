/**
 * A part's or plan's progress, read at a glance (D35, D38, D40): the fill is
 * what the account's money counts toward it; the white tick with the flag
 * above it is what the account must hold for it today so that every date is
 * met on the transfer set up at the bank. At or past the tick it is On
 * track; below it, on an account that is Short, it is Short -- and a Short
 * bar says why and what fixes it under the bar, not only on a tap.
 * Short is red, Ready to spend blue. The colour never stands alone: the pill
 * says the word. One line of numbers, "$X of $Y, due in N". The reading comes
 * from the domain; this only draws it.
 */

import { Hint, humanDate, When } from '@/components/ui'
import { PartStatusPill, STATUS_FILL } from '@/components/status'
import {
  barOf,
  formatCents,
  PART_STATUS_WORDS,
  type Cents,
  type CivilDate,
  type PartStatus,
  type ShortReason,
} from '@/domain'

export function ProgressBar({
  totalCents,
  countedCents,
  tickCents,
  status,
  dueDate,
  shortReasons = [],
  today,
  className = '',
}: {
  totalCents: Cents
  countedCents: Cents
  /** What the account must hold for it today (D40). */
  tickCents: Cents
  status: PartStatus
  dueDate?: CivilDate
  /** Why its accounts are Short and what fixes each, when the status is Short. */
  shortReasons?: readonly ShortReason[]
  /** Dates are said as a distance from today (D38). */
  today: CivilDate
  className?: string
}) {
  const bar = barOf({ totalCents, countedCents, tickCents })
  const tickDetail = `What the account needs to hold for this today, so every date is met on the transfer set up now: ${formatCents(tickCents)}.`
  // What a tap on the status word says: the reason, in a sentence or two.
  const statusDetail =
    status === 'short'
      ? 'Below what the account needs to hold for it today: on the transfer set up now, the money runs out before it is due.'
      : status === 'ready_to_spend'
        ? 'All of it is here and its date has come. The money stays held until you say it was spent.'
        : bar.fullyFunded
          ? 'All of it is here; nothing more to save.'
          : 'At or past what the account needs to hold for it today. The transfer set up now has the rest there on the day.'
  const fill = STATUS_FILL[status]

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3">
        <Hint detail={statusDetail}>
          <PartStatusPill status={status} />
        </Hint>
        <span className="tabular text-xs text-[var(--color-ink-soft)]">
          {formatCents(countedCents)} of {formatCents(totalCents)}
          {dueDate ? (
            <>
              , <When date={dueDate} today={today} as="due" />
            </>
          ) : null}
        </span>
      </div>
      <div className="relative mt-5">
        {!bar.fullyFunded && tickCents > 0 ? (
          <span
            className="absolute -top-5 -translate-x-1/2"
            style={{ left: `${bar.tickPercent}%` }}
          >
            <Hint detail={tickDetail}>
              <TickFlag />
              <span className="sr-only">Needed today</span>
            </Hint>
          </span>
        ) : null}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={bar.fillPercent}
          aria-label={`${formatCents(countedCents)} of ${formatCents(totalCents)} here, ${formatCents(tickCents)} needed today, ${PART_STATUS_WORDS[status].toLowerCase()}`}
          className="relative flex h-3 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
        >
          <div className="h-full" style={{ width: `${bar.fillPercent}%`, background: fill }} />
        </div>
        {!bar.fullyFunded && tickCents > 0 ? (
          <div
            aria-hidden="true"
            className="absolute -top-1 h-5 w-0.5 rounded-sm bg-[var(--color-ink)]"
            style={{ left: `calc(${bar.tickPercent}% - 1px)` }}
          />
        ) : null}
      </div>
      {status === 'short' && shortReasons.length > 0 ? (
        <div className="mt-2 space-y-1 text-xs text-[var(--color-ink-soft)]">
          {shortReasons.map((r) => (
            <p key={r.accountId}>
              {r.accountName} runs short <When date={r.on} today={today} as="due" />.
              {r.fixes.length > 0 ? ` Fix on This week: ${r.fixes.join(', then ')}.` : ''}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The mark above the tick: a small chequered flag. */
function TickFlag() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="block">
      <rect x="2" y="1" width="1.5" height="12" rx="0.5" fill="var(--color-ink)" />
      <rect x="3.5" y="1.5" width="9" height="6" fill="var(--color-card)" stroke="var(--color-ink)" strokeWidth="0.75" />
      <rect x="3.5" y="1.5" width="3" height="2" fill="var(--color-ink)" />
      <rect x="9.5" y="1.5" width="3" height="2" fill="var(--color-ink)" />
      <rect x="6.5" y="3.5" width="3" height="2" fill="var(--color-ink)" />
      <rect x="3.5" y="5.5" width="3" height="2" fill="var(--color-ink)" />
      <rect x="9.5" y="5.5" width="3" height="2" fill="var(--color-ink)" />
    </svg>
  )
}
