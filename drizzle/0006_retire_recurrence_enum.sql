-- The fixed menu (none/monthly/quarterly/semiannual/annual) becomes the
-- interval it always meant, before the column carrying it goes away. Data
-- first: a drop with no backfill silently turns every recurring plan into a
-- one-off, and nothing downstream would ever notice.
UPDATE "line_items" SET "recur_every" = 1, "recur_unit" = 'month' WHERE "recurrence" = 'monthly';--> statement-breakpoint
UPDATE "line_items" SET "recur_every" = 3, "recur_unit" = 'month' WHERE "recurrence" = 'quarterly';--> statement-breakpoint
UPDATE "line_items" SET "recur_every" = 6, "recur_unit" = 'month' WHERE "recurrence" = 'semiannual';--> statement-breakpoint
UPDATE "line_items" SET "recur_every" = 1, "recur_unit" = 'year' WHERE "recurrence" = 'annual';--> statement-breakpoint
ALTER TABLE "line_items" DROP COLUMN "recurrence";--> statement-breakpoint
DROP TYPE "public"."recurrence";--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_recurrence_is_whole" CHECK (("line_items"."recur_every" is null) = ("line_items"."recur_unit" is null));