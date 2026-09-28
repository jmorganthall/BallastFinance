/**
 * Editing, against a live database: a plan can be changed after it exists,
 * a part can be added, re-priced, re-dated, moved to another account or taken
 * out, a recurring part rolls forward when confirmed spent, and a debt can be
 * corrected or removed. Every one of these leaves an event behind.
 *
 * Nothing about how a plan stands is recorded (D35): every figure an edit
 * moves is read back from the one position, which simply re-derives. The
 * household keeps the defaults -- money moves on Saturdays, and the bank
 * figure is rounded up to $10 -- and each group of tests that asserts an
 * account's figures has an account of its own, because the position runs an
 * account forward over every live part in it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { Engine } from '@/server/engine'
import { INTAKE_CONTRACT_VERSION, weekdayOf, type AccountPosition } from '@/domain'

const url = process.env.DATABASE_URL
const describeDb = url ? describe : describe.skip

/** One part of an account's position, by line item. */
function part(a: AccountPosition, lineItemId: string) {
  const found = a.parts.find((p) => p.lineItem.id === lineItemId)
  if (!found) throw new Error(`No live part ${lineItemId} in ${a.account.name}`)
  return found
}

/** The position, one account in it, and that account's to-dos. */
async function standing(engine: Engine, accountId: string) {
  const p = await engine.position()
  const a = p.accounts.find((x) => x.account.id === accountId)
  if (!a) throw new Error(`No account ${accountId} in the position`)
  return { p, a, todos: p.todos.filter((t) => t.accountId === accountId) }
}

async function newAccount(engine: Engine, name: string): Promise<string> {
  return (await engine.createReserveAccount({ name, institutionLabel: `Capital One 360 — ${name}` })).id
}

describeDb('editing plans and debts', () => {
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let householdId: string
  let engine: Engine
  let accountId: string
  let today = '2026-09-19'

  const pin = (date: string) => {
    today = date
    engine = new Engine({ householdId, actorUserId: null, db, today })
  }

  const eventsOfKind = async (kind: (typeof schema.eventKindEnum.enumValues)[number]) =>
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.householdId, householdId), eq(schema.events.kind, kind)))
      .orderBy(schema.events.recordedAt)

  type Snapshot = { unitAmountCents: number; quantity: number; dueDate: string; reserveAccountId: string }
  /** Every `line_item_changed` payload for one part, in the order recorded. */
  const changesTo = async (lineItemId: string) =>
    (await eventsOfKind('line_item_changed'))
      .map(
        (e) =>
          e.payload as {
            line_item_id: string
            before: Snapshot
            after: Snapshot
            timeline_start?: unknown
          },
      )
      .filter((p) => p.line_item_id === lineItemId)

  /** The per-part openings a commit recorded, by line item. */
  const openingsOf = async (packageId: string) => {
    const commit = (await eventsOfKind('package_committed')).find(
      (e) => (e.payload as { package_id: string }).package_id === packageId,
    )
    const payload = commit!.payload as {
      opening_cents: number
      openings: { line_item_id: string; amount_cents: number }[]
    }
    return {
      openingCents: payload.opening_cents,
      byLineItem: Object.fromEntries(payload.openings.map((o) => [o.line_item_id, o.amount_cents])),
    }
  }

  const idOf = async (packageId: string, label: string) =>
    (await engine.listLineItems()).find((i) => i.packageId === packageId && i.label === label)!.id

  beforeAll(async () => {
    client = postgres(url!, { max: 4, prepare: false })
    db = drizzle(client, { schema })
    const [household] = await db
      .insert(schema.households)
      .values({ name: `Editing ${crypto.randomUUID()}` })
      .returning()
    householdId = household!.id
    pin('2026-09-19')
    accountId = await newAccount(engine, 'Annual Expenses')
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

  describe('committing with money already set aside', () => {
    let packageId: string
    let insuranceId: string
    let registrationId: string
    let tyresId: string
    let carAccountId: string

    it('splits the declared opening across the parts by cost, and the opening lowers the weekly amount', async () => {
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Car costs' },
        line_items: [
          { label: 'Insurance', unit_amount: '600', due_date: '2027-01-16', reserve_account: accountId, recurrence: 'semiannual' },
          { label: 'Registration', unit_amount: '200', due_date: '2027-01-16', reserve_account: accountId, recurrence: { every: 1, unit: 'year' } },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      packageId = created.packageId
      expect(created.lineItemIds).toHaveLength(2)
      insuranceId = await idOf(packageId, 'Insurance')
      registrationId = await idOf(packageId, 'Registration')

      // What committing would do, asked first: $800 due Saturday 16 Jan 2027,
      // 17 Saturdays away, from nothing: ceil(80000 / 17) = 4706, which the
      // household's $10 step makes $50 at the bank.
      expect(await engine.whatIfCommit(packageId)).toEqual([
        {
          accountId,
          accountName: 'Annual Expenses',
          weeklyNowCents: 0,
          weeklyAfterCents: 5000,
          moveAfterCents: 0,
          moveBy: null,
        },
      ])

      await engine.commitPackage(packageId, { openingCents: 40000 })

      // $400 split 3:1 by cost -> $300 and $100, recorded on the commit.
      expect(await openingsOf(packageId)).toEqual({
        openingCents: 40000,
        byLineItem: { [insuranceId]: 30000, [registrationId]: 10000 },
      })

      const { a, todos } = await standing(engine, accountId)
      // Never counted, so the account starts from the openings stated at commit.
      expect(a.money).toMatchObject({
        from: 'openings',
        on: '2026-09-19',
        startCents: 40000,
        transfersSinceCents: 0,
        totalCents: 40000,
      })
      // Only the other $400 has to be found: ceil(40000 / 17) = 2353. That is
      // below the run-rate of the two repeating parts, which the weekly amount
      // never goes under: insurance $600 over the 25 Saturdays of its next
      // cycle (16 Jan to Friday 16 Jul 2027) = 2400, plus registration
      // ceil(20000 / 52) = 385. So 2785, and $30 at the bank.
      expect(a.weeklyExactCents).toBe(2785)
      expect(a.weeklyCents).toBe(3000)
      // Nobody has said what the bank moves yet.
      expect(a.status).toBe('unconfirmed')
      expect(todos).toEqual([
        expect.objectContaining({ kind: 'set_transfer', reason: 'confirm', fromCents: null, toCents: 3000, blocking: true }),
      ])

      // Both repeat, so each is saving since it last came round (D30).
      // Insurance since Thursday 16 Jul 2026: 10 of its 27 Saturdays gone,
      // ceil(60000 × 10 / 27) = 22223. Registration since Friday 16 Jan
      // 2026: 36 of 53, ceil(20000 × 36 / 53) = 13585.
      const insurance = part(a, insuranceId)
      expect(insurance.lineItem.recurrence).toEqual({ every: 6, unit: 'month' })
      expect(insurance.savingSince).toEqual({ date: '2026-07-16', reason: 'last_occurrence' })
      expect(insurance.steadyPerWeekCents).toBe(2223) // ceil(60000 / 27)
      expect(insurance.savedForCents).toBe(22223)
      const registration = part(a, registrationId)
      expect(registration.savingSince).toEqual({ date: '2026-01-16', reason: 'last_occurrence' })
      expect(registration.steadyPerWeekCents).toBe(378) // ceil(20000 / 53)
      expect(registration.savedForCents).toBe(13585)
      // The $400 is counted up to each steady line first (22223 + 13585),
      // then soonest due -- a tie, so by name -- toward the totals: the 4192
      // left goes to insurance. Both are on track.
      expect([insurance.countedCents, registration.countedCents]).toEqual([26415, 13585])
      expect([insurance.status, registration.status]).toEqual(['on_track', 'on_track'])
    })

    it('judges the account on the transfer confirmed at the bank', async () => {
      await engine.confirmTransfer({ reserveAccountId: accountId, perWeekCents: 3000 })
      const { a, todos } = await standing(engine, accountId)
      expect(a.bank).toMatchObject({ perWeekCents: 3000, confirmedOn: '2026-09-19' })
      expect(a.status).toBe('on_track')
      expect(a.transferChange).toBeNull()
      expect(todos).toEqual([])
      // $400 now and 17 transfers of $30 make $910 by 16 Jan: $110 more
      // than the $800 due, and that could leave today.
      expect(a.extraCents).toBe(11000)
    })

    it('renames the plan and refuses a clash with a live one', async () => {
      await engine.renamePackage(packageId, 'Car running costs')
      expect((await engine.listPackages()).find((p) => p.id === packageId)!.name).toBe('Car running costs')

      const other = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Other' },
        line_items: [{ label: 'x', unit_amount: '1', due_date: '2027-01-16', reserve_account: accountId }],
      })
      if (!other.ok) throw new Error('setup')
      await expect(engine.renamePackage(other.packageId, 'car running costs')).rejects.toThrow(/already a plan/)
      await engine.retirePackage(other.packageId)
    })

    it('adds a part to a live plan starting today, not backdated to the commit', async () => {
      pin('2026-10-17')
      const before = await standing(engine, accountId)
      // The $400 opening plus four Saturdays of $30 since the commit.
      expect(before.a.money.totalCents).toBe(52000)
      expect(before.a.weeklyExactCents).toBe(2785)

      tyresId = await engine.addLineItem(packageId, {
        label: 'Tyres',
        unitAmountCents: 34000,
        quantity: 1,
        dueDate: '2027-01-16',
        reserveAccountId: accountId,
      })
      const { a, todos } = await standing(engine, accountId)
      const tyres = part(a, tyresId)
      expect(tyres.lineItem.state).toBe('accruing')
      expect(tyres.savingSince).toEqual({ date: '2026-10-17', reason: 'added' })
      expect(tyres.savedForCents).toBe(0)
      expect(tyres.steadyPerWeekCents).toBe(2616) // ceil(34000 / 13): 13 Saturdays left
      // Everything is due 16 Jan, 13 transfers away:
      // ceil((114000 − 52000) / 13) = 4770, $50 at the bank.
      expect(a.weeklyExactCents).toBe(4770)
      expect(a.weeklyCents).toBe(5000)
      // On the $30 the bank still moves, 16 Jan comes up short:
      // 52000 + 13 × 3000 = 91000 against 114000. Every part is due that day.
      expect(a.status).toBe('short')
      expect(a.short).toEqual({ on: '2027-01-16', byCents: 23000 })
      expect(a.parts.map((p) => p.status)).toEqual(['short', 'short', 'short'])
      expect(todos).toEqual([
        expect.objectContaining({ kind: 'set_transfer', reason: 'raise', fromCents: 3000, toCents: 5000, blocking: true }),
      ])
      expect(await eventsOfKind('line_item_added')).toHaveLength(1)
    })

    it('edits the amount and then the quantity: each is recorded, and the weekly amount moves with the money', async () => {
      await engine.updateLineItem(tyresId, { unitAmountCents: 40000 })
      let { a } = await standing(engine, accountId)
      // ceil((120000 − 52000) / 13) = 5231
      expect(a.weeklyExactCents).toBe(5231)

      await engine.updateLineItem(tyresId, { quantity: 2 })
      ;({ a } = await standing(engine, accountId))
      expect(part(a, tyresId).totalCents).toBe(80000)
      // Another $400 over the same 13 transfers: ceil((160000 − 52000) / 13)
      // = 8308, up by exactly ceil(40000 / 13) = 3077.
      expect(a.weeklyExactCents).toBe(8308)
      expect(a.weeklyExactCents - 5231).toBe(3077)

      const changes = await changesTo(tyresId)
      const at = { dueDate: '2027-01-16', reserveAccountId: accountId }
      expect(changes.map((c) => [c.before, c.after])).toEqual([
        [{ unitAmountCents: 34000, quantity: 1, ...at }, { unitAmountCents: 40000, quantity: 1, ...at }],
        [{ unitAmountCents: 40000, quantity: 1, ...at }, { unitAmountCents: 40000, quantity: 2, ...at }],
      ])
      // A money edit does not touch where the steady line starts.
      expect(changes.every((c) => c.timeline_start === undefined)).toBe(true)
    })

    it('brings a due date within four transfers: what the weekly amount cannot cover by then is a one-time move', async () => {
      await engine.updateLineItem(tyresId, { dueDate: '2026-11-07' })
      const { a, todos } = await standing(engine, accountId)
      // The $800 of tyres is now 3 transfers away; the other $800 is still 13.
      // A near date never sets the weekly amount, so with a move M:
      //   W = (160000 − 52000 − M) / 13  and  80000 − 52000 − M − 3W = 0
      //   => 10M = 13 × 28000 − 3 × 108000  => M = 4000, W = 104000 / 13 = 8000.
      expect(a.weeklyExactCents).toBe(8000)
      expect(a.weeklyCents).toBe(8000)
      expect(a.oneTimeMove).toEqual({ amountCents: 4000, byDate: '2026-11-07' })
      expect(part(a, tyresId).steadyPerWeekCents).toBe(26667) // ceil(80000 / 3)
      // On the $30 the bank moves, 7 Nov is the first date short:
      // 52000 + 3 × 3000 = 61000 against 80000.
      expect(a.short).toEqual({ on: '2026-11-07', byCents: 19000 })
      expect(a.extraCents).toBe(0)
      expect(todos).toEqual([
        expect.objectContaining({ kind: 'set_transfer', reason: 'raise', fromCents: 3000, toCents: 8000, blocking: true }),
        expect.objectContaining({ kind: 'move_in', amountCents: 4000, byDate: '2026-11-07', blocking: true }),
      ])
      const last = (await changesTo(tyresId)).at(-1)!
      expect([last.before.dueDate, last.after.dueDate]).toEqual(['2027-01-16', '2026-11-07'])
    })

    it('moves a part to another account and back to its date in one edit: one event, and both accounts re-derive', async () => {
      carAccountId = await newAccount(engine, 'Car')
      const changesBefore = (await changesTo(tyresId)).length
      await engine.updateLineItem(tyresId, { dueDate: '2027-01-16', reserveAccountId: carAccountId })

      const changes = await changesTo(tyresId)
      expect(changes).toHaveLength(changesBefore + 1)
      expect(changes.at(-1)!.before).toMatchObject({ dueDate: '2026-11-07', reserveAccountId: accountId })
      expect(changes.at(-1)!.after).toMatchObject({ dueDate: '2027-01-16', reserveAccountId: carAccountId })

      // Annual Expenses is back to what it was before the tyres: the
      // run-rate, on track on the $30, with nothing to do.
      const annual = await standing(engine, accountId)
      expect(annual.a.parts.map((p) => p.lineItem.id)).not.toContain(tyresId)
      expect(annual.a.weeklyExactCents).toBe(2785)
      expect(annual.a.status).toBe('on_track')
      expect(annual.a.oneTimeMove).toBeNull()
      expect(annual.todos).toEqual([])

      // The new account holds nothing: $800 over 13 transfers,
      // ceil(80000 / 13) = 6154, $70 at the bank, not yet confirmed.
      const car = await standing(engine, carAccountId)
      expect(part(car.a, tyresId).totalCents).toBe(80000)
      expect(car.a.money).toMatchObject({ from: 'nothing', totalCents: 0 })
      expect(car.a.weeklyExactCents).toBe(6154)
      expect(car.a.weeklyCents).toBe(7000)
      expect(car.a.status).toBe('unconfirmed')
      expect(car.todos).toEqual([
        expect.objectContaining({ kind: 'set_transfer', reason: 'confirm', fromCents: null, toCents: 7000 }),
      ])
    })

    it('edits the label and the recurrence: a label alone records nothing, and starting to repeat moves Saving since, not the weekly amount', async () => {
      const changesBefore = (await changesTo(tyresId)).length
      await engine.updateLineItem(tyresId, { label: 'Winter tyres' })
      expect((await engine.listLineItems()).find((i) => i.id === tyresId)!.label).toBe('Winter tyres')
      expect(await changesTo(tyresId)).toHaveLength(changesBefore)

      await engine.updateLineItem(tyresId, { recurrence: { every: 1, unit: 'year' } })
      const after = (await engine.listLineItems()).find((i) => i.id === tyresId)!
      expect(after.recurrence).toEqual({ every: 1, unit: 'year' })
      // Starting to repeat moved its Saving since to its last occurrence
      // (D30): recorded, with equal money snapshots and the switch beside them.
      expect(after.timelineStart).toBe('last_occurrence')
      const changes = await changesTo(tyresId)
      expect(changes).toHaveLength(changesBefore + 1)
      expect(changes.at(-1)!.before).toEqual(changes.at(-1)!.after)
      expect(changes.at(-1)!.timeline_start).toEqual({ before: 'commit', after: 'last_occurrence' })

      const { a } = await standing(engine, carAccountId)
      const tyres = part(a, tyresId)
      // Since Friday 16 Jan 2026, 40 of its 53 Saturdays gone:
      // ceil(80000 × 40 / 53) = 60378, and nothing in the account for it.
      expect(tyres.savingSince).toEqual({ date: '2026-01-16', reason: 'last_occurrence' })
      expect(tyres.savedForCents).toBe(60378)
      expect(tyres.steadyPerWeekCents).toBe(1510) // ceil(80000 / 53)
      expect(tyres.status).toBe('catching_up')
      // What has to be there by 16 Jan did not move: still ceil(80000 / 13),
      // above next year's run-rate of ceil(80000 / 52) = 1539.
      expect(a.weeklyExactCents).toBe(6154)
    })

    it('takes a part out of a plan without deleting its history', async () => {
      await engine.retireLineItem(tyresId)
      const view = (await engine.packageViews()).find((v) => v.package.id === packageId)!
      expect(view.items.find((i) => i.lineItem.id === tyresId)!.lineItem.state).toBe('retired')
      expect(view.totalCents).toBe(80000)
      expect(await eventsOfKind('line_item_retired')).toHaveLength(1)

      // Its account has nothing left to save for, and asks for nothing.
      const { a, todos } = await standing(engine, carAccountId)
      expect(a.parts).toEqual([])
      expect(a.weeklyExactCents).toBe(0)
      expect(a.status).toBe('on_track')
      expect(todos).toEqual([])
    })

    it('rolls a recurring part forward when confirmed spent, and starts again at $0', async () => {
      pin('2027-01-20') // past the 2027-01-16 due date
      expect((await engine.closeOutPrompts()).some((p) => p.lineItemId === insuranceId)).toBe(true)

      await engine.confirmSpend({ lineItemId: insuranceId, actualAmountCents: 60000 })

      const after = (await engine.listLineItems()).find((i) => i.id === insuranceId)!
      expect(after.state).toBe('accruing')
      expect(after.dueDate).toBe('2027-07-16') // six months on
      const { a } = await standing(engine, accountId)
      const insurance = part(a, insuranceId)
      // Its steady line starts again on the day it was spent.
      expect(insurance.savingSince).toEqual({ date: '2027-01-20', reason: 'spent' })
      expect(insurance.savedForCents).toBe(0)
      // The spend comes out of the money: the $400 opening, 17 Saturdays of
      // $30 (26 Sep to 16 Jan), less the $600 paid.
      expect(a.money).toMatchObject({
        from: 'openings',
        startCents: 40000,
        transfersSinceCents: 51000,
        spendsSinceCents: 60000,
        totalCents: 31000,
      })

      // The one-off registration, confirmed, retires as before.
      await engine.updateLineItem(registrationId, { recurrence: null })
      await engine.confirmSpend({ lineItemId: registrationId, actualAmountCents: 20000 })
      expect((await engine.listLineItems()).find((i) => i.id === registrationId)!.state).toBe('retired')
    })

    it('keeps the opening stated at commit in the money once the part it was stated for is spent', async () => {
      // FAILS against production as of D35 (reported, not fixed here): for an
      // account never counted, `moneyToday` in src/domain/position.ts takes
      // the openings only from the account's LIVE parts, while every spend
      // since the (absent) count is still subtracted. The registration is
      // retired by its spend, so its $100 opening drops out of the start
      // (40000 -> 30000) but its $200 spend stays in: 1000, not 11000.
      //
      // Both bills are paid: $400 opening + 17 × $30 − $600 − $200 = $110,
      // the extra the account showed the day its transfer was confirmed.
      const { a } = await standing(engine, accountId)
      expect(a.money).toMatchObject({
        from: 'openings',
        startCents: 40000,
        transfersSinceCents: 51000,
        spendsSinceCents: 80000,
        totalCents: 11000,
      })
    })

    it('stops a whole plan', async () => {
      await engine.retirePackage(packageId)
      expect((await engine.listPackages()).find((p) => p.id === packageId)!.state).toBe('retired')
      expect((await engine.listLineItems()).filter((i) => i.packageId === packageId).every((i) => i.state === 'retired')).toBe(true)
      expect(await eventsOfKind('package_retired')).toHaveLength(2)
      expect((await standing(engine, accountId)).a.parts).toEqual([])
    })

    it('deletes a finished plan for good, only with its name typed back, and keeps its history', async () => {
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Santa Visit' },
        line_items: [{ label: 'Photos', unit_amount: '45', due_date: '2028-12-19', reserve_account: accountId }],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await engine.commitPackage(created.packageId, { openingCents: 0 })
      const commitsBefore = (await eventsOfKind('package_committed')).length

      // A live plan cannot be deleted, whatever is typed.
      await expect(engine.deletePackage(created.packageId, 'Santa Visit')).rejects.toThrow(/finished/)
      await engine.retirePackage(created.packageId)

      // The name has to match exactly; nothing changes when it does not.
      await expect(engine.deletePackage(created.packageId, 'santa visit')).rejects.toThrow(/does not match/)
      await expect(engine.deletePackage(created.packageId, '')).rejects.toThrow(/does not match/)
      expect((await engine.listPackages()).some((p) => p.id === created.packageId)).toBe(true)

      await engine.deletePackage(created.packageId, '  Santa Visit ')
      expect((await engine.listPackages()).some((p) => p.id === created.packageId)).toBe(false)
      expect((await engine.listLineItems()).some((i) => i.packageId === created.packageId)).toBe(false)

      // The log keeps what the plan was, and everything recorded before it.
      const [deleted] = await eventsOfKind('package_deleted')
      expect(deleted!.payload).toMatchObject({
        package_id: created.packageId,
        name: 'Santa Visit',
        line_items: [{ label: 'Photos', unit_amount_cents: 4500, due_date: '2028-12-19' }],
      })
      expect(await eventsOfKind('package_committed')).toHaveLength(commitsBefore)

      // Deleting it again is refused rather than silently succeeding.
      await expect(engine.deletePackage(created.packageId, 'Santa Visit')).rejects.toThrow(/No such package/)
    })
  })

  describe('counting what an account holds toward its plans', () => {
    let christmasAccountId: string

    it('counts a count toward the parts on every read, soonest due first, and the weekly amount drops', async () => {
      pin('2026-09-19')
      christmasAccountId = await newAccount(engine, 'Christmas')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Christmas 2026' },
        line_items: [
          { label: 'Gifts', unit_amount: '1000', due_date: '2026-12-19', reserve_account: christmasAccountId },
          { label: 'Food', unit_amount: '300', due_date: '2026-12-24', reserve_account: christmasAccountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await engine.commitPackage(created.packageId)

      let { a } = await standing(engine, christmasAccountId)
      // Nothing held and nothing stated: $1,300 by Thursday 24 Dec, 13
      // Saturdays away, is 130000 / 13 = 10000 a week.
      expect(a.money).toMatchObject({ from: 'nothing', on: '2026-09-19', totalCents: 0 })
      expect(a.weeklyExactCents).toBe(10000)

      // The account actually holds $1,150.
      await engine.confirmBalance({ reserveAccountId: christmasAccountId, amountCents: 115000 })

      ;({ a } = await standing(engine, christmasAccountId))
      expect(a.money).toMatchObject({ from: 'count', on: '2026-09-19', startCents: 115000, totalCents: 115000 })
      // Soonest due first: all $1,000 to the gifts due 19 Dec, the other $150
      // to the food due 24 Dec. Both steady lines start today at $0, so both
      // are on track.
      const byLabel = Object.fromEntries(a.parts.map((p) => [p.lineItem.label, p]))
      expect(byLabel.Gifts!.countedCents).toBe(100000)
      expect(byLabel.Food!.countedCents).toBe(15000)
      expect(a.parts.every((p) => p.status === 'on_track')).toBe(true)
      // Only the food's other $150 is left to find, over the same 13 Saturdays.
      expect(a.weeklyExactCents).toBe(1154) // ceil(15000 / 13)
      // The counting is a reading, not a record: the count is the only fact.
      expect(await eventsOfKind('opening_recorded')).toHaveLength(0)
    })

    it('shares the extra out through the allocation engine and asks for it to be moved out', async () => {
      const { plan, instructionIds } = await engine.runAllocation({
        floorCents: 100000,
        sourceAccountId: christmasAccountId,
      })
      expect(plan.netCents).toBeGreaterThan(0)
      const outstanding = await engine.outstandingInstructions()
      const moveOut = outstanding.find((i) => i.type === 'one_time_move_out')!
      expect(moveOut.targetId).toBe(christmasAccountId)
      expect(moveOut.amountCents).toBe(plan.netCents)
      expect(instructionIds).toContain(moveOut.instructionId)
    })
  })

  describe('correcting a debt', () => {
    let debtId: string

    it('takes a dated balance at creation', async () => {
      const debt = await engine.createDebt({
        name: 'Store card',
        category: 'consumer',
        balanceCents: 40000,
        aprBasisPoints: 2999,
        minPaymentRule: { type: 'fixed', amountCents: 4000 },
        balanceAsOf: '2026-08-01',
      })
      debtId = debt.id
      expect(debt.balanceAsOf).toBe('2026-08-01')
    })

    it('changes the terms and records before and after', async () => {
      await engine.updateDebt(debtId, {
        name: 'Store card (Josh)',
        aprBasisPoints: 2499,
        minPaymentRule: { type: 'percent_with_floor', basisPoints: 200, floorCents: 2500 },
        creditLimitCents: 500000,
      })
      const after = (await engine.listDebts()).find((d) => d.id === debtId)!
      expect(after.name).toBe('Store card (Josh)')
      expect(after.aprBasisPoints).toBe(2499)
      expect(after.minPaymentRule).toEqual({ type: 'percent_with_floor', basisPoints: 200, floorCents: 2500 })
      expect(after.creditLimitCents).toBe(500000)
      expect(after.balanceCents).toBe(40000) // untouched: the balance has its own paths

      const [event] = await eventsOfKind('debt_updated')
      const payload = event!.payload as { before: { apr_basis_points: number }; after: { apr_basis_points: number } }
      expect(payload.before.apr_basis_points).toBe(2999)
      expect(payload.after.apr_basis_points).toBe(2499)
    })

    it('still refuses a promo rate that is not cheaper', async () => {
      await expect(
        engine.updateDebt(debtId, {
          promoRules: [{ rateBasisPoints: 2999, appliesTo: 'full', untilDate: '2027-06-01' }],
        }),
      ).rejects.toThrow(/not lower/)
    })

    it('removes a debt, keeping what it said on the event', async () => {
      await engine.removeDebt(debtId)
      expect((await engine.listDebts()).find((d) => d.id === debtId)).toBeUndefined()
      const [event] = await eventsOfKind('debt_removed')
      expect((event!.payload as { name: string }).name).toBe('Store card (Josh)')
    })
  })

  describe('what a recurring plan would already have set aside', () => {
    it('offers the elapsed part of each repeating cycle, and commits it part by part', async () => {
      // Other tests move the clock; this one is priced against 19 Sep 2026.
      const engine = new Engine({ householdId, actorUserId: null, db, today: '2026-09-19' })
      const boatAccountId = await newAccount(engine, 'Boat')
      // Insurance every year, next due 16 Jan 2027: the last one was 16 Jan
      // 2026, so most of a year's saving should already be there. The one-off
      // has no history and gets nothing.
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Offered opening' },
        line_items: [
          { label: 'Boat insurance', unit_amount: '530', due_date: '2027-01-16', reserve_account: boatAccountId, recurrence: { every: 1, unit: 'year' }, timeline_start: 'commit' },
          { label: 'Boat one-off', unit_amount: '200', due_date: '2027-01-16', reserve_account: boatAccountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      const items = (await engine.listLineItems()).filter((i) => i.packageId === created.packageId)
      const insuranceId = items.find((i) => i.label === 'Boat insurance')!.id
      const oneOffId = items.find((i) => i.label === 'Boat one-off')!.id

      const suggested = await engine.suggestedOpenings(created.packageId)
      expect(suggested.map((s) => s.label)).toEqual(['Boat insurance'])
      expect(suggested[0]!.lastOccurrence).toBe('2026-01-16')
      // 16 Jan 2026 is a Friday, so the cycle holds 53 Saturdays (17 Jan 2026
      // through 16 Jan 2027) and 36 of them have passed by 19 Sep 2026:
      // 36/53 of $530, rounded up.
      expect(suggested[0]!.cents).toBe(36000)

      await engine.commitPackage(created.packageId, {
        openingByLineItem: Object.fromEntries(suggested.map((s) => [s.lineItemId, s.cents])),
      })
      // The money is recorded on the part it belongs to, not spread by cost.
      expect(await openingsOf(created.packageId)).toEqual({
        openingCents: 36000,
        byLineItem: { [insuranceId]: 36000, [oneOffId]: 0 },
      })

      const { a } = await standing(engine, boatAccountId)
      expect(a.money).toMatchObject({ from: 'openings', on: '2026-09-19', totalCents: 36000 })
      // Saving since the commit, as chosen, so no steady line is above $0
      // yet; the $360 is counted toward the totals soonest due, a tie broken
      // by name, which puts it all on the insurance.
      const insurance = part(a, insuranceId)
      expect(insurance.savingSince).toEqual({ date: '2026-09-19', reason: 'plan_started' })
      expect(insurance.savedForCents).toBe(0)
      expect(insurance.countedCents).toBe(36000)
      expect(part(a, oneOffId).countedCents).toBe(0)
      // $730 due in 17 transfers with $360 held: ceil(37000 / 17) = 2177,
      // above the insurance's run-rate of ceil(53000 / 52) = 1020.
      expect(a.weeklyExactCents).toBe(2177)
    })
  })

  describe('a repeating part starts its timeline at its last occurrence (PRD D30)', () => {
    let homeAccountId: string
    let packageId: string
    let insuranceId: string
    let gutterId: string

    it('defaults a repeating part to its last occurrence and a one-off to the commit, and offers no opening for the former', async () => {
      pin('2026-09-26')
      homeAccountId = await newAccount(engine, 'Home')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Home bills' },
        line_items: [
          { label: 'Home insurance', unit_amount: '1200', due_date: '2026-11-15', reserve_account: homeAccountId, recurrence: { every: 1, unit: 'year' } },
          { label: 'Gutter clean', unit_amount: '300', due_date: '2026-11-15', reserve_account: homeAccountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      packageId = created.packageId
      const items = (await engine.listLineItems()).filter((i) => i.packageId === packageId)
      const insurance = items.find((i) => i.label === 'Home insurance')!
      insuranceId = insurance.id
      gutterId = items.find((i) => i.label === 'Gutter clean')!.id
      expect(insurance.timelineStart).toBe('last_occurrence')
      expect(items.find((i) => i.label === 'Gutter clean')!.timelineStart).toBe('commit')

      expect(await engine.suggestedOpenings(packageId)).toEqual([])
      // Asked as if it started today, the D8 figure is there for the form to show.
      const asToday = await engine.suggestedOpenings(packageId, {
        timelineStartByLineItem: { [insuranceId]: 'commit' },
      })
      expect(asToday.map((s) => [s.label, s.lastOccurrence, s.cents])).toEqual([['Home insurance', '2025-11-15', 103847]])
    })

    it('commits with the steady line from the last occurrence at the steady rate; the typed opening is recorded against the one-off', async () => {
      await engine.commitPackage(packageId, { openingCents: 10000 })
      // The $100 typed at commit is shared among the parts that start at the
      // commit, which is only the one-off.
      expect((await openingsOf(packageId)).byLineItem).toEqual({ [insuranceId]: 0, [gutterId]: 10000 })

      const { a } = await standing(engine, homeAccountId)
      const insurance = part(a, insuranceId)
      // Saving since Saturday 15 Nov 2025, 45 of its 52 Saturdays gone:
      // ceil(120000 × 45 / 52) = 103847, the figure the offer would have been.
      expect(insurance.savingSince).toEqual({ date: '2025-11-15', reason: 'last_occurrence' })
      expect(insurance.savedForCents).toBe(103847)
      expect(insurance.steadyPerWeekCents).toBe(2308) // ceil(120000 / 52)
      const gutter = part(a, gutterId)
      expect(gutter.savingSince).toEqual({ date: '2026-09-26', reason: 'plan_started' })
      expect(gutter.savedForCents).toBe(0)
      expect(gutter.steadyPerWeekCents).toBe(4286) // ceil(30000 / 7)
      // The account holds only the $100. It is counted up to the steady
      // lines first, so it goes to the insurance, which is far below its line.
      expect(insurance.countedCents).toBe(10000)
      expect(gutter.countedCents).toBe(0)
      expect(insurance.status).toBe('catching_up')
      expect(gutter.status).toBe('on_track')
      // $1,500 is due Sunday 15 Nov, 7 transfers away, from $100:
      // 140000 / 7 = 20000 a week. The parts' steady shares are 2308 + 4286
      // = 6594 of that; the other 13406 is catching up.
      expect(a.weeklyExactCents).toBe(20000)
      expect(a.steadyPerWeekCents).toBe(6594)
      expect(a.catchUpPerWeekCents).toBe(13406)
      expect(a.catchingUpParts).toBe(1)
    })

    it('can be unticked later, which is recorded, and the steady line then runs from the commit; the weekly amount does not move', async () => {
      const changesBefore = (await engine.listLineItemChanges()).filter((c) => c.lineItemId === insuranceId).length
      await engine.updateLineItem(insuranceId, { timelineStart: 'commit' })
      let { a } = await standing(engine, homeAccountId)
      let insurance = part(a, insuranceId)
      expect(insurance.lineItem.timelineStart).toBe('commit')
      expect(insurance.savingSince).toEqual({ date: '2026-09-26', reason: 'plan_started' })
      expect(insurance.savedForCents).toBe(0)
      expect(insurance.steadyPerWeekCents).toBe(17143) // $1,200 over the 7 Saturdays left
      // Neither part's steady line is above $0 today, so the $100 is counted
      // soonest due -- a tie, by name -- to the one-off, and both are on track.
      expect(part(a, gutterId).countedCents).toBe(10000)
      expect(insurance.status).toBe('on_track')
      // Saving since moves the steady line, never what has to be there by
      // the due date.
      expect(a.weeklyExactCents).toBe(20000)

      // The toggle is in the log with equal money snapshots and the switch beside them.
      const changes = (await engine.listLineItemChanges()).filter((c) => c.lineItemId === insuranceId)
      expect(changes).toHaveLength(changesBefore + 1)
      expect(changes.at(-1)!.before).toEqual(changes.at(-1)!.after)
      const [event] = (await eventsOfKind('line_item_changed')).filter(
        (e) => (e.payload as { line_item_id: string }).line_item_id === insuranceId,
      )
      expect(event!.payload).toMatchObject({ timeline_start: { before: 'last_occurrence', after: 'commit' } })

      // And back again.
      await engine.updateLineItem(insuranceId, { timelineStart: 'last_occurrence' })
      ;({ a } = await standing(engine, homeAccountId))
      insurance = part(a, insuranceId)
      expect(insurance.savingSince).toEqual({ date: '2025-11-15', reason: 'last_occurrence' })
      expect(insurance.savedForCents).toBe(103847)
    })

    it('honours the commit form: a part unticked at commit starts today, and the offered opening is money in its account', async () => {
      const carAccountId = await newAccount(engine, 'Car insurance')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Unticked at commit' },
        line_items: [
          { label: 'Car insurance', unit_amount: '600', due_date: '2026-11-15', reserve_account: carAccountId, recurrence: { every: 6, unit: 'month' } },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      const [car] = (await engine.listLineItems()).filter((i) => i.packageId === created.packageId)
      const starts = { [car!.id]: 'commit' as const }
      const offered = await engine.suggestedOpenings(created.packageId, { timelineStartByLineItem: starts })
      // Last round Friday 15 May 2026: 20 of its 27 Saturdays gone,
      // ceil(60000 × 20 / 27) = 44445.
      expect(offered.map((o) => o.cents)).toEqual([44445])
      await engine.commitPackage(created.packageId, {
        openingByLineItem: { [car!.id]: offered[0]!.cents },
        timelineStartByLineItem: starts,
      })

      const { a } = await standing(engine, carAccountId)
      const item = part(a, car!.id)
      expect(item.lineItem.timelineStart).toBe('commit')
      expect(item.savingSince).toEqual({ date: '2026-09-26', reason: 'plan_started' })
      expect(item.savedForCents).toBe(0)
      expect(a.money).toMatchObject({ from: 'openings', on: '2026-09-26', startCents: 44445, totalCents: 44445 })
      expect(item.countedCents).toBe(44445)
      expect(item.status).toBe('on_track')
    })

    it('refuses a one-off that starts at a last time it never had, at the database', async () => {
      // The engine starts it at the commit (D36); the CHECK is the backstop
      // for anything that bypasses the engine.
      await engine.updateLineItem(gutterId, { timelineStart: 'last_occurrence' })
      expect((await engine.listLineItems()).find((i) => i.id === gutterId)!.timelineStart).toBe('commit')
      const failure = await db
        .update(schema.lineItems)
        .set({ timelineStart: 'last_occurrence' })
        .where(eq(schema.lineItems.id, gutterId))
        .then(
          () => null,
          (error: unknown) => error as { message: string; cause?: { constraint_name?: string } },
        )
      expect(failure).not.toBeNull()
      expect(failure!.cause?.constraint_name ?? failure!.message).toMatch(/line_items_one_off_has_no_last_occurrence/)
    })

    it('starts the steady line again at the spend date once confirmed spent, and rolls forward', async () => {
      pin('2026-11-20')
      await engine.confirmSpend({ lineItemId: insuranceId, actualAmountCents: 120000 })
      const insurance = part((await standing(engine, homeAccountId)).a, insuranceId)
      expect(insurance.lineItem.dueDate).toBe('2027-11-15')
      expect(insurance.savingSince).toEqual({ date: '2026-11-20', reason: 'spent' })
      expect(insurance.savedForCents).toBe(0)
      // 52 Saturdays from Friday 20 Nov 2026 to Monday 15 Nov 2027.
      expect(insurance.steadyPerWeekCents).toBe(2308) // ceil(120000 / 52)
      pin('2026-09-19')
    })
  })

  describe('"Saving since" is a day a person can see and change (PRD D33)', () => {
    let houseAccountId: string
    let packageId: string
    let insuranceId: string
    let gutterId: string

    it('commits with a day given: the steady line runs from it, the heading and the chart start there, and no opening is offered', async () => {
      pin('2026-09-26')
      houseAccountId = await newAccount(engine, 'House')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Saving since a day' },
        line_items: [
          { label: 'Home insurance', unit_amount: '1200', due_date: '2026-11-15', reserve_account: houseAccountId, recurrence: { every: 1, unit: 'year' } },
          { label: 'Gutter clean', unit_amount: '300', due_date: '2026-11-15', reserve_account: houseAccountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      packageId = created.packageId
      insuranceId = await idOf(packageId, 'Home insurance')
      gutterId = await idOf(packageId, 'Gutter clean')

      const choice = { [insuranceId]: { kind: 'typed' as const, date: '2026-03-15' } }
      expect(await engine.suggestedOpenings(packageId, { timelineStartByLineItem: choice })).toEqual([])
      await engine.commitPackage(packageId, { openingCents: 10000, timelineStartByLineItem: choice })
      // The $100 typed at commit is recorded against the one-off, as under D30.
      expect((await openingsOf(packageId)).byLineItem).toEqual({ [insuranceId]: 0, [gutterId]: 10000 })

      const { p, a } = await standing(engine, houseAccountId)
      const insurance = part(a, insuranceId)
      expect(insurance.lineItem.timelineStart).toBe('typed')
      expect(insurance.lineItem.timelineStartDate).toBe('2026-03-15')
      // Saving since Sunday 15 Mar: 28 of its 35 Saturdays gone,
      // 120000 × 28 / 35 = 96000 exactly.
      expect(insurance.savingSince).toEqual({ date: '2026-03-15', reason: 'typed' })
      expect(insurance.savedForCents).toBe(96000)
      expect(insurance.steadyPerWeekCents).toBe(3429) // ceil(120000 / 35)
      // The $100 held is counted toward it, far below its line.
      expect(insurance.countedCents).toBe(10000)
      expect(insurance.status).toBe('catching_up')

      // The plan is headed by the earliest day any part saves from.
      const plan = p.plans.find((x) => x.package.id === packageId)!
      expect(plan.savingSince).toBe('2026-03-15')
      expect(plan.savedForCents).toBe(96000) // the one-off's line starts today, at $0
      expect(plan.countedCents).toBe(10000)
      expect(plan.status).toBe('catching_up')

      // The chart starts there too, and is sampled on transfer days: the day
      // given, the 35 Saturdays to the due date, and the due date itself.
      const chart = (await engine.planChart(packageId))!
      expect(chart.targetCents).toBe(150000)
      expect(chart.steady).toHaveLength(37)
      expect(chart.steady[0]).toEqual({ date: '2026-03-15', cents: 0 })
      expect(chart.steady.slice(1, -1).every((pt) => weekdayOf(pt.date) === 6)).toBe(true)
      expect(chart.steady.at(-1)).toEqual({ date: '2026-11-15', cents: 150000 })
      // Today's point on the steady line is the plan's figure, from the same position.
      expect(chart.steady.find((pt) => pt.date === '2026-09-26')!.cents).toBe(plan.savedForCents)
      expect(chart.countedToday).toEqual({ date: '2026-09-26', cents: 10000 })
      // Catching up, so the chart also draws the money from what is counted
      // today up to every total by the due date.
      expect(chart.catchUp![0]).toEqual({ date: '2026-09-26', cents: 10000 })
      expect(chart.catchUp!.at(-1)).toEqual({ date: '2026-11-15', cents: 150000 })
    })

    it('refuses a day after today or not before the due date, and a typed choice with no day, in plain words', async () => {
      await expect(
        engine.updateLineItem(insuranceId, { timelineStart: 'typed', timelineStartDate: '2026-09-27' }),
      ).rejects.toThrow('The day you have been saving since cannot be after today.')
      await expect(
        engine.updateLineItem(insuranceId, { timelineStart: 'typed', timelineStartDate: null }),
      ).rejects.toThrow('Pick the day you have been saving for this since.')
      await expect(
        engine.updateLineItem(insuranceId, { dueDate: '2026-03-15' }),
      ).rejects.toThrow('The day you have been saving since has to be before the day it is needed.')
    })

    it('changing the day is a line_item_changed event with equal money snapshots and the day in timeline_start', async () => {
      const changesBefore = (await changesTo(insuranceId)).length
      await engine.updateLineItem(insuranceId, { timelineStartDate: '2026-01-10' })
      const { a } = await standing(engine, houseAccountId)
      const insurance = part(a, insuranceId)
      // Since Saturday 10 Jan: 37 of its 44 Saturdays gone,
      // ceil(120000 × 37 / 44) = 100910.
      expect(insurance.savingSince).toEqual({ date: '2026-01-10', reason: 'typed' })
      expect(insurance.savedForCents).toBe(100910)
      // What has to be there by 15 Nov did not move: (150000 − 10000) / 7.
      expect(a.weeklyExactCents).toBe(20000)

      const changes = await changesTo(insuranceId)
      expect(changes).toHaveLength(changesBefore + 1)
      expect(changes.at(-1)!.before).toEqual(changes.at(-1)!.after)
      expect(changes.at(-1)!.timeline_start).toEqual({
        before: { kind: 'typed', date: '2026-03-15' },
        after: { kind: 'typed', date: '2026-01-10' },
      })

      // Back to the last occurrence: the day is cleared, and the record reads as D30 wrote it.
      await engine.updateLineItem(insuranceId, { timelineStart: 'last_occurrence' })
      const back = (await engine.listLineItems()).find((i) => i.id === insuranceId)!
      expect(back.timelineStart).toBe('last_occurrence')
      expect(back.timelineStartDate).toBeNull()
      expect((await changesTo(insuranceId)).at(-1)!.timeline_start).toEqual({
        before: { kind: 'typed', date: '2026-01-10' },
        after: 'last_occurrence',
      })
    })

    it('keeps a day given when the account is counted: a count says what is there, not when saving began', async () => {
      await engine.updateLineItem(insuranceId, { timelineStart: 'typed', timelineStartDate: '2026-03-15' })
      await engine.confirmBalance({ reserveAccountId: houseAccountId, amountCents: 90000 })
      const { a } = await standing(engine, houseAccountId)
      expect(a.money).toMatchObject({ from: 'count', on: '2026-09-26', startCents: 90000, totalCents: 90000 })
      const insurance = part(a, insuranceId)
      expect(insurance.lineItem.timelineStartDate).toBe('2026-03-15')
      expect(insurance.savingSince).toEqual({ date: '2026-03-15', reason: 'typed' })
      expect(insurance.savedForCents).toBe(96000)
      // All $900 is counted toward it, still $60 short of its line.
      expect(insurance.countedCents).toBe(90000)
      expect(insurance.status).toBe('catching_up')
      // ceil((150000 − 90000) / 7) = 8572
      expect(a.weeklyExactCents).toBe(8572)
    })

    it('lets a one-off save from a day given too (D36): its own line moves, what the account is asked for does not', async () => {
      const changesBefore = (await changesTo(gutterId)).length
      await engine.updateLineItem(gutterId, { timelineStart: 'typed', timelineStartDate: '2026-03-15' })
      const { a } = await standing(engine, houseAccountId)
      const gutter = part(a, gutterId)
      expect([gutter.lineItem.timelineStart, gutter.lineItem.timelineStartDate]).toEqual(['typed', '2026-03-15'])
      expect(gutter.savingSince).toEqual({ date: '2026-03-15', reason: 'typed' })
      // What the form offers as the other answer is still the day the plan started.
      expect(gutter.startedOn).toEqual({ date: '2026-09-26', reason: 'plan_started' })
      // Since Sunday 15 Mar: 28 of its 35 Saturdays gone, 30000 × 28 / 35 = 24000.
      expect(gutter.savedForCents).toBe(24000)
      expect(gutter.steadyPerWeekCents).toBe(858) // ceil(30000 / 35)
      // Due the same day, the one-off comes first by name, so the $900 now
      // reaches its line and the insurance is counted what is left.
      expect(gutter.countedCents).toBe(24000)
      expect(gutter.status).toBe('on_track')
      expect(part(a, insuranceId).countedCents).toBe(66000)
      expect(part(a, insuranceId).status).toBe('catching_up')
      // What has to be there by 15 Nov did not move: ceil((150000 − 90000) / 7).
      expect(a.weeklyExactCents).toBe(8572)

      const changes = await changesTo(gutterId)
      expect(changes).toHaveLength(changesBefore + 1)
      expect(changes.at(-1)!.before).toEqual(changes.at(-1)!.after)
      expect(changes.at(-1)!.timeline_start).toEqual({ before: 'commit', after: { kind: 'typed', date: '2026-03-15' } })

      // The same plain words refuse a day after today on a one-off.
      await expect(
        engine.updateLineItem(gutterId, { timelineStart: 'typed', timelineStartDate: '2026-09-27' }),
      ).rejects.toThrow('The day you have been saving since cannot be after today.')
    })

    it('keeps a day given when a part starts or stops repeating, and starts a part that stops on its last time where the plan did', async () => {
      await engine.updateLineItem(gutterId, { recurrence: { every: 1, unit: 'year' } })
      let gutter = (await engine.listLineItems()).find((i) => i.id === gutterId)!
      expect([gutter.timelineStart, gutter.timelineStartDate]).toEqual(['typed', '2026-03-15'])
      await engine.updateLineItem(gutterId, { recurrence: null })
      gutter = (await engine.listLineItems()).find((i) => i.id === gutterId)!
      expect([gutter.timelineStart, gutter.timelineStartDate]).toEqual(['typed', '2026-03-15'])

      // Back to where the plan started: the day is cleared.
      await engine.updateLineItem(gutterId, { timelineStart: 'commit' })
      const { a } = await standing(engine, houseAccountId)
      expect(part(a, gutterId).savingSince).toEqual({ date: '2026-09-26', reason: 'plan_started' })
      expect((await changesTo(gutterId)).at(-1)!.timeline_start).toEqual({
        before: { kind: 'typed', date: '2026-03-15' },
        after: 'commit',
      })
    })

    it('the database refuses a typed choice without a day', async () => {
      const failure = await db
        .update(schema.lineItems)
        .set({ timelineStart: 'typed', timelineStartDate: null })
        .where(eq(schema.lineItems.id, insuranceId))
        .then(
          () => null,
          (error: unknown) => error as { message: string; cause?: { constraint_name?: string } },
        )
      expect(failure).not.toBeNull()
      expect(failure!.cause?.constraint_name ?? failure!.message).toMatch(/line_items_typed_start_has_date/)
      pin('2026-09-19')
    })
  })

  describe('counting an account on the day its plan was committed', () => {
    it('takes the count over the opening stated at commit, not both', async () => {
      // The spreadsheet import commits every plan with its "reserved now",
      // and the household may count the account that same afternoon. The
      // count is what is there: it replaces the opening, it does not add to it.
      const engine = new Engine({ householdId, actorUserId: null, db, today: '2026-09-19' })
      const kitchenAccountId = await newAccount(engine, 'Kitchen')
      const created = await engine.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: 'Same-day count' },
        line_items: [
          { label: 'Water filter', unit_amount: '45', due_date: '2026-10-05', reserve_account: kitchenAccountId },
        ],
      })
      if (!created.ok) throw new Error(JSON.stringify(created.problems))
      await engine.commitPackage(created.packageId, { openingCents: 1837 })
      // No recurring transfer into this account.
      await engine.confirmTransfer({ reserveAccountId: kitchenAccountId, perWeekCents: 0 })

      let { a, todos } = await standing(engine, kitchenAccountId)
      expect(a.money).toMatchObject({ from: 'openings', on: '2026-09-19', totalCents: 1837 })
      expect(a.parts[0]!.countedCents).toBe(1837)
      // Due Monday 5 Oct, two transfers away: too soon for a weekly amount,
      // so the other $26.63 is a one-time move.
      expect(a.weeklyExactCents).toBe(0)
      expect(a.oneTimeMove).toEqual({ amountCents: 2663, byDate: '2026-10-05' })
      expect(a.status).toBe('short')
      expect(todos).toEqual([expect.objectContaining({ kind: 'move_in', amountCents: 2663 })])

      await engine.confirmBalance({ reserveAccountId: kitchenAccountId, amountCents: 4500 })
      ;({ a, todos } = await standing(engine, kitchenAccountId))
      expect(a.money).toMatchObject({ from: 'count', on: '2026-09-19', startCents: 4500, totalCents: 4500 })
      expect(a.parts[0]!.countedCents).toBe(4500)
      expect(a.parts[0]!.status).toBe('on_track')
      expect(a.oneTimeMove).toBeNull()
      expect(a.status).toBe('on_track')
      expect(todos).toEqual([])
    })
  })
})
