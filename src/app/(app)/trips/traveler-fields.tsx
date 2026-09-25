'use client'

/**
 * Who is going: a name and an age band each. Disney's bands decide what a
 * person pays for (adult from 10, child 3 to 9, infant under 3 pays for no
 * ticket, Lightning Lane, dining plan or souvenirs), so the band is the one
 * fact asked for beyond a name. Rows are plain inputs posted with the form.
 */

import { useState } from 'react'
import type { Traveler, TravelerBand } from '@/domain'

const input =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

const BANDS: { value: TravelerBand; label: string }[] = [
  { value: 'adult', label: 'Adult (10+)' },
  { value: 'child', label: 'Child (3–9)' },
  { value: 'infant', label: 'Under 3' },
]

export function TravelerFields({ initial = [] }: { initial?: Traveler[] }) {
  const [rows, setRows] = useState<Traveler[]>(initial.length > 0 ? initial : [{ name: '', band: 'adult' }, { name: '', band: 'adult' }])

  return (
    <fieldset>
      <legend className="text-sm font-medium">Who is going</legend>
      <div className="mt-1 space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-xs text-[var(--color-ink-soft)]">
              Name
              <input
                name="traveler_name"
                value={row.name}
                onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                placeholder="Josh"
                className={input}
              />
            </label>
            <label className="text-xs text-[var(--color-ink-soft)]">
              Age
              <select
                name="traveler_band"
                value={row.band}
                onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, band: e.target.value as TravelerBand } : r)))}
                className={input}
              >
                {BANDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label="Take this person off"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
              className="mb-1 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setRows([...rows, { name: '', band: 'child' }])}
        className="mt-2 text-sm text-[var(--color-accent)] underline underline-offset-4"
      >
        Add someone
      </button>
    </fieldset>
  )
}
