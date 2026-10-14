-- The day of the month a debt's regular payment goes out (PRD D49 (3)). Null
-- means none is assumed between the balances a person states.
ALTER TABLE "debts" ADD COLUMN "payment_day" smallint;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_payment_day_in_month" CHECK ("debts"."payment_day" is null or "debts"."payment_day" between 1 and 31);