-- The first and last day of each school year (PRD D59): a household fact,
-- typed or found in a school calendar's feed, one row for each end of each
-- year. Which days are school is derived from these and the days off; every
-- change is a school_calendar_changed event, as the days off are.
CREATE TABLE "school_year_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"school_year" text NOT NULL,
	"which" text NOT NULL,
	"date" date NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"recorded_on" date NOT NULL,
	CONSTRAINT "school_year_days_which" CHECK ("school_year_days"."which" in ('first', 'last'))
);
--> statement-breakpoint
ALTER TABLE "school_year_days" ADD CONSTRAINT "school_year_days_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "school_year_days_key_idx" ON "school_year_days" USING btree ("household_id","school_year","which");