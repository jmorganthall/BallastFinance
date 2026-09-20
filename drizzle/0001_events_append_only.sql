-- Events are append-only (PRD §3, §10).
--
-- The code never issues an UPDATE or DELETE against this table, but "the code
-- never does it" is a convention and conventions erode. This revokes the
-- privilege at the database role, so a mistake in a future route handler, a
-- migration script, or a psql session fails loudly instead of quietly rewriting
-- the audit trail. Current state is a fold over these rows; if they can be
-- edited, every derived figure becomes unfalsifiable.
--
-- The app connects as ${BALLAST_APP_ROLE} (default: ballast_app), which is NOT
-- the owner of the table. The owner retains full rights for migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ballast_app') THEN
    CREATE ROLE ballast_app LOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO ballast_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ballast_app;
--> statement-breakpoint

-- ...with the single exception that makes the log trustworthy.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE events FROM ballast_app;
--> statement-breakpoint

-- Future tables default to the same grant, so a new table is usable without a
-- follow-up migration. Events keeps its revoke because it already exists.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ballast_app;
--> statement-breakpoint

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ballast_app;
--> statement-breakpoint

-- A second belt for the same braces: even the owner cannot rewrite history by
-- accident, because the trigger fires regardless of role. Dropping it is a
-- deliberate, visible act.
CREATE OR REPLACE FUNCTION events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % on events is not permitted', TG_OP
    USING HINT = 'Record a correcting event instead of editing history.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER events_no_update
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION events_are_append_only();
--> statement-breakpoint

CREATE TRIGGER events_no_delete
  BEFORE DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_are_append_only();
