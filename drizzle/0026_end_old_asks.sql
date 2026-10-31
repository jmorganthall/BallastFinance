-- Asks from before D35 are closed (PRD D56 (4)). An open "Set the transfer",
-- rate bump, rate cut or catch-up move from before D35 used to sit on This
-- week beside the position's own to-dos, sometimes with a different amount.
-- Each one still open is ended once, by a recorded instruction_ended: nothing
-- is edited, so the history still says it was asked. The position's own
-- to-dos take their place. A bump or cut already confirmed is not touched: it
-- runs to its end as before and can still be stopped.
--
-- Nothing issues these open any more: a transfer change or a catch-up move
-- marked done on This week is issued and confirmed in one transaction.
-- The kinds are compared as text, as in 0016 and 0020. The insert runs only
-- when there is an ask to end: the migrator applies every pending file in one
-- transaction, and on a new database instruction_ended (added by 0010) is a
-- value of that same transaction, which an INSERT cannot use until it commits.
-- A new database has no asks, so it never reaches the insert.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "events" i
    WHERE i."kind"::text = 'instruction_issued'
      AND (
        i."payload"->>'type' IN ('set_weekly_transfer', 'rate_bump', 'rate_cut')
        OR (i."payload"->>'type' = 'one_time_move' AND COALESCE(i."payload"->>'purpose', 'catch_up') = 'catch_up')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "events" d
        WHERE d."household_id" = i."household_id"
          AND d."kind"::text IN ('instruction_confirmed', 'instruction_ended')
          AND d."payload"->>'instruction_id' = i."payload"->>'instruction_id'
      )
  ) THEN
    EXECUTE $insert$
      INSERT INTO "events" ("household_id", "kind", "occurred_at", "source", "payload")
      SELECT i."household_id",
             'instruction_ended',
             current_date,
             'manual',
             jsonb_build_object('instruction_id', i."payload"->>'instruction_id', 'reason', 'retired_by_d56')
      FROM "events" i
      WHERE i."kind"::text = 'instruction_issued'
        AND (
          i."payload"->>'type' IN ('set_weekly_transfer', 'rate_bump', 'rate_cut')
          OR (i."payload"->>'type' = 'one_time_move' AND COALESCE(i."payload"->>'purpose', 'catch_up') = 'catch_up')
        )
        AND NOT EXISTS (
          SELECT 1 FROM "events" d
          WHERE d."household_id" = i."household_id"
            AND d."kind"::text IN ('instruction_confirmed', 'instruction_ended')
            AND d."payload"->>'instruction_id' = i."payload"->>'instruction_id'
        )
    $insert$;
  END IF;
END
$$;
