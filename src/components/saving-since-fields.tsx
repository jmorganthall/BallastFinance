/**
 * "Saving since": where a part's money timeline begins, as one question
 * (PRD D30, D33, D36). A repeating part has three answers: the last time it
 * came round (the default for a new one), the day the plan started (the
 * older reading, under which the elapsed share is offered as an opening
 * instead), or another day, typed. A one-off has no last time, so it has
 * the other two, and the day the plan started (or the day it was added) is
 * its default.
 *
 * Server-rendered, no client JavaScript: the date box under "another day"
 * is revealed by CSS on the radio state, and the dates shown are the
 * domain's. The form posts `timeline_part`, `timeline_start_<id>`,
 * `timeline_date_<id>` and what the part had in `timeline_was_<id>`, so a
 * save can tell an answer a person changed from one left as it was; the
 * engine judges the day against today and the due date, so nothing here
 * decides anything.
 */

import { humanDate } from '@/components/ui'
import type { CivilDate, TimelineStart } from '@/domain'

const field =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

export function SavingSinceFields({
  lineItemId,
  lastOccurrence,
  planStarted,
  today,
  current = 'last_occurrence',
  currentDate = null,
  planStartedLabel = 'The day the plan started',
}: {
  lineItemId: string
  /** The last time the part came round, from the domain; null for a one-off, which never did. */
  lastOccurrence: CivilDate | null
  /** The commit date or the day the part was added (the position's `startedOn`), or today for a draft. */
  planStarted: CivilDate
  today: CivilDate
  current?: TimelineStart
  currentDate?: CivilDate | null
  planStartedLabel?: string
}) {
  const name = `timeline_start_${lineItemId}`
  const choice = (
    kind: TimelineStart,
    marker: string,
    label: string,
    note: string,
  ) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name={name}
        value={kind}
        defaultChecked={current === kind}
        className={`${marker} mt-1`}
      />
      <span>
        {label}
        <span className="block text-xs text-[var(--color-ink-soft)]">{note}</span>
      </span>
    </label>
  )

  return (
    <fieldset className="group/since space-y-2">
      <legend className="text-sm font-medium">Saving since</legend>
      <input type="hidden" name="timeline_part" value={lineItemId} />
      <input
        type="hidden"
        name={`timeline_was_${lineItemId}`}
        value={current === 'typed' && currentDate ? `typed:${currentDate}` : current}
      />
      {lastOccurrence
        ? choice(
            'last_occurrence',
            'tl-last',
            `The last time this came round (${humanDate(lastOccurrence)})`,
            'It should already hold its share of the cycle, and the weekly amount is the steady one.',
          )
        : null}
      {choice(
        'commit',
        'tl-commit',
        `${planStartedLabel} (${humanDate(planStarted)})`,
        'It starts from nothing, and the weekly amount fits the rest into the time left.',
      )}
      {choice(
        'typed',
        'tl-typed',
        'Another day',
        'The day you started setting money aside for this. It should hold its share since then.',
      )}
      <div className="hidden pl-6 group-has-[.tl-typed:checked]/since:block">
        <label className="block text-sm font-medium">
          Which day?
          <input
            name={`timeline_date_${lineItemId}`}
            type="date"
            max={today}
            defaultValue={currentDate ?? ''}
            className={field}
          />
        </label>
      </div>
    </fieldset>
  )
}
