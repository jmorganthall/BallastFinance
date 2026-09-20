/**
 * The left column, from tablet width up. The mark at the top, the places in
 * the middle. It never scrolls away: the page scrolls beside it.
 */

import Image from 'next/image'
import Link from 'next/link'
import { SidebarNav } from './nav'

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh flex-col border-r border-[var(--color-line)] bg-[var(--color-card)] pt-[env(safe-area-inset-top)] md:flex">
      <Link href="/" className="flex h-14 items-center gap-2 px-5" aria-label="Ballast home">
        <Image src="/logo-mark.png" alt="" width={32} height={32} priority className="h-8 w-8 shrink-0" />
        <span className="text-lg font-semibold tracking-tight">Ballast</span>
      </Link>
      <div className="mt-2 flex flex-1 flex-col">
        <SidebarNav />
      </div>
      <p className="px-5 pb-5 text-xs text-[var(--color-ink-soft)]">
        Never moves money. You make the transfers.
      </p>
    </aside>
  )
}
