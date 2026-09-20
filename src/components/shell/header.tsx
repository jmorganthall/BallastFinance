/**
 * The top bar. On a phone: the mark on the left, the person on the right. From
 * tablet width up the sidebar carries the mark, so the bar names the section
 * instead. Sticky, with room for a notched status bar when installed as a PWA.
 */

import Image from 'next/image'
import Link from 'next/link'
import type { Viewer } from '@/server/session'
import { ProfileMenu } from './profile-menu'
import { SectionTitle } from './nav'

export function AppHeader({ viewer }: { viewer: Viewer }) {
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-card)]/90 pt-[env(safe-area-inset-top)] backdrop-blur">
      {/* Full width, no centred cap: the person is always at the far right edge. */}
      <div className="flex h-14 w-full items-center gap-3 px-4">
        <Link href="/" className="flex items-center gap-2 md:hidden" aria-label="Ballast home">
          <Image src="/logo-mark.png" alt="" width={32} height={32} priority className="h-8 w-8 shrink-0" />
          <span className="text-lg font-semibold tracking-tight">Ballast</span>
        </Link>
        <div className="hidden md:block">
          <SectionTitle />
        </div>
        <div className="ml-auto">
          <ProfileMenu viewer={{ name: viewer.name, email: viewer.email, image: viewer.image }} />
        </div>
      </div>
    </header>
  )
}
