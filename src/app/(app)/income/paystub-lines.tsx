'use client'

/**
 * Paystub lines on the income form: as many as the stub has. Starts with the
 * lines already saved, or one blank one, and "Add a line" adds another. Each
 * row posts `<prefix>_label` and `<prefix>_amount`; the action skips blank
 * rows and reads "6%" as a percent of the check.
 */

import { useState } from 'react'

export interface LineValue {
  label: string
  amount: string
}

const input =
  'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-ink)]'

export function PaystubLines({
  prefix,
  initial,
  placeholder,
}: {
  prefix: 'pretax' | 'tax'
  initial: LineValue[]
  placeholder: string
}) {
  const [rows, setRows] = useState<(LineValue & { key: number })[]>(() =>
    (initial.length > 0 ? initial : [{ label: '', amount: '' }]).map((r, i) => ({ ...r, key: i })),
  )
  const [next, setNext] = useState(rows.length)

  return (
    <div className="mt-1 space-y-1">
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-[1fr_8rem_auto] items-center gap-2">
          <input name={`${prefix}_label`} defaultValue={row.label} placeholder={placeholder} className={input} aria-label="What" />
          <input name={`${prefix}_amount`} defaultValue={row.amount} inputMode="decimal" placeholder="0.00 or 6%" className={input} aria-label="Amount" />
          <button
            type="button"
            onClick={() => setRows((rs) => (rs.length === 1 ? [{ label: '', amount: '', key: next }] : rs.filter((r) => r.key !== row.key)))}
            className="px-1 text-xs text-[var(--color-ink-soft)] underline"
            aria-label="Remove this line"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          setRows((rs) => [...rs, { label: '', amount: '', key: next + 1 }])
          setNext((n) => n + 2)
        }}
        className="text-sm underline"
      >
        Add a line
      </button>
    </div>
  )
}
