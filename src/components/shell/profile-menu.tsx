'use client'

/**
 * The person in the top-right corner: who is signed in, and the way out.
 *
 * A plain button and a small menu. Closes on a tap outside, on Escape, and
 * after choosing anything, so it behaves the same with a thumb as with a mouse.
 */

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { signOutAction } from '@/server/actions'

export interface ProfileViewer {
  name: string | null
  email: string
  image: string | null
}

function initialsOf(name: string | null, email: string): string {
  const source = name?.trim() || email
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : source.slice(0, 2)
  return letters.toUpperCase()
}

function Avatar({ viewer, size }: { viewer: ProfileViewer; size: 'sm' | 'lg' }) {
  const [broken, setBroken] = useState(false)
  const dimension = size === 'sm' ? 'h-8 w-8 text-xs' : 'h-12 w-12 text-base'
  if (viewer.image && !broken) {
    return (
      // A plain img: the picture lives on Google's CDN, which is not a host
      // next/image is allowed to optimise, and a 32px avatar needs no optimising.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={viewer.image}
        alt=""
        width={size === 'sm' ? 32 : 48}
        height={size === 'sm' ? 32 : 48}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={`${dimension} shrink-0 rounded-full object-cover`}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`${dimension} flex shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]`}
    >
      {initialsOf(viewer.name, viewer.email)}
    </span>
  )
}

export function ProfileMenu({ viewer }: { viewer: ProfileViewer }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const firstName = viewer.name?.split(' ')[0] ?? null

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={open ? 'Close account menu' : 'Open account menu'}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-card)] py-1 pl-1 pr-2 hover:bg-[var(--color-surface)] sm:pr-3"
      >
        <Avatar viewer={viewer} size="sm" />
        {firstName ? (
          <span className="hidden max-w-[8rem] truncate text-sm font-medium sm:block">
            {firstName}
          </span>
        ) : null}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`h-4 w-4 text-[var(--color-ink-soft)] transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-2 shadow-lg"
        >
          <div className="flex items-center gap-3 px-3 py-3">
            <Avatar viewer={viewer} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-medium">{viewer.name ?? 'Signed in'}</p>
              <p className="truncate text-xs text-[var(--color-ink-soft)]">{viewer.email}</p>
            </div>
          </div>
          <div className="my-1 border-t border-[var(--color-line)]" />
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-11 items-center rounded-xl px-3 text-sm font-medium hover:bg-[var(--color-surface)]"
          >
            Settings
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-surface)]"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  )
}
