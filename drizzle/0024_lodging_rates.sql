-- What a night costs (PRD D55 (5)): Disney's published nightly rates by week or
-- month as a public page reproduced them (reference data, no household), and
-- the nightly prices a household was quoted. Facts only; each night's figure,
-- its trust level and the window's cost are derived in night-cost.ts.
ALTER TYPE "public"."event_kind" ADD VALUE 'lodging_quote_changed';--> statement-breakpoint
CREATE TABLE "lodging_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"stay" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"nightly_cents" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"recorded_on" date NOT NULL,
	CONSTRAINT "lodging_quotes_nights_in_order" CHECK ("lodging_quotes"."to_date" >= "lodging_quotes"."from_date"),
	CONSTRAINT "lodging_quotes_price_positive" CHECK ("lodging_quotes"."nightly_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "lodging_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"stay" text NOT NULL,
	"period" text NOT NULL,
	"period_start" date NOT NULL,
	"nightly_cents" bigint NOT NULL,
	"observed_on" date NOT NULL,
	"fetched_on" date NOT NULL,
	"source_url" text NOT NULL,
	CONSTRAINT "lodging_rates_period" CHECK ("lodging_rates"."period" in ('week', 'month')),
	CONSTRAINT "lodging_rates_price_positive" CHECK ("lodging_rates"."nightly_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "lodging_quotes" ADD CONSTRAINT "lodging_quotes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lodging_quotes_household_idx" ON "lodging_quotes" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lodging_rates_key_idx" ON "lodging_rates" USING btree ("source","stay","period","period_start");