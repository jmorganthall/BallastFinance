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
| `src/domain/` | The engine's math. Pure, tested hardest, no imports from `server` or `db`. `position.ts` is the one position (D35, D40): money today, the run-forward, the level weekly amount and the one-time move, the status words, each part's tick and parts counted automatically, the surplus move between accounts, the derived to-dos, the plan chart. `rollup.ts` only lists plans with their totals; `plan-order.ts` orders the plans list (D41). `trip.ts` is the first planner module: it prices a trip and emits a package through the intake contract. `trip-plan.ts` plans it: the day cut, the booking timeline and its merge, the week comparison, the day plan, reservation money, and the parsers for the crowd calendars and the geocoder. `trip-when.ts` proposes dates: federal holidays, long weekends, the candidate windows and their score, the iCal reader, the DVC listing parser. `park-data.ts` is Ballast's own park data: the weather blend by horizon, the normals, `busynessFor`, the wait-history ranking, the calendar month, and the parsers for Open-Meteo, ThemeParks.wiki, the crowd outlook and Queue-Times. `park-day-plan.ts` proposes which park on which day: the fit score with its plain constants, the day-by-day choice under each-park-once, the diff "Use this plan" would write. `reader-shapes.ts` holds the zod shapes the reader may answer with |
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
  not yet done: `on_track`, `short` (a current bill cannot be paid, with the
  first date), `running_down` (PRD D39, rev 70: every current bill is paid
  but the transfer is below what the repeating bills cost a year,
  `runRatePerWeekCents`, so the money runs out on a later round; calm amber,
  its to-do is a `keep_up` transfer change, and it blocks "All caught up")
  or `unconfirmed`.
  **Each account is one pile, and the tick is what it must hold today**
  (PRD D40, rev 73). Every amount a part needs by a date is a `Slot`
  (`requirementsFor` returns them: the current round, a later round within
  the horizon, the share of the round running at the horizon). `slotTicks`
  takes off each slot the transfers that land on or before it and are not
  already spoken for, soonest first, a surplus carried on; the ticks add up
  to `mustHoldCents`, the least the account must hold today on its bank
  transfer (on the ask, with its move, while unconfirmed).
  `countTowardParts` fills every slot to its tick soonest first, then every
  current round to its total soonest first; money held for a later round is
  in no part's count. Parts are `on_track` / `short` (and `ready_to_spend`);
  Catching up is retired. An account is `short` when a current round is
  below its tick, and `running_down` when only a later round runs out,
  inside the horizon or past it. A part is Short exactly when its account is
  Short and its count is below its `tickCents`, so a bar at or past its tick
  is never Short. Nothing is counted by hand and there is no reshuffle; no
  reshuffle inside one account could lower the weekly amount anyway.
  **Between accounts there is no lending, ever.** An account On track on
  its own confirmed transfer, at or above its run-rate, with `extraCents`,
  is asked to move it into a Short one (`move_between` to-do, the smaller of
  the extra and `missingTodayCents`) before any new money; the Short
  account's own asks are worked out as if the move were made, and
  `position.fixes` carries what fixes each Short account for the plan
  chart. To-dos (`position.todos`) are derived, not issued ahead: marking one
  done records the instruction and its confirmation together
  (`confirmTransfer`, `confirmMoveIn`, and `confirmMoveBetween`, which
  records the move out and the move in in one transaction and needs write
  access to both accounts). The invariants in
  `src/domain/__tests__/position.test.ts` pin the rest: the ticks add up to
  the least the account must hold; a part is Short exactly when it is below
  its tick on a Short account; a Short account always has a Short part and a
  fix, a Running down one none; a surplus move never exceeds the lender's
  extra or what the Short account is missing, and leaves the lender On
  track; lowering never makes an account Short; extra never exceeds money
  today. There is no drift, no
  should-hold, no catch-up bump or ease-off offer and no rate component on
  screen any more.
- **"Did this get spent?" can be snoozed, and a part waiting to be spent is
  Ready to spend** (PRD D38, rev 64). A snooze is a `close_out_snoozed` event
  (migration 0017) with the part, the due date asked about and the day it
  wakes; the latest for the part's current due date decides, and "Wake it up"
  / undo is one that wakes today (`Engine.snoozeCloseOut`). The rules and
  words are in `src/domain/closeout.ts` (`resolveSnoozeUntil`,
  `snoozeDays`, at most `SNOOZE_MAX_MONTHS` 6). Nothing about a snooze reaches
  the position: the part still goes out today, so its money stays held.
  `CloseOutPrompt.snoozedUntil` says it is asleep; This week and the digest
  show only `awakeCloseOuts`, the plan's page shows both. Either spouse may
  snooze: it moves no money. `ready_to_spend` is a fourth `PartStatus`: on or
  past its due date with every cent counted. It is the best status, so a plan
  reads it only when every part does; a past-due part not all there is
  Short, snoozed or not (invariant 6 in `position.test.ts`). It is drawn in
  `--color-accent`, and the plans list carries a `Zzz` mark while a part is
  snoozed. **Money and to-do dates are said as a distance from today**
  (`humanDistance` in `src/domain/next-due.ts`: days under 14, weeks under
  60 days, months under two years) through `When` in `src/components/ui.tsx`,
  with the date on hover or tap (`Hint` now opens on a tap too, via
  `src/components/tip.tsx`). A date inside a to-do sentence is a
  `SentencePart` with `date`, whose `text` keeps the date for the digest.
  Trip and park-calendar dates stay dates. **A plan card is read at a glance**
  (D38 (5), rev 66; D40): `ProgressBar` draws the fill and the white tick
  with a chequered flag above it -- what the account must hold for it
  today; one line "$X of $Y, due in N"; and, when Short, a line under the
  bar saying which account runs short, when, and the fix This week asks for
  (`shortReasons`), not only on a tap. The plan chart (`planChart`) runs
  from today: what will happen on the transfer set up now, and, while Short,
  a dashed line for after the fix; the even-pace steady line is not drawn.
- **Plan cards say the weekly cost and how short, and the list sorts**
  (PRD D41, rev 74). A live card shows "$X a week", the plan's
  `steadyPerWeekCents`, a figure for comparing plans and never the transfer
  (its tooltip names the account whose transfer it is). A Short part or plan
  says "+ $Y to make up" (`MakeUp` in `progress-bar.tsx`): `shortByCents` on
  `PartPosition` (tick less counted while Short, 0 otherwise) and
  `PlanPosition` (its parts' added up), above zero exactly when Short --
  invariant 7 in `position.test.ts`. `barOf` draws the fill and the tick to
  a fraction of a percent and gives `savedPercent`, rounded down, printed
  small beside "$X of $Y". Every card says "Next due: <part>, in N" ("Next
  out" is retired). The order is `src/domain/plan-order.ts`: Next due ·
  Per week · Total · Most short, each reversible, in the address
  (`?sort=&dir=`), never a setting; live, then drafts, then done; a draft
  falls back to Next due under the two figures it lacks.
- **Smart saving is the headline, and a plan shows why it lands on time**
  (PRD D50, rev 96). This week opens with `SmartSavingCard`
  (`src/components/smart-saving.tsx`): "$W a week covers all N plans" from
  `smartSaving` in `position.ts`, W the accounts' `neededPerWeekCents`
  against their `steadyPerWeekCents` (each plan saving on its own), and the
  difference a week and × 52 a year (parts on or past their date left out
  of on its own); when W is as much or more, or while any account with a
  plan is Short, unconfirmed or asked for a one-time move
  (`coversOnItsOwn` false), the weekly figure alone and nothing claimed. `planChart` also returns `onItsOwn`
  (each part's `evenPaceCents` from its Saving since, on the chart's own
  dates) and `story` (`PlanStory`, D50 (10), rev 98): what is below its
  own pace and where that money is (`heldBy`: other plans in the same
  account holding more than their own pace, due sooner or later, each up
  to its excess, worked out account by account and never netted across
  accounts; the rest still to come), the stretches of transfers ahead
  (`phases`, read off the run-forward transfer by transfer: `filling` when
  money comes here, `waiting` for two transfers or more that bring under
  `PHASE_MIN_RISE_CENTS` ($1), each naming the other plans the same
  transfers pay, and `rolledOff`, the ones the stretch before paid and this
  one does not, three named and `othersMore` / `rolledOffMore` counting the
  rest), the day it is full (`full`), and the day. The plan's page
  draws the dashed "Saving it on its own" line with the space below it
  shaded and numbered badges over the stretches (`StretchBadge`); that line
  is `--color-chart-pace`, a blue validated with the dataviz skill's
  validator on both card surfaces beside the ink line and the green
  after-the-fix line, so it is never read as the plan's own line. On a
  plan of more than one part, a numbered green pin (`DuePin`) stands on
  the axis where each part is due (`dueMarks` from `dueMarksOf`: soonest
  first, parts due the same day on one pin, none already past; empty for
  one part, whose date is the chart's end), and hover or a tap says
  "<part> · $X · <date>" through `Tip` (`above`, `plain`). The pins are
  HTML over the SVG so the words open on a phone; and
  `PlanStory` (`src/components/plan-story.tsx`) says "Where the money is
  today" and "What happens next" with the same numbers (the first stretch "Now to <end>", since it
  always starts with the next transfer, each later one "In N · start to
  end", and one line: where the money is focused while nothing
  comes here, or which plans are covered so money starts coming here, about
  $X a transfer, to $Y), then "On track:
  all $X due in N" only when `story.onTrack` (the plan On track, every
  account it is in On track on a confirmed transfer, and all of it there
  on the day). The chart scrolls sideways inside its card on a phone. It
  is a comparison and never a target: nothing judges a plan
  by it, and no screen says "behind", "lent" or "guaranteed". This brings
  back the line D40 (5) took off the chart, with that job and that name.
- **A move marked done is money the account holds until the next count**
  (PRD D34, rev 47). Which moves and spends came after the last count is the
  order the events were recorded (`recorded_at`, then id), answered only by
  `Engine.positionInput`; `doneMoveOf` decides whether a confirmation is a
  move on the ledger (any move into a reserve account or out of it since
  D35; never a "left over" ask, a transfer change or a bump). There is no
  second since-count ledger: the words come from the position's own
  breakdown, `AccountMoneyToday` (the count, transfers, `movesInCents`,
  `movesOutCents`, openings and spends since), said in one sentence by
  `moneySinceParts` / `moneySinceSentence` through `MoneySince`
  (`src/components/money-since.tsx`) on check-in and This week and in the
  account card's tooltip, so a spend can never change the number without
  changing the words. `money.countOwed` (a move or a spend marked done
  since the count; a transfer alone never) is the one answer to "ask what
  this account holds": This week asks "Update what these accounts hold" and
  the digest says the same once nothing else that moves money is left to
  do, with the position's likely balance in the box, through the ordinary
  `confirmBalancesAction` (with `back=home`). The last count is
  `money.from === 'count'` and `money.on`; the check-in nudge reads it
  there. An open "cover what is short" move, like an old catch-up, stands in
  for the one-time move the position would ask for, so the same money is
  never asked for twice. "Yes, spent" left blank records the part's own
  total, read by the engine, never a figure the form posted. The to-do
  sentence marks the account the money goes to, and the screen sets it in
  bold and the accent colour.
- **A debt's balance is the last one stated, less the payments since**
  (PRD D49 (1)-(2)). `debts.balance_cents` / `balance_as_of` are the last
  balance a person stated (a statement, the edit form, or the zero a payment
  that clears it writes), and `balance_recorded_at` (migration 0018) is when.
  `Engine.listDebts` takes off every payment recorded after that moment
  (`balanceAfterPayments` in `src/domain/debt.ts`): a `payment_confirmed`
  from the payment form, or "Done" on a `debt_payment` to-do (its actual
  amount, else the amount asked; one per instruction). The comparison runs in
  SQL so the timestamps keep their precision. A payment never moves
  `balance_as_of`: only a statement says when the balance was last checked.
  Never write a payment into the row. With a `payment_day` (D49 (3),
  migration 0019) the balance a screen reads is `likelyDebtBalance`: each
  payment day since the statement charges a month's interest at the rate in
  force and takes the regular payment (planned, else the minimum), the way an
  account assumes its confirmed transfer runs. A payment on the form is the
  regular one and replaces that month's assumed payment; a to-do's payment is
  a share-out's extra and comes off on top. `Debt.statedBalanceCents` carries
  the stated figure beside it ("likely" on Debts).
- **One status per debt** (PRD D49 (4)-(7)). `debtStatuses` in
  `src/domain/debt-status.ts`, read through `Engine.debtStatuses()`, is the
  only place a debt's status, its words (`debtStatusLabel`,
  `debtStatusLine`) and its to-dos are worked out; Debts, This week, the
  digest, the share-out's warning and its "cover what is short" reasons all
  read it. A deal the payments will not clear is "Misses its 0%" ("Misses its
  deal" off 0%), calm amber, and red "Short" inside `promo_lead_weeks`; the
  figures are `promoCliff`'s. Its to-do raises the monthly payment
  (`raise_debt_payment`, Done records `plannedPaymentCents`) and blocks "All
  caught up" (`householdCaughtUp`). A stated balance older than
  `BALANCE_STALE_AFTER_DAYS` (30) is an `update_debt_balance` to-do:
  housekeeping, never blocking. "Done" on a pay-a-debt to-do carries a box
  for what was actually paid.
- **A missed deal can charge its interest back** (PRD D49 (9)-(10)).
  `PromoRule.chargedBack` (absent: nobody has said, taken as yes, and a
  one-time `check_deal_terms` to-do asks) and `PromoRule.startDate` (absent:
  `debts.entered_on`, migration 0020) live in the `promo_rules` JSON. In
  `simulateMonths` a deal rolls off before the first payment that lands
  after its end -- the cliff's count of payments, so the projection and
  `promoCliff` agree -- and, unpaid and charged back, adds the full rate on
  each month's deal balance since its start (`chargedBackInterestCents`).
  "Interest left to pay" on Debts is `projectPayoff`'s total, with a bar
  against the costliest (`shareOfLargest`). The fine print sits in a
  collapsed "More about this deal" on the debt's form.
- **Each debt has its own page, `/debts/[id]`** (PRD D49 (11)), opened from
  its name on Debts: its status and deal; the balance from today to payoff
  with the deal's end marked (`payoffSchedule`, the projection's own months
  through `simulateMonths`' `onMonth`); a what-if by GET (`debtWhatIf`,
  extra a month or once, nothing stored); each payment split into paydown
  and interest (`paymentSplits`, years past 36 months) with a table view;
  and the history from the event log (`Engine.debtHistory`). The charts are
  `src/components/debt-charts.tsx`, inline SVG like the plan chart, in
  `--color-chart-paydown` / `--color-chart-interest`, a pair validated with
  the dataviz skill's validator on both card surfaces (the dark values sit
  in the dark lightness band, so they are not the accent and caution
  tokens). `debt_updated` now records `planned_payment_cents` too, so a
  raised payment shows in the history.
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
  `homeIsLocated()` before measuring a drive. The crowd site and
  Nominatim are unreachable from the build sandbox: the parsers are tested on
  fixtures, Thrill Data's copied from the live page the household's server
  fetched. Undercover Tourist answers an honest User-Agent with 403 and is no
  longer tried.
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
  `ropedrop_outlook_url`, parsed defensively; there is no default address:
  the first one shipped was a guess never seen live and answered 404, so the
  outlook runs only when a person sets an address that works), Queue-Times (park names in
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
  `summariseWaits`, and the ranking stays in the domain. "Refresh park data"
  also checks the crowd calendar (Thrill Data's year page,
  `/resort/wdw/<year>`, one `cal-cell lN` per day for the whole resort, read
  as park `other` at level 2N − 1; the reader only after it gave nothing)
  for the month shown and the next,
  through `Engine.checkCrowds`, and holds what came back on `/trips` for a
  person to keep (D42); it is the same hold "Check how busy" uses on a trip. Jobs
  (`PARK_WEATHER_CRON`, `PARK_HOURS_CRON`, `WAIT_POLL_CRON`, all off with
  `PARK_DATA_FETCH=off`, each off with its cron set to `off`) run once
  through the first household's engine, not per household. The calendar
  (`ParkCalendar`, on `/trips` and at the top of a trip's When section) is
  server-rendered with `?month=` and `?day=` links and colours busyness
  with the green-to-red scale `--color-busy-1..5` in `globals.css` (below);
  the number is printed too.
- **The calendar reads at a glance** (PRD D48, rev 88). No legend and no
  symbols: a cell's background (`--color-noschool`) is a day with no school
  (`CalendarCell.noSchool`: a weekend or a day off school; a federal holiday
  alone is a school day), black stripes (`--color-cantgo`) a day we cannot
  go, the busy bar on a card-coloured track with its number, the high and
  low faded unless forecast; the rest is in the tooltip and the tapped day's
  detail (beside the month on a wide screen). Above it, `yearStrip` (the
  next twelve months, a sliver a day, through `Engine.calendarYear`).
  `/trips` and a trip's page mark themselves `data-wide`, which lifts the
  shell's `max-w-2xl` (`has-[[data-wide]]` in `(app)/layout.tsx`); other
  pages keep one column. The `@theme` block is `static` because colours
  read as `var(--color-busy-${step})` from code are invisible to Tailwind's
  scan, and light mode silently lost busy steps 2-5 without it.
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
npm test            # 776 tests. Database tests skip when DATABASE_URL is unset
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
part is Short exactly when its own date is on or after its account's short
day and a Short account always has a fix, that lowering never makes an
account Short, and that "All caught up" means nothing is Short. They caught
real bugs while the position was being built (and D40's: a later round once
made a part due this week read Short); run them with more seeds
(`SEED`/`RUNS` in a scratch copy) after any change to `position.ts`.

## Plain language is a product requirement

PRD §9 carries a binding dictionary: UI copy says "weekly set-aside", not
"accrual"; a part, plan or account is "On track" or "Short" (D35, D40;
"Catching up" is retired), an account also "Running down" (D39) -- never
"behind" as a status, and never "drift"; "did this get spent?", not
"close-out"; "payoff order", not "priority score". The internal vocabulary
belongs in tooltips. If a non-technical reader needs a translation, the screen
has failed.
