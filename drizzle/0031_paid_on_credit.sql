-- Paid on credit (asked for by the household on Nov 27, 2026): a plan's spend
-- that went on a card is a spend_recorded naming the card; moving its money to
-- the bills account and paying the card are these two facts. Nothing else is
-- stored: the to-dos and the card's figures are worked out from the events.
ALTER TYPE "public"."event_kind" ADD VALUE 'credit_moved';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'credit_paid';
