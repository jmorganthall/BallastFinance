'use client'

/**
 * How often something comes round: a count and a unit, not a menu of four.
 *
 * "Every 3 weeks" and "every 18 months" are as ordinary as "every year", and a
 * fixed list made them unenterable. The count disappears for a one-off, so the
 * common case is still a single control (PRD §9: a screen a non-technical
 * reader does not need translated).
 *
 * It owns its own state so a server-rendered form can use it with no wiring;
 * `onChange` is for a caller that keeps its own copy, like the plan builder.
 */

import { useId, useState } from 'react'
import {
  describeRecurrence,
  recurrenceOf,
  RECURRENCE_UNITS,
  UNIT_LABELS,
  type Recurrence,
  type RecurrenceUnit,
} from '@/domain/recurrence'

const field =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

export function RecurrenceFields({
  defaultValue = null,
  onChange,
  label = 'How often',
}: {
  defaultValue?: Recurrence | null
  onChange?: (recurrence: Recurrence | null) => void
  label?: string
}) {
  // A plan editor renders one of these per part, so the label id must be unique.
  const labelId = useId()
  const [unit, setUnit] = useState<RecurrenceUnit | 'none'>(defaultValue?.unit ?? 'none')
  const [every, setEvery] = useState(String(defaultValue?.every ?? 1))

  const tell = (nextUnit: RecurrenceUnit | 'none', nextEvery: string) => {
    onChange?.(recurrenceOf(nextEvery, nextUnit))
  }

  return (
    <div className="block text-sm font-medium">
      <span id={labelId}>{label}</span>
      <div className="mt-1 flex gap-2">
        {unit === 'none' ? (
          // Still submitted, so a row of parts stays lined up with its fields.
          <input type="hidden" name="recurrence_every" value="1" />
        ) : (
          <input
            name="recurrence_every"
            type="number"
            min={1}
            max={999}
            value={every}
            onChange={(e) => {
              setEvery(e.target.value)
              tell(unit, e.target.value)
            }}
            aria-label="How many"
            className={`${field} w-16 shrink-0 sm:w-20`}
          />
        )}
        <select
          name="recurrence_unit"
          value={unit}
          onChange={(e) => {
            const next = e.target.value as RecurrenceUnit | 'none'
            setUnit(next)
            tell(next, every)
          }}
          aria-labelledby={labelId}
          className={`${field} min-w-0 flex-1`}
        >
          <option value="none">Just once</option>
          {RECURRENCE_UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </div>
      {unit === 'none' ? null : (
        <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
          {describeRecurrence(recurrenceOf(every, unit)) === 'Just once'
            ? 'Enter how many.'
            : `${describeRecurrence(recurrenceOf(every, unit))}. It comes round again on its own, and a past date means the last one was then.`}
        </span>
      )}
    </div>
  )
}
