/**
 * The engine: the only write path into core data (PRD §10).
 *
 * Every method is bound to one household at construction, so a query cannot
 * accidentally reach across households -- the scoping is structural rather than
 * a rule each caller has to remember (PRD §2). Route handlers and UI never
 * touch tables; they call through here.
 *
 * Reads return FACTS. Derived figures come from the derivation module, which
 * this file calls but never duplicates: there is no arithmetic in this layer.
 */

import { and, eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from '@/db/client'
import {
  debts as debtsTable,
  events,
  lineItems as lineItemsTable,
  packages as packagesTable,
  reserveAccounts as reserveAccountsTable,
  settings as settingsTable,
} from '@/db/schema'
import { randomUUID } from 'node:crypto'
import {
  accountViews,
  accrualCurve,
  apportion,
  canWriteAccount,
  closeOutPrompts,
  DEFAULT_TRANSFER_ROUND_UP_CENTS,
  findShortfalls,
  formatCents,
  lineItemTotalCents,
  openingSinceLastOccurrence,
  recurrenceOf,
  rollToFuture,
  DEFAULT_ALLOCATION_RULES,
  DEFAULT_BUFFER_CENTS,
  DEFAULT_PRIORITY_WEIGHT,
  DEFAULT_PROMO_LEAD_WEEKS,
  INTAKE_CONTRACT_VERSION,
  optimiseLumpSum,
  planAllocation,
  promoExpiryWarning,
  scoreDebts,
  validateDebtInputs,
  validateDebtRates,
  snowballLadder,
  outstandingInstructions,
  packageViews,
  todayIn,
  validateIntake,
  whatIfCommit,
  type AccountView,
  type CivilDate,
  type DerivationInput,
  type Id,
  type IntakeProblem,
  type LineItem,
  type LineItemChange,
  type LineItemCycle,
  type LineItemSnapshot,
  type Recurrence,
  type Package,
  type PackageView,
  type AccountScope,
  type ReserveAccount,
  type WhatIfLine,
  type Cents,
  type CloseOutPrompt,
  type ConfirmedInstruction,
  type DriftAdjustment,
  type InstructionType,
  type IssuedInstruction,
  type OutstandingInstruction,
  type AllocationPlan,
  type AllocationRule,
  type Shortfall,
  type Debt,
  type DebtCategory,
  type LadderRung,
  type MinPaymentRule,
  type OptimizerResult,
  type PromoRule,
  type CurvePoint,
  type SheetImport,
  type SheetProblem,
} from '@/domain'

export class EngineError extends Error {}

export type CreatePackageResult =
  | { ok: true; packageId: Id; lineItemIds: Id[] }
  | { ok: false; problems: IntakeProblem[] }

export interface EngineContext {
  householdId: Id
  actorUserId: Id | null
  timezone?: string
  db?: Db
  /**
   * Override "today". The derivation layer already takes today as a parameter;
   * this carries that property up to the engine, so a scheduled job, a backfill
   * or a test can be fully deterministic instead of depending on the wall clock.
   */
  today?: CivilDate
}

export class Engine {
  private readonly db: Db
  private readonly householdId: Id
  private readonly actorUserId: Id | null
  private readonly timezone: string
  private readonly pinnedToday: CivilDate | undefined

  constructor(context: EngineContext) {
    this.db = context.db ?? defaultDb
    this.householdId = context.householdId
    this.actorUserId = context.actorUserId
    this.timezone = context.timezone ?? 'America/Chicago'
    this.pinnedToday = context.today
  }

  /** Today in the household's timezone. The single source of "now". */
  today(): CivilDate {
    return this.pinnedToday ?? todayIn(this.timezone)
  }

  // ---------------------------------------------------------------- reserve accounts

  async listReserveAccounts(): Promise<ReserveAccount[]> {
    const rows = await this.db
      .select()
      .from(reserveAccountsTable)
      .where(eq(reserveAccountsTable.householdId, this.householdId))
    return rows.map(toReserveAccount)
  }

  /**
   * Create a reserve account. An individual account belongs to whoever creates
   * it: you cannot hand one to your spouse, because the point of the scope is
   * that its owner controls it.
   */
  async createReserveAccount(input: {
    name: string
    institutionLabel: string
    scope?: AccountScope
  }): Promise<ReserveAccount> {
    const scope: AccountScope = input.scope ?? 'household'
    if (scope === 'individual' && !this.actorUserId) {
      throw new EngineError('An individual account needs a signed-in owner')
    }

    const [row] = await this.db
      .insert(reserveAccountsTable)
      .values({
        householdId: this.householdId,
        name: input.name.trim(),
        institutionLabel: input.institutionLabel.trim(),
        scope,
        ownerUserId: scope === 'individual' ? this.actorUserId : null,
      })
      .returning()
    if (!row) throw new EngineError('Could not create the reserve account')
    return toReserveAccount(row)
  }

  /**
   * Every account this household has, and whether the current viewer may write
   * to each. Both spouses see the whole list; the flag drives what the UI
   * offers rather than what it shows.
   */
  async reserveAccountsForViewer(): Promise<(ReserveAccount & { writable: boolean })[]> {
    const accounts = await this.listReserveAccounts()
    return accounts.map((account) => ({
      ...account,
      writable: canWriteAccount(account, this.actorUserId),
    }))
  }

  /** Throws unless the viewer may write to this account. */
  private async assertCanWriteAccount(accountId: Id): Promise<ReserveAccount> {
    const account = (await this.listReserveAccounts()).find((a) => a.id === accountId)
    if (!account) throw new EngineError('No such reserve account in this household')
    if (!canWriteAccount(account, this.actorUserId)) {
      throw new EngineError(
        `"${account.name}" belongs to someone else in the household. Only its owner can change it.`,
      )
    }
    return account
  }

  // ---------------------------------------------------------------- packages

  /**
   * The single way a package is created (PRD §4). The manual builder and every
   * future planner module both arrive here, and both land in simulated state.
   */
  async createPackageFromIntake(raw: unknown): Promise<CreatePackageResult> {
    const today = this.today()
    const [accounts, existing] = await Promise.all([
      this.listReserveAccounts(),
      this.listPackages(),
    ])

    const result = validateIntake(raw, {
      today,
      accounts,
      packages: existing,
      actorUserId: this.actorUserId,
    })
    if (!result.ok) return { ok: false, problems: result.problems }

    const created = await this.db.transaction(async (tx) => {
      const [pkg] = await tx
        .insert(packagesTable)
        .values({
          householdId: this.householdId,
          name: result.value.name,
          module: result.value.module,
          detail: result.value.detail,
          state: 'simulated',
          createdAt: today,
          committedAt: null,
        })
        .returning({ id: packagesTable.id })
      if (!pkg) throw new EngineError('Could not create the package')

      const items = await tx
        .insert(lineItemsTable)
        .values(
          result.value.lineItems.map((item) => ({
            householdId: this.householdId,
            packageId: pkg.id,
            label: item.label,
            unitAmountCents: item.unitAmountCents,
            quantity: item.quantity,
            dueDate: item.dueDate,
            reserveAccountId: item.reserveAccountId,
            recurEvery: item.recurrence?.every ?? null,
            recurUnit: item.recurrence?.unit ?? null,
            state: 'planned' as const,
          })),
        )
        .returning({ id: lineItemsTable.id })

      return { packageId: pkg.id, lineItemIds: items.map((i) => i.id) }
    })

    return { ok: true, ...created }
  }

  /**
   * Commit: state becomes active, committed_at is today, and base accrual
   * components start from here (PRD §5). One tap plus one optional number:
   * how much is already set aside for this. A declared opening balance is
   * split across the parts in proportion to their cost (largest remainder, so
   * the parts add up to exactly what was declared) and recorded on the commit
   * event, which is where the accrual math reads it from. It reduces what the
   * base components have to cover, so the weekly figure is right from the
   * first week rather than over-collecting for money the household already has.
   */
  async commitPackage(
    packageId: Id,
    options: {
      openingCents?: Cents
      /**
       * What each part already holds, when the caller knows per part -- the
       * figure offered for a recurring plan, where one part may be most of a
       * year in and another brand new. Apportioning a single total by cost
       * would put that money in the wrong places.
       */
      openingByLineItem?: Readonly<Record<Id, Cents>>
    } = {},
  ): Promise<void> {
    const today = this.today()
    const perItem = options.openingByLineItem
    const openingCents = perItem
      ? Object.values(perItem).reduce((sum, cents) => sum + Math.max(0, cents), 0)
      : Math.max(0, options.openingCents ?? 0)

    await this.db.transaction(async (tx) => {
      const [pkg] = await tx
        .select()
        .from(packagesTable)
        .where(and(eq(packagesTable.id, packageId), eq(packagesTable.householdId, this.householdId)))

      if (!pkg) throw new EngineError('No such package in this household')
      if (pkg.state === 'active') throw new EngineError(`"${pkg.name}" is already committed`)
      if (pkg.state === 'retired') throw new EngineError(`"${pkg.name}" is retired`)

      const items = await tx
        .select()
        .from(lineItemsTable)
        .where(and(eq(lineItemsTable.packageId, packageId), eq(lineItemsTable.state, 'planned')))

      await tx
        .update(packagesTable)
        .set({ state: 'active', committedAt: today })
        .where(eq(packagesTable.id, packageId))

      await tx
        .update(lineItemsTable)
        .set({ state: 'accruing' })
        .where(and(eq(lineItemsTable.packageId, packageId), eq(lineItemsTable.state, 'planned')))

      const shares = perItem
        ? items.map((item) =>
            Math.max(0, Math.min(perItem[item.id] ?? 0, item.unitAmountCents * item.quantity)),
          )
        : openingCents > 0 && items.length > 0
          ? apportion(
              openingCents,
              items.map((i) => i.unitAmountCents * i.quantity),
            )
          : items.map(() => 0)

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'package_committed',
        occurredAt: today,
        actorUserId: this.actorUserId,
        payload: {
          package_id: packageId,
          opening_cents: openingCents,
          openings: items.map((item, index) => ({
            line_item_id: item.id,
            amount_cents: shares[index] ?? 0,
          })),
        },
      })
    })
  }

  /**
   * What each part of a not-yet-committed plan would already have set aside,
   * had the household been saving since the last time it came round.
   *
   * Only a suggestion, and only for the parts that repeat: the money is only
   * there if a person says it is (PRD §5 -- nothing is done until a human
   * confirms it). The figure comes from the domain, which prices a full cycle
   * exactly as a committed item is priced.
   */
  async suggestedOpenings(
    packageId: Id,
  ): Promise<{ lineItemId: Id; label: string; lastOccurrence: CivilDate; cents: Cents }[]> {
    const today = this.today()
    const rows = await this.db
      .select()
      .from(lineItemsTable)
      .where(
        and(eq(lineItemsTable.packageId, packageId), eq(lineItemsTable.householdId, this.householdId)),
      )

    return rows.flatMap((row) => {
      const item = toLineItem(row)
      const suggestion = openingSinceLastOccurrence({
        totalCents: lineItemTotalCents(item),
        dueDate: item.dueDate,
        recurrence: item.recurrence,
        today,
      })
      return suggestion
        ? [
            {
              lineItemId: item.id,
              label: item.label,
              lastOccurrence: suggestion.lastOccurrence,
              cents: suggestion.cents,
            },
          ]
        : []
    })
  }

  async listPackages(): Promise<Package[]> {
    const rows = await this.db
      .select()
      .from(packagesTable)
      .where(eq(packagesTable.householdId, this.householdId))
    return rows.map(toPackage)
  }

  async renamePackage(packageId: Id, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new EngineError('A plan needs a name')
    const existing = await this.listPackages()
    const target = existing.find((p) => p.id === packageId)
    if (!target) throw new EngineError('No such package in this household')
    const clash = existing.some(
      (p) => p.id !== packageId && p.state !== 'retired' && p.name.toLowerCase() === trimmed.toLowerCase(),
    )
    if (clash) throw new EngineError(`There is already a plan called "${trimmed}".`)
    await this.db
      .update(packagesTable)
      .set({ name: trimmed })
      .where(and(eq(packagesTable.id, packageId), eq(packagesTable.householdId, this.householdId)))
  }

  /**
   * Stop a plan. The package and every live part retire together; nothing is
   * deleted, so the history of what was planned and what was set aside for it
   * stays readable. Money already in the account is the account's business
   * and shows up as extra at the next check-in.
   */
  async retirePackage(packageId: Id): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [pkg] = await tx
        .select()
        .from(packagesTable)
        .where(and(eq(packagesTable.id, packageId), eq(packagesTable.householdId, this.householdId)))
      if (!pkg) throw new EngineError('No such package in this household')
      if (pkg.state === 'retired') return

      await tx.update(packagesTable).set({ state: 'retired' }).where(eq(packagesTable.id, packageId))
      await tx
        .update(lineItemsTable)
        .set({ state: 'retired' })
        .where(eq(lineItemsTable.packageId, packageId))
      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'package_retired',
        occurredAt: today,
        actorUserId: this.actorUserId,
        payload: { package_id: packageId, was: pkg.state },
      })
    })
  }

  // ---------------------------------------------------------------- line items

  /**
   * Edit a line item. The row holds current state; the change itself is an
   * append-only event, and it is that event the accrual math reads to build the
   * catch-up component (PRD §3, §5). Writing the row without the event would
   * silently erase the reason a weekly number changed.
   */
  async updateLineItem(
    lineItemId: Id,
    patch: Partial<
      Pick<LineItem, 'label' | 'unitAmountCents' | 'quantity' | 'dueDate' | 'reserveAccountId' | 'recurrence'>
    >,
  ): Promise<void> {
    const today = this.today()

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(lineItemsTable)
        .where(
          and(eq(lineItemsTable.id, lineItemId), eq(lineItemsTable.householdId, this.householdId)),
        )
      if (!row) throw new EngineError('No such line item in this household')

      // Moving an item into an account you do not own is a write to that
      // account's plan, so it needs the same permission as funding it.
      if (patch.reserveAccountId && patch.reserveAccountId !== row.reserveAccountId) {
        await this.assertCanWriteAccount(patch.reserveAccountId)
      }

      const before: LineItemSnapshot = {
        unitAmountCents: row.unitAmountCents,
        quantity: row.quantity,
        dueDate: row.dueDate,
        reserveAccountId: row.reserveAccountId,
      }
      const after: LineItemSnapshot = {
        unitAmountCents: patch.unitAmountCents ?? before.unitAmountCents,
        quantity: patch.quantity ?? before.quantity,
        dueDate: patch.dueDate ?? before.dueDate,
        reserveAccountId: patch.reserveAccountId ?? before.reserveAccountId,
      }

      const { recurrence, ...columns } = patch
      await tx
        .update(lineItemsTable)
        .set(
          'recurrence' in patch
            ? {
                ...columns,
                recurEvery: recurrence?.every ?? null,
                recurUnit: recurrence?.unit ?? null,
              }
            : columns,
        )
        .where(eq(lineItemsTable.id, lineItemId))

      const movesMoney =
        before.unitAmountCents !== after.unitAmountCents ||
        before.quantity !== after.quantity ||
        before.dueDate !== after.dueDate ||
        before.reserveAccountId !== after.reserveAccountId

      // A label-only edit is not a plan change and must not create a component.
      if (movesMoney) {
        await tx.insert(events).values({
          householdId: this.householdId,
          kind: 'line_item_changed',
          occurredAt: today,
          actorUserId: this.actorUserId,
          payload: { line_item_id: lineItemId, before, after },
        })
      }
    })
  }

  /**
   * Add a part to an existing plan. In a draft it is just another planned row;
   * in a live plan it starts accruing today, and the event that records the
   * addition is what tells the accrual math not to backdate it to the commit.
   */
  async addLineItem(
    packageId: Id,
    item: {
      label: string
      unitAmountCents: Cents
      quantity: number
      dueDate: CivilDate
      reserveAccountId: Id
      recurrence?: Recurrence | null
    },
  ): Promise<Id> {
    const today = this.today()
    const label = item.label.trim()
    if (!label) throw new EngineError('Every part needs a name')
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new EngineError('How many must be a whole number, at least one')
    }
    if (item.unitAmountCents <= 0) throw new EngineError('The cost must be more than zero')
    await this.assertCanWriteAccount(item.reserveAccountId)

    return this.db.transaction(async (tx) => {
      const [pkg] = await tx
        .select()
        .from(packagesTable)
        .where(and(eq(packagesTable.id, packageId), eq(packagesTable.householdId, this.householdId)))
      if (!pkg) throw new EngineError('No such package in this household')
      if (pkg.state === 'retired') throw new EngineError(`"${pkg.name}" is finished`)

      const recurrence = item.recurrence ?? null
      const dueDate = rollToFuture(item.dueDate, recurrence, today)
      if (dueDate <= today) throw new EngineError('The date has to be ahead of us')

      const [row] = await tx
        .insert(lineItemsTable)
        .values({
          householdId: this.householdId,
          packageId,
          label,
          unitAmountCents: item.unitAmountCents,
          quantity: item.quantity,
          dueDate,
          reserveAccountId: item.reserveAccountId,
          recurEvery: recurrence?.every ?? null,
          recurUnit: recurrence?.unit ?? null,
          state: pkg.state === 'active' ? 'accruing' : 'planned',
        })
        .returning({ id: lineItemsTable.id })
      if (!row) throw new EngineError('Could not add the part')

      if (pkg.state === 'active') {
        await tx.insert(events).values({
          householdId: this.householdId,
          kind: 'line_item_added',
          occurredAt: today,
          actorUserId: this.actorUserId,
          payload: { line_item_id: row.id, package_id: packageId },
        })
      }
      return row.id
    })
  }

  /** Take a part out of a plan. Retired, not deleted: its history stays. */
  async retireLineItem(lineItemId: Id): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(lineItemsTable)
        .where(and(eq(lineItemsTable.id, lineItemId), eq(lineItemsTable.householdId, this.householdId)))
      if (!row) throw new EngineError('No such line item in this household')
      if (row.state === 'retired') return
      await this.assertCanWriteAccount(row.reserveAccountId)

      await tx.update(lineItemsTable).set({ state: 'retired' }).where(eq(lineItemsTable.id, lineItemId))
      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'line_item_retired',
        occurredAt: today,
        actorUserId: this.actorUserId,
        payload: { line_item_id: lineItemId, package_id: row.packageId },
      })
    })
  }

  async listLineItems(): Promise<LineItem[]> {
    const rows = await this.db
      .select()
      .from(lineItemsTable)
      .where(eq(lineItemsTable.householdId, this.householdId))
    return rows.map(toLineItem)
  }

  /**
   * Every cycle start the accrual math needs (PRD §5): the commit, with the
   * opening balance declared then; a part added to a live plan; a recurring
   * part confirmed spent and rolled forward, which starts again at $0; and a
   * check-in that counted money already in the account toward a part.
   */
  async listCycleStarts(): Promise<LineItemCycle[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.householdId, this.householdId))

    const cycles: LineItemCycle[] = []
    for (const row of rows) {
      const on = row.occurredAt as CivilDate
      const p = row.payload as Record<string, unknown>
      switch (row.kind) {
        case 'package_committed':
          for (const o of (p.openings as { line_item_id: Id; amount_cents: Cents }[] | undefined) ?? []) {
            if (o.amount_cents > 0) {
              cycles.push({ lineItemId: o.line_item_id, startDate: on, openingCents: o.amount_cents })
            }
          }
          break
        case 'line_item_added':
          cycles.push({ lineItemId: p.line_item_id as Id, startDate: on, openingCents: 0 })
          break
        case 'spend_confirmed':
          if (p.rolled_to) cycles.push({ lineItemId: p.line_item_id as Id, startDate: on, openingCents: 0 })
          break
        case 'opening_recorded':
          cycles.push({
            lineItemId: p.line_item_id as Id,
            startDate: on,
            openingCents: p.opening_cents as Cents,
          })
          break
        default:
          break
      }
    }
    return cycles
  }

  /**
   * A check-in found more in an account than its plans had accrued, and the
   * person chose to count the extra toward those plans. Each part's new
   * opening balance is a fact about today, recorded as such; the accrual math
   * starts a fresh cycle from it. No money moves, so nothing needs confirming.
   */
  async recordOpeningBalances(
    items: readonly { lineItemId: Id; openingCents: Cents }[],
  ): Promise<void> {
    const today = this.today()
    const lineItems = await this.listLineItems()
    for (const entry of items) {
      const item = lineItems.find((li) => li.id === entry.lineItemId)
      if (!item) throw new EngineError('No such line item in this household')
      if (entry.openingCents < 0) throw new EngineError('An opening balance cannot be negative')
      await this.assertCanWriteAccount(item.reserveAccountId)
    }
    if (items.length === 0) return
    await this.db.insert(events).values(
      items.map((entry) => ({
        householdId: this.householdId,
        kind: 'opening_recorded' as const,
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual' as const,
        payload: { line_item_id: entry.lineItemId, opening_cents: entry.openingCents },
      })),
    )
  }

  /** Every recorded plan change, in the shape the accrual math consumes. */
  async listLineItemChanges(): Promise<LineItemChange[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.householdId, this.householdId), eq(events.kind, 'line_item_changed')))

    return rows
      .map((row) => {
        const payload = row.payload as {
          line_item_id: Id
          before: LineItemSnapshot
          after: LineItemSnapshot
        }
        return {
          lineItemId: payload.line_item_id,
          occurredAt: row.occurredAt as CivilDate,
          before: payload.before,
          after: payload.after,
        }
      })
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))
  }

  // ---------------------------------------------------------------- derived views

  /** Load every fact the derivation module needs, in one place. */
  async derivationInput(): Promise<DerivationInput> {
    const [accounts, packages, lineItems, changes, driftAdjustments, cycleStarts, transferRoundUpCents] =
      await Promise.all([
        this.listReserveAccounts(),
        this.listPackages(),
        this.listLineItems(),
        this.listLineItemChanges(),
        this.acceptedDriftAdjustments(),
        this.listCycleStarts(),
        this.transferRoundUpCents(),
      ])
    return {
      today: this.today(),
      accounts,
      packages,
      lineItems,
      changes,
      driftAdjustments,
      cycleStarts,
      transferRoundUpCents,
    }
  }

  /**
   * The step the bank figure is rounded up to. A household rule (a setting,
   * versioned like the others): nearest $10 unless they say otherwise, zero
   * for exact.
   */
  async transferRoundUpCents(): Promise<Cents> {
    return this.getSetting<number>('transfer_round_up_cents', DEFAULT_TRANSFER_ROUND_UP_CENTS)
  }

  /** Home / This Week: the per-account numbers to move (PRD §9). */
  async accountViews(): Promise<AccountView[]> {
    return accountViews(await this.derivationInput())
  }

  async packageViews(): Promise<PackageView[]> {
    return packageViews(await this.derivationInput())
  }

  async whatIf(packageId: Id): Promise<WhatIfLine[]> {
    return whatIfCommit(await this.derivationInput(), packageId)
  }

  /**
   * The should-have-saved curve for one package, plus the balances actually
   * confirmed along the way (PRD §5, capability 6).
   */
  async packageCurve(packageId: Id): Promise<{
    points: CurvePoint[]
    confirmed: { date: CivilDate; cents: Cents }[]
    targetCents: Cents
    from: CivilDate
    to: CivilDate
  } | null> {
    const view = (await this.packageViews()).find((v) => v.package.id === packageId)
    if (!view) return null

    const live = view.items.filter((i) => i.lineItem.state !== 'retired')
    if (live.length === 0) return null

    const from = view.package.committedAt ?? view.package.createdAt
    const to = live.map((i) => i.lineItem.dueDate).sort().at(-1)!
    const targetCents = view.totalCents

    const points = accrualCurve({
      components: live.flatMap((i) => i.components),
      from,
      to,
      capCents: targetCents,
    })

    // Confirmed balances are per account, so a package-level comparison only
    // makes sense where the package owns the whole account. Restricted to that
    // case rather than showing a number that silently includes other plans.
    const accountIds = new Set(live.map((i) => i.lineItem.reserveAccountId))
    const confirmed: { date: CivilDate; cents: Cents }[] = []

    if (accountIds.size === 1) {
      const accountId = [...accountIds][0]!
      const views = await this.accountViews()
      const account = views.find((v) => v.account.id === accountId)
      const ownsWholeAccount =
        account !== undefined &&
        account.items.every((i) => live.some((l) => l.lineItem.id === i.lineItem.id))

      if (ownsWholeAccount) {
        const rows = await this.db
          .select()
          .from(events)
          .where(
            and(eq(events.householdId, this.householdId), eq(events.kind, 'balance_confirmed')),
          )
        for (const row of rows) {
          const payload = row.payload as { reserve_account_id: Id; amount_cents: Cents }
          if (payload.reserve_account_id !== accountId) continue
          confirmed.push({ date: row.occurredAt as CivilDate, cents: payload.amount_cents })
        }
      }
    }

    return { points, confirmed, targetCents, from, to }
  }

  // ---------------------------------------------------------------- settings

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const rows = await this.db
      .select()
      .from(settingsTable)
      .where(and(eq(settingsTable.householdId, this.householdId), eq(settingsTable.key, key)))
    const latest = rows.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]
    return latest ? (latest.value as T) : fallback
  }

  // ---------------------------------------------------------------- check-ins and drift

  /**
   * Record a confirmed balance for an account (PRD §5, capability 3). This is
   * how the system learns an actual; the source column marks it as manual entry,
   * which is v1's only implementation of that interface.
   */
  async confirmBalance(input: { reserveAccountId: Id; amountCents: Cents }): Promise<void> {
    await this.assertCanWriteAccount(input.reserveAccountId)

    await this.db.insert(events).values({
      householdId: this.householdId,
      kind: 'balance_confirmed',
      occurredAt: this.today(),
      actorUserId: this.actorUserId,
      source: 'manual',
      payload: {
        reserve_account_id: input.reserveAccountId,
        amount_cents: input.amountCents,
      },
    })
  }

  /** The most recent confirmed balance per account, for showing drift since. */
  async latestConfirmedBalances(): Promise<Map<Id, { amountCents: Cents; on: CivilDate }>> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.householdId, this.householdId), eq(events.kind, 'balance_confirmed')))

    const latest = new Map<Id, { amountCents: Cents; on: CivilDate }>()
    for (const row of rows) {
      const payload = row.payload as { reserve_account_id: Id; amount_cents: Cents }
      const on = row.occurredAt as CivilDate
      const current = latest.get(payload.reserve_account_id)
      if (!current || current.on <= on) {
        latest.set(payload.reserve_account_id, { amountCents: payload.amount_cents, on })
      }
    }
    return latest
  }

  /**
   * Accepted rate bumps and cuts, as account-level catch-up components. Only a
   * CONFIRMED instruction counts: an offer the user never acted on must not
   * move the weekly number in either direction. A cut is the same component
   * with its sign flipped: the instruction stores a positive "take this much
   * off", the accrual math sees a negative delivery.
   */
  async acceptedDriftAdjustments(): Promise<DriftAdjustment[]> {
    const [issued, confirmed] = await Promise.all([
      this.listIssuedInstructions(),
      this.listConfirmedInstructions(),
    ])
    const confirmedIds = new Set(confirmed.map((c) => c.instructionId))

    return issued
      .filter(
        (i) =>
          (i.type === 'rate_bump' || i.type === 'rate_cut') &&
          confirmedIds.has(i.instructionId) &&
          i.endsOn,
      )
      .map((i) => ({
        id: i.instructionId,
        reserveAccountId: i.targetId,
        amountCents: i.type === 'rate_cut' ? -i.amountCents : i.amountCents,
        startDate: i.issuedOn,
        endDate: i.endsOn!,
      }))
  }

  // ---------------------------------------------------------------- close-out

  /** Passed due dates awaiting "did this get spent?" (PRD §5, capability 4). */
  async closeOutPrompts(): Promise<CloseOutPrompt[]> {
    const [lineItems, packages] = await Promise.all([this.listLineItems(), this.listPackages()])
    const byId = new Map(packages.map((p) => [p.id, p]))
    return closeOutPrompts({
      lineItems,
      today: this.today(),
      isLive: (item) => byId.get(item.packageId)?.state === 'active',
    })
  }

  /**
   * Confirm a line item's money was spent. The actual amount may differ from the
   * plan, and the difference is recorded rather than discarded -- it is either
   * money still sitting in the account or money that came from elsewhere.
   */
  async confirmSpend(input: { lineItemId: Id; actualAmountCents: Cents }): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(lineItemsTable)
        .where(
          and(
            eq(lineItemsTable.id, input.lineItemId),
            eq(lineItemsTable.householdId, this.householdId),
          ),
        )
      if (!row) throw new EngineError('No such line item in this household')
      if (row.state === 'retired') throw new EngineError('That one is already closed out')

      // A one-off retires. A recurring part rolls its due date to the next
      // occurrence in place and starts a fresh cycle from today at $0 saved
      // (PRD D8, superseded); the settled cycle stays in the log.
      const recurrence = recurrenceOf(row.recurEvery, row.recurUnit)
      const rolledTo = recurrence
        ? rollToFuture(row.dueDate as CivilDate, recurrence, today)
        : null

      await tx
        .update(lineItemsTable)
        .set(rolledTo ? { dueDate: rolledTo, state: 'accruing' } : { state: 'retired' })
        .where(eq(lineItemsTable.id, input.lineItemId))

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'spend_confirmed',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: {
          line_item_id: input.lineItemId,
          rolled_to: rolledTo,
          planned_cents: row.unitAmountCents * row.quantity,
          actual_amount_cents: input.actualAmountCents,
        },
      })
    })
  }

  // ---------------------------------------------------------------- instructions

  async issueInstruction(input: {
    type: InstructionType
    amountCents: Cents
    targetId: Id
    targetLabel: string
    note?: string
    endsOn?: CivilDate
  }): Promise<Id> {
    const instructionId = randomUUID()
    await this.db.insert(events).values({
      householdId: this.householdId,
      kind: 'instruction_issued',
      occurredAt: this.today(),
      actorUserId: this.actorUserId,
      payload: {
        instruction_id: instructionId,
        type: input.type,
        amount_cents: input.amountCents,
        target_id: input.targetId,
        target_label: input.targetLabel,
        note: input.note ?? null,
        ends_on: input.endsOn ?? null,
      },
    })
    return instructionId
  }

  async confirmInstruction(input: {
    instructionId: Id
    actualAmountCents?: Cents
  }): Promise<void> {
    await this.db.insert(events).values({
      householdId: this.householdId,
      kind: 'instruction_confirmed',
      occurredAt: this.today(),
      actorUserId: this.actorUserId,
      source: 'manual',
      payload: {
        instruction_id: input.instructionId,
        actual_amount_cents: input.actualAmountCents ?? null,
      },
    })
  }

  async listIssuedInstructions(): Promise<IssuedInstruction[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.householdId, this.householdId), eq(events.kind, 'instruction_issued')))

    return rows.map((row) => {
      const p = row.payload as {
        instruction_id: Id
        type: InstructionType
        amount_cents: Cents
        target_id: Id
        target_label: string
        note: string | null
        ends_on: CivilDate | null
      }
      return {
        instructionId: p.instruction_id,
        type: p.type,
        issuedOn: row.occurredAt as CivilDate,
        amountCents: p.amount_cents,
        targetId: p.target_id,
        targetLabel: p.target_label,
        note: p.note ?? undefined,
        endsOn: p.ends_on ?? undefined,
      }
    })
  }

  async listConfirmedInstructions(): Promise<ConfirmedInstruction[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(eq(events.householdId, this.householdId), eq(events.kind, 'instruction_confirmed')),
      )

    return rows.map((row) => {
      const p = row.payload as { instruction_id: Id; actual_amount_cents: Cents | null }
      return {
        instructionId: p.instruction_id,
        confirmedOn: row.occurredAt as CivilDate,
        actualAmountCents: p.actual_amount_cents ?? undefined,
      }
    })
  }

  async outstandingInstructions(): Promise<OutstandingInstruction[]> {
    const [issued, confirmed] = await Promise.all([
      this.listIssuedInstructions(),
      this.listConfirmedInstructions(),
    ])
    return outstandingInstructions({ issued, confirmed, today: this.today() })
  }

  // ---------------------------------------------------------------- allocation

  async allocationRules(): Promise<AllocationRule[]> {
    return this.getSetting<AllocationRule[]>('allocation_split', DEFAULT_ALLOCATION_RULES)
  }

  async bufferCents(): Promise<number> {
    return this.getSetting<number>('buffer_amount', DEFAULT_BUFFER_CENTS)
  }

  /** Preview only: shows the split without recording anything (PRD §6). */
  /**
   * What is short right now: reserve accounts behind their plans, and
   * deal-rate balances the minimums will not clear in time. The optional
   * first step of a share-out (PRD §6) covers these before the split.
   */
  async shortfalls(): Promise<Shortfall[]> {
    const [views, balances, debts] = await Promise.all([
      this.accountViews(),
      this.latestConfirmedBalances(),
      this.listDebts(),
    ])
    return findShortfalls({
      accounts: views.map((view) => ({
        view,
        confirmedCents: balances.get(view.account.id)?.amountCents ?? null,
      })),
      debts,
      today: this.today(),
    })
  }

  /**
   * The shortfalls a person ticked, by "kind:id", resolved against what is
   * actually short now. A form only ever says WHICH to cover; the amounts
   * come from here, so nothing posted back can inflate a top-up.
   */
  async chosenShortfalls(keys: readonly string[]): Promise<Shortfall[]> {
    if (keys.length === 0) return []
    const wanted = new Set(keys)
    return (await this.shortfalls()).filter((s) => wanted.has(`${s.kind}:${s.targetId}`))
  }

  async previewAllocation(
    floorCents: Cents,
    rules?: AllocationRule[],
    cover?: readonly Shortfall[],
  ): Promise<AllocationPlan> {
    return planAllocation({
      floorCents,
      bufferCents: await this.bufferCents(),
      rules: rules ?? (await this.allocationRules()),
      today: this.today(),
      cover,
    })
  }

  /**
   * Record an allocation run: one allocation_entered event plus an issued
   * instruction per destination, each independently confirmable (PRD §6).
   *
   * Nothing here moves money or marks anything done. The run is a recommendation
   * until a human confirms each instruction.
   */
  async runAllocation(input: {
    floorCents: Cents
    rules?: AllocationRule[]
    /**
     * When the money being shared out is the extra a check-in found sitting
     * in a reserve account, name it: the run then also asks for that money
     * to be moved out, so the to-do list says where it comes from as well as
     * where it goes.
     */
    sourceAccountId?: Id
    /** Shortfalls to cover first, off the top, before the split. */
    cover?: readonly Shortfall[]
  }): Promise<{ plan: AllocationPlan; instructionIds: Id[] }> {
    const today = this.today()
    const plan = await this.previewAllocation(input.floorCents, input.rules, input.cover)

    if (plan.netCents <= 0) return { plan, instructionIds: [] }

    const accounts = await this.listReserveAccounts()
    const instructionIds: Id[] = []

    if (input.sourceAccountId) {
      const source = accounts.find((a) => a.id === input.sourceAccountId)
      if (!source) throw new EngineError('No such reserve account in this household')
      instructionIds.push(
        await this.issueInstruction({
          type: 'one_time_move_out',
          amountCents: plan.netCents,
          targetId: source.id,
          targetLabel: source.name,
          note: 'The extra a check-in found here, shared out below.',
        }),
      )
    }

    // The first step: what was short gets covered before anything is split.
    for (const topUp of plan.topUps) {
      instructionIds.push(
        await this.issueInstruction(
          topUp.kind === 'plan'
            ? {
                type: 'one_time_move',
                amountCents: topUp.amountCents,
                targetId: topUp.targetId,
                targetLabel: topUp.label,
                note:
                  topUp.amountCents < topUp.shortCents
                    ? `Covers part of the ${formatCents(topUp.shortCents)} it is behind.`
                    : 'Covers what it is behind, before the rest is shared out.',
              }
            : {
                type: 'debt_payment',
                amountCents: topUp.amountCents,
                targetId: topUp.targetId,
                targetLabel: topUp.label,
                note:
                  topUp.amountCents < topUp.shortCents
                    ? `Part of the ${formatCents(topUp.shortCents)} its minimums will not clear before the deal ends.`
                    : 'Clears what its minimums will not before the deal ends.',
              },
        ),
      )
    }

    for (const share of plan.shares) {
      if (share.amountCents <= 0) continue

      if (share.destination === 'lifestyle') {
        // Released in halves so it is not spent all at once (PRD §6).
        for (const release of plan.lifestyleReleases) {
          if (release.amountCents <= 0) continue
          instructionIds.push(
            await this.issueInstruction({
              type: 'one_time_move',
              amountCents: release.amountCents,
              targetId: 'lifestyle',
              targetLabel: share.label,
              endsOn: release.releaseOn,
              note:
                release.releaseOn === today
                  ? 'First half, available now.'
                  : `Second half, from ${release.releaseOn}.`,
            }),
          )
        }
        continue
      }

      if (share.destination === 'debt') {
        // The debt share is handed to the optimizer, which names actual debts
        // (PRD §6 step 3) rather than leaving "put it at debt" for the user to
        // resolve. If there are no debts, it comes back with nothing and the
        // share is issued unassigned rather than silently dropped.
        const optimised = await this.optimiseLumpSum(share.amountCents)

        if (optimised.allocations.length === 0) {
          instructionIds.push(
            await this.issueInstruction({
              type: 'debt_payment',
              amountCents: share.amountCents,
              targetId: 'debt',
              targetLabel: share.label,
              note: 'No debts recorded yet, so this has nowhere specific to go.',
            }),
          )
          continue
        }

        for (const allocation of optimised.allocations) {
          instructionIds.push(
            await this.issueInstruction({
              type: 'debt_payment',
              amountCents: allocation.amountCents,
              targetId: allocation.debtId,
              targetLabel: allocation.debtName,
              note: allocation.reason,
            }),
          )
        }

        // Anything the optimizer could not place (every debt cleared) is still
        // the household's money and must not vanish from the plan.
        if (optimised.unallocatedCents > 0) {
          instructionIds.push(
            await this.issueInstruction({
              type: 'one_time_move',
              amountCents: optimised.unallocatedCents,
              targetId: 'debt',
              targetLabel: share.label,
              note: 'Left over after clearing every debt — decide where this goes.',
            }),
          )
        }
        continue
      }

      // A destination that maps to a real reserve account names that account,
      // so the instruction says where the money actually goes.
      const account = accounts.find((a) => a.name.toLowerCase() === share.label.toLowerCase())

      instructionIds.push(
        await this.issueInstruction({
          type: 'one_time_move',
          amountCents: share.amountCents,
          targetId: account?.id ?? share.destination,
          targetLabel: account?.name ?? share.label,
        }),
      )
    }

    await this.db.insert(events).values({
      householdId: this.householdId,
      kind: 'allocation_entered',
      occurredAt: today,
      actorUserId: this.actorUserId,
      source: 'manual',
      payload: {
        floor_cents: plan.floorCents,
        buffer_cents: plan.bufferCents,
        net_cents: plan.netCents,
        top_ups: plan.topUps.map((t) => ({
          kind: t.kind,
          target_id: t.targetId,
          short_cents: t.shortCents,
          amount_cents: t.amountCents,
        })),
        split_cents: plan.splitCents,
        splits: plan.shares.map((s) => ({
          destination: s.destination,
          percent: s.percent,
          amount_cents: s.amountCents,
        })),
        instruction_set: instructionIds,
      },
    })

    return { plan, instructionIds }
  }

  // ---------------------------------------------------------------- spreadsheet import (temporary)

  /**
   * Create what a parsed spreadsheet describes: missing accounts, one plan per
   * expense row committed with its "reserved now" as the opening balance, and
   * the debts with their dated balances. Every row goes through the same
   * paths a person would use by hand -- the intake contract, commit, createDebt
   * -- so nothing the importer makes is a special case. Rows the engine
   * refuses are reported by their sheet line and the rest still land.
   */
  async importSheet(parsed: SheetImport): Promise<{
    accountsCreated: string[]
    plansCreated: string[]
    debtsCreated: string[]
    problems: SheetProblem[]
  }> {
    const problems: SheetProblem[] = [...parsed.problems]
    const accountsCreated: string[] = []
    const plansCreated: string[] = []
    const debtsCreated: string[] = []

    for (const name of parsed.accountsToCreate) {
      const exists = (await this.listReserveAccounts()).some(
        (a) => a.name.toLowerCase() === name.toLowerCase(),
      )
      if (exists) continue
      await this.createReserveAccount({ name, institutionLabel: name })
      accountsCreated.push(name)
    }

    for (const expense of parsed.expenses) {
      const account = (await this.listReserveAccounts()).find(
        (a) => a.name.toLowerCase() === expense.account.toLowerCase(),
      )
      if (!account) {
        problems.push({ row: expense.row, message: `No account called "${expense.account}".` })
        continue
      }
      const created = await this.createPackageFromIntake({
        contract_version: INTAKE_CONTRACT_VERSION,
        package: { name: expense.label, module: 'sheet' },
        line_items: [
          {
            label: expense.label,
            unit_amount: expense.amountCents / 100,
            quantity: 1,
            due_date: expense.dueDate,
            reserve_account: account.id,
            recurrence: expense.recurrence,
          },
        ],
      })
      if (!created.ok) {
        problems.push({
          row: expense.row,
          message: `${expense.label}: ${created.problems.map((p) => p.message).join(' ')}`,
        })
        continue
      }
      await this.commitPackage(created.packageId, { openingCents: expense.openingCents })
      plansCreated.push(expense.label)
    }

    for (const debt of parsed.debts) {
      try {
        await this.createDebt({
          name: debt.name,
          category: debt.category,
          balanceCents: debt.balanceCents,
          aprBasisPoints: debt.aprBasisPoints,
          minPaymentRule: debt.minPaymentRule,
          creditLimitCents: debt.creditLimitCents,
          plannedPaymentCents: debt.plannedPaymentCents,
          ...(debt.balanceAsOf ? { balanceAsOf: debt.balanceAsOf } : {}),
        })
        debtsCreated.push(debt.name)
      } catch (error) {
        problems.push({ row: debt.row, message: `${debt.name}: ${(error as Error).message}` })
      }
    }

    return { accountsCreated, plansCreated, debtsCreated, problems: problems.sort((a, b) => a.row - b.row) }
  }

  // ---------------------------------------------------------------- debts

  async listDebts(): Promise<Debt[]> {
    const rows = await this.db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.householdId, this.householdId))
    return rows.map(toDebt)
  }

  async createDebt(input: {
    name: string
    category: DebtCategory
    balanceCents: Cents
    aprBasisPoints: number
    minPaymentRule: MinPaymentRule
    promoRules?: PromoRule[]
    creditLimitCents?: Cents | null
    /** What the household pays each month when that beats the minimum. */
    plannedPaymentCents?: Cents | null
    /** When the balance was last known to be right. Defaults to today. */
    balanceAsOf?: CivilDate
  }): Promise<Debt> {
    validateDebtInputs({
      balanceCents: input.balanceCents,
      aprBasisPoints: input.aprBasisPoints,
      minPaymentRule: input.minPaymentRule,
      plannedPaymentCents: input.plannedPaymentCents,
    })
    validateDebtRates({
      aprBasisPoints: input.aprBasisPoints,
      promoRules: input.promoRules ?? [],
    })

    const [row] = await this.db
      .insert(debtsTable)
      .values({
        householdId: this.householdId,
        name: input.name.trim(),
        category: input.category,
        balanceCents: input.balanceCents,
        balanceAsOf: input.balanceAsOf ?? this.today(),
        aprBasisPoints: input.aprBasisPoints,
        promoRules: input.promoRules ?? [],
        minPaymentRule: input.minPaymentRule,
        creditLimitCents: input.creditLimitCents ?? null,
        plannedPaymentCents: input.plannedPaymentCents ?? null,
        state: 'open',
      })
      .returning()
    if (!row) throw new EngineError('Could not create the debt')
    return toDebt(row)
  }

  /**
   * Correct a debt's terms: the name, kind, rate, minimum-payment rule, promo
   * rules and limit. The balance has its own paths (a payment, or a statement
   * balance), because a balance is a dated fact and these are terms. The
   * change is recorded before and after, so a rate that later looks wrong can
   * be traced to when it was typed.
   */
  async updateDebt(
    debtId: Id,
    patch: Partial<
      Pick<
        Debt,
        'name' | 'category' | 'aprBasisPoints' | 'minPaymentRule' | 'promoRules' | 'creditLimitCents' | 'plannedPaymentCents'
      >
    >,
  ): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, this.householdId)))
      if (!row) throw new EngineError('No such debt in this household')
      const before = toDebt(row)
      const after: Debt = {
        ...before,
        ...patch,
        name: (patch.name ?? before.name).trim(),
        promoRules: patch.promoRules ?? before.promoRules,
        creditLimitCents: patch.creditLimitCents === undefined ? before.creditLimitCents : patch.creditLimitCents,
        plannedPaymentCents:
          patch.plannedPaymentCents === undefined ? before.plannedPaymentCents : patch.plannedPaymentCents,
      }
      if (!after.name) throw new EngineError('A debt needs a name')

      validateDebtInputs({
        balanceCents: after.balanceCents,
        aprBasisPoints: after.aprBasisPoints,
        minPaymentRule: after.minPaymentRule,
        plannedPaymentCents: after.plannedPaymentCents,
      })
      validateDebtRates({ aprBasisPoints: after.aprBasisPoints, promoRules: after.promoRules })

      await tx
        .update(debtsTable)
        .set({
          name: after.name,
          category: after.category,
          aprBasisPoints: after.aprBasisPoints,
          minPaymentRule: after.minPaymentRule,
          promoRules: after.promoRules,
          creditLimitCents: after.creditLimitCents ?? null,
          plannedPaymentCents: after.plannedPaymentCents ?? null,
        })
        .where(eq(debtsTable.id, debtId))

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'debt_updated',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: {
          debt_id: debtId,
          before: {
            name: before.name,
            category: before.category,
            apr_basis_points: before.aprBasisPoints,
            min_payment_rule: before.minPaymentRule,
            promo_rules: before.promoRules,
            credit_limit_cents: before.creditLimitCents ?? null,
          },
          after: {
            name: after.name,
            category: after.category,
            apr_basis_points: after.aprBasisPoints,
            min_payment_rule: after.minPaymentRule,
            promo_rules: after.promoRules,
            credit_limit_cents: after.creditLimitCents ?? null,
          },
        },
      })
    })
  }

  /**
   * Remove a debt that should never have been entered. The row goes; what it
   * said is kept on the event, so the ladder's history still makes sense.
   */
  async removeDebt(debtId: Id): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, this.householdId)))
      if (!row) throw new EngineError('No such debt in this household')

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'debt_removed',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: {
          debt_id: debtId,
          name: row.name,
          category: row.category,
          balance_cents: row.balanceCents,
          balance_as_of: row.balanceAsOf,
          apr_basis_points: row.aprBasisPoints,
          min_payment_rule: row.minPaymentRule,
          promo_rules: row.promoRules,
          credit_limit_cents: row.creditLimitCents,
        },
      })
      await tx.delete(debtsTable).where(eq(debtsTable.id, debtId))
    })
  }

  /**
   * A confirmed payment (PRD §7). Balances move only through confirmations, so a
   * recommendation the user did not act on never changes a score.
   */
  async confirmDebtPayment(input: { debtId: Id; amountCents: Cents }): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, input.debtId), eq(debtsTable.householdId, this.householdId)))
      if (!row) throw new EngineError('No such debt in this household')

      const balanceCents = Math.max(0, row.balanceCents - input.amountCents)
      await tx
        .update(debtsTable)
        .set({
          balanceCents,
          balanceAsOf: today,
          state: balanceCents === 0 ? 'paid_off' : 'open',
        })
        .where(eq(debtsTable.id, input.debtId))

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'payment_confirmed',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: {
          debt_id: input.debtId,
          amount_cents: input.amountCents,
          balance_after_cents: balanceCents,
        },
      })
    })
  }

  /** A statement balance the user read off, rather than a payment they made. */
  async updateDebtBalance(input: { debtId: Id; balanceCents: Cents }): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, input.debtId), eq(debtsTable.householdId, this.householdId)))
      if (!row) throw new EngineError('No such debt in this household')

      await tx
        .update(debtsTable)
        .set({
          balanceCents: input.balanceCents,
          balanceAsOf: today,
          state: input.balanceCents === 0 ? 'paid_off' : 'open',
        })
        .where(eq(debtsTable.id, input.debtId))

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'debt_balance_updated',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: { debt_id: input.debtId, balance_cents: input.balanceCents, as_of: today },
      })
    })
  }

  async priorityWeight(): Promise<number> {
    return this.getSetting<number>('priority_weights', DEFAULT_PRIORITY_WEIGHT)
  }

  async promoLeadWeeks(): Promise<number> {
    return this.getSetting<number>('promo_lead_weeks', DEFAULT_PROMO_LEAD_WEEKS)
  }

  /** The payoff order, with the running trade-off at each rung (PRD §7). */
  async debtLadder(weightOverride?: number): Promise<LadderRung[]> {
    const [debts, weight, promoLeadWeeks] = await Promise.all([
      this.listDebts(),
      weightOverride !== undefined ? Promise.resolve(weightOverride) : this.priorityWeight(),
      this.promoLeadWeeks(),
    ])
    return snowballLadder(scoreDebts({ debts, today: this.today(), weight, promoLeadWeeks }))
  }

  /** Where a specific amount should go (PRD §7). */
  async optimiseLumpSum(amountCents: Cents, weightOverride?: number): Promise<OptimizerResult> {
    const [debts, weight, promoLeadWeeks] = await Promise.all([
      this.listDebts(),
      weightOverride !== undefined ? Promise.resolve(weightOverride) : this.priorityWeight(),
      this.promoLeadWeeks(),
    ])
    return optimiseLumpSum({
      debts,
      amountCents,
      today: this.today(),
      weight,
      promoLeadWeeks,
    })
  }

  /** Debts whose promotional rate is close enough to worry about (PRD §8). */
  async promoWarnings(): Promise<
    { debt: Debt; untilDate: CivilDate; monthlyToClearCents: Cents }[]
  > {
    const [debts, leadWeeks] = await Promise.all([this.listDebts(), this.promoLeadWeeks()])
    const today = this.today()
    return debts
      .filter((debt) => debt.state === 'open')
      .flatMap((debt) => {
        const warning = promoExpiryWarning(debt, today, leadWeeks)
        return warning ? [{ debt, ...warning }] : []
      })
  }

  /** Settings are versioned by effective_from; a change adds a row, never edits one. */
  async putSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settingsTable)
      .values({
        householdId: this.householdId,
        key,
        value,
        effectiveFrom: this.today(),
      })
      .onConflictDoUpdate({
        target: [settingsTable.householdId, settingsTable.key, settingsTable.effectiveFrom],
        set: { value },
      })
  }
}

function toPackage(r: typeof packagesTable.$inferSelect): Package {
  return {
    id: r.id,
    householdId: r.householdId,
    name: r.name,
    state: r.state,
    module: r.module,
    detail: r.detail,
    createdAt: r.createdAt as CivilDate,
    committedAt: (r.committedAt as CivilDate | null) ?? null,
  }
}

function toReserveAccount(r: typeof reserveAccountsTable.$inferSelect): ReserveAccount {
  return {
    id: r.id,
    householdId: r.householdId,
    name: r.name,
    institutionLabel: r.institutionLabel,
    scope: r.scope,
    ownerUserId: r.ownerUserId,
    active: r.active,
  }
}

function toDebt(r: typeof debtsTable.$inferSelect): Debt {
  return {
    id: r.id,
    householdId: r.householdId,
    name: r.name,
    category: r.category,
    balanceCents: r.balanceCents,
    balanceAsOf: r.balanceAsOf as CivilDate,
    aprBasisPoints: r.aprBasisPoints,
    promoRules: (r.promoRules as PromoRule[]) ?? [],
    minPaymentRule: r.minPaymentRule as MinPaymentRule,
    creditLimitCents: r.creditLimitCents,
    plannedPaymentCents: r.plannedPaymentCents,
    fixedPayment: r.fixedPayment,
    state: r.state,
  }
}

function toLineItem(r: typeof lineItemsTable.$inferSelect): LineItem {
  return {
    id: r.id,
    packageId: r.packageId,
    label: r.label,
    unitAmountCents: r.unitAmountCents,
    quantity: r.quantity,
    dueDate: r.dueDate as CivilDate,
    reserveAccountId: r.reserveAccountId,
    state: r.state,
    recurrence: recurrenceOf(r.recurEvery, r.recurUnit),
  }
}
