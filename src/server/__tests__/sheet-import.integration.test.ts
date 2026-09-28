/**
 * The spreadsheet import, against a live database: what the sheet said
 * becomes live plans with their reserved amounts counted, new accounts, and
 * dated debts -- through the same paths a person would use by hand.
 *
 * The figures are the one position's (D35). TODAY is a Sunday; transfers run
 * on Saturdays, the default, and "n transfers" is the Saturdays in (from, to].
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { parseSheet } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

const SHEET = [
  'Account\tIn Simplifi\tExpense\tBracket\tDue Every\tNext Due\tReserved Now\tAmount\tMonthly\tWeekly',
  'Annual Expenses\tYes\tCar insurance\tA\t6 months\t2/15/2027\t$410.00\t$1,230.00\t$205.00\t$47.31',
  'Gifts & Giving\tYes\tChristmas\tA\tYear\t12/19/2026\t$250\t$1,000\t$83.33\t$19.23',
  'Annual Expenses\tYes\tBroken row\tA\twhenever\t12/19/2026\t\t$10\t\t',
  '',
  'Loan\tCategory\tFreed Up\tMonthly\tAPR\t%\t$\tPrincipal/Month\tInt/Month\tInterest at Min Pmt\tMonths @ Min\tBalance\tLimit\tUtil\tAs of\tFixed Pmt.\tLong Term\tShort Term\tPriority',
  'Store card\tCredit Card\t$40\t$40\t29.99%\t\t$40\t\t\t\t\t$400\t$2,000\t20%\t8/1/2026\tN\t\t\t1',
].join('\n')

describeDb('bringing in the spreadsheet', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  const TODAY = '2026-09-20'

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Sheet ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    engine = new Engine({ householdId, actorUserId: null, db, today: TODAY })
    await engine.createReserveAccount({ name: 'Annual Expenses', institutionLabel: 'Capital One 360' })
  })

  afterAll(async () => {
    if (householdId) {
      await db.delete(schema.lineItems).where(eq(schema.lineItems.householdId, householdId))
      await db.delete(schema.packages).where(eq(schema.packages.householdId, householdId))
      await db.delete(schema.debts).where(eq(schema.debts.householdId, householdId))
      await db.delete(schema.reserveAccounts).where(eq(schema.reserveAccounts.householdId, householdId))
    }
    await client?.end()
  })

  it('creates the missing account, live plans with their reserved amounts, and dated debts', async () => {
    const existing = (await engine.listReserveAccounts()).map((a) => a.name)
    const parsed = parseSheet(SHEET, { today: TODAY, existingAccounts: existing })
    expect(parsed.problems.map((p) => p.row)).toEqual([4])

    const result = await engine.importSheet(parsed)
    expect(result.accountsCreated).toEqual(['Gifts & Giving'])
    expect(result.plansCreated).toEqual(['Car insurance', 'Christmas'])
    expect(result.debtsCreated).toEqual(['Store card'])
    expect(result.problems.map((p) => p.row)).toEqual([4])

    const views = await engine.packageViews()
    const car = views.find((v) => v.package.name === 'Car insurance')!
    expect(car.package.state).toBe('active')
    expect(car.package.module).toBe('sheet')
    expect(car.items[0]!.lineItem.recurrence).toEqual({ every: 6, unit: 'month' })
    expect(car.items[0]!.lineItem.dueDate).toBe('2027-02-15')

    const p = await engine.position()
    const annual = p.accounts.find((a) => a.account.name === 'Annual Expenses')!
    const gifts = p.accounts.find((a) => a.account.name === 'Gifts & Giving')!

    // $410 reserved now is already set aside: never counted, the account
    // starts from what the sheet said it held, and all of it counts toward
    // the car insurance, leaving $820 still to save.
    expect(annual.money).toMatchObject({ from: 'openings', on: TODAY, startCents: 41000, totalCents: 41000 })
    const carPlan = p.plans.find((x) => x.package.name === 'Car insurance')!
    expect(carPlan.countedCents).toBe(41000)
    expect(carPlan.totalCents - carPlan.countedCents).toBe(82000)
    // It comes round every six months, so its steady line runs from the last
    // time it did (15 Aug) to 15 Feb: 26 transfers, 5 of them gone by today,
    // ceil(123000 x 5 / 26) = $236.54. $410 is past that: on track.
    const carPart = carPlan.parts[0]!
    expect(carPart.savingSince).toEqual({ date: '2026-08-15', reason: 'last_occurrence' })
    expect(carPart.savedForCents).toBe(23654)
    expect(carPart.status).toBe('on_track')
    // Only the rest is spread -- ($1,230 - $410) over the 21 transfers to
    // 15 Feb is ceil(82000 / 21) = $39.05 -- but a part that comes round again
    // never asks for less than its steady run-rate: $1,230 over the next
    // cycle's 26 transfers, ceil(123000 / 26) = $47.31, the sheet's own
    // weekly figure. Rounded up to the $10 step, $50.
    expect(annual.weeklyExactCents).toBe(4731)
    expect(annual.weeklyCents).toBe(5000)

    // Christmas: $250 reserved now is what Gifts & Giving starts from.
    expect(gifts.money).toMatchObject({ from: 'openings', on: TODAY, startCents: 25000, totalCents: 25000 })
    // Its steady line from last Christmas (19 Dec 2025) is 53 transfers, 40
    // gone: ceil(100000 x 40 / 53) = $754.72 by now, so $250 is catching up...
    const christmas = gifts.parts[0]!
    expect(christmas.savedForCents).toBe(75472)
    expect(christmas.countedCents).toBe(25000)
    expect(christmas.status).toBe('catching_up')
    // ...and the rest, $750, is spread over the 13 transfers to 19 Dec:
    // ceil(75000 / 13) = $57.70, above its run-rate of ceil(100000 / 52).
    expect(gifts.weeklyExactCents).toBe(5770)
    expect(gifts.weeklyCents).toBe(6000)
    // Nobody has said what the bank moves into either account yet.
    expect([annual.status, gifts.status]).toEqual(['unconfirmed', 'unconfirmed'])

    const [debt] = await engine.listDebts()
    expect(debt).toMatchObject({
      name: 'Store card',
      category: 'consumer',
      balanceCents: 40000,
      balanceAsOf: '2026-08-01',
      aprBasisPoints: 2999,
      minPaymentRule: { type: 'fixed', amountCents: 4000 },
      creditLimitCents: 200000,
    })
  })

  it('refuses to make the same plan twice rather than duplicating it', async () => {
    const existing = (await engine.listReserveAccounts()).map((a) => a.name)
    const parsed = parseSheet(SHEET, { today: TODAY, existingAccounts: existing })
    const again = await engine.importSheet(parsed)
    expect(again.plansCreated).toEqual([])
    expect(again.problems.some((p) => /already a package called "Car insurance"/.test(p.message))).toBe(true)
    expect((await engine.packageViews()).filter((v) => v.package.name === 'Christmas')).toHaveLength(1)
  })
})
