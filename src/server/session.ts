/**
 * The bridge from an authenticated session to a household-scoped engine.
 *
 * Server components and route handlers call requireEngine(); there is no path
 * from a request to the database that skips this, which is what keeps household
 * scoping out of UI code (PRD §2).
 */

import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { Engine } from '@/server/engine'

export interface Viewer {
  userId: string
  householdId: string
  email: string
  name: string | null
}

export async function currentViewer(): Promise<Viewer | null> {
  const session = await auth()
  if (!session?.user?.id || !session.user.householdId) return null
  return {
    userId: session.user.id,
    householdId: session.user.householdId,
    email: session.user.email ?? '',
    name: session.user.name ?? null,
  }
}

export async function requireViewer(): Promise<Viewer> {
  const viewer = await currentViewer()
  if (!viewer) redirect('/sign-in')
  return viewer
}

export async function requireEngine(): Promise<{ engine: Engine; viewer: Viewer }> {
  const viewer = await requireViewer()
  return {
    viewer,
    engine: new Engine({ householdId: viewer.householdId, actorUserId: viewer.userId }),
  }
}
