import Link from 'next/link'
import { requireViewer } from '@/server/session'

const TABS = [
  { href: '/', label: 'This week' },
  { href: '/packages', label: 'Plans' },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireViewer()

  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl px-4 pb-24 pt-6">
      {children}

      {/* Fixed bottom nav: everything reachable with a thumb (PRD §9). */}
      <nav className="fixed inset-x-0 bottom-0 border-t border-[var(--color-line)] bg-[var(--color-card)] pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto flex max-w-2xl">
          {TABS.map((tab) => (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                className="flex h-14 items-center justify-center text-sm font-medium"
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
