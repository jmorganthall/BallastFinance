-- The day a debt was entered in Ballast (PRD D49 (9)): where interest a deal
-- charges back is counted from when the deal has no start date. Existing debts
-- never recorded it, so take the earliest day anything is known about each:
-- its balance date, or the first payment, statement or change recorded on it.
-- The kinds are compared as text: the migrator applies every pending file in
-- one transaction, and an enum value an earlier file adds cannot be used as
-- the enum until that commits (as in 0016).
ALTER TABLE "debts" ADD COLUMN "entered_on" date DEFAULT current_date NOT NULL;--> statement-breakpoint
UPDATE "debts" d
SET "entered_on" = LEAST(
  d."balance_as_of",
  COALESCE(
    (SELECT min(e."occurred_at") FROM "events" e
     WHERE e."household_id" = d."household_id"
       AND e."kind"::text IN ('payment_confirmed', 'debt_balance_updated', 'debt_updated')
       AND e."payload"->>'debt_id' = d."id"::text),
    d."balance_as_of"
  )
);
