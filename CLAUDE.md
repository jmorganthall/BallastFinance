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
| `src/domain/` | The engine's math. Pure, tested hardest, no imports from `server` or `db`. `trip.ts` is the first planner module: it prices a trip and emits a package through the intake contract. `trip-plan.ts` plans it: the day cut, the booking timeline and its merge, the week comparison, the day plan, reservation money, and the parsers for the crowd calendars and the geocoder |
| `src/db/` | Drizzle schema and the connection. Facts only |
| `src/server/` | The service layer, session bridge, server actions, scheduled jobs. `market-rate.ts` and `trip-fetch.ts` are the only outbound data calls (FRED CSVs, the OSRM router, Nominatim for the home address, and two public crowd calendars; public, key-free, each switchable off by env, every request with the app's own User-Agent) |
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
- **The week boundary is Saturday**, matching the Capital One transfer and the
  digest. A "week" in the accrual math is one Saturday transfer.
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
- **Nothing is seeded but the household and the allowlist.** Account names
  belong to a family's real bank, not to the software. The trip planner's
  usual figures are a constant in `src/domain/trip.ts`, laid over by a
  household setting, not a seed.

## Working on it

```bash
npm test            # 588 tests. Database tests skip when DATABASE_URL is unset
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
