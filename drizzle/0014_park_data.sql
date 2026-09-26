CREATE TYPE "public"."weather_horizon" AS ENUM('forecast', 'subseasonal', 'normal');--> statement-breakpoint
CREATE TABLE "park_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination" text DEFAULT 'wdw' NOT NULL,
	"park" "trip_park" NOT NULL,
	"date" date NOT NULL,
	"opens" text NOT NULL,
	"closes" text NOT NULL,
	"early_entry" text,
	"extended_evening" text,
	"source" text NOT NULL,
	"fetched_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "park_weather" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination" text DEFAULT 'wdw' NOT NULL,
	"date" date NOT NULL,
	"high_f" integer NOT NULL,
	"low_f" integer NOT NULL,
	"precip_chance" integer,
	"horizon" "weather_horizon" NOT NULL,
	"source" text NOT NULL,
	"fetched_on" date NOT NULL,
	CONSTRAINT "park_weather_precip_range" CHECK ("park_weather"."precip_chance" is null or "park_weather"."precip_chance" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "wait_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"park_id" text NOT NULL,
	"park_name" text NOT NULL,
	"ride_id" text NOT NULL,
	"ride_name" text NOT NULL,
	"is_open" boolean NOT NULL,
	"wait_minutes" integer,
	"observed_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wait_observations_minutes_range" CHECK ("wait_observations"."wait_minutes" is null or "wait_observations"."wait_minutes" between 0 and 1440)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "park_hours_key_idx" ON "park_hours" USING btree ("destination","park","date");--> statement-breakpoint
CREATE UNIQUE INDEX "park_weather_key_idx" ON "park_weather" USING btree ("destination","date","horizon");--> statement-breakpoint
CREATE UNIQUE INDEX "wait_observations_key_idx" ON "wait_observations" USING btree ("source","park_id","ride_id","observed_at");--> statement-breakpoint
CREATE INDEX "wait_observations_park_time_idx" ON "wait_observations" USING btree ("park_name","observed_at");