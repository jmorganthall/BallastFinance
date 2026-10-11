'use client'

/**
 * The words behind a dotted underline: on hover where there is a mouse, and
 * on a tap on a phone, where `title` alone never shows (PRD D38: every date
 * said as a distance shows the date itself this way).
 */

import { useState, type ReactNode } from 'react'

export function Tip({ children, detail }: { children: ReactNode; detail: string }) {
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
      className="relative cursor-help underline decoration-dotted decoration-[var(--color-ink-soft)] underline-offset-4"
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-10 mt-1 block w-max max-w-[16rem] rounded-lg border border-[var(--color-line)] bg-[var(--color-card)] px-2.5 py-1.5 text-xs font-normal text-[var(--color-ink)] no-underline shadow-lg"
        >
          {detail}
        </span>
      ) : null}
    </span>
  )
}
