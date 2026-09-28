-- "Saving since" is a day a person can give (PRD D33, revision 46). A third
-- choice, 'typed', with the day beside it: present exactly when the choice is
-- typed, and the timeline that runs from it is derived, never stored. The
-- column default stays 'commit' and a one-off still starts at the commit
-- (0015's CHECK). The new CHECK compares the enum as text because a value
-- added by ALTER TYPE cannot be used as the enum until the transaction that
-- added it commits, and the migrator applies every pending file in one.
ALTER TYPE "public"."timeline_start" ADD VALUE 'typed';--> statement-breakpoint
ALTER TABLE "line_items" ADD COLUMN "timeline_start_date" date;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_typed_start_has_date" CHECK (("line_items"."timeline_start_date" is not null) = ("line_items"."timeline_start"::text = 'typed'));