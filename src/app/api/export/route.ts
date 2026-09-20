/**
 * Household data export (PRD §11: the data-freedom guarantee).
 *
 * Objects plus the full event log, as one JSON file. The event log is the point:
 * without it an export is a snapshot, and every balance in it is unfalsifiable.
 * With it, the whole history can be recomputed from scratch elsewhere.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { debts, events, lineItems, packages, reserveAccounts, settings } from '@/db/schema'
import { requireViewer } from '@/server/session'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const viewer = await requireViewer()
  const where = viewer.householdId

  const [accountRows, packageRows, lineItemRows, debtRows, eventRows, settingRows] =
    await Promise.all([
      db.select().from(reserveAccounts).where(eq(reserveAccounts.householdId, where)),
      db.select().from(packages).where(eq(packages.householdId, where)),
      db.select().from(lineItems).where(eq(lineItems.householdId, where)),
      db.select().from(debts).where(eq(debts.householdId, where)),
      db.select().from(events).where(eq(events.householdId, where)),
      db.select().from(settings).where(eq(settings.householdId, where)),
    ])

  const payload = {
    exported_at: new Date().toISOString(),
    household_id: where,
    note: 'Amounts are integer cents. Dates are calendar dates in America/Chicago.',
    reserve_accounts: accountRows,
    packages: packageRows,
    line_items: lineItemRows,
    debts: debtRows,
    settings: settingRows,
    events: eventRows,
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="ballast-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    },
  })
}
