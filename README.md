# Ballast Finance

A self-hosted family reservation engine that answers one question continuously:
**"How much needs to move into each reserve account this week, and are the reserves on pace?"**

It never moves money and holds no bank credentials. Capital One 360 recurring transfers
execute the plan; Simplifi keeps handling aggregation and budgeting. This is the decision
layer — the part that lives in a spreadsheet today.

## Status

**Phase A is built and verified.** Schema, auth, reserve accounts, the package builder via
the intake contract, the accrual derivations, and the Home/This Week screen all work
end to end against a live PostgreSQL 16.

| Phase | Contents | Status |
| --- | --- | --- |
| A | Schema, auth + household, reserve accounts, package builder, accrual derivations, Home/This Week | **Done** |
| B | Check-ins, drift, close-out, instructions, n8n notifications, weekly digest | Next |
| C | Simulate → commit, what-if overlay, Allocate screen | Not started |
| D | Debt inventory, scoring + slider, ladder, projections, lump-sum optimizer | Not started |

See [running it](docs/running-it.md) to get it going.

## Documents

| Document | What it is |
| --- | --- |
| [PRD v1](docs/prd.md) | **Source of truth for the build.** Lives in Claude Docs, not in this repo — it changes over time, so read it live rather than trusting a copy |
| [Product abstract](docs/product-abstract.md) | The problem, v1 scope, core concepts, and data-model principles. Its open-questions list is superseded by the PRD's decisions log |
| [Running it](docs/running-it.md) | Local development, the two database roles, and Unraid deployment |

## How it is put together

The engine is the product; Capital One and Simplifi are adapters. Three rules hold the
shape (PRD §10):

1. **`src/domain` is the only place math lives.** Pure functions, zero I/O, "today" always
   a parameter. The UI, the jobs and the API all call it; nothing recomputes an accrual
   for itself.
2. **Facts are stored, derivations are computed.** No weekly rate, curve, drift figure or
   score is ever written to the database. If it can be recomputed, it is a view.
3. **One write path.** Everything goes through `src/server/engine.ts`, which is bound to a
   single household at construction — so cross-household access is not something a caller
   has to remember to avoid, it is something they cannot express.
