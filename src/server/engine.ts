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
  events,
  lineItems as lineItemsTable,
  packages as packagesTable,
  reserveAccounts as reserveAccountsTable,
  settings as settingsTable,
} from '@/db/schema'
import {
  accountViews,
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
  type LineItemSnapshot,
  type Package,
  type PackageView,
  type ReserveAccount,
  type WhatIfLine,
} from '@/domain'

export class EngineError extends Error {}

export type CreatePackageResult =
  | { ok: true; packageId: Id }
  | { ok: false; problems: IntakeProblem[] }

export interface EngineContext {
  householdId: Id
  actorUserId: Id | null
  timezone?: string
  db?: Db
}

export class Engine {
  private readonly db: Db
  private readonly householdId: Id
  private readonly actorUserId: Id | null
  private readonly timezone: string

  constructor(context: EngineContext) {
    this.db = context.db ?? defaultDb
    this.householdId = context.householdId
    this.actorUserId = context.actorUserId
    this.timezone = context.timezone ?? 'America/Chicago'
  }

  /** Today in the household's timezone. The single source of "now". */
  today(): CivilDate {
    return todayIn(this.timezone)
  }

  // ---------------------------------------------------------------- reserve accounts

  async listReserveAccounts(): Promise<ReserveAccount[]> {
    const rows = await this.db
      .select()
      .from(reserveAccountsTable)
      .where(eq(reserveAccountsTable.householdId, this.householdId))
    return rows.map((r) => ({
      id: r.id,
      householdId: r.householdId,
      name: r.name,
      institutionLabel: r.institutionLabel,
      active: r.active,
    }))
  }

  async createReserveAccount(input: {
    name: string
    institutionLabel: string
  }): Promise<ReserveAccount> {
    const [row] = await this.db
      .insert(reserveAccountsTable)
      .values({
        householdId: this.householdId,
        name: input.name.trim(),
        institutionLabel: input.institutionLabel.trim(),
      })
      .returning()
    if (!row) throw new EngineError('Could not create the reserve account')
    return {
      id: row.id,
      householdId: row.householdId,
      name: row.name,
      institutionLabel: row.institutionLabel,
      active: row.active,
    }
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

    const result = validateIntake(raw, { today, accounts, packages: existing })
    if (!result.ok) return { ok: false, problems: result.problems }

    const packageId = await this.db.transaction(async (tx) => {
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

      await tx.insert(lineItemsTable).values(
        result.value.lineItems.map((item) => ({
          householdId: this.householdId,
          packageId: pkg.id,
          label: item.label,
          unitAmountCents: item.unitAmountCents,
          quantity: item.quantity,
          dueDate: item.dueDate,
          reserveAccountId: item.reserveAccountId,
          state: 'planned' as const,
        })),
      )

      return pkg.id
    })

    return { ok: true, packageId }
  }

  /**
   * Commit: state becomes active, committed_at is today, $0 is reserved, and
   * base accrual components start from here (PRD §5). One tap, and the only
   * moment a draft starts costing real weekly money.
   */
  async commitPackage(packageId: Id): Promise<void> {
    const today = this.today()

    await this.db.transaction(async (tx) => {
      const [pkg] = await tx
        .select()
        .from(packagesTable)
        .where(and(eq(packagesTable.id, packageId), eq(packagesTable.householdId, this.householdId)))

      if (!pkg) throw new EngineError('No such package in this household')
      if (pkg.state === 'active') throw new EngineError(`"${pkg.name}" is already committed`)
      if (pkg.state === 'retired') throw new EngineError(`"${pkg.name}" is retired`)

      await tx
        .update(packagesTable)
        .set({ state: 'active', committedAt: today })
        .where(eq(packagesTable.id, packageId))

      await tx
        .update(lineItemsTable)
        .set({ state: 'accruing' })
        .where(and(eq(lineItemsTable.packageId, packageId), eq(lineItemsTable.state, 'planned')))

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'package_committed',
        occurredAt: today,
        actorUserId: this.actorUserId,
        payload: { package_id: packageId },
      })
    })
  }

  async listPackages(): Promise<Package[]> {
    const rows = await this.db
      .select()
      .from(packagesTable)
      .where(eq(packagesTable.householdId, this.householdId))
    return rows.map(toPackage)
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
    patch: Partial<Pick<LineItem, 'label' | 'unitAmountCents' | 'quantity' | 'dueDate' | 'reserveAccountId'>>,
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

      await tx
        .update(lineItemsTable)
        .set({ ...patch })
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

  async listLineItems(): Promise<LineItem[]> {
    const rows = await this.db
      .select()
      .from(lineItemsTable)
      .where(eq(lineItemsTable.householdId, this.householdId))
    return rows.map(toLineItem)
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
    const [accounts, packages, lineItems, changes] = await Promise.all([
      this.listReserveAccounts(),
      this.listPackages(),
      this.listLineItems(),
      this.listLineItemChanges(),
    ])
    return { today: this.today(), accounts, packages, lineItems, changes }
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

  // ---------------------------------------------------------------- settings

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const rows = await this.db
      .select()
      .from(settingsTable)
      .where(and(eq(settingsTable.householdId, this.householdId), eq(settingsTable.key, key)))
    const latest = rows.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]
    return latest ? (latest.value as T) : fallback
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
  }
}
