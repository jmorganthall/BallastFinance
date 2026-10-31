/**
 * Which build is running, for the Update now button to poll while the
 * container is recreated. No sign-in: the new build may answer before the
 * page's session is read again, and a revision is no secret -- the published
 * image carries it as a label.
 */

import { runningBuild } from '@/server/version'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return Response.json({ revision: runningBuild().revision }, { headers: { 'cache-control': 'no-store' } })
}
