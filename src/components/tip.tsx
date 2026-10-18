'use client'

/**
 * The words behind a dotted underline: on hover where there is a mouse, and
 * on a tap on a phone, where `title` alone never shows (PRD D38: every date
 * said as a distance shows the date itself this way).
 */

import { useState, type ReactNode } from 'react'

export function Tip({
  children,
  detail,
  above = false,
  plain = false,
}: {
  children: ReactNode
  detail: string
  /** Open above, where below would be cut off (a pin on a chart's axis). */
  above?: boolean
  /** No dotted underline, for a mark that is not words. */
  plain?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <span
      title={detail}
      tabIndex={0}
      role="button"
      aria-expanded={open}
      onClick={(e) => {
        // Inside a card that is a link, a tap shows the words, not the page.
        e.preventDefault()
        e.stopPropagation()
        setOpen((o) => !o)
      }}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen((o) => !o)
        }
        if (e.key === 'Escape') setOpen(false)
      }}
      className={`relative cursor-help ${plain ? '' : 'underline decoration-dotted decoration-[var(--color-ink-soft)] underline-offset-4'}`}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          className={`absolute z-10 block w-max max-w-[16rem] whitespace-pre-line rounded-lg border ${above ? 'bottom-full left-1/2 mb-1 -translate-x-1/2' : 'left-0 top-full mt-1'} border-[var(--color-line)] bg-[var(--color-card)] px-2.5 py-1.5 text-xs font-normal text-[var(--color-ink)] no-underline shadow-lg`}
        >
          {detail}
        </span>
      ) : null}
    </span>
  )
}
