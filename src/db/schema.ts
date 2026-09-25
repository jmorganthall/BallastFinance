/**
 * Database schema (PRD §3).
 *
 * Six stored objects plus household/user plumbing. Only human assertions live
 * here: what was planned, what was confirmed, what the rules are. Every derived
 * figure -- accrual components, weekly rates, should-have-saved curves, drift,
 * priority scores, ladders, allocations, projections -- is computed on read by
 * the derivation module and is deliberately absent from this file (D9).
 *
 * Money is integer cents throughout (PRD §10). Dates that a human reasons about
 * as calendar dates (due dates, as-of dates) are `date` columns read as strings,
 * never timestamps, so no timezone can shift them.
 */

import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/** Integer cents. Signed, because reductions and refunds are legal. */
const cents = (name: string) => bigint(name, { mode: 'number' })

export const packageStateEnum = pgEnum('package_state', ['simulated', 'active', 'retired'])
export const lineItemStateEnum = pgEnum('line_item_state', [
  'planned',
  'accruing',
  'due',
  'retired',
])
/**
 * Who may write to a reserve account. Reads are unrestricted within the
 * household either way (PRD §2): this is ownership, not secrecy.
 */
export const accountScopeEnum = pgEnum('account_scope', ['household', 'individual'])

/**
 * How often a line item comes round again, as an interval: `recur_every` of
 * `recur_unit`. Both null is a one-off. A recurring item rolls its due date
 * forward in place when confirmed spent, rather than retiring (PRD D8).
 *
 * An interval rather than a fixed menu, because a bill every 3 weeks or an
 * inspection every 2 years is as ordinary as an annual one.
 */
export const recurrenceUnitEnum = pgEnum('recurrence_unit', ['day', 'week', 'month', 'year'])

export const debtCategoryEnum = pgEnum('debt_category', ['consumer', 'auto', 'mortgage'])
export const debtStateEnum = pgEnum('debt_state', ['open', 'paid_off'])
export const assetKindEnum = pgEnum('asset_kind', ['home', 'vehicle'])
export const assetStateEnum = pgEnum('asset_state', ['owned', 'sold'])

/** The closed set of event kinds (PRD §3). Growing it is a deliberate change. */
export const eventKindEnum = pgEnum('event_kind', [
  'package_committed',
  'line_item_changed',
  'balance_confirmed',
  'spend_confirmed',
  'payment_confirmed',
  'debt_balance_updated',
  'allocation_entered',
  'instruction_issued',
  'instruction_confirmed',
  // Editing (migration 0004). Each is the audit trail for a row change that
  // the accrual math or a person may later need to explain.
  'line_item_added',
  'line_item_retired',
  'package_retired',
  'debt_updated',
  'debt_removed',
  /** A check-in counted money already in the account toward its plans (PRD §5). */
  'opening_recorded',
  /**
   * A finished plan taken off the books for good (migration 0008). The row
   * goes; this event keeps what it was, so the log still explains the
   * money that went through it.
   */
  'package_deleted',
  // Equity (migration 0009, PRD §15). A value is a dated fact a person read
  // off Zillow or KBB, so every change to one is kept.
  'asset_added',
  'asset_changed',
  'asset_removed',
  /**
   * A person ended an instruction early (PRD D18, rev 28; migration 0010):
   * withdrew an open ask, or stopped a running bump or cut that day. The
   * issued and confirmed events stay as they were; this one closes the
   * window, and everything derived reads the earlier end.
   */
  'instruction_ended',
  // The trip planner (migration 0011, PRD §16). Every figure on a trip is a
  // stated fact, so every change to one is kept; the send records which way
  // of doing it became the plan.
  'trip_changed',
  'trip_sent',
  /**
   * The household's school calendar changed (migration 0013, PRD §16 D25):
   * days off typed, removed, or imported from a feed, a PDF or a page. The
   * payload says what was added and removed and where it came from.
   */
  'school_calendar_changed',
])

export const tripLineCategoryEnum = pgEnum('trip_line_category', [
  'travel',
  'lodging',
  'tickets',
  'lightning_lane',
  'dining',
  'photos',
  'souvenirs',
  'promotion',
  'contingency',
])
/** Where a trip figure came from: a person, a quote they read, or one of the two fetches (PRD D20). */
export const tripLineSourceEnum = pgEnum('trip_line_source', ['typed', 'quote', 'fetched'])

// Planning a trip (migration 0012, PRD §16 D22-D23). What a day is for, what
// kind of booking a reservation is, what kind of to-do a task is.
export const tripParkEnum = pgEnum('trip_park', [
  'magic_kingdom',
  'epcot',
  'hollywood_studios',
  'animal_kingdom',
  'water_park',
  'other',
  'rest',
  'travel',
])
export const tripReservationKindEnum = pgEnum('trip_reservation_kind', [
  'dining',
  'lightning_lane',
  'experience',
  'flight',
  'lodging',
  'transport',
  'other',
])
export const tripTaskKindEnum = pgEnum('trip_task_kind', ['book', 'pay', 'buy', 'pack', 'do'])

/**
 * How the system learned an actual (commercial-path seam 2). Manual entry is
 * v1's only implementation; a feed becomes a second one when ingestion arrives,
 * without changing how a confirmation is recorded.
 */
export const confirmationSourceEnum = pgEnum('confirmation_source', ['manual', 'feed'])

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/Chicago'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Identity lives in the IdP; this table caches what the UI needs and nothing
 * more. A user is keyed by (issuer, subject) from the ID token, so swapping or
 * adding a provider never touches tenancy (PRD §2).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_issuer_subject_idx').on(t.issuer, t.subject)],
)

/** Household membership is an app-domain table, never an IdP concept (PRD §2). */
export const householdMembers = pgTable(
  'household_members',
  {
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // No roles in v1; the column is reserved so adding them is not a migration
    // of every membership row.
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('household_members_pk').on(t.householdId, t.userId)],
)

/** Signup allowlist (PRD §2): only these emails can create a session in v1. */
export const allowedEmails = pgTable('allowed_emails', {
  email: text('email').primaryKey(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => households.id, { onDelete: 'cascade' }),
})

export const reserveAccounts = pgTable(
  'reserve_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    institutionLabel: text('institution_label').notNull(),
    scope: accountScopeEnum('scope').notNull().default('household'),
    /** Set only for an individual account; that user alone may write to it. */
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reserve_accounts_household_idx').on(t.householdId),
    uniqueIndex('reserve_accounts_name_idx').on(t.householdId, t.name),
    // An individual account without an owner has nobody who can write to it;
    // a household account with one implies a restriction that is not enforced.
    // Both are silently wrong, so the database refuses them.
    check(
      'reserve_accounts_owner_matches_scope',
      sql`(${t.scope} = 'individual') = (${t.ownerUserId} is not null)`,
    ),
  ],
)

export const packages = pgTable(
  'packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    state: packageStateEnum('state').notNull().default('simulated'),
    /** Which planner emitted this package. "manual" is v1's only producer. */
    module: text('module').notNull().default('manual'),
    /** Module-owned richness. The core engine never reads this. */
    detail: jsonb('detail'),
    createdAt: date('created_at').notNull(),
    /** Null until committed. The start of every base accrual component. */
    committedAt: date('committed_at'),
  },
  (t) => [index('packages_household_idx').on(t.householdId, t.state)],
)

export const lineItems = pgTable(
  'line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    unitAmountCents: cents('unit_amount_cents').notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(1),
    dueDate: date('due_date').notNull(),
    reserveAccountId: uuid('reserve_account_id')
      .notNull()
      .references(() => reserveAccounts.id, { onDelete: 'restrict' }),
    state: lineItemStateEnum('state').notNull().default('planned'),
    recurEvery: integer('recur_every'),
    recurUnit: recurrenceUnitEnum('recur_unit'),
  },
  (t) => [
    index('line_items_package_idx').on(t.packageId),
    // An interval is both halves or neither. Half of one -- a number with no
    // unit -- has no meaning, and the roll-forward would silently do nothing.
    check(
      'line_items_recurrence_is_whole',
      sql`(${t.recurEvery} is null) = (${t.recurUnit} is null)`,
    ),
    index('line_items_account_idx').on(t.householdId, t.reserveAccountId, t.state),
  ],
)

/**
 * A home or vehicle the household owns (PRD §15, object #9). Its value is a
 * stated fact with the date it was checked, never fetched: nothing here
 * pretends to know what a house is worth.
 */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: assetKindEnum('kind').notNull(),
    valueCents: cents('value_cents').notNull(),
    valueAsOf: date('value_as_of').notNull(),
    /** What selling takes off the top, basis points: 700 = 7%. */
    sellingCostBasisPoints: integer('selling_cost_basis_points').notNull(),
    state: assetStateEnum('state').notNull().default('owned'),
  },
  (t) => [
    index('assets_household_idx').on(t.householdId, t.state),
    check('assets_value_not_negative', sql`${t.valueCents} >= 0`),
    check(
      'assets_selling_cost_in_range',
      sql`${t.sellingCostBasisPoints} between 0 and 5000`,
    ),
  ],
)

export const debts = pgTable(
  'debts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: debtCategoryEnum('category').notNull(),
    balanceCents: cents('balance_cents').notNull(),
    balanceAsOf: date('balance_as_of').notNull(),
    /** Annual percentage rate in basis points: 2499 = 24.99%. Integers, no float drift. */
    aprBasisPoints: bigint('apr_basis_points', { mode: 'number' }).notNull(),
    /** [{rate_basis_points, applies_to: 'full'|'amount', amount_cents?, until_date}] */
    promoRules: jsonb('promo_rules').notNull().default(sql`'[]'::jsonb`),
    /** {type: 'fixed'|'percent'|'percent_with_floor', value, floor_cents?} */
    minPaymentRule: jsonb('min_payment_rule').notNull(),
    creditLimitCents: cents('credit_limit_cents'),
    /**
     * What the household actually pays each month, when that is more than
     * the card's minimum. Null means "just the minimum". A stored fact about
     * the household, not the lender: it is what decides whether a deal-rate
     * balance is on track to clear before its rate ends.
     */
    plannedPaymentCents: cents('planned_payment_cents'),
    fixedPayment: boolean('fixed_payment').notNull().default(false),
    state: debtStateEnum('state').notNull().default('open'),
    /** The home or vehicle this debt is secured on (PRD §15). Removing the asset unlinks it. */
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
  },
  (t) => [index('debts_household_idx').on(t.householdId, t.state)],
)

/**
 * A trip the household is pricing (PRD §16, D19): a planner module's own
 * object, not core. It holds who is going and when; each way of doing it is a
 * trip_variants row with its parts in trip_lines. Once a way is sent to Plans
 * the package is the truth and the trip only records which one went, when.
 */
export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    destination: text('destination').notNull().default('wdw'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /** [{name, band: 'adult'|'child'|'infant'}] */
    travelers: jsonb('travelers').notNull().default(sql`'[]'::jsonb`),
    /** {label, latitude, longitude}: copied from the household setting when the trip is made. */
    home: jsonb('home'),
    /** {mpg, seats} */
    car: jsonb('car'),
    /** The way of doing it that became the plan. No foreign key: the variant table points here. */
    chosenVariantId: uuid('chosen_variant_id'),
    packageId: uuid('package_id').references(() => packages.id, { onDelete: 'set null' }),
    sentOn: date('sent_on'),
    createdAt: date('created_at').notNull(),
    retiredAt: date('retired_at'),
  },
  (t) => [
    index('trips_household_idx').on(t.householdId),
    check('trips_dates_in_order', sql`${t.endDate} >= ${t.startDate}`),
  ],
)

export const tripVariants = pgTable(
  'trip_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** {travel, lodging, lightningLane, dining, parkDays, promotion?} */
    choices: jsonb('choices').notNull(),
    createdAt: date('created_at').notNull(),
  },
  (t) => [index('trip_variants_trip_idx').on(t.tripId)],
)

/**
 * One part of one way of doing the trip: a stated figure with its date and
 * where it came from. Quantity x figure is computed on read, never stored.
 */
export const tripLines = pgTable(
  'trip_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => tripVariants.id, { onDelete: 'cascade' }),
    category: tripLineCategoryEnum('category').notNull(),
    label: text('label').notNull(),
    quantity: integer('quantity').notNull().default(1),
    /** Negative only for a deal. */
    unitAmountCents: cents('unit_amount_cents').notNull(),
    dueDate: date('due_date').notNull(),
    reserveAccountId: uuid('reserve_account_id').references(() => reserveAccounts.id, { onDelete: 'set null' }),
    source: tripLineSourceEnum('source').notNull().default('typed'),
    asOf: date('as_of').notNull(),
    note: text('note'),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [
    index('trip_lines_variant_idx').on(t.variantId),
    check('trip_lines_quantity_not_negative', sql`${t.quantity} >= 0`),
    check(
      'trip_lines_sign_matches_category',
      sql`(${t.category} = 'promotion' and ${t.unitAmountCents} <= 0) or (${t.category} <> 'promotion' and ${t.unitAmountCents} >= 0)`,
    ),
  ],
)

/**
 * One date of a trip (PRD §16 D22): which park, or a rest or travel day, and
 * the day's notes. One row per date from the first day to the last, cut
 * again when the dates change. The planning tables are the module's own
 * facts; the core never reads them and the weekly math never sees them.
 */
export const tripDays = pgTable(
  'trip_days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    park: tripParkEnum('park').notNull().default('rest'),
    /** {notes, ropeDrop} */
    plan: jsonb('plan').notNull().default(sql`'{"notes":"","ropeDrop":false}'::jsonb`),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('trip_days_trip_date_idx').on(t.tripId, t.date)],
)

/**
 * Something booked for the trip, with its confirmation (D22). A cost per
 * person is a fact; what it comes to is computed, and when it points at a
 * part of the trip it is already counted there, never added twice.
 */
export const tripReservations = pgTable(
  'trip_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    /** "HH:MM", or null for an all-day booking. */
    time: text('time'),
    kind: tripReservationKindEnum('kind').notNull(),
    name: text('name').notNull(),
    park: tripParkEnum('park'),
    confirmation: text('confirmation'),
    party: integer('party').notNull().default(1),
    perPersonCents: cents('per_person_cents'),
    lineId: uuid('line_id').references(() => tripLines.id, { onDelete: 'set null' }),
    note: text('note'),
  },
  (t) => [
    index('trip_reservations_trip_idx').on(t.tripId, t.date),
    check('trip_reservations_party_not_negative', sql`${t.party} >= 0`),
    check('trip_reservations_cost_not_negative', sql`${t.perPersonCents} is null or ${t.perPersonCents} >= 0`),
  ],
)

/**
 * A to-do on the way to the trip (D22): what to book, pay, buy, pack or do,
 * and when. The timeline generates most of them, with a stable key so a
 * rebuild finds its own rows; a person's edit makes one theirs (generated
 * false) and the timeline leaves it alone from then on.
 */
export const tripTasks = pgTable(
  'trip_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    kind: tripTaskKindEnum('kind').notNull().default('do'),
    label: text('label').notNull(),
    dueOn: date('due_on').notNull(),
    doneOn: date('done_on'),
    link: text('link'),
    lineId: uuid('line_id').references(() => tripLines.id, { onDelete: 'set null' }),
    sort: integer('sort').notNull().default(0),
    generated: boolean('generated').notNull().default(false),
    key: text('key'),
  },
  (t) => [index('trip_tasks_trip_idx').on(t.tripId, t.dueOn)],
)

/**
 * How busy a park is on a date, 1 quiet to 10 packed (D23): a fetched fact
 * with its source and the day it was fetched, or one a person typed.
 * Reference data shared across households, still written only through the
 * engine.
 */
export const crowdLevels = pgTable(
  'crowd_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    destination: text('destination').notNull().default('wdw'),
    date: date('date').notNull(),
    park: tripParkEnum('park').notNull(),
    level: integer('level').notNull(),
    source: text('source').notNull(),
    fetchedOn: date('fetched_on').notNull(),
  },
  (t) => [
    uniqueIndex('crowd_levels_key_idx').on(t.destination, t.date, t.park, t.source),
    check('crowd_levels_level_range', sql`${t.level} between 1 and 10`),
  ],
)

/**
 * A day students do not attend school (D25): the household's own fact, with
 * where it came from -- typed, an iCal feed, or the reader ("read:<model>")
 * -- and a school-year label. Long weekends and school days missed are
 * computed from these; nothing derived is stored.
 */
export const schoolDaysOff = pgTable(
  'school_days_off',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    label: text('label').notNull(),
    schoolYear: text('school_year').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    recordedOn: date('recorded_on').notNull(),
  },
  (t) => [uniqueIndex('school_days_off_key_idx').on(t.householdId, t.date, t.label)],
)

/**
 * A DVC room a broker had on a date (D26): resort, room, check-in, nights,
 * points and price, as their public page listed it, with the source and the
 * day it was read. Reference data shared across households like crowd
 * levels, still written only through the engine; shown beside the lodging
 * line, never the line itself, and never used in money math.
 */
export const dvcListings = pgTable(
  'dvc_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    resort: text('resort').notNull(),
    room: text('room').notNull(),
    checkIn: date('check_in').notNull(),
    nights: integer('nights').notNull(),
    points: integer('points'),
    priceCents: cents('price_cents'),
    sourceUrl: text('source_url').notNull(),
    seenOn: date('seen_on').notNull(),
  },
  (t) => [
    uniqueIndex('dvc_listings_key_idx').on(t.source, t.resort, t.room, t.checkIn, t.nights),
    check('dvc_listings_nights_range', sql`${t.nights} between 1 and 60`),
    check('dvc_listings_price_not_negative', sql`${t.priceCents} is null or ${t.priceCents} >= 0`),
  ],
)

/**
 * The append-only event log (PRD §3). Current state is a fold over these, and
 * the audit trail is free. Append-only is enforced at the database role as well
 * as in code (PRD §10) -- see the migration that revokes UPDATE and DELETE.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    kind: eventKindEnum('kind').notNull(),
    occurredAt: date('occurred_at').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** How this actual reached the system. v1 only ever writes 'manual'. */
    source: confirmationSourceEnum('source').notNull().default('manual'),
    payload: jsonb('payload').notNull(),
  },
  (t) => [
    index('events_household_kind_idx').on(t.householdId, t.kind, t.occurredAt),
    index('events_occurred_idx').on(t.householdId, t.occurredAt),
  ],
)

/** The family's rules, versioned by effective_from so history stays readable. */
export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    effectiveFrom: date('effective_from').notNull(),
  },
  (t) => [uniqueIndex('settings_key_idx').on(t.householdId, t.key, t.effectiveFrom)],
)

export const householdsRelations = relations(households, ({ many }) => ({
  members: many(householdMembers),
  reserveAccounts: many(reserveAccounts),
  packages: many(packages),
  debts: many(debts),
  assets: many(assets),
  trips: many(trips),
}))

export const tripsRelations = relations(trips, ({ one, many }) => ({
  household: one(households, { fields: [trips.householdId], references: [households.id] }),
  variants: many(tripVariants),
  days: many(tripDays),
  reservations: many(tripReservations),
  tasks: many(tripTasks),
}))

export const tripDaysRelations = relations(tripDays, ({ one }) => ({
  trip: one(trips, { fields: [tripDays.tripId], references: [trips.id] }),
}))

export const tripReservationsRelations = relations(tripReservations, ({ one }) => ({
  trip: one(trips, { fields: [tripReservations.tripId], references: [trips.id] }),
  line: one(tripLines, { fields: [tripReservations.lineId], references: [tripLines.id] }),
}))

export const tripTasksRelations = relations(tripTasks, ({ one }) => ({
  trip: one(trips, { fields: [tripTasks.tripId], references: [trips.id] }),
  line: one(tripLines, { fields: [tripTasks.lineId], references: [tripLines.id] }),
}))

export const tripVariantsRelations = relations(tripVariants, ({ one, many }) => ({
  trip: one(trips, { fields: [tripVariants.tripId], references: [trips.id] }),
  lines: many(tripLines),
}))

export const tripLinesRelations = relations(tripLines, ({ one }) => ({
  variant: one(tripVariants, { fields: [tripLines.variantId], references: [tripVariants.id] }),
}))

export const packagesRelations = relations(packages, ({ one, many }) => ({
  household: one(households, {
    fields: [packages.householdId],
    references: [households.id],
  }),
  lineItems: many(lineItems),
}))

export const lineItemsRelations = relations(lineItems, ({ one }) => ({
  package: one(packages, { fields: [lineItems.packageId], references: [packages.id] }),
  reserveAccount: one(reserveAccounts, {
    fields: [lineItems.reserveAccountId],
    references: [reserveAccounts.id],
  }),
}))
