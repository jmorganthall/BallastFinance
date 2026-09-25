'use client'

/**
 * The one list of places in the app, drawn two ways: a sidebar from tablet
 * width up, and a thumb-height tab bar on a phone (PRD §9: every flow one-handed
 * on a phone; desktop is a wider layout of the same screens, not a different
 * app). Both read the current path so the active place is always marked.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export interface NavItem {
  href: string
  label: string
  icon: keyof typeof ICONS
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'This week', icon: 'week' },
  { href: '/check-in', label: 'Check in', icon: 'check' },
  { href: '/allocate', label: 'Share out', icon: 'share' },
  { href: '/debts', label: 'Debts', icon: 'debts' },
  { href: '/packages', label: 'Plans', icon: 'plans' },
  { href: '/trips', label: 'Trips', icon: 'trips' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
]

/** Simple 24-unit line icons, drawn inline so nothing is fetched. */
const ICONS = {
  week: 'M8 3v3M16 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 12h3M8 16h6',
  check: 'M20 6 9 17l-5-5',
  share: 'M12 3v12M8 11l4 4 4-4M5 21h14',
  debts: 'M3 7h18v10H3zM3 11h18M7 15h3',
  plans: 'M4 4h11l5 5v11H4zM15 4v5h5M8 13h8M8 17h5',
  // A suitcase.
  trips: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M4 7h16v12H4zM8 7v12M16 7v12',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
} as const

function Icon({ name, className = '' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={ICONS[name]} />
    </svg>
  )
}

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

/** The name of the place the person is on, for the header. */
export function currentSection(pathname: string): string {
  return NAV_ITEMS.find((item) => isActive(pathname, item.href))?.label ?? 'Ballast'
}

export function SidebarNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="flex-1 px-3">
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]'
                }`}
              >
                <Icon name={item.icon} className="h-5 w-5 shrink-0" />
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function BottomNav() {
  const pathname = usePathname()
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-line)] bg-[var(--color-card)] pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-2xl">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href)
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 px-1 text-center text-[11px] font-medium leading-tight ${
                  active ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-soft)]'
                }`}
              >
                <Icon name={item.icon} className="h-5 w-5" />
                <span className="w-full truncate">{item.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function SectionTitle() {
  const pathname = usePathname()
  return <span className="text-sm font-medium text-[var(--color-ink-soft)]">{currentSection(pathname)}</span>
}
