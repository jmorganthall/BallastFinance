# Ballast Finance — working notes

A self-hosted family reservation engine. It never moves money and holds no bank
credentials: it works out the numbers, and a human executes the transfers in
Capital One 360.

**The PRD is the source of truth and it is not in this repo.** It is a living
Claude Docs document that changes as the build teaches us things — see
[docs/prd.md](docs/prd.md) for the link and why there is deliberately no copy
here. Read it live before making a design decision; do not trust a summary,
including this file.

## The three rules that hold the shape

Everything else is detail. These are from PRD §10 and the abstract's data-model
principles, and they are non-negotiable.

1. **`src/domain` is the only place math lives.** Pure functions, zero I/O,
   `today` always a parameter. No arithmetic in components, in SQL, or in the
   service layer. If you find yourself computing a rate in a React component,
   the function belongs in the domain module instead.
2. **Facts are stored; derivations are computed.** No weekly rate, curve, drift
   figure, priority score or ladder is ever written to the database. If it can
   be recomputed, it is a view, not a column. Stored derivations are the root
   cause of sync glue.
3. **One write path.** Everything goes through `src/server/engine.ts`, which is
   bound to one household at construction — cross-household access is not
   something a caller must remember to avoid, it is something they cannot
   express. Packages are created only through the intake contract.

## Layout

| Path | What lives there |
| --- | --- |
| `src/domain/` | The engine's math. Pure, tested hardest, no imports from `server` or `db`. `trip.ts` is the first planner module: it prices a trip and emits a package through the intake contract. `trip-plan.ts` plans it: the day cut, the booking timeline and its merge, the week comparison, the day plan, reservation money, and the parsers for the crowd calendars and the geocoder. `trip-when.ts` proposes dates: federal holidays, long weekends, the candidate windows and their score, the iCal reader, the DVC listing parser. `park-data.ts` is Ballast's own park data: the weather blend by horizon, the normals, `busynessFor`, the wait-history ranking, the calendar month, and the parsers for Open-Meteo, ThemeParks.wiki, the crowd outlook and Queue-Times. `reader-shapes.ts` holds the zod shapes the reader may answer with |
| `src/db/` | Drizzle schema and the connection. Facts only |
| `src/server/` | The service layer, session bridge, server actions, scheduled jobs. `market-rate.ts`, `trip-fetch.ts` and `park-fetch.ts` are the only outbound data calls (FRED CSVs, the OSRM router, Nominatim for the home address, two public crowd calendars, a district's iCal feed, a DVC broker's public page, Open-Meteo, ThemeParks.wiki, the RopeDrop outlook, Queue-Times; public, key-free, each switchable off by env, every request with the app's own User-Agent and **never an `origin` or `referer` header**, and never an endpoint a site's own front end uses privately). `reader.ts` is the one place a language model is called, and it is off unless the environment says otherwise |
| `src/app/` | Screens. They render; they do not calculate |
| `drizzle/` | Migrations. `0001` is the append-only enforcement — read it before touching events |
| `scripts/` | Bootstrap, seed, backup, quickstart, and the Disney demo for checking against the spreadsheet |
| `docker/` | Container entrypoint. Bootstrap runs before the server, then `exec`s it as PID 1 |

## Things that will bite you

- **Money is integer cents; rates are basis points.** Never a float. `2499` is
  24.99%. These numbers decide where real money goes.
- **Rounding direction is deliberate and differs by context.** Accruals round
  **up** (a household rule: "rather have a few cents more than not enough"), so
  an instruction never under-funds. Allocations use **largest-remainder**
  apportionment, because they divide money that actually exists and rounding
  every share up would hand out more than was put in.
- **Dates are calendar dates, not instants.** `CivilDate` strings, `date`
  columns, and no timezone in the arithmetic. The only timezone-aware function
  is `todayIn()`.
- **The week boundary is the household's transfer day** (PRD D31, rev 44),
  the weekday the Capital One recurring transfer runs: setting
  `transfer_weekday` (0 Sunday – 6 Saturday), default Saturday until a person
  picks a day under Settings ("Our transfer runs on"). A "week" in the accrual
  math is one such transfer. The one definition of the count is
  `transferWeeksBetween` in `src/domain/dates.ts`; every function that counts
  weeks takes the day as `transferWeekday` beside `today` (a field on an args
  object, or the last positional parameter), defaulting to Saturday only so
  pure tests can leave it out. The engine always passes the household's:
  `DerivationInput.transferWeekday` from `derivationInput()`, and
  `engine.transferWeekday()` wherever a screen or the digest calls a domain
  function directly. Nothing derived is stored, so changing the day
  re-derives every figure. The digest is sent on the transfer day:
  `DIGEST_CRON` names a time of day and `buildWeeklyDigestIfDue` skips a
  household whose day it is not. A catch-up bump or cut ends on the n-th
  transfer day (`nthTransferDayAfter`). Any place that still assumes Saturday
  is a bug.
- **Events are append-only**, enforced by a revoked privilege *and* a trigger
  that fires regardless of role. Never add an UPDATE or DELETE against `events`;
  record a correcting event instead.
- **The app connects as a restricted role** (`ballast_app`); migrations run as
  the owner. Giving the app the owner's credentials silently undoes the
  append-only guarantee. The bootstrap sets that role's password from
  `APP_DB_PASSWORD` on every start.
- **The database client connects lazily.** Importing `src/db/client` must never
  open a connection or throw — `next build` collects page data without any
  credentials, and a placeholder URL in a Dockerfile is exactly the thing that
  later gets copied into a deployment.
- **PRD §6 "Order of operations and cash flow" is binding.** Every step of a
  share-out sees balances as they will be after the earlier steps, and every
  figure that appears in more than one place has one definition in `src/domain`
  (`monthlyPaymentCents`, `promoCliff`, `projectPayoff`). The effective APR is
  for ranking only; never project with a blended rate.
- **Nothing is done until a human confirms it.** An issued instruction the user
  ignored must never change a weekly number or a balance.
- **Account scope restricts writes, never reads.** Both spouses see every
  reserve account and every balance, so a household total is never a partial
  picture. An `individual` account can only be renamed, funded, or
  balance-confirmed by its owner (`canWriteAccount` in `src/domain/types.ts`).
  There is deliberately no `canReadAccount`.
- **Home and car values are typed, never fetched** (PRD §15, D13). Zillow and
  KBB do not license their values to an app like this. The mortgage rate is the
  one outbound data call (`src/server/market-rate.ts`, FRED's public CSV), and
  what it returns is refused unless it reads as a plausible rate.
- **A trip is a planner module, not core** (PRD §16, D19). `trips`,
  `trip_variants` and `trip_lines` are the module's own facts; the core never
  reads them, and the trip never touches weekly math. "Add to Plans" goes
  through `createPackageFromIntake` like the manual builder, with
  `module: 'trip'`, and after that the trip is read-only: the plan is the
  truth. Nothing Disney sells is fetched (D20); every cost is a dated,
  sourced figure a person stated, and a typed figure is never overwritten by
  the drive or gas-price fetch. The cushion and the price tag are computed,
  never stored.
- **A trip is planned here, not only priced** (PRD §16, D22–D24, rev 37).
  `trip_days`, `trip_reservations` and `trip_tasks` are the module's own
  planning facts (migration 0012); every edit is a `trip_changed` event with
  `day_id` / `reservation_id` / `task_id`. Once a trip is a plan its *money*
  is read-only, but its days, reservations and to-dos go on being planned.
  The booking timeline is regenerated with stable keys and never touches a
  to-do a person edited (`generated = false`) or ticked. `crowd_levels` is
  household-independent reference data (1 quiet – 10 packed, per date and
  park, with source and fetched-on), still written only through the engine;
  a pull is held in a setting and shown before it is kept, a typed level
  always shows over a fetched one, and one older than 30 days is flagged.
  TouringPlans is subscriber-only and never fetched. Home is an **address**
  (D24): saving geocodes it once through Nominatim (one request a second,
  cached), stores the address as typed with the point and the resolved name,
  and a failed lookup keeps the address with no point, so the drive waits.
  `HomeLocation.latitude/longitude` are therefore nullable; use
  `homeIsLocated()` before measuring a drive. The two crowd sites and
  Nominatim are unreachable from the build sandbox: every parser is tested on
  hand-written fixtures, never a live page.
- **The When section proposes dates** (PRD §16, D25–D26, rev 38). Every
  window of the trip's length across a horizon (`trip_horizon_months`, 12)
  plus every long weekend a federal holiday or a day off school makes, each
  scored and the top ten shown with reasons. The formula is documented at the
  top of `src/domain/trip-when.ts`: quiet, then cheap, then no school missed
  (`trip_week_weights`, 3/2/1), each part normalised across the candidates,
  price among candidates of the same length, a blackout excludes. Federal
  holidays are computed with the observed-day rules. `school_days_off`
  (migration 0013) is the household's own calendar — typed, imported from an
  iCal feed, or read by the reader — and every change to it is a
  `school_calendar_changed` event; a school year is taken to run from its
  first listed day off to its last, and with no calendar at all every
  weekday counts as school. `dvc_listings` is household-independent
  reference data like `crowd_levels`: what a broker had on a date, shown
  beside the lodging line and never the line itself, never in money math.
  Both pulls are held in a setting and shown before they are kept.
- **Ballast collects its own park data, and the calendar comes first**
  (PRD §16, D28–D29, rev 41). `park_weather` (per date and horizon:
  forecast / subseasonal / normal), `park_hours` (per park and date, "HH:MM"
  on the park's own clock, never converted) and `wait_observations` (one
  row per posting, unique on source + park + ride + the feed's own
  timestamp, so a re-poll is a no-op) are household-independent reference
  data like `crowd_levels` (migration 0014), written only through the
  engine, each row with a source and fetched-on; the crowd outlook is
  stored in `crowd_levels` under source `ropedrop`. Adapters in
  `src/server/park-fetch.ts`: Open-Meteo (forecast, seasonal, archive),
  ThemeParks.wiki (park ids resolved once from the destination's children
  by name and kept in setting `park_hours_ids`; a name not found is an
  error in the log), RopeDrop Planner's public JSON (URL in setting
  `ropedrop_outlook_url`, parsed defensively), Queue-Times (park names in
  setting `park_wait_names`). None is reachable from the sandbox; every
  adapter is tested on fixtures from the documented shapes and a fake
  fetch. **Queue-Times' data must appear with "Powered by Queue-Times.com"
  linking to https://queue-times.com/en-US** wherever it is shown. **No
  request sets `origin` or `referer`.** Busyness is derived, never stored:
  `busynessFor` (typed → outlook → the household's own wait history ranked
  1–10 across the year, documented at the top of `park-data.ts` → a
  crowd-calendar level → nothing), and `pickLevel`/`weekComparison`/
  `dayPlan`/`bestWeeks`/the calendar all read through it. One exception to
  "no arithmetic in SQL", stated in `Engine.waitHistory`: the per-park,
  per-day mean wait is summed in SQL because a row per ride per five
  minutes is too big to read; its shape matches the domain's
  `summariseWaits`, and the ranking stays in the domain. Jobs
  (`PARK_WEATHER_CRON`, `PARK_HOURS_CRON`, `WAIT_POLL_CRON`, all off with
  `PARK_DATA_FETCH=off`, each off with its cron set to `off`) run once
  through the first household's engine, not per household. The calendar
  (`ParkCalendar`, on `/trips` and at the top of a trip's When section) is
  server-rendered with `?month=` and `?day=` links and colours busyness
  with the one-hue ramp `--color-busy-1..5` in `globals.css`, validated
  as an ordinal ramp in both themes; the number is printed too.
- **The reader is the only model call, and the last resort** (PRD §16, D27).
  `src/server/reader.ts` is the one module that knows a language model
  exists. It is off unless `READER_API_KEY`, `READER_BASE_URL` and
  `READER_MODEL` are set in the environment — never in the database, never on
  a screen beyond a notice that it is off. Structured first: an engine method
  that can fall back takes a `fallbackToReader` flag, and the action sets it
  only after the parser path returned nothing (a PDF or a page has no parser,
  so the action sets it at once). The request carries a strict JSON schema
  from `src/domain/reader-shapes.ts` and the reply is validated there or
  refused. What it read is held in a setting and shown to a person before
  anything is stored; a stored fact carries source `read:<model>`, the URL
  and the date. It never touches money math and never runs on a schedule.
  Do not import it anywhere but the engine, and do not add a second caller.
  Unreachable from the sandbox: tested with a fake fetch only.
- **A repeating part's timeline starts at its last occurrence** (PRD D30,
  rev 42). `line_items.timeline_start` (migration 0015) is
  `'last_occurrence'` for a new part that comes round again and `'commit'`
  for a one-off (a CHECK enforces the latter); the column default is
  `'commit'` so rows from before D30 behave exactly as they did. Under
  `last_occurrence` the base component runs from `previousOccurrence(due)`
  at total ÷ cycle weeks, so on the commit day should-hold is already the
  elapsed share -- the same number as `evenPaceCents` for the same window --
  and the pace and the money timeline agree; whether the money is there is
  the check-in's job, and no opening is suggested. The rules for where a
  base starts live in one place, `baseStartDate` in `src/domain/accrual.ts`:
  a cycle a spend began, a cycle a check-in count or a reshuffle began, and
  a cycle that opens with money (an opening typed at commit, a sheet's
  "reserved now") run from the cycle date under either setting -- a stated balance is where
  a timeline begins, and that is what keeps "should hold rises to match
  what is there" true. Like the recurrence, the setting is a fact on the
  part and not part of `LineItemSnapshot`: the math reads the current
  setting over the whole cycle, and `updateLineItem` records a toggle on a
  `line_item_changed` event with equal money snapshots (a zero delta, no
  component) and `timeline_start: { before, after }` beside them.
- **Nothing is seeded but the household and the allowlist.** Account names
  belong to a family's real bank, not to the software. The trip planner's
  usual figures are a constant in `src/domain/trip.ts`, laid over by a
  household setting, not a seed.

## Working on it

```bash
npm test            # 710 tests. Database tests skip when DATABASE_URL is unset
npm run typecheck
npm run demo        # the Disney scenario, for checking against the sheet
npm run bootstrap   # migrate + set the app role's password + seed, as the container does
npm run seed        # just the household, allowlist and reserve accounts
```

`./scripts/quickstart.sh` brings the whole stack up in Docker from nothing. The
container runs `scripts/bootstrap.ts` on every start, so there are no manual
first-run steps and no `ALTER ROLE` buried in a runbook.

Database tests need a live PostgreSQL 16 and run against it for real — the
acceptance criteria are about what the app produces, not what a pure function
returns.

Before changing accrual math, read the invariant test in
`src/domain/__tests__/accrual.test.ts`: *components always deliver exactly the
line item's total by its due date*. It is a randomised property test over
generated edit histories, and it has already caught one real bug.

## Plain language is a product requirement

PRD §9 carries a binding dictionary: UI copy says "weekly set-aside", not
"accrual"; "behind" and "ahead", not "drift"; "did this get spent?", not
"close-out"; "payoff order", not "priority score". The internal vocabulary
belongs in tooltips. If a non-technical reader needs a translation, the screen
has failed.
