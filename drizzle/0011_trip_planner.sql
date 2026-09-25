CREATE TYPE "public"."trip_line_category" AS ENUM('travel', 'lodging', 'tickets', 'lightning_lane', 'dining', 'photos', 'souvenirs', 'promotion', 'contingency');--> statement-breakpoint
CREATE TYPE "public"."trip_line_source" AS ENUM('typed', 'quote', 'fetched');--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'trip_changed';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'trip_sent';--> statement-breakpoint
CREATE TABLE "trip_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"category" "trip_line_category" NOT NULL,
	"label" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_cents" bigint NOT NULL,
	"due_date" date NOT NULL,
	"reserve_account_id" uuid,
	"source" "trip_line_source" DEFAULT 'typed' NOT NULL,
	"as_of" date NOT NULL,
	"note" text,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trip_lines_quantity_not_negative" CHECK ("trip_lines"."quantity" >= 0),
	CONSTRAINT "trip_lines_sign_matches_category" CHECK (("trip_lines"."category" = 'promotion' and "trip_lines"."unit_amount_cents" <= 0) or ("trip_lines"."category" <> 'promotion' and "trip_lines"."unit_amount_cents" >= 0))
);
--> statement-breakpoint
CREATE TABLE "trip_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"name" text NOT NULL,
	"choices" jsonb NOT NULL,
	"created_at" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"destination" text DEFAULT 'wdw' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"travelers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"home" jsonb,
	"car" jsonb,
	"chosen_variant_id" uuid,
	"package_id" uuid,
	"sent_on" date,
	"created_at" date NOT NULL,
	"retired_at" date,
	CONSTRAINT "trips_dates_in_order" CHECK ("trips"."end_date" >= "trips"."start_date")
);
--> statement-breakpoint
ALTER TABLE "trip_lines" ADD CONSTRAINT "trip_lines_variant_id_trip_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."trip_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_lines" ADD CONSTRAINT "trip_lines_reserve_account_id_reserve_accounts_id_fk" FOREIGN KEY ("reserve_account_id") REFERENCES "public"."reserve_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_variants" ADD CONSTRAINT "trip_variants_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_lines_variant_idx" ON "trip_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "trip_variants_trip_idx" ON "trip_variants" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trips_household_idx" ON "trips" USING btree ("household_id");