/**
 * A part's or plan's progress, read at a glance (D35, D38): the fill is what
 * the account's money counts toward it; the white tick with the pace flag
 * above it is where steady saving would have it today; while it is catching
 * up, the stretch from the fill to the tick is striped yellow on a green
 * fill -- the account will have it on the day, it is just below pace now.
 * Short is red, Ready to spend blue. The colour never stands alone: the pill
 * says the word, and a tap on the pill or the flag says the rest. One line of
 * numbers, "$X of $Y, due in N". The reading comes from the domain; this only
 * draws it.
 */

import { Hint, humanDate, When } from '@/components/ui'
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
  today,
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
  /** Dates are said as a distance from today (D38). */
  today: CivilDate
  className?: string
}) {
  const bar = barOf({ totalCents, countedCents, savedForCents })
  const tickDetail = savingSince
    ? `Pace: saving steadily since ${humanDate(savingSince.date)} (${savingSince.words})${dueDate ? ` to ${humanDate(dueDate)}` : ''}, ${formatCents(savedForCents)} would be here by today.`
    : `Pace: saving steadily over each part's own stretch, ${formatCents(savedForCents)} would be here by today.`
  // What a tap on the status word says: the reason, in a sentence or two.
  const statusDetail =
    status === 'short'
      ? `On the transfer set up now, the account runs short${shortOn ? ` on ${humanDate(shortOn)}` : ''}. This week says what fixes it.`
      : status === 'ready_to_spend'
        ? 'All of it is here and its date has come. The money stays held until you say it was spent.'
        : status === 'catching_up'
          ? [
              `Below pace by ${formatCents(coveringSoonerCents + notYetHereCents)} today (the striped part).`,
              coveringSoonerCents > 0
                ? `${formatCents(coveringSoonerCents)} of it is covering plans due sooner.`
                : null,
              notYetHereCents > 0 ? `${formatCents(notYetHereCents)} is not in the account yet.` : null,
              'The weekly transfer is set so the account has all of it on the day it is due.',
            ]
              .filter(Boolean)
              .join(' ')
          : bar.fullyFunded
            ? 'All of it is here; nothing more to save.'
            : 'At or ahead of pace.'
  // On a catch-up the fill is green -- it will be there on the day -- and the
  // gap to the pace tick is striped yellow (D38).
  const fill = status === 'catching_up' ? STATUS_FILL.on_track : STATUS_FILL[status]

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
        {!bar.fullyFunded ? (
          <span
            className="absolute -top-5 -translate-x-1/2"
            style={{ left: `${bar.tickPercent}%` }}
          >
            <Hint detail={tickDetail}>
              <PaceFlag />
              <span className="sr-only">Pace</span>
            </Hint>
          </span>
        ) : null}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={bar.fillPercent}
          aria-label={`${formatCents(countedCents)} of ${formatCents(totalCents)} here, ${PART_STATUS_WORDS[status].toLowerCase()}`}
          className="relative flex h-3 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
        >
          <div className="h-full" style={{ width: `${bar.fillPercent}%`, background: fill }} />
          {status === 'catching_up' && bar.catchUpPercent > 0 ? (
            <div
              aria-hidden="true"
              className="h-full"
              style={{
                width: `${bar.catchUpPercent}%`,
                background:
                  'repeating-linear-gradient(-45deg, var(--color-caution) 0 4px, var(--color-caution-soft) 4px 8px)',
              }}
            />
          ) : null}
        </div>
        {!bar.fullyFunded ? (
          <div
            aria-hidden="true"
            className="absolute -top-1 h-5 w-0.5 rounded-sm bg-[var(--color-ink)]"
            style={{ left: `calc(${bar.tickPercent}% - 1px)` }}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The pace mark above the tick: a small chequered flag. */
function PaceFlag() {
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
