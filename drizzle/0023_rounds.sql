-- Rounds (PRD D53): a spend against a round, a round finished, a round saved
-- back up, and any of the three taken back. Facts only; open rounds are derived.
ALTER TYPE "public"."event_kind" ADD VALUE 'spend_recorded';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'round_finished';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'round_saved_back_up';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'event_undone';