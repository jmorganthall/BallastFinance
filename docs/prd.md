# PRD v1 — lives in Claude Docs

The Ballast Finance PRD is **not stored in this repository**. It is a living Claude Docs
document, and it is the source of truth for the build.

**[Ballast Finance — PRD v1](https://claude.ai/code/artifact/90c0f7fc-e538-45b2-b2b6-dcd4efaf2a3f)**

- Claude Docs id: `90c0f7fc-e538-45b2-b2b6-dcd4efaf2a3f`
- Companion: [product abstract](product-abstract.md) (also mirrored as a Claude Doc, id `62d37afe-b369-4757-8336-664cf872a6d0`)

## Why there is no copy here

The PRD changes as the build teaches us things. A markdown snapshot in this repo would
silently go stale, and a stale spec that *looks* authoritative is worse than no spec —
someone would build against it without knowing it had drifted.

So: **read the live document.** Do not paste its contents into this repo. If you need a
point-in-time record of what was built against, cite the document's revision number
(every read returns one) in the commit or PR that did the work.

## What it contains

Sixteen sections: overview and the D1–D9 decisions log, users/auth/household, the data
model, the Package Intake contract, the Reservations module (accrual math), the Allocation
Engine, Debt Priorities, notifications, UX requirements, architecture, security, build
phasing, out-of-scope/open items, the income module (§14), the equity and next-home module
(§15), and the trip planner (§16, Disney first).

## Constraints the PRD marks non-negotiable

Repeated here because they bind every commit, and because a builder who reads only the
repo still has to know them. Everything else: read the document.

1. **Decisions log D1–D9** (PRD §1) is binding.
2. **Structural rules** (PRD §10): the derivation module is the only place math lives; all
   writes go through the engine's service layer; events are append-only and enforced by
   revoking `UPDATE`/`DELETE` at the DB role; money is integer cents; weeks are computed in
   `America/Chicago` with the household's transfer day as the boundary (D31, rev 44:
   setting `transfer_weekday`, Saturday until a person picks a day).
3. **Facts stored, derivations computed** — nothing derived is persisted (D9). A cache is
   permitted later only if it is rebuildable and never load-bearing.
4. **Build phase by phase** (PRD §12, phases A–D), each usable and verified before the next.
5. **No bank credentials and no money movement**, ever.

## Build status

| Phase | Contents | Status |
| --- | --- | --- |
| A | Schema, auth + household, ReserveAccounts, package builder via intake, accrual derivations, Home/This Week | Built |
| B | Check-ins, drift, close-out, instructions, n8n notifications, weekly digest | Built |
| C | Simulate → commit, what-if overlay, Allocate screen | Built |
| D | Debt inventory, scoring + slider, ladder, projections, lump-sum optimizer | Built |
| E | Income and recurring expenses (§14) | Specified, not built |
| F | Equity and next home: homes and vehicles, weekly mortgage rate, "What could we buy?" (§15, PRD rev 26) | Built |
| Trip-A/B | Trip planner, Disney first: trips, ways to do it, the usual figures, the drive and gas-price fetches, "Add to Plans" (§16, PRD rev 35) | Built |
| Trip-C | Favourite dining list (§16) | Not built |
| Trip-D | Planning the trip: candidate weeks and how busy they are (crowd calendar, D23), the booking timeline and checklist, the days, reservations with confirmations, home as an address found on the map once (D22–D24, PRD rev 37) | Built |
| Trip-E | When to go: the household school calendar (typed, iCal, or read from the district's PDF), federal holidays, long weekends, the ten best weeks with reasons; DVC broker listings behind a parser; the reader behind an environment key, used only where a parser fails (D25–D27, PRD rev 38) | Built |
| D30 | A repeating part's timeline starts at its last occurrence: `timeline_start` on the part, the base component from the last occurrence at the steady rate, no opening offered for such a part, a checkbox at commit and on the part's edit form (PRD D30, rev 42) | Built |
| D31 | The transfer day is a household setting: `transfer_weekday` (default Saturday) under Settings as "Our transfer runs on"; one definition of the week count in `src/domain/dates.ts`, the day threaded as `transferWeekday` beside `today` through every count; the digest sent on that day, `DIGEST_CRON` naming only the time (PRD D31, rev 44) | Built |
| Trip-F | Ballast's own park data and the calendar: weather by horizon (Open-Meteo), park hours (ThemeParks.wiki), the crowd outlook (RopeDrop Planner), live waits polled into a wait history (Queue-Times) and ranked to 1–10; busyness derived through one function; a month grid on `/trips` and at the top of each trip's When section, with "Refresh park data" (D28–D29, PRD rev 41) | Built |
| Trip-G | Which park, which day: a proposed park for each open day from how busy, the weather and the park hours, with the reasons in words, applied only by "Use this plan"; a day set by hand is "your pick" and planned around; each park once before any repeats; busyness coloured green (quiet) to deep red (packed) with the number beside it, validated in both themes (D32, PRD rev 45) | Built |
| D33 | "Saving since" is a date a person can see and change: `timeline_start` gains `typed` with `timeline_start_date` beside it (migration 0016); one question with three answers at commit and on the part's edit form; the plan headed, and its chart started, by the earliest day any part runs from; a part's own date and the reason in words when it differs; a typed day inert on a cycle a count, a roll or money began; every change a `line_item_changed` event with equal snapshots and `timeline_start { before, after }` (PRD D33, rev 46) | Built |
| D34 | A move marked done is money the account holds until the next count: `OpenCommitments.doneMoves` carried by `committedAfter`, the order of events deciding which moves came after the last count; "Update what these accounts hold" on This week once the to-dos are done, with the likely balance filled in and recorded through the ordinary check-in path; the same hint on the check-in screen; the to-do sentence names the destination account in bold and the accent colour (PRD D34, rev 47) | Built |
| D35 | One position: every money figure from one function, `position()` in `src/domain/position.ts`. Each account runs forward on the transfer confirmed at the bank to its furthest due date (and past it when the transfer is below the repeating parts' run-rate); the weekly amount is the smallest level transfer that meets every date, never below the run-rate, with a one-time move for a gap four transfers away or fewer; statuses On track / Catching up / Short everywhere; parts counted automatically, soonest due first; to-dos derived ("set the transfer", "move $M by"), marked done in one step; "All caught up" when every account is On track on its confirmed transfer; the plan chart's steady line and yellow catch-up line. Retired: drift, should-hold, catch-up bumps and ease-offs, counting the extra, the reshuffle, rate components on screen (PRD D35, rev 61) | Built |
| D37 | A card with nothing owed is idle but never gone; a loan paid off is done: `isOwing` is the payoff order, `idleDebtsOf` (a credit card or loan at $0) is listed under "Idle lines of credit" with its rate, any running promotion, its limit and the usual controls, and `paidOffLoansOf` (a car loan or mortgage at $0) leaves the screen and stays in the log; a payment or statement balance that would clear a loan asks once first and the engine refuses without the answer; adding a loan at $0 is refused; the event that takes any debt to $0 notes the facts as they stood (`paid_off`) for a future snowball module; a card paid in full every month stays at $0; unused credit is never money (PRD D37, rev 63) | Built |

Phases A–D, F, Trip-A/B/D/E/F/G, D30–D35 and D37 are implemented and tested. What remains before v1 is done is
verification against reality, not more building — see the PRD's acceptance
criteria (§12) and the open items (§13).
