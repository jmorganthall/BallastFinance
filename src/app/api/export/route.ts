/**
 * Household data export (PRD §11: the data-freedom guarantee).
 *
 * Every table that belongs to the household, plus the full event log, as one
 * JSON file, read through the engine in one snapshot so the parts agree
 * (`Engine.exportAll`). The rows are the household's facts as they stand;
 * the event log is how they came to be. Every write to an account, a plan,
 * a part or a debt records its event (the layering plan's Phase 4), and
 * every money figure Ballast shows is worked out from these rows and events
 * by `src/domain`, so nothing derived needs exporting. Reference data that
 * belongs to no household (park and crowd data, public lodging rates) is
 * left out. Events from before Phase 4 are older than that rule: a few
 * early rows (an account, a plan, a debt made then) have no creation event,
 * so the rows here, not the log alone, are the starting point.
 */

import { requireEngine } from '@/server/session'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const { engine, viewer } = await requireEngine()
  const tables = await engine.exportAll()

  const payload = {
    format: 2,
    exported_at: new Date().toISOString(),
    household_id: viewer.householdId,
    note:
      'Amounts are integer cents; rates are basis points. Dates are calendar dates in the household\'s timezone. ' +
      'Every figure Ballast shows is worked out from these rows and events; none is stored.',
    ...tables,
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="ballast-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    },
  })
}
