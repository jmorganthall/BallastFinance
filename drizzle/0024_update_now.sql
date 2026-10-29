-- "Update now" (design 2026-10-29): each press of the button, each backup the
-- bootstrap takes before a migration, and who has said "Got it" to a missing
-- one. Facts about the server, not a household; not events, because an
-- attempt is settled after the container that made it has gone.
CREATE TABLE "backup_notice_dismissals" (
	"backup_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_notice_dismissals_backup_id_user_id_pk" PRIMARY KEY("backup_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "database_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" text,
	"migrations" text[] NOT NULL,
	"ok" boolean NOT NULL,
	"file" text,
	"bytes" bigint,
	"elapsed_ms" integer NOT NULL,
	"reason" text,
	CONSTRAINT "database_backups_ok_file" CHECK ("database_backups"."ok" = ("database_backups"."file" is not null))
);
--> statement-breakpoint
CREATE TABLE "update_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"url" text NOT NULL,
	"token_sent" boolean NOT NULL,
	"revision_before" text,
	"outcome" text NOT NULL,
	"http_status" integer,
	"response_body" text,
	"error" text,
	"elapsed_ms" integer,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"verdict_at" timestamp with time zone,
	"revision_after" text,
	CONSTRAINT "update_attempts_outcome" CHECK ("update_attempts"."outcome" in ('requested', 'accepted', 'dropped', 'rejected', 'unreachable')),
	CONSTRAINT "update_attempts_verdict" CHECK ("update_attempts"."verdict" in ('pending', 'updated', 'no_change', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "backup_notice_dismissals" ADD CONSTRAINT "backup_notice_dismissals_backup_id_database_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."database_backups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_notice_dismissals" ADD CONSTRAINT "backup_notice_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_attempts" ADD CONSTRAINT "update_attempts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_backups_taken_idx" ON "database_backups" USING btree ("taken_at");--> statement-breakpoint
CREATE INDEX "update_attempts_created_idx" ON "update_attempts" USING btree ("created_at");