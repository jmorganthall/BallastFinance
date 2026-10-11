/**
 * Shared UI primitives.
 *
 * Plain language is a product requirement, not a preference (PRD §9): the copy
 * here uses the household's words -- "weekly set-aside", "behind", "set aside
 * for later" -- and the internal vocabulary (accrual, drift, component) appears
 * only inside tooltips for anyone who wants it.
 */

import type { ReactNode } from 'react'
import { Tip } from '@/components/tip'
import { compareDates, formatCents, type Cents, type CivilDate } from '@/domain'
import { humanDistance } from '@/domain/next-due'

/** "Sep 1, 2026" from a civil date, with no timezone involved. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-4 ${className}`}
    >
      {children}
    </div>
  )
}

export function Money({
  cents,
  className = '',
}: {
  cents: Cents
  className?: string
}) {
  return <span className={`tabular ${className}`}>{formatCents(cents)}</span>
}

/**
 * The nerdy detail the plain-language rule keeps out of the main copy. Uses a
 * native title attribute so it works on a phone without any JS.
 */
export function Hint({ children, detail }: { children: ReactNode; detail: string }) {
  return <Tip detail={detail}>{children}</Tip>
}

/**
 * A money or to-do date said as a distance from today (PRD D38): "in 5
 * days", "tomorrow", "3 weeks ago", with the date itself on hover or tap.
 * `lead` opens a sentence ("In 5 days"); `due` says "due in 5 days" or "was
 * due 3 days ago"; `until` says how long something lasts ("for the next 5
 * weeks", "until tomorrow").
 */
export function When({
  date,
  today,
  as = 'plain',
}: {
  date: CivilDate
  today: CivilDate
  as?: 'plain' | 'lead' | 'due' | 'until'
}) {
  const daysAway = compareDates(date, today)
  const distance = humanDistance(daysAway)
  // A sentence that opens on a day already here is something to do now.
  const words =
    as === 'lead'
      ? daysAway < 0
        ? 'Now'
        : distance.charAt(0).toUpperCase() + distance.slice(1)
      : as === 'due'
        ? `${daysAway < 0 ? 'was due' : 'due'} ${distance}`
        : as === 'until'
          ? daysAway > 1
            ? `for the next ${distance.replace(/^in /, '')}`
            : `until ${distance}`
          : distance
  return <Hint detail={humanDate(date)}>{words}</Hint>
}

/** The snooze mark (D38): a sleeping "Zzz", never the only sign -- a word is always beside it. */
export function Zzz({ className = '' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`font-semibold italic tracking-tight ${className}`}>
      Z<sup className="text-[0.75em]">z</sup>
      <sup className="text-[0.6em]">z</sup>
    </span>
  )
}

export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'behind' | 'ahead' | 'accent' | 'caution'
  children: ReactNode
}) {
  const tones = {
    neutral: 'bg-[var(--color-surface)] text-[var(--color-ink-soft)] border-[var(--color-line)]',
    behind: 'bg-[var(--color-behind-soft)] text-[var(--color-behind)] border-transparent',
    ahead: 'bg-[var(--color-ahead-soft)] text-[var(--color-ahead)] border-transparent',
    accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-transparent',
    caution: 'bg-[var(--color-caution-soft)] text-[var(--color-caution)] border-transparent',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-5">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{subtitle}</p> : null}
    </header>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-2 text-sm text-[var(--color-ink-soft)]">{children}</div> : null}
    </Card>
  )
}
