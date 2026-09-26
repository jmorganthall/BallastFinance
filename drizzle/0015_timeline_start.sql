-- Where a repeating part's money timeline begins (PRD D30, revision 42). The column
-- defaults to 'commit' so every existing row keeps exactly the behaviour it had;
-- the engine sets 'last_occurrence' for a new part that comes round again.
CREATE TYPE "public"."timeline_start" AS ENUM('last_occurrence', 'commit');--> statement-breakpoint
ALTER TABLE "line_items" ADD COLUMN "timeline_start" timeline_start DEFAULT 'commit' NOT NULL;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_one_off_starts_at_commit" CHECK ("line_items"."recur_every" is not null or "line_items"."timeline_start" = 'commit');