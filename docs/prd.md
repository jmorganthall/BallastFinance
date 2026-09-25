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
   `America/Chicago` with a Saturday boundary.
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

Phases A–D, F and Trip-A/B are implemented and tested. What remains before v1 is done is
verification against reality, not more building — see the PRD's acceptance
criteria (§12) and the open items (§13).
