-- A one-off's "Saving since" is a day a person can give (PRD D36). A one-off
-- still has no last time it came round, so it is never 'last_occurrence';
-- it starts where the plan does ('commit', the default) or on a day given
-- ('typed', with timeline_start_date, which 0016's CHECK already requires).
-- Every existing one-off is 'commit', so no row changes.
ALTER TABLE "line_items" DROP CONSTRAINT "line_items_one_off_starts_at_commit";--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_one_off_has_no_last_occurrence" CHECK ("line_items"."recur_every" is not null or "line_items"."timeline_start"::text <> 'last_occurrence');