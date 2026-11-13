-- A standing transfer offer on a debt (PRD D61): a card's "0% for 18 months,
-- 3% fee", or a line of credit's own rate. A fact a person typed, changed
-- through the debt's form and recorded on its debt_added / debt_updated events
-- like the rest of its terms. What a transfer would save is never stored.
ALTER TABLE "debts" ADD COLUMN "transfer_offer" jsonb;
