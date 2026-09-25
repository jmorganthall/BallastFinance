CREATE TYPE "public"."trip_park" AS ENUM('magic_kingdom', 'epcot', 'hollywood_studios', 'animal_kingdom', 'water_park', 'other', 'rest', 'travel');--> statement-breakpoint
CREATE TYPE "public"."trip_reservation_kind" AS ENUM('dining', 'lightning_lane', 'experience', 'flight', 'lodging', 'transport', 'other');--> statement-breakpoint
CREATE TYPE "public"."trip_task_kind" AS ENUM('book', 'pay', 'buy', 'pack', 'do');--> statement-breakpoint
CREATE TABLE "crowd_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination" text DEFAULT 'wdw' NOT NULL,
	"date" date NOT NULL,
	"park" "trip_park" NOT NULL,
	"level" integer NOT NULL,
	"source" text NOT NULL,
	"fetched_on" date NOT NULL,
	CONSTRAINT "crowd_levels_level_range" CHECK ("crowd_levels"."level" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "trip_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"date" date NOT NULL,
	"park" "trip_park" DEFAULT 'rest' NOT NULL,
	"plan" jsonb DEFAULT '{"notes":"","ropeDrop":false}'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"date" date NOT NULL,
	"time" text,
	"kind" "trip_reservation_kind" NOT NULL,
	"name" text NOT NULL,
	"park" "trip_park",
	"confirmation" text,
	"party" integer DEFAULT 1 NOT NULL,
	"per_person_cents" bigint,
	"line_id" uuid,
	"note" text,
	CONSTRAINT "trip_reservations_party_not_negative" CHECK ("trip_reservations"."party" >= 0),
	CONSTRAINT "trip_reservations_cost_not_negative" CHECK ("trip_reservations"."per_person_cents" is null or "trip_reservations"."per_person_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trip_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"kind" "trip_task_kind" DEFAULT 'do' NOT NULL,
	"label" text NOT NULL,
	"due_on" date NOT NULL,
	"done_on" date,
	"link" text,
	"line_id" uuid,
	"sort" integer DEFAULT 0 NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"key" text
);
--> statement-breakpoint
ALTER TABLE "trip_days" ADD CONSTRAINT "trip_days_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_reservations" ADD CONSTRAINT "trip_reservations_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_reservations" ADD CONSTRAINT "trip_reservations_line_id_trip_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."trip_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_tasks" ADD CONSTRAINT "trip_tasks_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_tasks" ADD CONSTRAINT "trip_tasks_line_id_trip_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."trip_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crowd_levels_key_idx" ON "crowd_levels" USING btree ("destination","date","park","source");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_days_trip_date_idx" ON "trip_days" USING btree ("trip_id","date");--> statement-breakpoint
CREATE INDEX "trip_reservations_trip_idx" ON "trip_reservations" USING btree ("trip_id","date");--> statement-breakpoint
CREATE INDEX "trip_tasks_trip_idx" ON "trip_tasks" USING btree ("trip_id","due_on");