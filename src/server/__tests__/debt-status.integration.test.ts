/**
 * PRD D49 (4)-(6): one status per debt, read by This week's to-dos, the
 * digest and the debt's fix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { buildWeeklyDigest } from '@/server/digest'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

describeDb('debt statuses', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let shieldId: string
  const TODAY = '2026-10-14'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Debt status ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })

    const shield = await engine.createDebt({
      name: 'Shield 0568',
      category: 'consumer',
      balanceCents: 670239,
      balanceAsOf: '2026-10-01',
      aprBasisPoints: 3049,
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2028-01-12', chargedBack: false }],
      minPaymentRule: { type: 'fixed', amountCents: 4000 },
      plannedPaymentCents: 47500,
    })
    shieldId = shield.id
    await engine.createDebt({
      name: 'Old card',
      category: 'consumer',
      balanceCents: 120000,
      balanceAsOf: '2026-09-01',
      aprBasisPoints: 2199,
      minPaymentRule: { type: 'fixed', amountCents: 4000 },
    })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.debts).where(eq(schema.debts.householdId, householdId))
    }
    await client?.end()
  })

  it('says which debt misses its deal and which balance is old, with a to-do for each', async () => {
    const { debts, todos, caughtUp } = await engine.debtStatuses()
    expect(debts.find((d) => d.debt.name === 'Shield 0568')!.status).toBe('misses_deal')
    expect(debts.find((d) => d.debt.name === 'Old card')).toMatchObject({ status: 'on_track', balanceStale: true, balanceAgeDays: 43 })
    expect(todos.map((t) => [t.kind, t.debtName])).toEqual([
      ['raise_debt_payment', 'Shield 0568'],
      ['update_debt_balance', 'Old card'],
    ])
    expect(caughtUp).toBe(false)
  })

  it('the digest says it in the same words, and counts the debt as something to do', async () => {
    const digest = await buildWeeklyDigest({ householdId, baseUrl: 'https://ballast.example', db, today: TODAY })
    expect(digest.body).toContain(
      '- **Shield 0568**: Misses its 0% — The 0% ends 2028-01-12 with $52.39 still owed, charged 30.49% from then. Pay $478.75 a month to clear it in time.',
    )
    expect(digest.body).toContain('- Raise the monthly payment on Shield 0568 to $478.75')
    expect(digest.body).toContain('- Check the balance on Old card against its statement: it was last checked 43 days ago.')
    expect(digest.summary).toBe('Ballast: 1 thing(s) to do this week.')
    expect(digest.detail).toMatchObject({
      all_caught_up: false,
      debts: [{ name: 'Shield 0568', status: 'misses_deal', owed_at_end_cents: 5239, clear_per_month_cents: 47875 }],
    })
  })

  it('doing the fix, and checking the old balance, leaves nothing to do', async () => {
    await engine.updateDebt(shieldId, { plannedPaymentCents: 47875 })
    const old = (await engine.listDebts()).find((d) => d.name === 'Old card')!
    await engine.updateDebtBalance({ debtId: old.id, balanceCents: 118000 })

    const { todos, caughtUp } = await engine.debtStatuses()
    expect(todos).toEqual([])
    expect(caughtUp).toBe(true)
  })

  it('a deal entered before Ballast asked about charged-back interest asks once, and the answer is kept', async () => {
    const debt = await engine.createDebt({
      name: 'Store card',
      category: 'consumer',
      balanceCents: 90000,
      aprBasisPoints: 2699,
      promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2027-06-30' }],
      minPaymentRule: { type: 'fixed', amountCents: 20000 },
    })
    expect((await engine.debtStatuses()).todos.map((t) => [t.kind, t.debtName])).toEqual([
      ['check_deal_terms', 'Store card'],
    ])
    const [stored] = (await engine.listDebts()).filter((d) => d.id === debt.id)
    await engine.updateDebt(debt.id, { promoRules: stored!.promoRules.map((r) => ({ ...r, chargedBack: false })) })
    expect((await engine.debtStatuses()).todos).toEqual([])
    expect((await engine.listDebts()).find((d) => d.id === debt.id)!.enteredOn).toBe(TODAY)
  })
})
