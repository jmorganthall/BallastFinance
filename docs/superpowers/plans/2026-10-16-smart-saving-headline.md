# Smart Saving Headline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "$W a week instead of $X" the headline on This week, and show on each plan why a plan below its own pace still lands on its date (PRD D50).

**Architecture:** Two pure derivations in `src/domain/position.ts`: `smartSaving(position)` and an extended `planChart` that adds the on-its-own line and a `story`. Screens only draw them: a new `SmartSavingCard`, the existing `AccrualChart`, and a new `PlanStory`.

**Tech Stack:** TypeScript, Next.js server components, inline SVG, vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-smart-saving-headline-design.md` (PRD D50, rev 96)

## Global Constraints

- Money is integer cents; never a float in a stored or shown figure.
- All math in `src/domain`; components render only (CLAUDE.md rule 1, 4).
- Nothing new is stored; no migration.
- Copy never says "behind", "lent", "borrowed", "guaranteed", "drift".
- Colours are existing tokens from `src/app/globals.css`; blue (`--color-accent`) in a plan chart means only Ready to spend (D38 (5)).

## Review Focus

- A plan already above its own pace: below = 0, no shading, no "covering" words.
- A Short plan: the after-fix line and red words stay; no "On track for" promise; the due step says what the transfer set up now reaches.
- A plan due within a week (one transfer day): no turning point, chart still draws.
- A plan whose parts sit in two accounts: covering and turning point look at both accounts.
- Chart sampling (`maxPoints` stride): the on-its-own line uses exactly the actual line's dates; the turning point is found on the unsampled series.

---

### Task 1: `smartSaving` — the headline figures

**Files:** Modify `src/domain/position.ts`; Test `src/domain/__tests__/position.test.ts`

**Interfaces — Produces:**
```ts
export interface SmartSaving {
  withBallastPerWeekCents: Cents   // Σ neededPerWeekCents, accounts with a live part
  onItsOwnPerWeekCents: Cents      // Σ steadyPerWeekCents, same accounts
  lessPerWeekCents: Cents          // max(0, onItsOwn − withBallast)
  lessPerYearCents: Cents          // lessPerWeek × 52
  planCount: number                // plans with ≥ 1 live part
}
export function smartSaving(p: Pick<HouseholdPosition, 'accounts' | 'plans'>): SmartSaving | null // null: no live plan
```

- [ ] Test `smart saving (D50)`: on the Disney fixture (Phase A acceptance block) `withBallast` = 21177 + 7059 rounded as `neededPerWeekCents` sums, `onItsOwn` = Σ accounts' `steadyPerWeekCents`, `less` = difference, `lessPerYear` = less × 52, `planCount` = 1; a household with no line items → `null`; a household where W ≥ on its own → `lessPerWeekCents` 0.
- [ ] Run `npx vitest run src/domain/__tests__/position.test.ts -t "smart saving"` → FAIL.
- [ ] Implement; add it to the randomised invariants: `lessPerWeekCents ≥ 0` and `lessPerYearCents === lessPerWeekCents * 52`.
- [ ] Run → PASS. Commit.

### Task 2: the plan chart's on-its-own line and story

**Files:** Modify `src/domain/position.ts` (`PlanChart`, `planChart`); Test `src/domain/__tests__/position.test.ts`

**Interfaces — Produces:**
```ts
interface PlanChart { /* existing */ onItsOwn: PlanChartPoint[]; story: PlanStory }
export interface PlanStory {
  now: { cents: Cents; onItsOwnCents: Cents; belowCents: Cents; coveringCents: Cents;
         covering: { packageId: Id; name: string; dueDate: CivilDate }[]; toComeCents: Cents }
  turn: { on: CivilDate; cents: Cents; perWeekAfterCents: Cents; paid: { packageId: Id; name: string }[] } | null
  due: { on: CivilDate; cents: Cents; totalCents: Cents }   // cents = actual's last point
}
```
`planChart` takes `household: Pick<HouseholdPosition, 'accounts' | 'fixes' | 'plans'>` (plans for names). Algorithms per the spec's Definitions.

- [ ] Tests in `describe('the plan chart (D50)')`, one account, Friday transfers, TODAY 2026-09-28:
  - `soon` plan $1,200 due 2026-12-25 and `trip` plan $4,000 due 2027-09-24, Saving since typed 2026-06-26 on the trip, account counted $1,000 today, transfer confirmed at the account's `weeklyCents`: `onItsOwn` has `actual`'s dates; its last point is 400000; `story.now.belowCents` = onItsOwnToday − counted; `covering[0].name` = 'soon' plan's name; `coveringCents + toComeCents === belowCents`; `turn.on` = '2026-12-25' and `turn.paid[0].name` the soon plan; `perWeekAfterCents` > the before-average.
  - A plan above its own pace (counted ≥ on its own) → `belowCents` 0, `covering` [], `turn` null when the line is even.
  - The existing Short test still passes and `story.due.cents < story.due.totalCents`.
- [ ] Run → FAIL. Implement. Randomised invariants: `onItsOwn.length === actual.length`; every on-its-own point ≤ total; `covering + toCome === below`; `covering ≤ below`.
- [ ] Run whole file → PASS. Commit.

### Task 3: the headline card on This week

**Files:** Create `src/components/smart-saving.tsx`; Modify `src/app/(app)/page.tsx`

**Interfaces — Consumes:** `smartSaving` (Task 1).

- [ ] `SmartSavingCard({ saving }: { saving: SmartSaving })`: "Your weekly set-aside"; big `$W` + "a week covers all N plans" ("1 plan"); when `lessPerWeekCents > 0`: two bars ("Each plan on its own" full width in `--color-line`-ish fill, "With Ballast" at W/onItsOwn width, the bar width a domain-given fraction — add `withBallastShare` (0–1, 4 decimals) to `SmartSaving` and its test), a pill "$D a week less" in `--color-ahead-soft`/`--color-ahead`, and "That's $Y a year. Ballast pays whatever is due soonest out of the money already set aside, so the transfer stays low." Hint on the bars naming both figures exactly.
- [ ] Render it first under the page header when `smartSaving(position)` is not null.
- [ ] `npm run typecheck` → clean. Commit.

### Task 4: the chart, the steps, the promise on the plan page

**Files:** Modify `src/components/accrual-chart.tsx`, `src/app/(app)/packages/[id]/page.tsx`; Create `src/components/plan-story.tsx`

- [ ] `AccrualChart`: draw `onItsOwn` dashed in `--color-ink-soft`; the plan's line solid in `--color-ink`; shade between the two where the plan's line is below (`--color-ink-soft`, opacity .12) replacing the area under the line; a dot at `story.turn` with a `<title>`; a dot at the end in `--color-ahead` when `due.cents ≥ totalCents`. Legend: "Saving it on its own", "On the transfer set up now" (keeps "(ends $X short)"), "After the fix on This week" when present, "Covering sooner bills" swatch when `belowCents > 0`. y-scale tops at max(total, on-its-own max).
- [ ] `PlanStory({ story, today, status })`: three steps (two without a turn), per mockup 2E copy:
  - Now: `$cents`; when below > 0: "Saved on its own it would hold $X." + when covering > 0 "$A of that is paying <names> first." + when toCome > 0 "$B more comes from the transfer on the way."; else "That is at or ahead of saving it on its own."
  - Turn: `$cents`, "<names> paid <When>. From then about $P a week comes here."
  - Due: `$total` green when `due.cents ≥ total`, "All of it, <When due>." else `$due.cents` with "on the transfer set up now; all $total after the fix on This week."
  - Under them, when status is `on_track`: the promise line from the spec, `--color-ahead-soft` background.
- [ ] Render `PlanStory` under the chart in the "How the money builds up" card.
- [ ] `npm run typecheck && npm test` → clean. Commit.

### Task 5: docs and the look

**Files:** `CLAUDE.md`, `docs/prd.md`

- [ ] CLAUDE.md: a "Smart saving is the headline" bullet (D50, rev 96) naming `smartSaving`, `PlanChart.onItsOwn`/`story`, and the no-judging rule; update the test count.
- [ ] docs/prd.md: a D50 row in Build status.
- [ ] Render the plan page and This week with the Disney demo data (or a page rendering the components with domain output) in light and dark; fix what looks wrong.
- [ ] Commit.
