-- Every money fact is written with its event (the layering plan's Phase 4).
-- Four kinds for the rows that used to be created or renamed with nothing in
-- the log beside them: a reserve account, a plan, a plan's new name, a debt.
-- They are added here and first used by the code, after this commits (as in
-- 0016, a value ALTER TYPE adds cannot be used in the same transaction).
--
-- Settings append: a change is a new row, never an edit, so two changes on
-- one day are two rows and the later recorded one is the setting. The index
-- on (household, key, effective_from) stops being unique.
ALTER TYPE "public"."event_kind" ADD VALUE 'account_added';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'package_created';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'package_renamed';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'debt_added';--> statement-breakpoint
DROP INDEX "settings_key_idx";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "recorded_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "settings_key_idx" ON "settings" USING btree ("household_id","key","effective_from");