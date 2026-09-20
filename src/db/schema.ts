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

export const debtCategoryEnum = pgEnum('debt_category', ['consumer', 'auto', 'mortgage'])
export const debtStateEnum = pgEnum('debt_state', ['open', 'paid_off'])

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
])

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
  },
  (t) => [
    index('line_items_package_idx').on(t.packageId),
    index('line_items_account_idx').on(t.householdId, t.reserveAccountId, t.state),
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
    fixedPayment: boolean('fixed_payment').notNull().default(false),
    state: debtStateEnum('state').notNull().default('open'),
  },
  (t) => [index('debts_household_idx').on(t.householdId, t.state)],
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
