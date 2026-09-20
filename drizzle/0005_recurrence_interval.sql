CREATE TYPE "public"."recurrence_unit" AS ENUM('day', 'week', 'month', 'year');--> statement-breakpoint
ALTER TABLE "line_items" ADD COLUMN "recur_every" integer;--> statement-breakpoint
ALTER TABLE "line_items" ADD COLUMN "recur_unit" "recurrence_unit";