CREATE TYPE "public"."confirmation_source" AS ENUM('manual', 'feed');--> statement-breakpoint
CREATE TYPE "public"."debt_category" AS ENUM('consumer', 'auto', 'mortgage');--> statement-breakpoint
CREATE TYPE "public"."debt_state" AS ENUM('open', 'paid_off');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('package_committed', 'line_item_changed', 'balance_confirmed', 'spend_confirmed', 'payment_confirmed', 'debt_balance_updated', 'allocation_entered', 'instruction_issued', 'instruction_confirmed');--> statement-breakpoint
CREATE TYPE "public"."line_item_state" AS ENUM('planned', 'accruing', 'due', 'retired');--> statement-breakpoint
CREATE TYPE "public"."package_state" AS ENUM('simulated', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "allowed_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "debt_category" NOT NULL,
	"balance_cents" bigint NOT NULL,
	"balance_as_of" date NOT NULL,
	"apr_basis_points" bigint NOT NULL,
	"promo_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_payment_rule" jsonb NOT NULL,
	"credit_limit_cents" bigint,
	"fixed_payment" boolean DEFAULT false NOT NULL,
	"state" "debt_state" DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"occurred_at" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"source" "confirmation_source" DEFAULT 'manual' NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"label" text NOT NULL,
	"unit_amount_cents" bigint NOT NULL,
	"quantity" bigint DEFAULT 1 NOT NULL,
	"due_date" date NOT NULL,
	"reserve_account_id" uuid NOT NULL,
	"state" "line_item_state" DEFAULT 'planned' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" "package_state" DEFAULT 'simulated' NOT NULL,
	"module" text DEFAULT 'manual' NOT NULL,
	"detail" jsonb,
	"created_at" date NOT NULL,
	"committed_at" date
);
--> statement-breakpoint
CREATE TABLE "reserve_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"institution_label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"effective_from" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allowed_emails" ADD CONSTRAINT "allowed_emails_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_reserve_account_id_reserve_accounts_id_fk" FOREIGN KEY ("reserve_account_id") REFERENCES "public"."reserve_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserve_accounts" ADD CONSTRAINT "reserve_accounts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "debts_household_idx" ON "debts" USING btree ("household_id","state");--> statement-breakpoint
CREATE INDEX "events_household_kind_idx" ON "events" USING btree ("household_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "events_occurred_idx" ON "events" USING btree ("household_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "household_members_pk" ON "household_members" USING btree ("household_id","user_id");--> statement-breakpoint
CREATE INDEX "line_items_package_idx" ON "line_items" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "line_items_account_idx" ON "line_items" USING btree ("household_id","reserve_account_id","state");--> statement-breakpoint
CREATE INDEX "packages_household_idx" ON "packages" USING btree ("household_id","state");--> statement-breakpoint
CREATE INDEX "reserve_accounts_household_idx" ON "reserve_accounts" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reserve_accounts_name_idx" ON "reserve_accounts" USING btree ("household_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_idx" ON "settings" USING btree ("household_id","key","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "users_issuer_subject_idx" ON "users" USING btree ("issuer","subject");