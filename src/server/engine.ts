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
  canWriteAccount,
  closeOutPrompts,
  DEFAULT_ALLOCATION_RULES,
  DEFAULT_BUFFER_CENTS,
  DEFAULT_PRIORITY_WEIGHT,
  DEFAULT_PROMO_LEAD_WEEKS,
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
  type LineItemSnapshot,
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
  type Debt,
  type DebtCategory,
  type LadderRung,
  type MinPaymentRule,
  type OptimizerResult,
  type PromoRule,
  type CurvePoint,
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

  // ---------------------------------------------------------------- allocation

  async allocationRules(): Promise<AllocationRule[]> {
    return this.getSetting<AllocationRule[]>('allocation_split', DEFAULT_ALLOCATION_RULES)
  }

  async bufferCents(): Promise<number> {
    return this.getSetting<number>('buffer_amount', DEFAULT_BUFFER_CENTS)
  }

  /** Preview only: shows the split without recording anything (PRD §6). */
  async previewAllocation(floorCents: Cents, rules?: AllocationRule[]): Promise<AllocationPlan> {
    return planAllocation({
      floorCents,
      bufferCents: await this.bufferCents(),
      rules: rules ?? (await this.allocationRules()),
      today: this.today(),
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
  }): Promise<{ plan: AllocationPlan; instructionIds: Id[] }> {
    const today = this.today()
    const plan = await this.previewAllocation(input.floorCents, input.rules)

    if (plan.netCents <= 0) return { plan, instructionIds: [] }

    const accounts = await this.listReserveAccounts()
    const instructionIds: Id[] = []

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
    fixedPayment?: boolean
  }): Promise<Debt> {
    validateDebtInputs({
      balanceCents: input.balanceCents,
      aprBasisPoints: input.aprBasisPoints,
      minPaymentRule: input.minPaymentRule,
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
        balanceAsOf: this.today(),
        aprBasisPoints: input.aprBasisPoints,
        promoRules: input.promoRules ?? [],
        minPaymentRule: input.minPaymentRule,
        creditLimitCents: input.creditLimitCents ?? null,
        fixedPayment: input.fixedPayment ?? false,
        state: 'open',
      })
      .returning()
    if (!row) throw new EngineError('Could not create the debt')
    return toDebt(row)
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
    recurrence: r.recurrence,
  }
}
