# Resorts as a fact, and the raw layer

Asked for by the household on Nov 28, 2026. Not yet a PRD decision; proposed
as D64 against PRD rev 121. This is the first of two steps toward a price
the household can trust for any week: this step gives every price a resort
to be about and a raw page to come from; the next gives each week's price a
label saying how sure it is.

## What was wrong

- A price was about a string. A quote typed as "Pop Century" never met
  Disney's rate for "Pop Century Resort", so Explore fell back to the tier
  average or said nothing. Universal had nowhere to go at all.
- A pasted or fetched page was read and thrown away. Only the parsed rows
  were kept, so a better parser, or a fixed name match, could never read
  the same page again, and a newer capture overwrote what the older one
  said.

## Decision (D64, proposed)

1. **Three layers, everywhere Ballast reads from outside** (the household's
   medallion rule, Nov 28: "keep a medallion data model across everything
   so that we can always change our abstraction or presentation layer
   without changing the underlying raw data").
   - Raw: `source_pulls`. Each page or paste exactly as it arrived, with
     its source, address, how it came in, its media type, its SHA-256 and
     the day. Append-only: the app role has no update or delete, and a
     trigger refuses anyone else. The same body from the same source is
     one row.
   - Facts: the resort list and its aliases and perks; the rates, quotes
     and listings, each keeping the source's own spelling of the resort
     and the pull it came from.
   - Derived: which resort a name means, a stay's canonical key, and every
     price label and prediction. Never stored.
2. **A resort is a first-class fact** with a stable id, its destination
   (`wdw` or `uor`), its brand, the owner's name for it, its tier and
   whether it is a DVC resort.
3. **Each brand has its own tier ladder**, as each sells it, never compared
   across brands. Disney: value, moderate, deluxe, campground (DVC villas
   are deluxe with `dvc` set, matching the three tiers Disney's published
   averages cover). Universal: value (Value Inns and Suites), prime_value
   (Prime Value Hotels), signature (Signature Collection).
4. **Names are matched, never guessed.** Normalised exact match on the
   resort's own name, then an alias kept for that source, then an alias for
   any source. A name nothing matches stays unmatched and is listed. Two
   resorts sharing a normalised name is a catalogue error and throws. A
   wrong guess would price one resort at another's rate.
5. **Perks are dated observations.** Express Unlimited is kept at the three
   Signature hotels a source said include it, with what it covers and the
   day it was read. It is checked again like any dated fact.

## What changes in the app now

- Explore prices a stay against every rate and quote for the same resort,
  whatever each source called it (`priceFactsFor`). An unknown name still
  matches only itself, as before.
- The resortings paste and the DVC listing fetch land raw before anything
  is held, and the rates and listings they produce name the pull.
- Nothing on screen changes yet.

## The seed (migration 0032)

- 32 Walt Disney World resorts: the 31 resortings.com prices on its
  prices-by-month page (page updated Nov 11, 2026, read Nov 28, 2026), plus
  the Fort Wilderness cabins, which that page leaves out.
- Universal Orlando's 11 hotels in its three groups, from Orlando Informer
  (Oct 2, 2025) and CrowdLevels (Aug 28, 2026), which agree, Cabana Bay
  included in Value.
- Express Unlimited at Portofino Bay, Hard Rock and Royal Pacific
  (CrowdLevels, observed Nov 28, 2026): Universal Studios Florida and
  Islands of Adventure only, not Epic Universe or Volcano Bay.

## Assumptions to confirm

- The Fort Wilderness campsites sit on their own `campground` tier rather
  than value or moderate. Not checked against Disney's own grouping.
- Swan, Dolphin, Swan Reserve and the Disney Springs hotels are left out:
  Disney does not set their rates and resortings.com does not list them.
- Disney Lakeshore Lodge is seeded as a deluxe DVC resort. resortings.com
  lists it with no December figure yet.

## The next step (not in this change)

- Each week's price gets a label: **Definite** (a quote or a lookup for
  those nights), **Disney list price** (Disney's published rate),
  **Predicted** (from history and the list price), or **Unknown**, with the
  basis it rests on. A Definite figure that differs from the prediction
  feeds the prediction; it never becomes one.
- Rooms, under resorts.
- Crowds, weather and school calendars land raw too.

## Guard rails

The archguard ratchet now runs in Ballast's test suite (counts in
`.archguard-baseline.json`). This change adds no new weak shapes.
