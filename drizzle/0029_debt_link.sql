-- A link on each debt (PRD D60): the lender's page, to open it from Ballast.
-- A fact a person typed, changed through the debt's form and recorded on its
-- debt_added / debt_updated events like the rest of its terms. Only a web
-- address is kept, checked here as well as in the domain.
ALTER TABLE "debts" ADD COLUMN "link_url" text;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_link_is_web" CHECK ("debts"."link_url" is null or "debts"."link_url" ~ '^https?://');