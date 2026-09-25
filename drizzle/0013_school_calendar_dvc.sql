ALTER TYPE "public"."event_kind" ADD VALUE 'school_calendar_changed';--> statement-breakpoint
CREATE TABLE "dvc_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"resort" text NOT NULL,
	"room" text NOT NULL,
	"check_in" date NOT NULL,
	"nights" integer NOT NULL,
	"points" integer,
	"price_cents" bigint,
	"source_url" text NOT NULL,
	"seen_on" date NOT NULL,
	CONSTRAINT "dvc_listings_nights_range" CHECK ("dvc_listings"."nights" between 1 and 60),
	CONSTRAINT "dvc_listings_price_not_negative" CHECK ("dvc_listings"."price_cents" is null or "dvc_listings"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "school_days_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"date" date NOT NULL,
	"label" text NOT NULL,
	"school_year" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"recorded_on" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "school_days_off" ADD CONSTRAINT "school_days_off_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dvc_listings_key_idx" ON "dvc_listings" USING btree ("source","resort","room","check_in","nights");--> statement-breakpoint
CREATE UNIQUE INDEX "school_days_off_key_idx" ON "school_days_off" USING btree ("household_id","date","label");