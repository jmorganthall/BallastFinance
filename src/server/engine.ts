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

import { and, eq, gte, isNull, lte } from 'drizzle-orm'
import { db as defaultDb, type Db } from '@/db/client'
import {
  assets as assetsTable,
  debts as debtsTable,
  events,
  lineItems as lineItemsTable,
  packages as packagesTable,
  reserveAccounts as reserveAccountsTable,
  settings as settingsTable,
  crowdLevels as crowdLevelsTable,
  dvcListings as dvcListingsTable,
  schoolDaysOff as schoolDaysOffTable,
  tripDays as tripDaysTable,
  tripLines as tripLinesTable,
  tripReservations as tripReservationsTable,
  tripTasks as tripTasksTable,
  tripVariants as tripVariantsTable,
  trips as tripsTable,
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
  reshuffleAccount as planReshuffle,
  type Reshuffle,
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
  driftAdjustmentsFrom,
  openCommitmentsFor,
  outstandingInstructions,
  packageViews,
  todayIn,
  validateIntake,
  whatIfCommit,
  type AccountView,
  type CivilDate,
  type DerivationInput,
  type EndedInstruction,
  type OpenCommitments,
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
  type InstructionPurpose,
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
  DEFAULT_HOME_BUYING,
  DEFAULT_SELLING_COST_BASIS_POINTS,
  equityPosition,
  mortgagePaymentsCents,
  homeCost,
  mostHouseForPayment,
  rateInUse,
  validateAssetInputs,
  validateHomeBuying,
  type Asset,
  type AssetKind,
  type AssetState,
  type EquityPosition,
  type HomeBuyingAssumptions,
  type HomeCost,
  type MarketRate,
  type RateInUse,
  contingencyBasisPoints,
  defaultLines,
  DEFAULT_MAX_DRIVE_MINUTES,
  DEFAULT_REFERENCE_PRICES,
  driveSettingKey,
  headlineDueDate,
  keepTypedLines,
  mergeReferencePrices,
  toIntake,
  validateChoices,
  validateDriveEstimate,
  validateGasPrice,
  validateHomeLocation,
  validateLineInputs,
  validateReferencePrices,
  validateTripInputs,
  variantPrice,
  type DefaultLine,
  type DriveEstimate,
  type GasPrice,
  type HomeLocation,
  type ReferencePrice,
  type Traveler,
  type Trip,
  type TripCar,
  type TripDestination,
  type TripLine,
  type TripLineCategory,
  type TripVariant,
  type VariantChoices,
  type VariantPrice,
  homeIsLocated,
  ADDED_LINE_SORT,
  addDays,
  compareDates,
  lineTotalCents as tripLineTotalCents,
  bookingTimeline,
  comingUpTasks,
  cutDays,
  dayPlan,
  DEFAULT_PACK_TEMPLATE,
  mergeTimeline,
  reservationMoney,
  sortReservations,
  sortTasks,
  validateBlackoutDates,
  validateCrowdLevel,
  validateDayInputs,
  validatePackTemplate,
  validateReservationInputs,
  validateTaskInputs,
  weekComparison,
  type BlackoutRange,
  type CrowdLevel,
  type DayView,
  type GeocodeResult,
  type ParsedCrowdLevel,
  type ReservationMoney,
  type TaskKind,
  type TripDay,
  type TripPark,
  type TripReservation,
  type TripTask,
  type WeekComparisonRow,
  addMonths,
  bestWeeks,
  DEFAULT_HORIZON_MONTHS,
  DVC_LISTING_SOURCES,
  DEFAULT_WEEK_WEIGHTS,
  diffDaysOff,
  listingWindow,
  listingsForTrip,
  schoolYearOf,
  validateDayOff,
  validateDvcListing,
  validateHorizonMonths,
  validateSchoolCalendarSources,
  validateWeekWeights,
  type BestWeeks,
  type DayOffInput,
  type DvcListing,
  type ParsedListings,
  type SchoolCalendarSource,
  type SchoolDayOff,
  type WeekWeights,
} from '@/domain'
import { fetchSchoolCalendarIcal, pullDvcListings } from '@/server/trip-fetch'
import { readerEnabled, readerSourceName, readStructured, type ReaderDeps } from '@/server/reader'

export class EngineError extends Error {}

export type CreatePackageResult =
  | { ok: true; packageId: Id; lineItemIds: Id[] }
  | { ok: false; problems: IntakeProblem[] }

/** A transaction handle, or the connection itself for a read outside one. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Conn = Db | Tx

/**
 * A crowd calendar pull, held for the person to look at before it is kept
 * (D23). Facts as fetched, not yet crowd levels: "Use these" makes them so.
 */
export interface CrowdPull {
  source: string
  label: string
  destination: TripDestination
  months: string[]
  levels: ParsedCrowdLevel[]
  fetchedOn: CivilDate
  /** What each source said when it gave nothing, so the screen can say so plainly. */
  notes: string[]
}

/**
 * A school calendar as a feed or the reader gave it, held for the person to
 * look at before it is kept (D25, D27). Kept, it becomes days off with this
 * source and link.
 */
export interface SchoolCalendarPending {
  label: string
  /** 'ical' or 'read:<model>'. */
  source: string
  sourceUrl: string
  /** The year as the document names it; a feed does not say, so each day's is worked out from its date. */
  schoolYear: string | null
  items: DayOffInput[]
  readOn: CivilDate
  notes: string[]
}

/** DVC rooms a broker had, held for the person to look at before they are kept (D26). */
export interface DvcPull {
  /** The source key, or 'read:<model>' when the reader read the page. */
  source: string
  label: string
  url: string
  from: CivilDate
  to: CivilDate
  listings: ParsedListings['listings']
  seenOn: CivilDate
  notes: string[]
}

/** What "Read it" or "Check what DVC brokers have" came back with: something to look at, or nothing with the reasons. */
export type ReadOutcome = { ok: true; count: number } | { ok: false; notes: string[] }

/** The reader's helpers a test can replace: the fetches, and the reader itself. */
export interface ReadDeps extends ReaderDeps {
  read?: typeof readStructured
}

/** Everything the planning sections of the trip screen show (D22): facts, plus the derivation module's views of them. */
export interface TripPlanView {
  trip: Trip
  /** The way the plan follows: the one sent, else the first. */
  variant: (TripVariant & { lines: TripLine[] }) | null
  days: TripDay[]
  dayViews: DayView[]
  reservations: TripReservation[]
  money: ReservationMoney
  tasks: TripTask[]
  weeks: WeekComparisonRow[]
  crowdLevels: CrowdLevel[]
  blackoutDates: BlackoutRange[]
  packTemplate: string[]
  pendingPull: CrowdPull | null
  /** The top ten dates across the horizon, with the reasons (D25). */
  bestWeeks: BestWeeks
  horizonMonths: number
  weekWeights: WeekWeights
  /** What a broker had for the trip's dates, two days either side (D26). */
  dvcListings: DvcListing[]
  pendingDvcPull: DvcPull | null
}

/** Everything the trip screen shows: facts, plus each way's price tag from the derivation module. */
export interface TripView {
  trip: Trip
  variants: (TripVariant & { lines: TripLine[]; price: VariantPrice; firstMoneyDue: CivilDate })[]
  referencePrices: ReferencePrice[]
  bufferCents: Cents
  drive: DriveEstimate | null
  gasPrice: GasPrice | null
  maxDriveMinutes: number
}

/**
 * Parts a person added by hand sort from here, above every default part, so a
 * rebuild after a change of choices can tell them apart and keep them.
 */

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

  /**
   * Take a finished plan off the books for good. Only a retired plan can go,
   * and only with its name typed back exactly: the check is here, in the one
   * write path, not left to a screen. The rows go (its parts with them); the
   * events stay, as they always do, and a `package_deleted` event records what
   * the plan was, so the log still explains the money that went through it.
   */
  async deletePackage(packageId: Id, confirmName: string): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [pkg] = await tx
        .select()
        .from(packagesTable)
        .where(and(eq(packagesTable.id, packageId), eq(packagesTable.householdId, this.householdId)))
      if (!pkg) throw new EngineError('No such package in this household')
      if (pkg.state !== 'retired') {
        throw new EngineError('Only a finished plan can be deleted. Stop saving for it first.')
      }
      if (confirmName.trim() !== pkg.name) {
        throw new EngineError('The name typed does not match the plan, so nothing was deleted.')
      }

      const parts = await tx.select().from(lineItemsTable).where(eq(lineItemsTable.packageId, packageId))
      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'package_deleted',
        occurredAt: today,
        actorUserId: this.actorUserId,
        payload: {
          package_id: packageId,
          name: pkg.name,
          module: pkg.module,
          created_at: pkg.createdAt,
          committed_at: pkg.committedAt,
          line_items: parts.map((row) => ({
            line_item_id: row.id,
            label: row.label,
            unit_amount_cents: row.unitAmountCents,
            quantity: row.quantity,
            due_date: row.dueDate,
            reserve_account_id: row.reserveAccountId,
            state: row.state,
            recurrence: toLineItem(row).recurrence,
          })),
        },
      })
      await tx.delete(lineItemsTable).where(eq(lineItemsTable.packageId, packageId))
      await tx.delete(packagesTable).where(eq(packagesTable.id, packageId))
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
    // In the order they were recorded: a same-day tie between two starts is
    // decided by that order, so it has to be the database's, not chance.
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.householdId, this.householdId))
      .orderBy(events.recordedAt, events.id)

    const cycles: LineItemCycle[] = []
    const next = () => cycles.length
    for (const row of rows) {
      const on = row.occurredAt as CivilDate
      const p = row.payload as Record<string, unknown>
      switch (row.kind) {
        case 'package_committed':
          for (const o of (p.openings as { line_item_id: Id; amount_cents: Cents }[] | undefined) ?? []) {
            if (o.amount_cents > 0) {
              cycles.push({
                lineItemId: o.line_item_id,
                startDate: on,
                openingCents: o.amount_cents,
                recordedOrder: next(),
                origin: 'commit',
              })
            }
          }
          break
        case 'line_item_added':
          cycles.push({
            lineItemId: p.line_item_id as Id,
            startDate: on,
            openingCents: 0,
            recordedOrder: next(),
            origin: 'added',
          })
          break
        case 'spend_confirmed':
          if (p.rolled_to) {
            cycles.push({
              lineItemId: p.line_item_id as Id,
              startDate: on,
              openingCents: 0,
              recordedOrder: next(),
              origin: 'rolled',
            })
          }
          break
        case 'opening_recorded':
          cycles.push({
            lineItemId: p.line_item_id as Id,
            startDate: on,
            openingCents: p.opening_cents as Cents,
            recordedOrder: next(),
            origin: 'counted',
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

  /**
   * What re-spreading this account's counted money across its parts would
   * change (PRD §6): every part up to its pace first, the rest onto the
   * one-offs, and nothing above pace on a part that comes round again. A
   * preview; nothing is recorded.
   */
  async reshufflePreview(accountId: Id): Promise<Reshuffle | null> {
    return planReshuffle(await this.derivationInput(), accountId)
  }

  /**
   * Do it. Each part whose counted money changes gets that figure recorded
   * as its opening today -- the same fact a check-in count records -- and
   * the spread is worked out again here as it is recorded, so what lands is
   * today's answer rather than a stale preview. What the account holds is
   * untouched, so nothing needs confirming; anything the parts should not
   * count shows as extra at the next check-in.
   */
  async reshuffleAccount(accountId: Id): Promise<Reshuffle | null> {
    const plan = await this.reshufflePreview(accountId)
    if (!plan || plan.openings.length === 0) return plan
    await this.recordOpeningBalances(plan.openings)
    return plan
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
    const [accounts, packages, lineItems, changes, adjustments, cycleStarts, transferRoundUpCents] =
      await Promise.all([
        this.listReserveAccounts(),
        this.listPackages(),
        this.listLineItems(),
        this.listLineItemChanges(),
        this.driftAdjustments(),
        this.listCycleStarts(),
        this.transferRoundUpCents(),
      ])
    return {
      today: this.today(),
      accounts,
      packages,
      lineItems,
      changes,
      driftAdjustments: adjustments.accepted,
      pendingDriftAdjustments: adjustments.pending,
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
   * Rate bumps and cuts as account-level catch-up components, split into the
   * ones a human has marked done and the ones still waiting. Only `accepted`
   * moves the weekly number: an offer the user never acted on must not change
   * it in either direction. `pending` only prices what the number becomes
   * once the to-do is done (`AccountView.pendingWeekly`).
   */
  async driftAdjustments(): Promise<{ accepted: DriftAdjustment[]; pending: DriftAdjustment[] }> {
    const [issued, confirmed, ended] = await Promise.all([
      this.listIssuedInstructions(),
      this.listConfirmedInstructions(),
      this.listEndedInstructions(),
    ])
    return driftAdjustmentsFrom({ issued, confirmed, ended })
  }

  /**
   * Per account, everything still on the way that a check-in must size its
   * offer net of (D18): bumps and cuts running or waiting, and one-time
   * catch-up moves or move-outs still on the to-do list. The screen hands
   * this to the domain; it works nothing out for itself.
   */
  async openCommitmentsByAccount(): Promise<Map<Id, OpenCommitments>> {
    const [accounts, adjustments, outstanding] = await Promise.all([
      this.listReserveAccounts(),
      this.driftAdjustments(),
      this.outstandingInstructions(),
    ])
    return new Map(
      accounts.map((account) => [
        account.id,
        openCommitmentsFor({
          reserveAccountId: account.id,
          accepted: adjustments.accepted,
          pending: adjustments.pending,
          outstanding,
        }),
      ]),
    )
  }

  /** The confirmed bumps and cuts: the only ones the live figures read. */
  async acceptedDriftAdjustments(): Promise<DriftAdjustment[]> {
    return (await this.driftAdjustments()).accepted
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
    purpose?: InstructionPurpose
    availableOn?: CivilDate
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
        purpose: input.purpose ?? null,
        available_on: input.availableOn ?? null,
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

  /**
   * End an instruction early (D18). An open ask is withdrawn; a confirmed bump
   * or cut stops today, and the numbers change the moment this is recorded,
   * because changing the transfer back is something the person has already
   * done in the bank. Nothing is edited: the issued and confirmed events stay,
   * and every derivation folds this one in.
   *
   * Only an instruction this household issued can be ended. The lookup goes
   * through the household-bound read, so ending someone else's is not a
   * permission to check but a thing that cannot be said.
   */
  async endInstruction(input: { instructionId: Id }): Promise<void> {
    const [issued, ended] = await Promise.all([
      this.listIssuedInstructions(),
      this.listEndedInstructions(),
    ])
    if (!issued.some((i) => i.instructionId === input.instructionId)) {
      throw new Error('No such instruction in this household.')
    }
    if (ended.some((e) => e.instructionId === input.instructionId)) {
      throw new Error('That instruction has already been ended.')
    }
    await this.db.insert(events).values({
      householdId: this.householdId,
      kind: 'instruction_ended',
      occurredAt: this.today(),
      actorUserId: this.actorUserId,
      source: 'manual',
      payload: { instruction_id: input.instructionId },
    })
  }

  async listEndedInstructions(): Promise<EndedInstruction[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.householdId, this.householdId), eq(events.kind, 'instruction_ended')))

    return rows.map((row) => {
      const p = row.payload as { instruction_id: Id }
      return { instructionId: p.instruction_id, endedOn: row.occurredAt as CivilDate }
    })
  }

  async listIssuedInstructions(): Promise<IssuedInstruction[]> {
    // In the order recorded: two asks of the same kind issued the same day
    // are settled by which came later (D18), and that must not depend on
    // how the rows happen to come back.
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.householdId, this.householdId), eq(events.kind, 'instruction_issued')))
      .orderBy(events.recordedAt, events.id)

    return rows.map((row) => {
      const p = row.payload as {
        instruction_id: Id
        type: InstructionType
        amount_cents: Cents
        target_id: Id
        target_label: string
        note: string | null
        ends_on: CivilDate | null
        purpose?: InstructionPurpose | null
        available_on?: CivilDate | null
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
        purpose: p.purpose ?? undefined,
        availableOn: p.available_on ?? undefined,
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
    const [issued, confirmed, ended] = await Promise.all([
      this.listIssuedInstructions(),
      this.listConfirmedInstructions(),
      this.listEndedInstructions(),
    ])
    return outstandingInstructions({ issued, confirmed, ended, today: this.today() })
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
                purpose: 'cover' as const,
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
              purpose: 'share_out',
              availableOn: release.releaseOn,
              note:
                release.releaseOn === today
                  ? 'The first half of the fun money, available now.'
                  : 'The second half of the fun money, held back so it is not all spent at once.',
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
        const optimised = await this.optimiseLumpSum(share.amountCents, undefined, {
          lessPaid: debtTopUps(plan),
        })

        if (optimised.consideredDebts === 0) {
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

        // Anything the optimizer could not place -- every debt cleared, or
        // every debt left on a deal it is on track to clear -- is still the
        // household's money and must not vanish from the plan. The optimizer
        // says which, in its own words.
        if (optimised.unallocatedCents > 0) {
          instructionIds.push(
            await this.issueInstruction({
              type: 'one_time_move',
              amountCents: optimised.unallocatedCents,
              targetId: 'debt',
              targetLabel: share.label,
              purpose: 'left_over',
              note: optimised.why,
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
          purpose: 'share_out',
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
  async optimiseLumpSum(
    amountCents: Cents,
    weightOverride?: number,
    options: {
      /**
       * Payments already decided before this one, by debt id: the share-out's
       * "cover what is short" step. The optimizer sees the debts as they will
       * be after those (PRD §6, order of operations), so a cliff that step
       * covered is a deal again here and attracts nothing more.
       */
      lessPaid?: Readonly<Record<Id, Cents>>
    } = {},
  ): Promise<OptimizerResult> {
    const [debts, weight, promoLeadWeeks] = await Promise.all([
      this.listDebts(),
      weightOverride !== undefined ? Promise.resolve(weightOverride) : this.priorityWeight(),
      this.promoLeadWeeks(),
    ])
    const lessPaid = options.lessPaid ?? {}
    return optimiseLumpSum({
      debts: debts.map((d) => ({
        ...d,
        balanceCents: Math.max(0, d.balanceCents - (lessPaid[d.id] ?? 0)),
      })),
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

  // ---------------------------------------------------------------- equity (PRD §15)

  async listAssets(): Promise<Asset[]> {
    const rows = await this.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.householdId, this.householdId))
    return rows.map(toAsset)
  }

  async createAsset(input: {
    name: string
    kind: AssetKind
    valueCents: Cents
    /** Absent: the usual figure for the kind, which the form shows first. */
    sellingCostBasisPoints?: number
    valueAsOf?: CivilDate
  }): Promise<Asset> {
    const name = input.name.trim()
    if (!name) throw new EngineError('A home or vehicle needs a name')
    const sellingCostBasisPoints =
      input.sellingCostBasisPoints ?? DEFAULT_SELLING_COST_BASIS_POINTS[input.kind]
    validateAssetInputs({ valueCents: input.valueCents, sellingCostBasisPoints })

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(assetsTable)
        .values({
          householdId: this.householdId,
          name,
          kind: input.kind,
          valueCents: input.valueCents,
          valueAsOf: input.valueAsOf ?? this.today(),
          sellingCostBasisPoints,
          state: 'owned',
        })
        .returning()
      if (!row) throw new EngineError('Could not add it')
      const asset = toAsset(row)
      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'asset_added',
        occurredAt: this.today(),
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: { asset_id: asset.id, ...assetEventShape(asset) },
      })
      return asset
    })
  }

  /**
   * Correct or revalue a home or vehicle. A new value is a fresh reading, so
   * it takes today as the date it was checked; a rename does not.
   */
  async updateAsset(
    assetId: Id,
    patch: Partial<{ name: string; kind: AssetKind; valueCents: Cents; sellingCostBasisPoints: number; state: AssetState }>,
  ): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.id, assetId), eq(assetsTable.householdId, this.householdId)))
      if (!row) throw new EngineError('No such home or vehicle in this household')
      const before = toAsset(row)
      const revalued = patch.valueCents !== undefined && patch.valueCents !== before.valueCents
      const after: Asset = {
        ...before,
        ...patch,
        name: (patch.name ?? before.name).trim(),
        valueAsOf: revalued ? today : before.valueAsOf,
      }
      if (!after.name) throw new EngineError('A home or vehicle needs a name')
      validateAssetInputs(after)

      await tx
        .update(assetsTable)
        .set({
          name: after.name,
          kind: after.kind,
          valueCents: after.valueCents,
          valueAsOf: after.valueAsOf,
          sellingCostBasisPoints: after.sellingCostBasisPoints,
          state: after.state,
        })
        .where(eq(assetsTable.id, assetId))

      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'asset_changed',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: { asset_id: assetId, before: assetEventShape(before), after: assetEventShape(after) },
      })
    })
  }

  /** Remove one entered by mistake. Its debts stay, unlinked; the event keeps what it said. */
  async removeAsset(assetId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(assetsTable)
        .where(and(eq(assetsTable.id, assetId), eq(assetsTable.householdId, this.householdId)))
      if (!row) throw new EngineError('No such home or vehicle in this household')
      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'asset_removed',
        occurredAt: this.today(),
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: { asset_id: assetId, ...assetEventShape(toAsset(row)) },
      })
      await tx.delete(assetsTable).where(eq(assetsTable.id, assetId))
    })
  }

  /**
   * Say which home or vehicle a debt is secured on, or none. Both must be this
   * household's: the foreign key alone would accept another household's asset.
   */
  async linkDebtToAsset(debtId: Id, assetId: Id | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [debt] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, this.householdId)))
      if (!debt) throw new EngineError('No such debt in this household')
      if (assetId !== null) {
        const [asset] = await tx
          .select({ id: assetsTable.id })
          .from(assetsTable)
          .where(and(eq(assetsTable.id, assetId), eq(assetsTable.householdId, this.householdId)))
        if (!asset) throw new EngineError('No such home or vehicle in this household')
      }
      if ((debt.assetId ?? null) === assetId) return

      await tx.update(debtsTable).set({ assetId }).where(eq(debtsTable.id, debtId))
      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'debt_updated',
        occurredAt: this.today(),
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: { debt_id: debtId, before: { asset_id: debt.assetId ?? null }, after: { asset_id: assetId } },
      })
    })
  }

  /** The weekly average, as the scheduled fetch last stored it. */
  async marketMortgageRate(): Promise<MarketRate | null> {
    return this.getSetting<MarketRate | null>('market_mortgage_rate', null)
  }

  /** Written only by the scheduled fetch (PRD D14). */
  async recordMarketMortgageRate(rate: MarketRate): Promise<void> {
    await this.putSetting('market_mortgage_rate', rate)
  }

  async typedMortgageRate(): Promise<number | null> {
    const stored = await this.getSetting<{ rateBasisPoints: number | null } | null>('mortgage_rate_override', null)
    return stored?.rateBasisPoints ?? null
  }

  /** A lender's quote, say. Null goes back to the weekly average. */
  async setTypedMortgageRate(rateBasisPoints: number | null): Promise<void> {
    if (rateBasisPoints !== null && (!Number.isInteger(rateBasisPoints) || rateBasisPoints <= 0 || rateBasisPoints > 2500)) {
      throw new EngineError('A mortgage rate must be more than 0% and at most 25%.')
    }
    // The value column holds a fact, never SQL null: clearing is a row saying "none".
    await this.putSetting('mortgage_rate_override', { rateBasisPoints })
  }

  async homeBuyingAssumptions(): Promise<HomeBuyingAssumptions> {
    const stored = await this.getSetting<Partial<HomeBuyingAssumptions> | null>('home_buying', null)
    return { ...DEFAULT_HOME_BUYING, ...(stored ?? {}) }
  }

  async setHomeBuyingAssumptions(assumptions: HomeBuyingAssumptions): Promise<void> {
    validateHomeBuying(assumptions)
    await this.putSetting('home_buying', assumptions)
  }

  /**
   * Everything the "What could we buy?" screen shows, from the derivation
   * module. Pass a price to also get what that house would cost a month.
   */
  async nextHome(priceCents?: Cents | null): Promise<{
    today: CivilDate
    assets: Asset[]
    debts: Debt[]
    position: EquityPosition
    rate: RateInUse | null
    assumptions: HomeBuyingAssumptions
    /** What the open mortgages come to, for when no housing payment is stated. */
    mortgagePaymentsCents: Cents
    /** The payment being matched: the stated one, else the mortgages'. */
    targetPaymentCents: Cents
    mostHouse: HomeCost | null
    atPrice: HomeCost | null
  }> {
    const today = this.today()
    const [assets, debts, market, typed, assumptions] = await Promise.all([
      this.listAssets(),
      this.listDebts(),
      this.marketMortgageRate(),
      this.typedMortgageRate(),
      this.homeBuyingAssumptions(),
    ])
    const position = equityPosition(assets, debts)
    const rate = rateInUse({ typedBasisPoints: typed, market, today })
    const fromMortgages = mortgagePaymentsCents(debts)
    const target = assumptions.currentHousingPaymentCents ?? fromMortgages
    const common = { equityCents: position.countedCents, assumptions }
    return {
      today,
      assets,
      debts,
      position,
      rate,
      assumptions,
      mortgagePaymentsCents: fromMortgages,
      targetPaymentCents: target,
      mostHouse:
        rate && target > 0
          ? mostHouseForPayment({ ...common, targetMonthlyCents: target, rateBasisPoints: rate.rateBasisPoints })
          : null,
      atPrice:
        rate && priceCents != null && priceCents > 0
          ? homeCost({ ...common, priceCents, rateBasisPoints: rate.rateBasisPoints })
          : null,
    }
  }

  // ---------------------------------------------------------------- trips (PRD §16)

  async listTrips(): Promise<Trip[]> {
    const rows = await this.db
      .select()
      .from(tripsTable)
      .where(eq(tripsTable.householdId, this.householdId))
    return rows.map(toTrip).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name))
  }

  /** The household's usual figures: the defaults, with whatever it has changed laid over them. */
  async referencePrices(): Promise<ReferencePrice[]> {
    const stored = await this.getSetting<ReferencePrice[] | null>('trip_reference_prices', null)
    return mergeReferencePrices(DEFAULT_REFERENCE_PRICES, stored)
  }

  async setReferencePrices(prices: readonly ReferencePrice[]): Promise<void> {
    validateReferencePrices(prices)
    await this.putSetting('trip_reference_prices', prices)
  }

  async homeLocation(): Promise<HomeLocation | null> {
    return this.getSetting<HomeLocation | null>('home_location', null)
  }

  async setHomeLocation(home: HomeLocation): Promise<void> {
    validateHomeLocation(home)
    await this.putSetting('home_location', home)
  }

  async maxDriveMinutes(): Promise<number> {
    return this.getSetting<number>('trip_max_drive_minutes', DEFAULT_MAX_DRIVE_MINUTES)
  }

  async gasPrice(): Promise<GasPrice | null> {
    return this.getSetting<GasPrice | null>('gas_price', null)
  }

  /** The drive from this trip's home, if it has been looked up. */
  async driveEstimate(trip: Pick<Trip, 'home' | 'destination'>): Promise<DriveEstimate | null> {
    if (!homeIsLocated(trip.home)) return null
    return this.getSetting<DriveEstimate | null>(driveSettingKey(trip.home, trip.destination), null)
  }

  /**
   * A trip, every way of doing it, and what each comes to. The figures are
   * the derivation module's; the rows are facts.
   */
  async tripView(tripId: Id): Promise<TripView | null> {
    const [trip] = (await this.listTrips()).filter((t) => t.id === tripId)
    if (!trip) return null
    const [variants, referencePrices, buffer, drive, gas, maxDriveMinutes] = await Promise.all([
      this.variantsWithLines(tripId),
      this.referencePrices(),
      this.bufferCents(),
      this.driveEstimate(trip),
      this.gasPrice(),
      this.maxDriveMinutes(),
    ])
    const percent = contingencyBasisPoints(referencePrices)
    return {
      trip,
      variants: variants.map((v) => ({
        ...v,
        price: variantPrice(v.lines, percent),
        firstMoneyDue: headlineDueDate(v.lines, buffer, trip.startDate),
      })),
      referencePrices,
      bufferCents: buffer,
      drive,
      gasPrice: gas,
      maxDriveMinutes,
    }
  }

  async createTrip(input: {
    name: string
    destination?: TripDestination
    startDate: CivilDate
    endDate: CivilDate
    travelers: Traveler[]
    car: TripCar | null
  }): Promise<Trip> {
    const name = input.name.trim()
    const travelers = input.travelers.map((t) => ({ name: t.name.trim(), band: t.band }))
    validateTripInputs({ ...input, name, travelers })
    const today = this.today()
    const home = await this.homeLocation()
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(tripsTable)
        .values({
          householdId: this.householdId,
          name,
          destination: input.destination ?? 'wdw',
          startDate: input.startDate,
          endDate: input.endDate,
          travelers,
          home,
          car: input.car,
          createdAt: today,
        })
        .returning()
      if (!row) throw new EngineError('Could not start the trip')
      const trip = toTrip(row)
      await this.recordTripChange(tx, { trip_id: trip.id, before: null, after: tripEventShape(trip) })
      // The days and the first to-dos come with the trip (D22).
      await this.applyDayCut(tx, trip, false)
      await this.refreshTimeline(tx, trip)
      return trip
    })
  }

  /**
   * Change the trip's facts. Who is going and for how long decide every
   * part's quantity, so each way of doing it is rebuilt, keeping what a
   * person typed.
   */
  async updateTrip(
    tripId: Id,
    patch: Partial<{ name: string; startDate: CivilDate; endDate: CivilDate; travelers: Traveler[]; car: TripCar | null; home: HomeLocation | null }>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const before = await this.tripForWrite(tx, tripId)
      const after: Trip = {
        ...before,
        ...patch,
        name: (patch.name ?? before.name).trim(),
        travelers: (patch.travelers ?? before.travelers).map((t) => ({ name: t.name.trim(), band: t.band })),
      }
      validateTripInputs(after)
      if (after.home) validateHomeLocation(after.home)
      await tx
        .update(tripsTable)
        .set({
          name: after.name,
          startDate: after.startDate,
          endDate: after.endDate,
          travelers: after.travelers,
          car: after.car,
          home: after.home,
        })
        .where(eq(tripsTable.id, tripId))
      await this.recordTripChange(tx, { trip_id: tripId, before: tripEventShape(before), after: tripEventShape(after) })
      await this.rebuildVariants(tx, after)
      if (after.startDate !== before.startDate || after.endDate !== before.endDate) {
        await this.applyDayCut(tx, after, true)
        await this.refreshTimeline(tx, after)
      }
    })
  }

  /**
   * "Use this week" (D22): the same trip, the same length, a different
   * week. The days move with it -- a park picked for the third day is still
   * the third day -- and so does a reservation nobody has confirmed yet. One
   * with a confirmation number is a real booking on a real date and stays
   * where it is, which the screen then points out.
   */
  async shiftTrip(tripId: Id, newStartDate: CivilDate): Promise<void> {
    await this.db.transaction(async (tx) => {
      const before = await this.tripForWrite(tx, tripId)
      const offset = compareDates(newStartDate, before.startDate)
      if (offset === 0) return
      const after: Trip = { ...before, startDate: newStartDate, endDate: addDays(before.endDate, offset) }
      validateTripInputs(after)
      // Move the rows first, then the trip, so the cut finds them in place.
      // The days go out and come back with their ids, because moving them
      // one at a time would land on a date another still holds.
      const days = await this.daysOf(tx, tripId)
      await tx.delete(tripDaysTable).where(eq(tripDaysTable.tripId, tripId))
      if (days.length > 0) {
        await tx
          .insert(tripDaysTable)
          .values(days.map((d) => ({ id: d.id, tripId, date: addDays(d.date, offset), park: d.park, plan: d.plan, sort: d.sort })))
      }
      for (const r of await this.reservationsOf(tx, tripId)) {
        if (r.confirmation) continue
        await tx.update(tripReservationsTable).set({ date: addDays(r.date, offset) }).where(eq(tripReservationsTable.id, r.id))
      }
      await tx.update(tripsTable).set({ startDate: after.startDate, endDate: after.endDate }).where(eq(tripsTable.id, tripId))
      await this.recordTripChange(tx, { trip_id: tripId, before: tripEventShape(before), after: tripEventShape(after) })
      await this.rebuildVariants(tx, after)
      await this.applyDayCut(tx, after, true)
      await this.refreshTimeline(tx, after)
    })
  }

  /** Put a trip away without sending it. Its rows stay for the record. */
  async retireTrip(tripId: Id): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      const trip = await this.tripInHousehold(tx, tripId)
      if (trip.retiredAt) return
      await tx.update(tripsTable).set({ retiredAt: today }).where(eq(tripsTable.id, tripId))
      await this.recordTripChange(tx, { trip_id: tripId, before: { retired_at: null }, after: { retired_at: today } })
    })
  }

  /** A way of doing the trip, with every part it needs, priced from the usual figures. */
  async addVariant(tripId: Id, input: { name: string; choices: VariantChoices }): Promise<TripVariant> {
    const name = input.name.trim()
    if (!name) throw new EngineError('Give this way of doing it a name, like "Drive and stay at Pop".')
    const today = this.today()
    return this.db.transaction(async (tx) => {
      const trip = await this.tripForWrite(tx, tripId)
      validateChoices(input.choices, trip)
      const [row] = await tx
        .insert(tripVariantsTable)
        .values({ tripId, name, choices: input.choices, createdAt: today })
        .returning()
      if (!row) throw new EngineError('Could not add it')
      const variant = toVariant(row)
      const lines = await this.buildLines(trip, variant, [])
      await this.replaceLines(tx, variant.id, lines)
      await this.recordTripChange(tx, { trip_id: tripId, variant_id: variant.id, before: null, after: variantEventShape(variant) })
      await this.refreshTimeline(tx, trip)
      return variant
    })
  }

  async updateVariant(tripId: Id, variantId: Id, patch: Partial<{ name: string; choices: VariantChoices }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const trip = await this.tripForWrite(tx, tripId)
      const before = await this.variantInTrip(tx, tripId, variantId)
      const after: TripVariant = { ...before, ...patch, name: (patch.name ?? before.name).trim() }
      if (!after.name) throw new EngineError('Give this way of doing it a name.')
      validateChoices(after.choices, trip)
      await tx.update(tripVariantsTable).set({ name: after.name, choices: after.choices }).where(eq(tripVariantsTable.id, variantId))
      await this.recordTripChange(tx, { trip_id: tripId, variant_id: variantId, before: variantEventShape(before), after: variantEventShape(after) })
      if (patch.choices) {
        const existing = await this.linesOf(tx, variantId)
        await this.replaceLines(tx, variantId, await this.buildLines(trip, after, existing))
        await this.refreshTimeline(tx, trip)
      }
    })
  }

  async removeVariant(tripId: Id, variantId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForWrite(tx, tripId)
      const variant = await this.variantInTrip(tx, tripId, variantId)
      await this.recordTripChange(tx, { trip_id: tripId, variant_id: variantId, before: variantEventShape(variant), after: null })
      await tx.delete(tripVariantsTable).where(eq(tripVariantsTable.id, variantId))
      await this.refreshTimeline(tx, await this.tripInHousehold(tx, tripId))
    })
  }

  /** A person's own figure for a part. From here on it is typed, dated today, and no fetch touches it. */
  async updateTripLine(
    tripId: Id,
    lineId: Id,
    patch: Partial<{ label: string; quantity: number; unitAmountCents: Cents; dueDate: CivilDate; reserveAccountId: Id | null; note: string | null }>,
  ): Promise<void> {
    const today = this.today()
    await this.db.transaction(async (tx) => {
      await this.tripForWrite(tx, tripId)
      const before = await this.lineInTrip(tx, tripId, lineId)
      const figureChanged =
        (patch.unitAmountCents !== undefined && patch.unitAmountCents !== before.unitAmountCents) ||
        (patch.quantity !== undefined && patch.quantity !== before.quantity)
      // A deal's note says what it applies to, which its cap depends on, so the note is not the person's to edit there.
      const keepNote = patch.note === undefined || before.category === 'promotion'
      const after: TripLine = {
        ...before,
        ...patch,
        label: (patch.label ?? before.label).trim(),
        note: keepNote ? before.note : patch.note?.trim() || null,
        source: figureChanged ? 'typed' : before.source,
        asOf: figureChanged ? today : before.asOf,
      }
      validateLineInputs(after)
      if (after.reserveAccountId) await this.accountInHousehold(after.reserveAccountId)
      await tx
        .update(tripLinesTable)
        .set({
          label: after.label,
          quantity: after.quantity,
          unitAmountCents: after.unitAmountCents,
          dueDate: after.dueDate,
          reserveAccountId: after.reserveAccountId,
          source: after.source,
          asOf: after.asOf,
          note: after.note,
        })
        .where(eq(tripLinesTable.id, lineId))
      await this.recordTripChange(tx, {
        trip_id: tripId,
        variant_id: before.variantId,
        line_id: lineId,
        before: lineEventShape(before),
        after: lineEventShape(after),
      })
    })
  }

  /** A part the defaults did not think of. Kept through rebuilds. */
  async addTripLine(
    tripId: Id,
    variantId: Id,
    input: { category: TripLineCategory; label: string; quantity: number; unitAmountCents: Cents; dueDate: CivilDate; reserveAccountId?: Id | null; note?: string | null },
  ): Promise<TripLine> {
    const today = this.today()
    return this.db.transaction(async (tx) => {
      await this.tripForWrite(tx, tripId)
      await this.variantInTrip(tx, tripId, variantId)
      const line = { ...input, label: input.label.trim(), note: input.note?.trim() || null }
      validateLineInputs(line)
      if (line.reserveAccountId) await this.accountInHousehold(line.reserveAccountId)
      const existing = await this.linesOf(tx, variantId)
      const sort = Math.max(ADDED_LINE_SORT - 1, ...existing.map((l) => l.sort)) + 1
      const [row] = await tx
        .insert(tripLinesTable)
        .values({
          variantId,
          category: line.category,
          label: line.label,
          quantity: line.quantity,
          unitAmountCents: line.unitAmountCents,
          dueDate: line.dueDate,
          reserveAccountId: line.reserveAccountId ?? null,
          source: 'typed',
          asOf: today,
          note: line.note,
          sort,
        })
        .returning()
      if (!row) throw new EngineError('Could not add the part')
      const added = toTripLine(row)
      await this.recordTripChange(tx, { trip_id: tripId, variant_id: variantId, line_id: added.id, before: null, after: lineEventShape(added) })
      return added
    })
  }

  async removeTripLine(tripId: Id, lineId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForWrite(tx, tripId)
      const line = await this.lineInTrip(tx, tripId, lineId)
      await this.recordTripChange(tx, { trip_id: tripId, variant_id: line.variantId, line_id: lineId, before: lineEventShape(line), after: null })
      await tx.delete(tripLinesTable).where(eq(tripLinesTable.id, lineId))
    })
  }

  /**
   * Keep a looked-up drive for this trip's home, and refresh every fuel figure
   * that came from a fetch. A typed fuel figure is left alone (D20).
   */
  async recordDriveEstimate(tripId: Id, drive: DriveEstimate): Promise<void> {
    validateDriveEstimate(drive)
    const trip = (await this.listTrips()).find((t) => t.id === tripId)
    if (!trip) throw new EngineError('No such trip in this household')
    if (!trip.home) throw new EngineError('The trip needs a home to drive from. Set it under Trips.')
    if (!homeIsLocated(trip.home)) throw new EngineError('Home has not been found on the map yet, so the drive cannot be measured. Save the address again under Trips.')
    await this.putSetting(driveSettingKey(trip.home, trip.destination), drive)
    await this.refreshFetchedLines(tripId)
  }

  /** Keep this week's gas price and refresh every fetched fuel figure on every open trip. */
  async recordGasPrice(gas: GasPrice): Promise<void> {
    validateGasPrice(gas)
    await this.putSetting('gas_price', gas)
    for (const trip of await this.listTrips()) {
      if (trip.sentOn || trip.retiredAt) continue
      await this.refreshFetchedLines(trip.id)
    }
  }

  /**
   * Add to Plans (PRD §16): the one-way handoff. The way of doing it becomes a
   * package through the intake contract, exactly as the manual builder's
   * would, and the trip records which one went and when. From here on the
   * plan is the truth; the trip's figures are read-only.
   */
  async sendVariantToPlans(
    tripId: Id,
    variantId: Id,
    options: { defaultAccountId: Id },
  ): Promise<CreatePackageResult> {
    const today = this.today()
    const trip = (await this.listTrips()).find((t) => t.id === tripId)
    if (!trip) throw new EngineError('No such trip in this household')
    if (trip.packageId) throw new EngineError('This trip is a plan already.')
    const variant = (await this.variantsWithLines(tripId)).find((v) => v.id === variantId)
    if (!variant) throw new EngineError('No such way of doing it on this trip')
    await this.accountInHousehold(options.defaultAccountId)

    const intake = toIntake({
      trip,
      variant,
      lines: variant.lines,
      referencePrices: await this.referencePrices(),
      defaultAccountId: options.defaultAccountId,
      today,
    })
    // Account scope is checked inside intake (canWriteAccount for the actor),
    // so a part pointed at a spouse's account is refused with a message, not sent.
    const created = await this.createPackageFromIntake(intake)
    if (!created.ok) return created

    await this.db.transaction(async (tx) => {
      await tx
        .update(tripsTable)
        .set({ chosenVariantId: variantId, packageId: created.packageId, sentOn: today })
        .where(and(eq(tripsTable.id, tripId), eq(tripsTable.householdId, this.householdId)))
      await tx.insert(events).values({
        householdId: this.householdId,
        kind: 'trip_sent',
        occurredAt: today,
        actorUserId: this.actorUserId,
        source: 'manual',
        payload: { trip_id: tripId, variant_id: variantId, package_id: created.packageId },
      })
      // The to-dos follow the way that went to Plans.
      await this.refreshTimeline(tx, await this.tripInHousehold(tx, tripId))
    })
    return created
  }

  // ---------------------------------------------------------------- planning a trip (PRD §16 D22-D24)

  /**
   * The planning sections of the trip screen: the days, what is booked, the
   * to-dos, how the candidate weeks compare. Every figure is the derivation
   * module's; the rows are facts. A trip made before days existed gets its
   * rows here, once.
   */
  async tripPlanView(tripId: Id): Promise<TripPlanView | null> {
    const trip = (await this.listTrips()).find((t) => t.id === tripId)
    if (!trip) return null
    const days = await this.listTripDays(tripId)
    const [variants, reservations, tasks, referencePrices, drive, gas, maxDriveMinutes, blackoutDates, packTemplate, pendingPull] = await Promise.all([
      this.variantsWithLines(tripId),
      this.listReservations(tripId),
      this.listTasks(tripId),
      this.referencePrices(),
      this.driveEstimate(trip),
      this.gasPrice(),
      this.maxDriveMinutes(),
      this.blackoutDates(),
      this.packTemplate(),
      this.pendingCrowdPull(),
    ])
    const variant = planningVariant(trip, variants)
    const today = this.today()
    const [horizonMonths, weekWeights, daysOff, pendingDvcPull] = await Promise.all([this.horizonMonths(), this.weekWeights(), this.schoolDaysOff(), this.pendingDvcPull()])
    // One read of the crowd levels covers the ±3 weeks and the whole horizon the best-weeks list looks across.
    const from = addDays(trip.startDate, -7 * 3)
    const to = addDays(trip.endDate, 7 * 3)
    const horizonEnd = addDays(addMonths(today, horizonMonths), compareDates(trip.endDate, trip.startDate) + 7)
    const crowdLevels = await this.crowdLevels(trip.destination, compareDates(today, from) < 0 ? today : from, compareDates(horizonEnd, to) > 0 ? horizonEnd : to)
    const listingDates = listingWindow(trip)
    const dvcListings = listingsForTrip(await this.dvcListings(listingDates.from, listingDates.to), trip)
    const pricing = { trip, variant, lines: variant?.lines ?? [], referencePrices, drive, gasPrice: gas, maxDriveMinutes, today }
    return {
      trip,
      variant,
      days,
      dayViews: dayPlan(trip, days, reservations, crowdLevels),
      reservations,
      money: reservationMoney(reservations),
      tasks,
      weeks: weekComparison({ ...pricing, days, crowdLevels, blackoutDates }),
      crowdLevels,
      blackoutDates,
      packTemplate,
      pendingPull,
      bestWeeks: bestWeeks({ ...pricing, days, crowdLevels, daysOff, blackoutDates, horizonMonths, weights: weekWeights }),
      horizonMonths,
      weekWeights,
      dvcListings,
      pendingDvcPull,
    }
  }

  /** The top ten dates for a trip (D25): the facts gathered here, the choosing in the derivation module. */
  async bestWeeks(tripId: Id): Promise<BestWeeks> {
    const view = await this.tripPlanView(tripId)
    if (!view) throw new EngineError('No such trip in this household')
    return view.bestWeeks
  }

  /**
   * "Use these dates" (D25): a window of the trip's own length moves the
   * whole trip, days and unconfirmed reservations with it; a long weekend
   * of another length sets the first and last day, and the days are cut
   * afresh.
   */
  async useDates(tripId: Id, dates: { startDate: CivilDate; endDate: CivilDate }): Promise<void> {
    const trip = await this.tripInHousehold(this.db, tripId)
    if (compareDates(dates.endDate, dates.startDate) === compareDates(trip.endDate, trip.startDate)) {
      await this.shiftTrip(tripId, dates.startDate)
      return
    }
    await this.updateTrip(tripId, { startDate: dates.startDate, endDate: dates.endDate })
  }

  /** The trip's day rows, in date order. A trip from before they existed gets them now; nothing else changes. */
  async listTripDays(tripId: Id): Promise<TripDay[]> {
    return this.db.transaction(async (tx) => {
      const trip = await this.tripInHousehold(tx, tripId)
      const existing = await this.daysOf(tx, tripId)
      const cut = cutDays(trip, existing)
      if (cut.add.length === 0 && cut.remove.length === 0 && cut.keep.every((k) => k.day.sort === k.sort)) return existing
      await this.applyDayCut(tx, trip, false)
      return this.daysOf(tx, tripId)
    })
  }

  async updateTripDay(tripId: Id, dayId: Id, patch: Partial<{ park: TripPark; plan: Partial<TripDay['plan']> }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const before = await this.dayInTrip(tx, tripId, dayId)
      const after: TripDay = {
        ...before,
        park: patch.park ?? before.park,
        plan: { notes: (patch.plan?.notes ?? before.plan.notes).trim(), ropeDrop: patch.plan?.ropeDrop ?? before.plan.ropeDrop },
      }
      validateDayInputs(after)
      await tx.update(tripDaysTable).set({ park: after.park, plan: after.plan }).where(eq(tripDaysTable.id, dayId))
      await this.recordTripChange(tx, { trip_id: tripId, day_id: dayId, before: dayEventShape(before), after: dayEventShape(after) })
    })
  }

  async listReservations(tripId: Id): Promise<TripReservation[]> {
    await this.tripInHousehold(this.db, tripId)
    return this.reservationsOf(this.db, tripId)
  }

  async addReservation(tripId: Id, input: Omit<TripReservation, 'id' | 'tripId'>): Promise<TripReservation> {
    return this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const r = tidyReservation(input)
      validateReservationInputs(r)
      if (r.lineId) await this.lineInTrip(tx, tripId, r.lineId)
      const [row] = await tx.insert(tripReservationsTable).values({ tripId, ...r }).returning()
      if (!row) throw new EngineError('Could not add the reservation')
      const added = toReservation(row)
      await this.recordTripChange(tx, { trip_id: tripId, reservation_id: added.id, before: null, after: reservationEventShape(added) })
      return added
    })
  }

  async updateReservation(tripId: Id, reservationId: Id, patch: Partial<Omit<TripReservation, 'id' | 'tripId'>>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const before = await this.reservationInTrip(tx, tripId, reservationId)
      const after: TripReservation = { ...before, ...tidyReservation({ ...before, ...patch }) }
      validateReservationInputs(after)
      if (after.lineId) await this.lineInTrip(tx, tripId, after.lineId)
      const { id: _id, tripId: _tripId, ...columns } = after
      await tx.update(tripReservationsTable).set(columns).where(eq(tripReservationsTable.id, reservationId))
      await this.recordTripChange(tx, { trip_id: tripId, reservation_id: reservationId, before: reservationEventShape(before), after: reservationEventShape(after) })
    })
  }

  async removeReservation(tripId: Id, reservationId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const r = await this.reservationInTrip(tx, tripId, reservationId)
      await this.recordTripChange(tx, { trip_id: tripId, reservation_id: reservationId, before: reservationEventShape(r), after: null })
      await tx.delete(tripReservationsTable).where(eq(tripReservationsTable.id, reservationId))
    })
  }

  async listTasks(tripId: Id): Promise<TripTask[]> {
    await this.tripInHousehold(this.db, tripId)
    return this.tasksOf(this.db, tripId)
  }

  /** A person's own to-do. Never touched by a timeline rebuild. */
  async addTask(tripId: Id, input: { kind: TaskKind; label: string; dueOn: CivilDate; link?: string | null; lineId?: Id | null }): Promise<TripTask> {
    return this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const task = { kind: input.kind, label: input.label.trim(), dueOn: input.dueOn, link: input.link?.trim() || null, lineId: input.lineId ?? null }
      validateTaskInputs(task)
      if (task.lineId) await this.lineInTrip(tx, tripId, task.lineId)
      const existing = await this.tasksOf(tx, tripId)
      const sort = Math.max(-1, ...existing.map((t) => t.sort)) + 1
      const [row] = await tx
        .insert(tripTasksTable)
        .values({ tripId, ...task, sort, generated: false, key: null })
        .returning()
      if (!row) throw new EngineError('Could not add the to-do')
      const added = toTask(row)
      await this.recordTripChange(tx, { trip_id: tripId, task_id: added.id, before: null, after: taskEventShape(added) })
      return added
    })
  }

  /** Editing a to-do makes it the person's: the timeline stops rebuilding it. */
  async updateTask(tripId: Id, taskId: Id, patch: Partial<{ kind: TaskKind; label: string; dueOn: CivilDate; link: string | null; lineId: Id | null }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const before = await this.taskInTrip(tx, tripId, taskId)
      const after: TripTask = {
        ...before,
        kind: patch.kind ?? before.kind,
        label: (patch.label ?? before.label).trim(),
        dueOn: patch.dueOn ?? before.dueOn,
        link: patch.link === undefined ? before.link : patch.link?.trim() || null,
        lineId: patch.lineId === undefined ? before.lineId : patch.lineId,
        generated: false,
      }
      validateTaskInputs(after)
      if (after.lineId) await this.lineInTrip(tx, tripId, after.lineId)
      await tx
        .update(tripTasksTable)
        .set({ kind: after.kind, label: after.label, dueOn: after.dueOn, link: after.link, lineId: after.lineId, generated: false })
        .where(eq(tripTasksTable.id, taskId))
      await this.recordTripChange(tx, { trip_id: tripId, task_id: taskId, before: taskEventShape(before), after: taskEventShape(after) })
    })
  }

  async tickTask(tripId: Id, taskId: Id): Promise<void> {
    await this.setTaskDone(tripId, taskId, this.today())
  }

  async untickTask(tripId: Id, taskId: Id): Promise<void> {
    await this.setTaskDone(tripId, taskId, null)
  }

  async removeTask(tripId: Id, taskId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const task = await this.taskInTrip(tx, tripId, taskId)
      await this.recordTripChange(tx, { trip_id: tripId, task_id: taskId, before: taskEventShape(task), after: null })
      await tx.delete(tripTasksTable).where(eq(tripTasksTable.id, taskId))
    })
  }

  /** "Rebuild the timeline": the generated to-dos brought up to date; nothing a person edited or ticked is touched. */
  async rebuildTimeline(tripId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      const trip = await this.tripForPlanning(tx, tripId)
      await this.refreshTimeline(tx, trip)
    })
  }

  /** The next few trip to-dos across every trip not put away, soonest first, for the home screen. */
  async comingUpTripTasks(limit: number = 3): Promise<(TripTask & { tripName: string })[]> {
    const trips = (await this.listTrips()).filter((t) => !t.retiredAt)
    if (trips.length === 0) return []
    const names = new Map(trips.map((t) => [t.id, t.name]))
    const rows = await this.db
      .select({ task: tripTasksTable })
      .from(tripTasksTable)
      .innerJoin(tripsTable, eq(tripTasksTable.tripId, tripsTable.id))
      .where(and(eq(tripsTable.householdId, this.householdId), isNull(tripsTable.retiredAt), isNull(tripTasksTable.doneOn)))
    const tasks = rows.map((r) => toTask(r.task))
    return comingUpTasks(tasks, limit).map((t) => ({ ...t, tripName: names.get(t.tripId) ?? 'A trip' }))
  }

  // -- how busy (D23): reference data, household-independent, written only here

  async crowdLevels(destination: TripDestination, from: CivilDate, to: CivilDate): Promise<CrowdLevel[]> {
    const rows = await this.db
      .select()
      .from(crowdLevelsTable)
      .where(and(eq(crowdLevelsTable.destination, destination), gte(crowdLevelsTable.date, from), lte(crowdLevelsTable.date, to)))
    return rows.map(toCrowdLevel)
  }

  /**
   * Keep what a pull found, one row per date, park and source; a later pull
   * from the same source replaces its own figure for a day. Recorded in the
   * log once per pull: which source, how many days.
   */
  async recordCrowdLevels(levels: readonly ParsedCrowdLevel[], meta: { destination: TripDestination; source: string; fetchedOn: CivilDate }): Promise<number> {
    for (const l of levels) validateCrowdLevel({ ...l, source: meta.source })
    if (levels.length === 0) return 0
    await this.db.transaction(async (tx) => {
      for (const l of levels) {
        await tx
          .insert(crowdLevelsTable)
          .values({ destination: meta.destination, date: l.date, park: l.park, level: l.level, source: meta.source, fetchedOn: meta.fetchedOn })
          .onConflictDoUpdate({
            target: [crowdLevelsTable.destination, crowdLevelsTable.date, crowdLevelsTable.park, crowdLevelsTable.source],
            set: { level: l.level, fetchedOn: meta.fetchedOn },
          })
      }
      const dates = levels.map((l) => l.date).sort()
      await this.recordTripChange(tx, {
        crowd_levels: { destination: meta.destination, source: meta.source, count: levels.length, from: dates[0], to: dates[dates.length - 1], fetched_on: meta.fetchedOn },
      })
    })
    return levels.length
  }

  /** A level a person typed for a day: the truest figure there is, shown over any fetched one. */
  async typeCrowdLevel(tripId: Id, input: { date: CivilDate; park: TripPark; level: number }): Promise<void> {
    const trip = await this.tripInHousehold(this.db, tripId)
    await this.recordCrowdLevels([input], { destination: trip.destination, source: 'typed', fetchedOn: this.today() })
  }

  async pendingCrowdPull(): Promise<CrowdPull | null> {
    const stored = await this.getSetting<CrowdPull | false | null>('trip_crowd_pull', null)
    return stored && typeof stored === 'object' && Array.isArray(stored.levels) ? stored : null
  }

  /** Hold a pull for the person to look at. Nothing is a crowd level until they say so. A cleared hold is stored as false: a setting's value is never null. */
  async stashCrowdPull(pull: CrowdPull | null): Promise<void> {
    await this.putSetting('trip_crowd_pull', pull ?? false)
  }

  /** "Use these": the held pull becomes crowd levels, and the hold is cleared. */
  async keepCrowdPull(): Promise<number> {
    const pull = await this.pendingCrowdPull()
    if (!pull) throw new EngineError('There is nothing waiting to be kept.')
    const kept = await this.recordCrowdLevels(pull.levels, { destination: pull.destination, source: pull.source, fetchedOn: pull.fetchedOn })
    await this.stashCrowdPull(null)
    return kept
  }

  // -- where home is (D24), and the household's planning settings

  /**
   * Home as an address, saved with the point the geocoder found for it. A
   * lookup that failed keeps the address and no point, and the drive waits.
   * Open trips whose home has no point yet take this one, so a second try
   * that works reaches the trip started after the first that did not.
   */
  async setHomeAddress(input: { address: string; geocode: GeocodeResult | null; geocodedOn: CivilDate }): Promise<HomeLocation> {
    const address = input.address.trim()
    const home: HomeLocation = {
      label: address.split(',')[0]?.trim() || address,
      address,
      latitude: input.geocode?.latitude ?? null,
      longitude: input.geocode?.longitude ?? null,
      resolvedName: input.geocode?.resolvedName ?? null,
      geocodedOn: input.geocode ? input.geocodedOn : null,
    }
    validateHomeLocation(home)
    await this.putSetting('home_location', home)
    if (homeIsLocated(home)) {
      await this.db.transaction(async (tx) => {
        for (const trip of await this.listTrips()) {
          if (trip.packageId || trip.retiredAt || homeIsLocated(trip.home)) continue
          const after = { ...trip, home }
          await tx.update(tripsTable).set({ home }).where(eq(tripsTable.id, trip.id))
          await this.recordTripChange(tx, { trip_id: trip.id, before: tripEventShape(trip), after: tripEventShape(after) })
        }
      })
    }
    return home
  }

  async blackoutDates(): Promise<BlackoutRange[]> {
    return this.getSetting<BlackoutRange[]>('trip_blackout_dates', [])
  }

  async setBlackoutDates(ranges: readonly BlackoutRange[]): Promise<void> {
    const tidy = ranges.map((r) => ({ ...r, label: r.label.trim() }))
    validateBlackoutDates(tidy)
    await this.putSetting('trip_blackout_dates', tidy)
  }

  async packTemplate(): Promise<string[]> {
    const stored = await this.getSetting<string[] | null>('trip_pack_template', null)
    return stored ?? [...DEFAULT_PACK_TEMPLATE]
  }

  async setPackTemplate(labels: readonly string[]): Promise<void> {
    const tidy = labels.map((l) => l.trim()).filter((l) => l !== '')
    validatePackTemplate(tidy)
    await this.putSetting('trip_pack_template', tidy)
  }

  // -- the school calendar (D25): the household's own days off, and where they come from

  /** Days off school, in date order; within a range when one is given. */
  async schoolDaysOff(range?: { from: CivilDate; to: CivilDate }): Promise<SchoolDayOff[]> {
    const where = range
      ? and(eq(schoolDaysOffTable.householdId, this.householdId), gte(schoolDaysOffTable.date, range.from), lte(schoolDaysOffTable.date, range.to))
      : eq(schoolDaysOffTable.householdId, this.householdId)
    const rows = await this.db.select().from(schoolDaysOffTable).where(where)
    return rows.map(toSchoolDayOff).sort((a, b) => compareDates(a.date, b.date) || a.label.localeCompare(b.label))
  }

  /** A day off typed by hand. The same date and name again is the same fact, not a second row. */
  async addSchoolDayOff(input: { date: CivilDate; label: string; schoolYear?: string | null }): Promise<SchoolDayOff> {
    const label = input.label.trim()
    const schoolYear = input.schoolYear?.trim() || schoolYearOf(input.date)
    validateDayOff({ date: input.date, label, schoolYear })
    return this.db.transaction(async (tx) => {
      const [have] = await tx
        .select()
        .from(schoolDaysOffTable)
        .where(and(eq(schoolDaysOffTable.householdId, this.householdId), eq(schoolDaysOffTable.date, input.date), eq(schoolDaysOffTable.label, label)))
      if (have) return toSchoolDayOff(have)
      const [row] = await tx
        .insert(schoolDaysOffTable)
        .values({ householdId: this.householdId, date: input.date, label, schoolYear, source: 'typed', sourceUrl: null, recordedOn: this.today() })
        .returning()
      await this.recordSchoolCalendarChange(tx, { added: [{ date: input.date, label }], removed: [], source: 'typed', source_url: null })
      return toSchoolDayOff(row!)
    })
  }

  async removeSchoolDayOff(dayOffId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(schoolDaysOffTable)
        .where(and(eq(schoolDaysOffTable.id, dayOffId), eq(schoolDaysOffTable.householdId, this.householdId)))
        .returning()
      if (!row) throw new EngineError('No such day off in this household')
      await this.recordSchoolCalendarChange(tx, { added: [], removed: [{ date: row.date, label: row.label }], source: row.source, source_url: row.sourceUrl })
    })
  }

  /**
   * A calendar brought in whole (D25, D27): what it lists and is not here
   * yet is added; what this same source and link gave before and the
   * calendar no longer lists is taken away. Days typed by hand or from
   * another source are never touched. The same calendar again changes
   * nothing and records nothing, so an import is safe to repeat.
   */
  async importSchoolCalendar(input: { items: readonly DayOffInput[]; source: string; sourceUrl: string | null; schoolYear?: string | null }): Promise<{ added: number; removed: number }> {
    const source = input.source.trim()
    if (!source) throw new EngineError('An import needs to say where it came from.')
    const items = input.items.map((i) => ({ date: i.date, label: i.label.trim() }))
    for (const i of items) validateDayOff({ ...i, schoolYear: input.schoolYear?.trim() || schoolYearOf(i.date) })
    return this.db.transaction(async (tx) => {
      const existing = (await tx.select().from(schoolDaysOffTable).where(eq(schoolDaysOffTable.householdId, this.householdId))).map(toSchoolDayOff)
      const diff = diffDaysOff(existing, items)
      const mine = new Set(existing.filter((e) => e.source === source && (e.sourceUrl ?? null) === (input.sourceUrl ?? null)).map((e) => `${e.date}|${e.label.toLowerCase()}`))
      const remove = diff.remove.filter((r) => mine.has(`${r.date}|${r.label.toLowerCase()}`))
      if (diff.add.length === 0 && remove.length === 0) return { added: 0, removed: 0 }
      for (const d of diff.add) {
        await tx
          .insert(schoolDaysOffTable)
          .values({
            householdId: this.householdId,
            date: d.date,
            label: d.label,
            schoolYear: input.schoolYear?.trim() || schoolYearOf(d.date),
            source,
            sourceUrl: input.sourceUrl,
            recordedOn: this.today(),
          })
          .onConflictDoNothing()
      }
      for (const r of remove) {
        await tx
          .delete(schoolDaysOffTable)
          .where(and(eq(schoolDaysOffTable.householdId, this.householdId), eq(schoolDaysOffTable.date, r.date), eq(schoolDaysOffTable.label, r.label)))
      }
      await this.recordSchoolCalendarChange(tx, {
        added: diff.add,
        removed: remove.map((r) => ({ date: r.date, label: r.label })),
        source,
        source_url: input.sourceUrl,
      })
      return { added: diff.add.length, removed: remove.length }
    })
  }

  async schoolCalendarSources(): Promise<SchoolCalendarSource[]> {
    return this.getSetting<SchoolCalendarSource[]>('school_calendar_sources', [])
  }

  async setSchoolCalendarSources(sources: readonly SchoolCalendarSource[]): Promise<void> {
    const tidy = sources.map((s) => ({ label: s.label.trim(), url: s.url.trim(), kind: s.kind }))
    validateSchoolCalendarSources(tidy)
    await this.putSetting('school_calendar_sources', tidy)
  }

  async horizonMonths(): Promise<number> {
    return this.getSetting<number>('trip_horizon_months', DEFAULT_HORIZON_MONTHS)
  }

  async setHorizonMonths(months: number): Promise<void> {
    validateHorizonMonths(months)
    await this.putSetting('trip_horizon_months', months)
  }

  async weekWeights(): Promise<WeekWeights> {
    const stored = await this.getSetting<Partial<WeekWeights> | null>('trip_week_weights', null)
    return { ...DEFAULT_WEEK_WEIGHTS, ...(stored ?? {}) }
  }

  async setWeekWeights(weights: WeekWeights): Promise<void> {
    validateWeekWeights(weights)
    await this.putSetting('trip_week_weights', weights)
  }

  /**
   * "Read it" on a calendar source (D25, D27). A feed is read by the iCal
   * parser; a PDF or a page has no parser, so only the reader can read it,
   * and only when the action says so (`fallbackToReader`, set after the
   * parser path came back empty, or at once when no parser applies). What
   * was read is held for the person to look at; nothing is a day off until
   * they keep it.
   */
  async readSchoolCalendarSource(index: number, options: { fallbackToReader: boolean } & ReadDeps): Promise<ReadOutcome> {
    const sources = await this.schoolCalendarSources()
    const source = sources[index]
    if (!source) throw new EngineError('No such calendar source.')
    const notes: string[] = []
    const fetchImpl = options.fetchImpl ?? fetch
    const read = options.read ?? readStructured
    if (source.kind === 'ical') {
      try {
        const items = await fetchSchoolCalendarIcal(source.url, fetchImpl)
        if (items.length > 0) {
          await this.stashSchoolCalendar({ label: source.label, source: 'ical', sourceUrl: source.url, schoolYear: null, items, readOn: this.today(), notes: [`${source.label}: ${items.length} days read from the feed.`] })
          return { ok: true, count: items.length }
        }
        notes.push(`${source.label}: nothing in the feed read as a day off.`)
      } catch (error) {
        notes.push(`${source.label}: ${(error as Error).message}`)
      }
    } else {
      notes.push(`${source.label}: a ${source.kind === 'pdf' ? 'PDF' : 'web page'} has no fixed shape, so only the reader can read it.`)
    }
    if (!options.fallbackToReader) {
      await this.stashSchoolCalendar(null)
      return { ok: false, notes }
    }
    if (!readerEnabled(options.env)) {
      await this.stashSchoolCalendar(null)
      return { ok: false, notes: [...notes, 'Add a reader key in the environment to read PDFs and pages.'] }
    }
    const result = await read({ source: { url: source.url }, shape: 'school_calendar' }, options)
    if (!result.ok) {
      await this.stashSchoolCalendar(null)
      return { ok: false, notes: [...notes, result.reason] }
    }
    const calendar = result.value as { schoolYear: string; daysOff: DayOffInput[] }
    if (calendar.daysOff.length === 0) {
      await this.stashSchoolCalendar(null)
      return { ok: false, notes: [...notes, `The reader found no days off in ${source.label}.`] }
    }
    await this.stashSchoolCalendar({
      label: source.label,
      source: readerSourceName(result.model),
      sourceUrl: source.url,
      schoolYear: calendar.schoolYear,
      items: calendar.daysOff,
      readOn: this.today(),
      notes: [...notes, `The reader read ${calendar.daysOff.length} days off from ${source.label}.`],
    })
    return { ok: true, count: calendar.daysOff.length }
  }

  async pendingSchoolCalendar(): Promise<SchoolCalendarPending | null> {
    const stored = await this.getSetting<SchoolCalendarPending | false | null>('trip_school_calendar_read', null)
    return stored && typeof stored === 'object' && Array.isArray(stored.items) ? stored : null
  }

  /** Hold a read calendar for the person to look at. A cleared hold is stored as false: a setting's value is never null. */
  async stashSchoolCalendar(pending: SchoolCalendarPending | null): Promise<void> {
    await this.putSetting('trip_school_calendar_read', pending ?? false)
  }

  /** "Keep these": the held calendar becomes days off with its source and link, and the hold is cleared. */
  async keepSchoolCalendar(): Promise<{ added: number; removed: number }> {
    const pending = await this.pendingSchoolCalendar()
    if (!pending) throw new EngineError('There is nothing waiting to be kept.')
    const done = await this.importSchoolCalendar({ items: pending.items, source: pending.source, sourceUrl: pending.sourceUrl, schoolYear: pending.schoolYear })
    await this.stashSchoolCalendar(null)
    return done
  }

  // -- DVC listings (D26): reference data, household-independent, written only here

  async dvcListings(from: CivilDate, to: CivilDate): Promise<DvcListing[]> {
    const rows = await this.db
      .select()
      .from(dvcListingsTable)
      .where(and(gte(dvcListingsTable.checkIn, from), lte(dvcListingsTable.checkIn, to)))
    return rows.map(toDvcListing)
  }

  /**
   * Keep what a broker had, one row per source, resort, room, check-in and
   * nights; the same room seen again from the same source updates its
   * price, points and the day it was seen. Recorded in the log once per
   * pull: which source, how many rooms. Never a trip line: the lodging
   * figure stays what a person typed.
   */
  async recordDvcListings(listings: ParsedListings['listings'], meta: { source: string; sourceUrl: string; seenOn: CivilDate }): Promise<number> {
    for (const l of listings) validateDvcListing(l)
    if (listings.length === 0) return 0
    if (!meta.source.trim() || !/^https?:\/\//.test(meta.sourceUrl)) throw new EngineError('A listing needs to say where it came from.')
    await this.db.transaction(async (tx) => {
      for (const l of listings) {
        await tx
          .insert(dvcListingsTable)
          .values({ source: meta.source, resort: l.resort.trim(), room: l.room.trim(), checkIn: l.checkIn, nights: l.nights, points: l.points, priceCents: l.priceCents, sourceUrl: meta.sourceUrl, seenOn: meta.seenOn })
          .onConflictDoUpdate({
            target: [dvcListingsTable.source, dvcListingsTable.resort, dvcListingsTable.room, dvcListingsTable.checkIn, dvcListingsTable.nights],
            set: { points: l.points, priceCents: l.priceCents, sourceUrl: meta.sourceUrl, seenOn: meta.seenOn },
          })
      }
      const dates = listings.map((l) => l.checkIn).sort()
      await this.recordTripChange(tx, {
        dvc_listings: { source: meta.source, source_url: meta.sourceUrl, count: listings.length, from: dates[0], to: dates[dates.length - 1], seen_on: meta.seenOn },
      })
    })
    return listings.length
  }

  /**
   * "Check what DVC brokers have" (D26, D27): the broker sources in order
   * for the trip's dates two days either side; when every parser came back
   * empty and the action allows it, the reader reads the first source's
   * page. What came back is held for the person to look at.
   */
  async checkDvcListings(tripId: Id, options: { fallbackToReader: boolean } & ReadDeps): Promise<ReadOutcome> {
    const trip = await this.tripInHousehold(this.db, tripId)
    const window = listingWindow(trip)
    const fetchImpl = options.fetchImpl ?? fetch
    const read = options.read ?? readStructured
    const pulled = await pullDvcListings(window, fetchImpl)
    if (pulled.source && pulled.url) {
      await this.stashDvcPull({ source: pulled.source.key, label: pulled.source.label, url: pulled.url, from: window.from, to: window.to, listings: pulled.listings, seenOn: this.today(), notes: pulled.notes })
      return { ok: true, count: pulled.listings.length }
    }
    const notes = [...pulled.notes]
    if (!options.fallbackToReader) {
      await this.stashDvcPull(null)
      return { ok: false, notes }
    }
    if (!readerEnabled(options.env)) {
      await this.stashDvcPull(null)
      return { ok: false, notes: [...notes, 'Add a reader key in the environment to read pages the app cannot.'] }
    }
    const first = DVC_LISTING_SOURCES[0]!
    const url = first.url(window)
    const result = await read({ source: { url }, shape: 'dvc_listings', instruction: `Only rooms with a check-in between ${window.from} and ${window.to} matter.` }, options)
    if (!result.ok) {
      await this.stashDvcPull(null)
      return { ok: false, notes: [...notes, result.reason] }
    }
    const listings = (result.value as { listings: ParsedListings['listings'] }).listings.filter((l) => l.checkIn >= window.from && l.checkIn <= window.to)
    if (listings.length === 0) {
      await this.stashDvcPull(null)
      return { ok: false, notes: [...notes, `The reader found no rooms for those dates on ${first.label}.`] }
    }
    await this.stashDvcPull({
      source: readerSourceName(result.model),
      label: first.label,
      url,
      from: window.from,
      to: window.to,
      listings,
      seenOn: this.today(),
      notes: [...notes, `The reader read ${listings.length} rooms from ${first.label}.`],
    })
    return { ok: true, count: listings.length }
  }

  async pendingDvcPull(): Promise<DvcPull | null> {
    const stored = await this.getSetting<DvcPull | false | null>('trip_dvc_pull', null)
    return stored && typeof stored === 'object' && Array.isArray(stored.listings) ? stored : null
  }

  async stashDvcPull(pull: DvcPull | null): Promise<void> {
    await this.putSetting('trip_dvc_pull', pull ?? false)
  }

  /** "Keep these": the held listings become dated facts, and the hold is cleared. */
  async keepDvcPull(): Promise<number> {
    const pull = await this.pendingDvcPull()
    if (!pull) throw new EngineError('There is nothing waiting to be kept.')
    const kept = await this.recordDvcListings(pull.listings, { source: pull.source, sourceUrl: pull.url, seenOn: pull.seenOn })
    await this.stashDvcPull(null)
    return kept
  }

  private async recordSchoolCalendarChange(
    tx: Conn,
    payload: { added: DayOffInput[]; removed: { date: CivilDate; label: string }[]; source: string; source_url: string | null },
  ): Promise<void> {
    await tx.insert(events).values({
      householdId: this.householdId,
      kind: 'school_calendar_changed',
      occurredAt: this.today(),
      actorUserId: this.actorUserId,
      source: 'manual',
      payload,
    })
  }

  // -- planning plumbing

  /** A trip that can still be planned: not put away. A trip that is a plan is still planned -- the money is what froze. */
  private async tripForPlanning(tx: Conn, tripId: Id): Promise<Trip> {
    const trip = await this.tripInHousehold(tx, tripId)
    if (trip.retiredAt) throw new EngineError('This trip has been put away.')
    return trip
  }

  private async daysOf(tx: Conn, tripId: Id): Promise<TripDay[]> {
    const rows = await tx.select().from(tripDaysTable).where(eq(tripDaysTable.tripId, tripId))
    return rows.map(toTripDay).sort((a, b) => a.date.localeCompare(b.date))
  }

  private async reservationsOf(tx: Conn, tripId: Id): Promise<TripReservation[]> {
    const rows = await tx.select().from(tripReservationsTable).where(eq(tripReservationsTable.tripId, tripId))
    return sortReservations(rows.map(toReservation))
  }

  private async tasksOf(tx: Conn, tripId: Id): Promise<TripTask[]> {
    const rows = await tx.select().from(tripTasksTable).where(eq(tripTasksTable.tripId, tripId))
    return sortTasks(rows.map(toTask))
  }

  private async dayInTrip(tx: Conn, tripId: Id, dayId: Id): Promise<TripDay> {
    const [row] = await tx.select().from(tripDaysTable).where(and(eq(tripDaysTable.id, dayId), eq(tripDaysTable.tripId, tripId)))
    if (!row) throw new EngineError('No such day on this trip')
    return toTripDay(row)
  }

  private async reservationInTrip(tx: Conn, tripId: Id, reservationId: Id): Promise<TripReservation> {
    const [row] = await tx
      .select()
      .from(tripReservationsTable)
      .where(and(eq(tripReservationsTable.id, reservationId), eq(tripReservationsTable.tripId, tripId)))
    if (!row) throw new EngineError('No such reservation on this trip')
    return toReservation(row)
  }

  private async taskInTrip(tx: Conn, tripId: Id, taskId: Id): Promise<TripTask> {
    const [row] = await tx.select().from(tripTasksTable).where(and(eq(tripTasksTable.id, taskId), eq(tripTasksTable.tripId, tripId)))
    if (!row) throw new EngineError('No such to-do on this trip')
    return toTask(row)
  }

  private async setTaskDone(tripId: Id, taskId: Id, doneOn: CivilDate | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.tripForPlanning(tx, tripId)
      const before = await this.taskInTrip(tx, tripId, taskId)
      if (before.doneOn === doneOn) return
      const after = { ...before, doneOn }
      await tx.update(tripTasksTable).set({ doneOn }).where(eq(tripTasksTable.id, taskId))
      await this.recordTripChange(tx, { trip_id: tripId, task_id: taskId, before: taskEventShape(before), after: taskEventShape(after) })
    })
  }

  /**
   * Bring the day rows in line with the trip's dates. A person's change of
   * dates is logged with the days it added and removed; a first-time cut
   * for an old trip is not, since nobody did anything.
   */
  private async applyDayCut(tx: Conn, trip: Trip, log: boolean): Promise<void> {
    const cut = cutDays(trip, await this.daysOf(tx, trip.id))
    for (const day of cut.remove) {
      if (log) await this.recordTripChange(tx, { trip_id: trip.id, day_id: day.id, before: dayEventShape(day), after: null })
      await tx.delete(tripDaysTable).where(eq(tripDaysTable.id, day.id))
    }
    for (const k of cut.keep) {
      if (k.day.sort !== k.sort) await tx.update(tripDaysTable).set({ sort: k.sort }).where(eq(tripDaysTable.id, k.day.id))
    }
    if (cut.add.length > 0) {
      const rows = await tx
        .insert(tripDaysTable)
        .values(cut.add.map((a) => ({ tripId: trip.id, date: a.date, park: a.park, sort: a.sort })))
        .returning()
      if (log) {
        for (const row of rows) {
          const day = toTripDay(row)
          await this.recordTripChange(tx, { trip_id: trip.id, day_id: day.id, before: null, after: dayEventShape(day) })
        }
      }
    }
  }

  /** The generated to-dos, merged over what is there. Each row that changes is logged. */
  private async refreshTimeline(tx: Conn, trip: Trip): Promise<void> {
    const variants = (await tx.select().from(tripVariantsTable).where(eq(tripVariantsTable.tripId, trip.id))).map(toVariant)
    const variant = planningVariant(trip, variants)
    const lines = variant ? await this.linesOf(tx, variant.id) : []
    const generated = bookingTimeline(trip, variant, this.today(), { packTemplate: await this.packTemplate() })
    const merge = mergeTimeline(generated, await this.tasksOf(tx, trip.id))
    // A generated to-do points at the part it books or pays for, when the way has one.
    const lineFor = (category: TripLineCategory | null): Id | null => {
      if (!category) return null
      const candidates = lines.filter((l) => l.category === category)
      return (candidates.find((l) => tripLineTotalCents(l) > 0) ?? candidates[0])?.id ?? null
    }
    for (const task of merge.remove) {
      await this.recordTripChange(tx, { trip_id: trip.id, task_id: task.id, before: taskEventShape(task), after: null })
      await tx.delete(tripTasksTable).where(eq(tripTasksTable.id, task.id))
    }
    for (const { task, patch } of merge.update) {
      const after = { ...task, ...patch }
      await tx.update(tripTasksTable).set(patch).where(eq(tripTasksTable.id, task.id))
      await this.recordTripChange(tx, { trip_id: trip.id, task_id: task.id, before: taskEventShape(task), after: taskEventShape(after) })
    }
    // A to-do the timeline still owns points at the part the way now has:
    // the tickets to-do made before any way was priced finds its line.
    const wanted = new Map(generated.map((g) => [g.key, g]))
    for (const task of await this.tasksOf(tx, trip.id)) {
      if (!task.generated || task.doneOn || !task.key) continue
      const fresh = wanted.get(task.key)
      if (!fresh) continue
      const lineId = lineFor(fresh.category)
      if (lineId === task.lineId) continue
      await tx.update(tripTasksTable).set({ lineId }).where(eq(tripTasksTable.id, task.id))
      await this.recordTripChange(tx, { trip_id: trip.id, task_id: task.id, before: taskEventShape(task), after: taskEventShape({ ...task, lineId }) })
    }
    if (merge.add.length > 0) {
      const rows = await tx
        .insert(tripTasksTable)
        .values(
          merge.add.map((g, i) => ({
            tripId: trip.id,
            kind: g.kind,
            label: g.label,
            dueOn: g.dueOn,
            link: null,
            lineId: lineFor(g.category),
            sort: i,
            generated: true,
            key: g.key,
          })),
        )
        .returning()
      for (const row of rows) {
        const task = toTask(row)
        await this.recordTripChange(tx, { trip_id: trip.id, task_id: task.id, before: null, after: taskEventShape(task) })
      }
    }
  }

  // -- trip plumbing: every read is household-scoped through the trip row

  private async tripInHousehold(tx: Conn, tripId: Id): Promise<Trip> {
    const [row] = await tx
      .select()
      .from(tripsTable)
      .where(and(eq(tripsTable.id, tripId), eq(tripsTable.householdId, this.householdId)))
    if (!row) throw new EngineError('No such trip in this household')
    return toTrip(row)
  }

  /** A trip that may still change: not sent, not put away. */
  private async tripForWrite(tx: Conn, tripId: Id): Promise<Trip> {
    const trip = await this.tripInHousehold(tx, tripId)
    if (trip.packageId) throw new EngineError('This trip is a plan now. Change the plan instead.')
    if (trip.retiredAt) throw new EngineError('This trip has been put away.')
    return trip
  }

  private async variantInTrip(tx: Conn, tripId: Id, variantId: Id): Promise<TripVariant> {
    const [row] = await tx
      .select()
      .from(tripVariantsTable)
      .where(and(eq(tripVariantsTable.id, variantId), eq(tripVariantsTable.tripId, tripId)))
    if (!row) throw new EngineError('No such way of doing it on this trip')
    return toVariant(row)
  }

  private async lineInTrip(tx: Conn, tripId: Id, lineId: Id): Promise<TripLine> {
    const [row] = await tx
      .select({ line: tripLinesTable })
      .from(tripLinesTable)
      .innerJoin(tripVariantsTable, eq(tripLinesTable.variantId, tripVariantsTable.id))
      .where(and(eq(tripLinesTable.id, lineId), eq(tripVariantsTable.tripId, tripId)))
    if (!row) throw new EngineError('No such part on this trip')
    return toTripLine(row.line)
  }

  private async accountInHousehold(accountId: Id): Promise<ReserveAccount> {
    const account = (await this.listReserveAccounts()).find((a) => a.id === accountId)
    if (!account) throw new EngineError('No such reserve account in this household')
    return account
  }

  private async linesOf(tx: Conn, variantId: Id): Promise<TripLine[]> {
    const rows = await tx.select().from(tripLinesTable).where(eq(tripLinesTable.variantId, variantId))
    return rows.map(toTripLine).sort((a, b) => a.sort - b.sort)
  }

  private async variantsWithLines(tripId: Id): Promise<(TripVariant & { lines: TripLine[] })[]> {
    const variants = (await this.db.select().from(tripVariantsTable).where(eq(tripVariantsTable.tripId, tripId)))
      .map(toVariant)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
    return Promise.all(variants.map(async (v) => ({ ...v, lines: await this.linesOf(this.db, v.id) })))
  }

  /** The default parts for a way of doing it, with the person's typed figures and added parts carried over. */
  private async buildLines(trip: Trip, variant: TripVariant, existing: readonly TripLine[]): Promise<DefaultLine[]> {
    const [referencePrices, drive, gas, maxDriveMinutes] = await Promise.all([
      this.referencePrices(),
      this.driveEstimate(trip),
      this.gasPrice(),
      this.maxDriveMinutes(),
    ])
    const fresh = defaultLines(trip, variant, { referencePrices, drive, gasPrice: gas, maxDriveMinutes, today: this.today() })
    // Default parts carry their typed figures over by name; added parts come along as they are.
    const kept = keepTypedLines(
      existing.filter((l) => l.sort < ADDED_LINE_SORT),
      fresh,
    )
    const added = existing.filter((l) => l.sort >= ADDED_LINE_SORT)
    return [...kept, ...added]
  }

  /**
   * Make the variant's rows match the rebuilt parts. A part that is still
   * there (same category and name) keeps its row and its id, so a
   * reservation or to-do counted against it still points at it after the
   * choices change or a fetch refreshes a figure; parts that went are
   * deleted, new ones inserted.
   */
  private async replaceLines(tx: Conn, variantId: Id, lines: readonly DefaultLine[]): Promise<void> {
    const existing = await this.linesOf(tx, variantId)
    const pool = new Map<string, TripLine[]>()
    for (const l of existing) {
      const key = `${l.category}|${l.label}`
      pool.set(key, [...(pool.get(key) ?? []), l])
    }
    const values = (l: DefaultLine) => ({
      category: l.category,
      label: l.label,
      quantity: l.quantity,
      unitAmountCents: l.unitAmountCents,
      dueDate: l.dueDate,
      reserveAccountId: l.reserveAccountId,
      source: l.source,
      asOf: l.asOf,
      note: l.note,
      sort: l.sort,
    })
    const inserts: (ReturnType<typeof values> & { variantId: Id })[] = []
    for (const l of lines) {
      const match = pool.get(`${l.category}|${l.label}`)?.shift()
      if (match) await tx.update(tripLinesTable).set(values(l)).where(eq(tripLinesTable.id, match.id))
      else inserts.push({ variantId, ...values(l) })
    }
    for (const leftover of pool.values()) {
      for (const l of leftover) await tx.delete(tripLinesTable).where(eq(tripLinesTable.id, l.id))
    }
    if (inserts.length > 0) await tx.insert(tripLinesTable).values(inserts)
  }

  private async rebuildVariants(tx: Conn, trip: Trip): Promise<void> {
    const variants = (await tx.select().from(tripVariantsTable).where(eq(tripVariantsTable.tripId, trip.id))).map(toVariant)
    for (const variant of variants) {
      const existing = await this.linesOf(tx, variant.id)
      await this.replaceLines(tx, variant.id, await this.buildLines(trip, variant, existing))
    }
  }

  /**
   * After a fetch: every way that drives is rebuilt, so a fuel figure that
   * came from a fetch takes the new one and a long drive gains its hotel on
   * the way. A typed fuel figure survives the rebuild untouched (D20). The
   * fuel figure's before and after is kept, as any other change is.
   */
  private async refreshFetchedLines(tripId: Id): Promise<void> {
    await this.db.transaction(async (tx) => {
      const trip = await this.tripInHousehold(tx, tripId)
      if (trip.packageId || trip.retiredAt) return
      const variants = (await tx.select().from(tripVariantsTable).where(eq(tripVariantsTable.tripId, tripId))).map(toVariant)
      for (const variant of variants) {
        if (variant.choices.travel !== 'drive') continue
        const existing = await this.linesOf(tx, variant.id)
        await this.replaceLines(tx, variant.id, await this.buildLines(trip, variant, existing))
        const before = existing.find((l) => l.source === 'fetched') ?? null
        const after = (await this.linesOf(tx, variant.id)).find((l) => l.source === 'fetched') ?? null
        if (after && after.unitAmountCents !== before?.unitAmountCents) {
          await this.recordTripChange(tx, {
            trip_id: tripId,
            variant_id: variant.id,
            line_id: after.id,
            before: before ? lineEventShape(before) : null,
            after: lineEventShape(after),
          })
        }
      }
    })
  }

  private async recordTripChange(tx: Conn, payload: Record<string, unknown>): Promise<void> {
    await tx.insert(events).values({
      householdId: this.householdId,
      kind: 'trip_changed',
      occurredAt: this.today(),
      actorUserId: this.actorUserId,
      source: 'manual',
      payload,
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
    assetId: r.assetId,
  }
}

function toAsset(r: typeof assetsTable.$inferSelect): Asset {
  return {
    id: r.id,
    householdId: r.householdId,
    name: r.name,
    kind: r.kind,
    valueCents: r.valueCents,
    valueAsOf: r.valueAsOf as CivilDate,
    sellingCostBasisPoints: r.sellingCostBasisPoints,
    state: r.state,
  }
}

function toTrip(r: typeof tripsTable.$inferSelect): Trip {
  return {
    id: r.id,
    householdId: r.householdId,
    name: r.name,
    destination: r.destination as TripDestination,
    startDate: r.startDate as CivilDate,
    endDate: r.endDate as CivilDate,
    travelers: (r.travelers as Traveler[]) ?? [],
    home: (r.home as HomeLocation | null) ?? null,
    car: (r.car as TripCar | null) ?? null,
    chosenVariantId: r.chosenVariantId,
    packageId: r.packageId,
    sentOn: (r.sentOn as CivilDate | null) ?? null,
    createdAt: r.createdAt as CivilDate,
    retiredAt: (r.retiredAt as CivilDate | null) ?? null,
  }
}

function toVariant(r: typeof tripVariantsTable.$inferSelect): TripVariant {
  return {
    id: r.id,
    tripId: r.tripId,
    name: r.name,
    choices: r.choices as VariantChoices,
    createdAt: r.createdAt as CivilDate,
  }
}

function toTripLine(r: typeof tripLinesTable.$inferSelect): TripLine {
  return {
    id: r.id,
    variantId: r.variantId,
    category: r.category,
    label: r.label,
    quantity: r.quantity,
    unitAmountCents: r.unitAmountCents,
    dueDate: r.dueDate as CivilDate,
    reserveAccountId: r.reserveAccountId,
    source: r.source,
    asOf: r.asOf as CivilDate,
    note: r.note,
    sort: r.sort,
  }
}

/** The way the plan follows: the one that went to Plans, else the first priced. */
function planningVariant<V extends TripVariant>(trip: Trip, variants: readonly V[]): V | null {
  return variants.find((v) => v.id === trip.chosenVariantId) ?? variants[0] ?? null
}

function tidyReservation(r: Omit<TripReservation, 'id' | 'tripId'>): Omit<TripReservation, 'id' | 'tripId'> {
  return {
    date: r.date,
    time: r.time?.trim() || null,
    kind: r.kind,
    name: r.name.trim(),
    park: r.park ?? null,
    confirmation: r.confirmation?.trim() || null,
    party: r.party,
    perPersonCents: r.perPersonCents ?? null,
    lineId: r.lineId ?? null,
    note: r.note?.trim() || null,
  }
}

function toTripDay(r: typeof tripDaysTable.$inferSelect): TripDay {
  const plan = (r.plan as Partial<TripDay['plan']> | null) ?? {}
  return {
    id: r.id,
    tripId: r.tripId,
    date: r.date as CivilDate,
    park: r.park,
    plan: { notes: typeof plan.notes === 'string' ? plan.notes : '', ropeDrop: plan.ropeDrop === true },
    sort: r.sort,
  }
}

function toReservation(r: typeof tripReservationsTable.$inferSelect): TripReservation {
  return {
    id: r.id,
    tripId: r.tripId,
    date: r.date as CivilDate,
    time: r.time,
    kind: r.kind,
    name: r.name,
    park: r.park,
    confirmation: r.confirmation,
    party: r.party,
    perPersonCents: r.perPersonCents,
    lineId: r.lineId,
    note: r.note,
  }
}

function toTask(r: typeof tripTasksTable.$inferSelect): TripTask {
  return {
    id: r.id,
    tripId: r.tripId,
    kind: r.kind,
    label: r.label,
    dueOn: r.dueOn as CivilDate,
    doneOn: (r.doneOn as CivilDate | null) ?? null,
    link: r.link,
    lineId: r.lineId,
    sort: r.sort,
    generated: r.generated,
    key: r.key,
  }
}

function toSchoolDayOff(r: typeof schoolDaysOffTable.$inferSelect): SchoolDayOff {
  return {
    id: r.id,
    householdId: r.householdId,
    date: r.date as CivilDate,
    label: r.label,
    schoolYear: r.schoolYear,
    source: r.source,
    sourceUrl: r.sourceUrl,
    recordedOn: r.recordedOn as CivilDate,
  }
}

function toDvcListing(r: typeof dvcListingsTable.$inferSelect): DvcListing {
  return {
    resort: r.resort,
    room: r.room,
    checkIn: r.checkIn as CivilDate,
    nights: r.nights,
    points: r.points,
    priceCents: r.priceCents,
    sourceUrl: r.sourceUrl,
    source: r.source,
    seenOn: r.seenOn as CivilDate,
  }
}

function toCrowdLevel(r: typeof crowdLevelsTable.$inferSelect): CrowdLevel {
  return {
    destination: r.destination as TripDestination,
    date: r.date as CivilDate,
    park: r.park,
    level: r.level,
    source: r.source,
    fetchedOn: r.fetchedOn as CivilDate,
  }
}

function dayEventShape(d: TripDay) {
  return { date: d.date, park: d.park, plan: d.plan }
}

function reservationEventShape(r: TripReservation) {
  return {
    date: r.date,
    time: r.time,
    kind: r.kind,
    name: r.name,
    park: r.park,
    confirmation: r.confirmation,
    party: r.party,
    per_person_cents: r.perPersonCents,
    line_id: r.lineId,
    note: r.note,
  }
}

function taskEventShape(t: TripTask) {
  return { kind: t.kind, label: t.label, due_on: t.dueOn, done_on: t.doneOn, link: t.link, line_id: t.lineId, generated: t.generated, key: t.key }
}

function tripEventShape(t: Trip) {
  return {
    name: t.name,
    destination: t.destination,
    start_date: t.startDate,
    end_date: t.endDate,
    travelers: t.travelers,
    home: t.home,
    car: t.car,
  }
}

function variantEventShape(v: TripVariant) {
  return { name: v.name, choices: v.choices }
}

function lineEventShape(l: TripLine) {
  return {
    category: l.category,
    label: l.label,
    quantity: l.quantity,
    unit_amount_cents: l.unitAmountCents,
    due_date: l.dueDate,
    reserve_account_id: l.reserveAccountId,
    source: l.source,
    as_of: l.asOf,
    note: l.note,
  }
}

function assetEventShape(a: Asset) {
  return {
    name: a.name,
    kind: a.kind,
    value_cents: a.valueCents,
    value_as_of: a.valueAsOf,
    selling_cost_basis_points: a.sellingCostBasisPoints,
    state: a.state,
  }
}

/** The share-out's first step, as the debt step must see it: what is already going at each debt. */
export function debtTopUps(plan: AllocationPlan): Record<Id, Cents> {
  const paid: Record<Id, Cents> = {}
  for (const t of plan.topUps) {
    if (t.kind !== 'debt') continue
    paid[t.targetId] = (paid[t.targetId] ?? 0) + t.amountCents
  }
  return paid
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
