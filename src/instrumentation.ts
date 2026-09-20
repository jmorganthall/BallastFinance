/**
 * Starts the in-app scheduler once, in the Node runtime only (PRD §10: the app
 * owns computation, n8n owns delivery).
 *
 * Disabled during `next build` and in tests, so a build never fires a real
 * notification.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  if (process.env.DISABLE_SCHEDULER === '1') return

  const { startScheduler } = await import('@/server/scheduler')
  startScheduler()
}
