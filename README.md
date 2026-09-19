# Ballast Finance

A self-hosted family reservation engine that answers one question continuously:
**"How much needs to move into each reserve account this week, and are the reserves on pace?"**

It never moves money and holds no bank credentials. Capital One 360 recurring transfers
execute the plan; Simplifi keeps handling aggregation and budgeting. This is the decision
layer — the part that lives in a spreadsheet today.

## Status

Building Phase A of v1 — schema, auth, reserve accounts, the package builder, the accrual
derivations, and the Home/This Week screen. See the PRD for the phase plan.

## Documents

| Document | What it is |
| --- | --- |
| [PRD v1](docs/prd.md) | **Source of truth for the build.** Lives in Claude Docs, not in this repo — it changes over time, so read it live rather than trusting a copy |
| [Product abstract](docs/product-abstract.md) | The problem, v1 scope, core concepts, and data-model principles. Its open-questions list is superseded by the PRD's decisions log |
