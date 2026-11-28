-- D64 (proposed, asked for by the household on Nov 28, 2026): a resort is a
-- first-class fact at Walt Disney World and Universal Orlando, and every page
-- or paste a rate or listing is read from is kept raw before it is parsed
-- (the household's medallion rule: raw, facts, derived). The facts keep each
-- source's own name for a resort; which resort it means is worked out in
-- src/domain/resort.ts and never stored.
CREATE TABLE "resort_aliases" (
	"source" text NOT NULL,
	"alias" text NOT NULL,
	"resort_id" text NOT NULL,
	CONSTRAINT "resort_aliases_source_alias_pk" PRIMARY KEY("source","alias")
);
--> statement-breakpoint
CREATE TABLE "resort_perks" (
	"resort_id" text NOT NULL,
	"perk" text NOT NULL,
	"detail" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text NOT NULL,
	"observed_on" date NOT NULL,
	CONSTRAINT "resort_perks_resort_id_perk_source_pk" PRIMARY KEY("resort_id","perk","source"),
	CONSTRAINT "resort_perks_perk" CHECK ("resort_perks"."perk" in ('express_unlimited'))
);
--> statement-breakpoint
CREATE TABLE "resorts" (
	"id" text PRIMARY KEY NOT NULL,
	"destination" text NOT NULL,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"tier" text NOT NULL,
	"dvc" boolean DEFAULT false NOT NULL,
	CONSTRAINT "resorts_destination_brand" CHECK (("resorts"."destination" = 'wdw' and "resorts"."brand" = 'disney') or ("resorts"."destination" = 'uor' and "resorts"."brand" = 'universal')),
	CONSTRAINT "resorts_tier_on_ladder" CHECK (("resorts"."brand" = 'disney' and "resorts"."tier" in ('value', 'moderate', 'deluxe', 'campground')) or ("resorts"."brand" = 'universal' and "resorts"."tier" in ('value', 'prime_value', 'signature'))),
	CONSTRAINT "resorts_dvc_is_disney" CHECK (not "resorts"."dvc" or "resorts"."brand" = 'disney')
);
--> statement-breakpoint
CREATE TABLE "source_pulls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"url" text NOT NULL,
	"how" text NOT NULL,
	"media_type" text NOT NULL,
	"body" text NOT NULL,
	"sha256" text NOT NULL,
	"pulled_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_pulls_how" CHECK ("source_pulls"."how" in ('fetched', 'pasted')),
	CONSTRAINT "source_pulls_media_type" CHECK ("source_pulls"."media_type" in ('text/html', 'text/plain', 'application/json')),
	CONSTRAINT "source_pulls_sha256" CHECK ("source_pulls"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "dvc_listings" ADD COLUMN "pull_id" uuid;--> statement-breakpoint
ALTER TABLE "lodging_rates" ADD COLUMN "pull_id" uuid;--> statement-breakpoint
ALTER TABLE "resort_aliases" ADD CONSTRAINT "resort_aliases_resort_id_resorts_id_fk" FOREIGN KEY ("resort_id") REFERENCES "public"."resorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resort_perks" ADD CONSTRAINT "resort_perks_resort_id_resorts_id_fk" FOREIGN KEY ("resort_id") REFERENCES "public"."resorts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resorts_name_idx" ON "resorts" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "source_pulls_body_idx" ON "source_pulls" USING btree ("source","sha256");--> statement-breakpoint
ALTER TABLE "dvc_listings" ADD CONSTRAINT "dvc_listings_pull_id_source_pulls_id_fk" FOREIGN KEY ("pull_id") REFERENCES "public"."source_pulls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lodging_rates" ADD CONSTRAINT "lodging_rates_pull_id_source_pulls_id_fk" FOREIGN KEY ("pull_id") REFERENCES "public"."source_pulls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The raw layer is append-only, as events is (0001): a pull is what arrived,
-- and a fact read from it can always be read again from the same bytes.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE source_pulls FROM ballast_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION source_pulls_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'source_pulls is append-only: % on source_pulls is not permitted', TG_OP
    USING HINT = 'Land a new pull instead of editing what arrived.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER source_pulls_no_update
  BEFORE UPDATE ON source_pulls
  FOR EACH ROW EXECUTE FUNCTION source_pulls_are_append_only();
--> statement-breakpoint

CREATE TRIGGER source_pulls_no_delete
  BEFORE DELETE ON source_pulls
  FOR EACH ROW EXECUTE FUNCTION source_pulls_are_append_only();
--> statement-breakpoint

-- Walt Disney World: the 31 resorts resortings.com prices (page updated
-- Nov 11, 2026, read Nov 28, 2026) plus the Cabins at Fort Wilderness, which
-- it leaves out because Disney does not price them online. Disney-owned and
-- Disney-run only: the Swan, Dolphin, Swan Reserve and the Disney Springs
-- hotels are not here. Villas are deluxe with dvc true; the campsites are
-- their own step on the ladder.
INSERT INTO resorts (id, destination, brand, name, tier, dvc) VALUES
  ('wdw-all-star-movies', 'wdw', 'disney', 'Disney''s All-Star Movies Resort', 'value', false),
  ('wdw-all-star-music', 'wdw', 'disney', 'Disney''s All-Star Music Resort', 'value', false),
  ('wdw-all-star-sports', 'wdw', 'disney', 'Disney''s All-Star Sports Resort', 'value', false),
  ('wdw-pop-century', 'wdw', 'disney', 'Disney''s Pop Century Resort', 'value', false),
  ('wdw-art-of-animation', 'wdw', 'disney', 'Disney''s Art of Animation Resort', 'value', false),
  ('wdw-caribbean-beach', 'wdw', 'disney', 'Disney''s Caribbean Beach Resort', 'moderate', false),
  ('wdw-coronado-springs', 'wdw', 'disney', 'Disney''s Coronado Springs Resort', 'moderate', false),
  ('wdw-port-orleans-french-quarter', 'wdw', 'disney', 'Disney''s Port Orleans Resort – French Quarter', 'moderate', false),
  ('wdw-port-orleans-riverside', 'wdw', 'disney', 'Disney''s Port Orleans Resort – Riverside', 'moderate', false),
  ('wdw-fort-wilderness-campsites', 'wdw', 'disney', 'The Campsites at Disney''s Fort Wilderness Resort', 'campground', false),
  ('wdw-grand-floridian', 'wdw', 'disney', 'Disney''s Grand Floridian Resort & Spa', 'deluxe', false),
  ('wdw-polynesian-village', 'wdw', 'disney', 'Disney''s Polynesian Village Resort', 'deluxe', false),
  ('wdw-contemporary', 'wdw', 'disney', 'Disney''s Contemporary Resort', 'deluxe', false),
  ('wdw-boardwalk-inn', 'wdw', 'disney', 'Disney''s BoardWalk Inn', 'deluxe', false),
  ('wdw-beach-club', 'wdw', 'disney', 'Disney''s Beach Club Resort', 'deluxe', false),
  ('wdw-yacht-club', 'wdw', 'disney', 'Disney''s Yacht Club Resort', 'deluxe', false),
  ('wdw-wilderness-lodge', 'wdw', 'disney', 'Disney''s Wilderness Lodge', 'deluxe', false),
  ('wdw-animal-kingdom-lodge', 'wdw', 'disney', 'Disney''s Animal Kingdom Lodge', 'deluxe', false),
  ('wdw-grand-floridian-villas', 'wdw', 'disney', 'The Villas at Disney''s Grand Floridian Resort & Spa', 'deluxe', true),
  ('wdw-polynesian-villas', 'wdw', 'disney', 'Disney''s Polynesian Villas & Bungalows', 'deluxe', true),
  ('wdw-bay-lake-tower', 'wdw', 'disney', 'Bay Lake Tower at Disney''s Contemporary Resort', 'deluxe', true),
  ('wdw-boardwalk-villas', 'wdw', 'disney', 'Disney''s BoardWalk Villas', 'deluxe', true),
  ('wdw-beach-club-villas', 'wdw', 'disney', 'Disney''s Beach Club Villas', 'deluxe', true),
  ('wdw-boulder-ridge-villas', 'wdw', 'disney', 'Boulder Ridge Villas at Disney''s Wilderness Lodge', 'deluxe', true),
  ('wdw-copper-creek-villas', 'wdw', 'disney', 'Copper Creek Villas & Cabins at Disney''s Wilderness Lodge', 'deluxe', true),
  ('wdw-riviera', 'wdw', 'disney', 'Disney''s Riviera Resort', 'deluxe', true),
  ('wdw-lakeshore-lodge', 'wdw', 'disney', 'Disney Lakeshore Lodge', 'deluxe', true),
  ('wdw-animal-kingdom-kidani', 'wdw', 'disney', 'Disney''s Animal Kingdom Villas – Kidani Village', 'deluxe', true),
  ('wdw-animal-kingdom-jambo', 'wdw', 'disney', 'Disney''s Animal Kingdom Villas – Jambo House', 'deluxe', true),
  ('wdw-old-key-west', 'wdw', 'disney', 'Disney''s Old Key West Resort', 'deluxe', true),
  ('wdw-saratoga-springs', 'wdw', 'disney', 'Disney''s Saratoga Springs Resort & Spa', 'deluxe', true),
  ('wdw-fort-wilderness-cabins', 'wdw', 'disney', 'The Cabins at Disney''s Fort Wilderness Resort', 'deluxe', true),
-- Universal Orlando: its 11 hotels in its three groups, as Orlando Informer
-- (updated Oct 2, 2025) and CrowdLevels (Aug 28, 2026) both list them, read
-- Nov 28, 2026.
  ('uor-helios-grand', 'uor', 'universal', 'Universal Helios Grand Hotel', 'signature', false),
  ('uor-portofino-bay', 'uor', 'universal', 'Loews Portofino Bay Hotel', 'signature', false),
  ('uor-hard-rock', 'uor', 'universal', 'Hard Rock Hotel', 'signature', false),
  ('uor-royal-pacific', 'uor', 'universal', 'Loews Royal Pacific Resort', 'signature', false),
  ('uor-sapphire-falls', 'uor', 'universal', 'Loews Sapphire Falls Resort', 'signature', false),
  ('uor-aventura', 'uor', 'universal', 'Universal Aventura Hotel', 'prime_value', false),
  ('uor-stella-nova', 'uor', 'universal', 'Universal Stella Nova Resort', 'prime_value', false),
  ('uor-terra-luna', 'uor', 'universal', 'Universal Terra Luna Resort', 'prime_value', false),
  ('uor-cabana-bay', 'uor', 'universal', 'Universal Cabana Bay Beach Resort', 'value', false),
  ('uor-dockside', 'uor', 'universal', 'Universal Endless Summer Resort – Dockside Inn and Suites', 'value', false),
  ('uor-surfside', 'uor', 'universal', 'Universal Endless Summer Resort – Surfside Inn and Suites', 'value', false);
--> statement-breakpoint

-- Spellings the normalised match cannot place on its own. "Polynesian
-- Villas" is how DVC brokers list the villas (the fixture in
-- trip-when.test.ts); the rest are names people use for one building.
INSERT INTO resort_aliases (source, alias, resort_id) VALUES
  ('any', 'Polynesian Villas', 'wdw-polynesian-villas'),
  ('any', 'Gran Destino Tower', 'wdw-coronado-springs'),
  ('any', 'Kidani Village', 'wdw-animal-kingdom-kidani'),
  ('any', 'Jambo House', 'wdw-animal-kingdom-jambo'),
  ('any', 'Dockside Inn and Suites', 'uor-dockside'),
  ('any', 'Surfside Inn and Suites', 'uor-surfside');
--> statement-breakpoint

-- Express Unlimited comes with a stay at three hotels only. Both pages agree;
-- CrowdLevels names the parks it covers.
INSERT INTO resort_perks (resort_id, perk, detail, source, source_url, observed_on) VALUES
  ('uor-portofino-bay', 'express_unlimited', 'Universal Studios Florida and Islands of Adventure only, not Epic Universe or Volcano Bay; park tickets still needed', 'crowdlevels', 'https://www.crowdlevels.com/guides/universal-orlando-hotels', '2026-11-28'),
  ('uor-hard-rock', 'express_unlimited', 'Universal Studios Florida and Islands of Adventure only, not Epic Universe or Volcano Bay; park tickets still needed', 'crowdlevels', 'https://www.crowdlevels.com/guides/universal-orlando-hotels', '2026-11-28'),
  ('uor-royal-pacific', 'express_unlimited', 'Universal Studios Florida and Islands of Adventure only, not Epic Universe or Volcano Bay; park tickets still needed', 'crowdlevels', 'https://www.crowdlevels.com/guides/universal-orlando-hotels', '2026-11-28');
