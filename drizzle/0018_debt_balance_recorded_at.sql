-- A debt's balance is the last one a person stated, less the payments marked
-- done since (PRD D49 (2)). The row keeps the stated balance and the moment it
-- was recorded; the engine takes off every payment recorded after that moment.
ALTER TABLE "debts" ADD COLUMN "balance_recorded_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Until now "Done" on a "Pay $X toward <debt>" to-do recorded the confirmation
-- and nothing read it back, so those payments never reached the balance. The
-- column above dates every existing balance to now, which would leave them out
-- for good; take them off once here instead. A payment counts when it was
-- confirmed after the debt's last stated balance (or ever, with none stated),
-- because a stated balance already includes everything paid before it. The
-- payment form always wrote into the row, so its payments are in it already.
WITH last_stated AS (
  SELECT "payload"->>'debt_id' AS debt_id, max("recorded_at") AS at
  FROM "events"
  WHERE "kind" = 'debt_balance_updated'
  GROUP BY 1
), confirmed AS (
  SELECT DISTINCT ON (c."payload"->>'instruction_id')
    i."payload"->>'target_id' AS debt_id,
    COALESCE((c."payload"->>'actual_amount_cents')::bigint, (i."payload"->>'amount_cents')::bigint) AS amount,
    c."recorded_at" AS at
  FROM "events" c
  JOIN "events" i
    ON i."household_id" = c."household_id"
   AND i."kind" = 'instruction_issued'
   AND i."payload"->>'instruction_id' = c."payload"->>'instruction_id'
  WHERE c."kind" = 'instruction_confirmed'
    AND i."payload"->>'type' = 'debt_payment'
  ORDER BY c."payload"->>'instruction_id', c."recorded_at"
), unpaid AS (
  SELECT c.debt_id, sum(c.amount) AS paid
  FROM confirmed c
  LEFT JOIN last_stated s ON s.debt_id = c.debt_id
  WHERE s.at IS NULL OR c.at > s.at
  GROUP BY c.debt_id
)
UPDATE "debts" d
SET "balance_cents" = GREATEST(0, d."balance_cents" - u.paid),
    "state" = CASE WHEN d."balance_cents" - u.paid <= 0 THEN 'paid_off'::debt_state ELSE d."state" END
FROM unpaid u
WHERE d."id"::text = u.debt_id AND d."state" = 'open';
