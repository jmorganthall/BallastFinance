# Smart saving is the headline (PRD D50)

PRD: D50 in the decisions log, rev 96. The PRD is the source of truth; this
file records how the build reads it and the calls the builder made.

## Why

A person does the napkin math on a plan ("I've put in $X a week for Y weeks,
so it should hold about Z"), sees much less, and stops trusting the numbers.
The reason is Ballast's whole point: an account is one pile, the soonest dates
are paid first out of the money already there, so the transfer is far smaller
than every plan saving on its own ($190 against $456 in the household's
Annual Expenses). Today that is one line of small print under the account
card. It becomes the headline, and a plan below its own pace shows where its
money is and how it still lands on its date.

## What gets built

1. **The headline on This week** (mockup 1A). Above "All caught up" / the
   attention card: "$W a week covers all N plans", a bar for each plan on its
   own against a bar for Ballast, and a pill "$D a week less" with "$D×52 a
   year". When D ≤ 0 only "$W a week covers all N plans" shows. Hidden when
   there is no live plan.
2. **The plan chart** (mockup 2C), on the plan's page. Adds the dashed
   "Saving it on its own" line, shades the space where the plan's line is
   below it, marks the turning point, and marks the due date.
3. **The story in steps** (mockup 2E), under the chart: Now, the turning
   point (when there is one), the due date.
4. **The promise** under the steps for an On track plan: "On track for
   <due>. Ballast checks every date in this account each week, and would say
   Short with the fix if the transfer stopped being enough." Never
   "guaranteed".

## Definitions (all in `src/domain/position.ts`, nothing stored)

- **W** — the sum of `neededPerWeekCents` over accounts with at least one
  live part: what each account card says it needs. *Builder's call*, written
  into D50 (1): both sides of the comparison are "what it takes", so a bank
  transfer that is too high or too low does not distort the headline.
- **On its own** — the sum of `steadyPerWeekCents` over those accounts (= the
  plans' D41 weekly costs added up).
- **D** — on its own − W. **A year** = D × 52 (*builder's call*: 52 transfers).
- **N** — live plans with at least one live part.
- **Saving it on its own line** — at each chart date, the sum over the
  plan's parts of `evenPaceCents` from the part's Saving since to its due
  date (the one pace). Same dates as the plan's line.
- **Below** — max(0, on its own today − counted today).
- **Covering** — other plans' parts in this plan's accounts whose outflow
  date is before this plan's last due date and whose counted is above their
  own `savedForCents`; covering = min(below, the sum of those excesses). Named
  by plan name, soonest first, deduplicated. **Still to come** = below −
  covering.
- **Turning point** — for each due date d of another plan's part in this
  plan's accounts strictly after today and before this plan's last due date:
  split the plan's per-transfer rises at the first transfer day after d; the
  average rise after less the average rise before. Take the largest; it must
  be at least 1.5× the before-average and at least $1 a week more, else no
  turning point. The turning point carries d, what the plan holds by d, the
  average rise after ("about $P a week comes here"), and the plans paid on d.
- The chart still starts today (D50 (6)).

## Non-goals and anti-goals

- No change to any status, tick, to-do, weekly amount or the run-forward.
  The on-its-own line is a comparison; nothing reads it to judge.
- Never the words "behind", "lent", "borrowed", "guaranteed", "drift".
- No history redrawn before today.
- The account card's small print stays (it is detail; the headline now
  carries the point).
