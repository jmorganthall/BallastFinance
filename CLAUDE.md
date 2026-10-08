# Ballast Finance — working notes

A self-hosted family reservation engine. It never moves money and holds no bank
credentials: it works out the numbers, and a human executes the transfers in
Capital One 360.

**The PRD is the source of truth and it is not in this repo.** It is a living
Claude Docs document that changes as the build teaches us things — see
[docs/prd.md](docs/prd.md) for the link and why there is deliberately no copy
here. Read it live before making a design decision; do not trust a summary,
including this file.

## The four rules that hold the shape

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
4. **Every money figure comes from the one position** (PRD D35, §5 "The one
   position"). `position()` in `src/domain/position.ts`, read through
   `Engine.position()`, is the only place a weekly amount, a status, what an
   account likely holds, what a part counts, a to-do or "All caught up" is
   worked out. A screen, the digest or a to-do that needs a figure reads it
   from there and never re-derives it; two screens disagreeing about the same
   account is the bug D35 exists to end.

## Layout

| Path | What lives there |
| --- | --- |
| `src/domain/` | The engine's math. Pure, tested hardest, no imports from `server` or `db`. `position.ts` is the one position (D35): money today, the run-forward, the level weekly amount and the one-time move, the three status words, parts counted automatically, the derived to-dos, the plan chart. `rollup.ts` only lists plans with their totals. `trip.ts` is the first planner module: it prices a trip and emits a package through the intake contract. `trip-plan.ts` plans it: the day cut, the booking timeline and its merge, the week comparison, the day plan, reservation money, and the parsers for the crowd calendars and the geocoder. `trip-when.ts` proposes dates: federal holidays, long weekends, the candidate windows and their score, the iCal reader, the DVC listing parser. `park-data.ts` is Ballast's own park data: the weather blend by horizon, the normals, `busynessFor`, the wait-history ranking, the calendar month, and the parsers for Open-Meteo, ThemeParks.wiki, the crowd outlook and Queue-Times. `park-day-plan.ts` proposes which park on which day: the fit score with its plain constants, the day-by-day choice under each-park-once, the diff "Use this plan" would write. `reader-shapes.ts` holds the zod shapes the reader may answer with |
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
  `PositionInput.transferWeekday` from `positionInput()`, and
  `engine.transferWeekday()` wherever a screen or the digest calls a domain
  function directly. Nothing derived is stored, so changing the day
  re-derives every figure. The digest is sent on the transfer day:
  `DIGEST_CRON` names a time of day and `buildWeeklyDigestIfDue` skips a
  household whose day it is not. A bump or cut from before D35 ends on the
  n-th transfer day (`nthTransferDayAfter`), and a stopped one is counted on
  the household's day too. Any place that still assumes Saturday is a bug.
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
- **The one position (D35) is how every account is judged.** Money today is
  the last count plus the transfers since (at the amount in force that day,
  from the transfer after the day it was confirmed), plus moves marked done
  since, minus spends since; never counted, it starts from the first commit
  and its stated openings. Each account runs forward to its furthest due date
  (and past it when the bank transfer is below the repeating parts'
  run-rate, until the day it would run dry). The weekly amount is the
  smallest level transfer that meets every date, never below the run-rate; a
  date four transfers away or fewer that it cannot meet is a one-time move,
  so the transfer never spikes. The status is judged on the transfer
  *confirmed* at the bank (`set_weekly_transfer` confirmed), never on an ask
  not yet done: `on_track`, `short` (with the first date) or `unconfirmed`.
  Parts are `on_track` / `catching_up` / `short`, counted automatically
  soonest due first up to each steady line, then up to totals; nothing is
  counted by hand and there is no reshuffle. To-dos (`position.todos`) are
  derived, not issued ahead: marking one done records the instruction and
  its confirmation together (`confirmTransfer`, `confirmMoveIn`). The
  invariants in `src/domain/__tests__/position.test.ts` pin the rest: a
  Short account always has a Short part and a fix; lowering never makes an
  account Short; extra never exceeds money today. There is no drift, no
  should-hold, no catch-up bump or ease-off offer and no rate component on
  screen any more.
- **A move marked done is money the account holds until the next count**
  (PRD D34, rev 47). Which moves and spends came after the last count is the
  order the events were recorded (`recorded_at`, then id), answered by
  `Engine.positionInput` (and `doneMovesSinceCount` for the words on This
  week); `doneMoveOf` decides whether a confirmation is a move on the ledger
  (any move into a reserve account or out of it since D35; never a "left
  over" ask, a transfer change or a bump). This week asks "Update what these
  accounts hold" once nothing is left to do, with the position's likely
  balance in the box, through the ordinary `confirmBalancesAction` (with
  `back=home`). The to-do sentence marks the account the money goes to, and
  the screen sets it in bold and the accent colour.
- **Account scope restricts writes, never reads.** Both spouses see every
  reserve account and every balance, so a household total is never a partial
  picture. An `individual` account can only be renamed, funded, or
  balance-confirmed by its owner (`canWriteAccount` in `src/domain/types.ts`).
  There is deliberately no `canReadAccount`.
- **A card with nothing owed is idle but never gone; a loan paid off is
  done** (PRD D37, rev 63). `isOwing` in `src/domain/debt.ts` is the one test
  for being in the payoff order (the ranking and the lump-sum optimizer both
  read it). `isLineOfCredit` reads the "Credit card or loan" kind as a line of
  credit and a car loan or mortgage as an installment loan. `idleDebtsOf` (a
  line of credit at $0) is listed under "Idle lines of credit" with the same
  balance, terms and remove controls, so a paid-off card can take a new
  balance; `paidOffLoansOf` (a loan at $0) is not shown at all and stays in
  the log. Every debt is in exactly one of the three; never build a list of
  debts from the ladder alone. Because a paid-off loan cannot come back on
  screen, `paysOffLoan` decides when a payment (`balanceAfterPaymentCents`) or
  a statement balance would clear one: the screen asks once
  (`payoff-question.tsx`), the action sends `confirm_payoff=yes`, and
  `confirmDebtPayment` / `updateDebtBalance` refuse without it; adding a loan
  at $0 is refused. When any debt reaches $0 the event that takes it there
  carries `paid_off` (balance before, minimum rule, planned payment, rate,
  type): facts for a future snowball module, never a worked-out figure. A
  card paid in full every month stays at $0 (its bill is spending, not debt),
  and unused credit is never money: a limit is shown, never totalled or
  counted.
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
  with the green-to-red scale `--color-busy-1..5` in `globals.css` (below);
  the number is printed too.
- **Which park, which day is a derivation, and "Use this plan" is the only
  write** (PRD D32, rev 45). `src/domain/park-day-plan.ts` documents the fit
  at its top: the busyness level (`MISSING_BUSYNESS` 5.5 when nothing is
  known, said in the reasons), plus `(1 − PARK_COVER[park]) × RAIN_WEIGHT`
  on a day at or above `RAIN_THRESHOLD_PERCENT` (50), minus
  `HEAT_EARLY_BONUS` (1) for the park that opens earliest on a day at or
  above `HEAT_THRESHOLD_F` (92), minus `LATE_CLOSE_BONUS` (0.5) for a close
  at or after `LATE_CLOSE_HOUR` (21); a park whose hours say it is closed is
  unavailable, and no hours row means unknown, not closed. `planParkDays`
  takes the lowest total fit over the days open to it, day by day never
  taking a park while another has been used less (the days a person chose
  count), ties to the earlier day's quieter park; a greedy pass was tried
  and rejected because it leaves a wet day whatever park is left. Which
  days are open to the plan: a theme-park day or a rest day nobody chose
  and that is not yet gone; never a travel day, a water-park day or
  "somewhere else". "Set by hand" is `trip_days.plan.parkChosen` (in the
  plan JSON, no migration; absent on older rows and read as false): the
  form sets it when the park a person picks differs from what the day was
  (`park_was`), and "Let the plan choose" clears it. `Engine.parkDayPlan`
  gathers the facts and `applyParkDayPlan` derives the proposal again,
  refuses when it differs from what the page showed, and writes each
  changed day through `updateTripDay` (one `trip_changed` event per day,
  `parkChosen` false so a later plan may move it). Nothing about the
  proposal is stored. On screen the number is "fit", never "score", and a
  hand-set day is "your pick". The busyness colours are the green-to-red
  scale `--color-busy-1..5` in `globals.css`: two levels a step
  (`busynessStep`), light green for quiet down to deep red for packed in
  the light theme and, with the lightness anchor flipped, deep green up to
  bright red on a dark card. The order is carried by lightness so it holds
  for colour-blind readers, and the number is always printed beside the
  colour. Before touching it, run the dataviz skill's validator in
  `--ordinal` mode against both card surfaces (`#ffffff`, `#192028`):
  monotone lightness, gaps of at least 0.06, the end nearest the card at
  2:1 or better must all pass; its "single hue" check fails by design,
  because the PRD asks for green to red.
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
- **A part's steady line starts where the person said: "Saving since"**
  (PRD D30, rev 42; D33, rev 46; D35). `line_items.timeline_start`
  (migration 0015) is `'last_occurrence'` for a new part that comes round
  again and `'commit'` for a one-off (a CHECK enforces the latter); the
  column default is `'commit'`. D33 adds `'typed'` with `timeline_start_date`
  beside it (migration 0016; a CHECK makes the date present exactly when the
  choice is typed, written as a text comparison because the migrator applies
  every pending file in one transaction and a value `ALTER TYPE ... ADD VALUE`
  adds cannot be used as the enum until that commits). Where the line starts
  is `steadyLineStart` in `src/domain/position.ts`: the last occurrence, the
  day the plan started (or the part was added), or the typed day, and the
  spend date after a spend; a count never moves it. `PartPosition.savingSince`
  and `PlanPosition.savingSince` (the earliest of its parts: the plan's
  heading and where its chart starts) are computed, never stored. A typed day
  must be on or before today and before the due date (`resolveTimelineStart`
  in `src/domain/types.ts`, one set of plain words for the intake, the engine
  and the forms). The setting is a fact on the part and not part of
  `LineItemSnapshot`; `updateLineItem` records a change of kind or day on a
  `line_item_changed` event with equal money snapshots and
  `timeline_start: { before, after }` beside them, each side a
  `TimelineStartRecord`. On screen the question is "Saving since" with three
  answers (`SavingSinceFields`, at commit and on the part's edit form).
- **Nothing is seeded but the household and the allowlist.** Account names
  belong to a family's real bank, not to the software. The trip planner's
  usual figures are a constant in `src/domain/trip.ts`, laid over by a
  household setting, not a seed.

## Working on it

```bash
npm test            # 704 tests. Database tests skip when DATABASE_URL is unset
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

Before changing any money figure, read the invariants in
`src/domain/__tests__/position.test.ts` (D35). They are a randomised property
test over generated households -- accounts, parts, counts, transfers, transfer
days -- asserting that W is the smallest level transfer that works, that a
Short account always has a Short part and a fix, that lowering never makes an
account Short, and that "All caught up" means nothing is Short. They caught
real bugs while the position was being built; run them with more seeds
(`SEED`/`RUNS` in a scratch copy) after any change to `position.ts`.

## Plain language is a product requirement

PRD §9 carries a binding dictionary: UI copy says "weekly set-aside", not
"accrual"; a part, plan or account is "On track", "Catching up" or "Short"
(D35) -- never "behind" as a status, and never "drift"; "did this get spent?", not
"close-out"; "payoff order", not "priority score". The internal vocabulary
belongs in tooltips. If a non-technical reader needs a translation, the screen
has failed.
