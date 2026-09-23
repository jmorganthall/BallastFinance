CREATE TYPE "public"."asset_kind" AS ENUM('home', 'vehicle');--> statement-breakpoint
CREATE TYPE "public"."asset_state" AS ENUM('owned', 'sold');--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'asset_added';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'asset_changed';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'asset_removed';--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"value_cents" bigint NOT NULL,
	"value_as_of" date NOT NULL,
	"selling_cost_basis_points" integer NOT NULL,
	"state" "asset_state" DEFAULT 'owned' NOT NULL,
	CONSTRAINT "assets_value_not_negative" CHECK ("assets"."value_cents" >= 0),
	CONSTRAINT "assets_selling_cost_in_range" CHECK ("assets"."selling_cost_basis_points" between 0 and 5000)
);
--> statement-breakpoint
ALTER TABLE "debts" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_household_idx" ON "assets" USING btree ("household_id","state");--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;