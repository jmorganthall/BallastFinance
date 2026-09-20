import { requireViewer } from '@/server/session'
import { AppHeader } from '@/components/shell/header'
import { AppFooter } from '@/components/shell/footer'
import { Sidebar } from '@/components/shell/sidebar'
import { BottomNav } from '@/components/shell/nav'

/**
 * The shell every signed-in screen sits in.
 *
 * Phone: a top bar with the mark and the person, the page, the footer, and a
 * fixed tab bar within reach of a thumb (PRD §9). Tablet and up: the same
 * screens beside a left sidebar, the tab bar gone, the top bar naming the
 * section. One layout, two widths -- not two apps.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer()

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Sidebar />

      {/* Bottom padding on a phone clears the fixed tab bar plus the home indicator. */}
      <div className="flex min-h-dvh min-w-0 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <AppHeader viewer={viewer} />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-6">{children}</main>
        <AppFooter />
      </div>

      <BottomNav />
    </div>
  )
}
