/**
 * Shared UI primitives.
 *
 * Plain language is a product requirement, not a preference (PRD §9): the copy
 * here uses the household's words -- "weekly set-aside", "behind", "set aside
 * for later" -- and the internal vocabulary (accrual, drift, component) appears
 * only inside tooltips for anyone who wants it.
 */

import type { ReactNode } from 'react'
import { formatCents, type Cents } from '@/domain'

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
  return (
    <span
      title={detail}
      className="cursor-help underline decoration-dotted decoration-[var(--color-ink-soft)] underline-offset-4"
    >
      {children}
    </span>
  )
}

export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'behind' | 'ahead' | 'accent'
  children: ReactNode
}) {
  const tones = {
    neutral: 'bg-[var(--color-surface)] text-[var(--color-ink-soft)] border-[var(--color-line)]',
    behind: 'bg-[var(--color-behind-soft)] text-[var(--color-behind)] border-transparent',
    ahead: 'bg-[var(--color-ahead-soft)] text-[var(--color-ahead)] border-transparent',
    accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-transparent',
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
