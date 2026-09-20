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
import { randomUUID } from 'node:crypto'
import {
  accountViews,
  closeOutPrompts,
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
  type LineItemSnapshot,
  type Package,
  type PackageView,
  type ReserveAccount,
  type WhatIfLine,
  type Cents,
  type CloseOutPrompt,
  type ConfirmedInstruction,
  type DriftAdjustment,
  type InstructionType,
  type IssuedInstruction,
  type OutstandingInstruction,
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
    const [accounts, packages, lineItems, changes, driftAdjustments] = await Promise.all([
      this.listReserveAccounts(),
      this.listPackages(),
      this.listLineItems(),
      this.listLineItemChanges(),
      this.acceptedDriftAdjustments(),
    ])
    return { today: this.today(), accounts, packages, lineItems, changes, driftAdjustments }
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

  // ---------------------------------------------------------------- check-ins and drift

  /**
   * Record a confirmed balance for an account (PRD §5, capability 3). This is
   * how the system learns an actual; the source column marks it as manual entry,
   * which is v1's only implementation of that interface.
   */
  async confirmBalance(input: { reserveAccountId: Id; amountCents: Cents }): Promise<void> {
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
   * Accepted rate bumps, as account-level catch-up components. Only a CONFIRMED
   * instruction counts: an offer the user never acted on must not inflate the
   * weekly number.
   */
  async acceptedDriftAdjustments(): Promise<DriftAdjustment[]> {
    const [issued, confirmed] = await Promise.all([
      this.listIssuedInstructions(),
      this.listConfirmedInstructions(),
    ])
    const confirmedIds = new Set(confirmed.map((c) => c.instructionId))

    return issued
      .filter((i) => i.type === 'rate_bump' && confirmedIds.has(i.instructionId) && i.endsOn)
      .map((i) => ({
        id: i.instructionId,
        reserveAccountId: i.targetId,
        amountCents: i.amountCents,
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

      await tx
        .update(lineItemsTable)
        .set({ state: 'retired' })
        .where(eq(lineItemsTable.id, input.lineItemId))

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'spend_confirmed',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: {
          line_item_id: input.lineItemId,
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
