-- Income and the recurring list (PRD §14, D52). The recurring list is what
-- Simplifi says comes round again, or what a person added; income sources are
-- one job's paystub lines; income payments are the bonus log. Reserve accounts
-- and debts carry the names Simplifi knows them by. Nothing derived is stored.
CREATE TYPE "public"."frequency" AS ENUM('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'semiannual', 'yearly');--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'expense_changed';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'income_changed';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'income_received';--> statement-breakpoint
CREATE TABLE "income_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"income_source_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"landed_cents" bigint NOT NULL,
	"pretax_estimate_cents" bigint,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "income_payments_landed_not_negative" CHECK ("income_payments"."landed_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "income_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"person" text NOT NULL,
	"name" text NOT NULL,
	"frequency" "frequency" NOT NULL,
	"started_on" date,
	"annual_salary_cents" bigint,
	"gross_per_check_cents" bigint,
	"pretax_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tax_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"net_per_check_cents" bigint,
	"spending_share_basis_points" integer DEFAULT 2000 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"simplifi_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_sources_state" CHECK ("income_sources"."state" in ('active', 'ended')),
	CONSTRAINT "income_sources_has_pay" CHECK ("income_sources"."annual_salary_cents" is not null or "income_sources"."gross_per_check_cents" is not null or "income_sources"."net_per_check_cents" is not null),
	CONSTRAINT "income_sources_share_in_range" CHECK ("income_sources"."spending_share_basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "recurring_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"direction" text DEFAULT 'out' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"frequency" "frequency" NOT NULL,
	"next_amount_cents" bigint,
	"next_date" date,
	"account" text DEFAULT '' NOT NULL,
	"account_type" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_expenses_source" CHECK ("recurring_expenses"."source" in ('simplifi', 'manual')),
	CONSTRAINT "recurring_expenses_direction" CHECK ("recurring_expenses"."direction" in ('out', 'in')),
	CONSTRAINT "recurring_expenses_amount_not_negative" CHECK ("recurring_expenses"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN "simplifi_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "reserve_accounts" ADD COLUMN "simplifi_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "income_payments" ADD CONSTRAINT "income_payments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_payments" ADD CONSTRAINT "income_payments_income_source_id_income_sources_id_fk" FOREIGN KEY ("income_source_id") REFERENCES "public"."income_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "income_payments_source_idx" ON "income_payments" USING btree ("household_id","income_source_id");--> statement-breakpoint
CREATE INDEX "income_sources_household_idx" ON "income_sources" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "recurring_expenses_household_idx" ON "recurring_expenses" USING btree ("household_id");