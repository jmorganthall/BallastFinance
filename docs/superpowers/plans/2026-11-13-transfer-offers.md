# Transfer Offers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A debt can carry a standing transfer offer, and "Is a transfer worth it?" works out how much to move, from which debts, the net savings and how much sooner it is paid off, for a stored debt or an imagined card.

**Architecture:** The offer is one nullable jsonb fact on `debts` (migration 0030), written through `createDebt`/`updateDebt` with its event. The calculation is one pure domain function, `transferCheck` in `src/domain/debt-transfer.ts`, built on the debt projection (`simulateMonths`). A GET page, `/debts/transfer`, calls it the way the debt's page calls `debtWhatIf`.

**Tech Stack:** TypeScript, Next.js 15 app router, Drizzle + PostgreSQL 16, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-transfer-offers-design.md` (PRD D61, laid as a suggestion at rev 117)

## Global Constraints

- Money is integer cents and rates are basis points. Never use a float in a stored or compared figure.
- The fee rounds **up** to the cent: `max(feeMinCents ?? 0, ceil(A × feeBasisPoints / 10 000))`.
- Both sides of the comparison use each debt's own payment rule. The target also gets `freed = Σ monthlyPaymentCents(source, today) − monthlyPaymentCents(sourceAfter, today)` as `extraPerMonthCents`, where a source moved in full pays 0.
- Sources: `consumer`, open, balance > 0, not the target, `currentDeal(d, today) === null`, and APR > the offer's rate. Fill order is APR high to low, then balance high to low, then name.
- Target: `consumer`, carries an offer, and has no live deal. If the offer ends, the target's balance must be 0.
- An offer with no end has no rate of its own. It uses the debt's APR.
- Recommendation steps are $100 at the finest. Ties go to the smaller amount. Not worth it when the best net savings ≤ 0.
- When any candidate never pays off, every candidate is compared over 120 months.
- Plain words on screen: "transfer", "fee", "saves", "paid off", "0% deal". Never "optimal" or "APR delta".
- Nothing about the calculation is stored. No to-do is created, and no status or "All caught up" changes.

## Review Focus

1. **A typed amount above the most that fits.** Clamp it to the most and say so next to the box (test in Task 2).
2. **The fee minimum is larger than the room.** The most is 0, and the screen says no transfer fits, without crashing (Task 2).
3. **A source with a planned payment that moves only part of its balance.** Its payment stays the same, so freed is 0 (Task 2).
4. **Try a card with no minimum payment typed.** The form problem shows in place and nothing is calculated (Task 3).
5. **A stored target with no credit limit.** The page asks for `?limit=` and never writes it (Task 5, by hand in the browser).

---

### Task 1: The offer as a domain fact

**Files:** Modify `src/domain/debt.ts`. Test `src/domain/__tests__/debt-transfer.test.ts` (new).

**Produces:**
- `interface TransferOffer { rateBasisPoints?: number; months?: number; untilDate?: CivilDate; feeBasisPoints: number; feeMinCents?: Cents; transferBy?: CivilDate; chargedBack?: boolean }`
- `Debt.transferOffer?: TransferOffer | null`
- `offerEnds(o): boolean`: true when `months` or `untilDate` is set
- `validateTransferOffer(offer, aprBasisPoints, category): void`, which throws `DebtDataError`. It rejects:
  - a non-consumer debt
  - both `months` and `untilDate` set
  - an offer that ends but has no rate
  - an offer that ends with a rate ≥ the APR
  - an offer with no end that has a rate
  - months that are not between 1 and 60
  - a fee that is not between 0 and 2000 basis points
  - a negative fee minimum
- `projectWithin({ debt, today, extraPerMonthCents, horizonMonths }): { interestCents }`, a thin export over `simulateMonths`
- `TERM_WORDS.transfer_offer = 'transfer offer'`

- [ ] Write the failing tests for `validateTransferOffer`, covering each refusal plus one valid offer of each kind.
- [ ] Implement the code, run `npx vitest run src/domain/__tests__/debt-transfer.test.ts`, and confirm it passes.

### Task 2: `transferCheck`

**Files:** Create `src/domain/debt-transfer.ts` and export it from `src/domain/index.ts`. Test `src/domain/__tests__/debt-transfer.test.ts`.

**Produces:** `transferCheck({ debts, target, today, amountCents?, limitCents? }): TransferCheck`, where:
- `target: TransferTarget = { debtId: Id | null; name; category; balanceCents; aprBasisPoints; minPaymentRule; plannedPaymentCents?; creditLimitCents; promoRules; offer: TransferOffer }`
- `targetOf(debt): TransferTarget | null`

```ts
interface TransferCheck {
  refused: TransferRefusal | null // {kind:'not_consumer'|'no_offer'|'on_deal'|'mixes_rates'|'needs_limit'|'no_room', ...}
  leftOut: { debt: Debt; reason: { kind: 'on_deal'; until: CivilDate } | { kind: 'cheaper'; aprBasisPoints: number } | { kind: 'not_consumer' } }[]
  sources: Debt[]               // in fill order
  roomCents: Cents | null
  mostCents: Cents
  recommendedCents: Cents | null  // null: nothing saves money
  bestNetSavingsCents: Cents | null
  typed: { cents: Cents; problem: 'over_most' | 'not_positive' | null } | null
  result: TransferResult | null   // for typed ?? recommended ?? most; null when mostCents is 0
}
interface TransferResult {
  amountCents; feeCents; freedPerMonthCents
  moves: { debt: Debt; amountCents: Cents; paymentBeforeCents: Cents; paymentAfterCents: Cents }[]
  interestWithoutCents; interestWithCents; netSavingsCents
  horizonMonths: number | null   // 120 when compared over ten years
  monthsWithout: number | null; monthsWith: number | null; monthsSooner: number | null
  perDebt: { name: string; monthsWithout: number | null; monthsWith: number | null }[]
  deal: { endsOn: CivilDate; leftAtEndCents: Cents; clearsAtPerMonthCents: Cents | null } | null
}
```

Tests, with figures worked by hand in the test's comment:
- [ ] A $5,000 card at 24.99%, a fixed $200 minimum, and an empty 0%/12-month/3%-fee card with a $10,000 limit. Assert:
  - the most is $5,000
  - the fee is $150
  - the net savings equal the interest without, less (the interest with + $150)
  - the result moves the whole $5,000
  - freed is $200
- [ ] A source on a live deal is in `leftOut` with `on_deal` and is never in `moves`.
- [ ] Two sources fill highest APR first, and the room caps the second.
- [ ] A typed amount above the most gives `problem: 'over_most'`, and the result uses the most.
- [ ] A fee minimum larger than the room gives `mostCents: 0` and `result: null`.
- [ ] A target holding a balance with an offer that ends is refused as `mixes_rates`. A line of credit at one rate with a balance is accepted.
- [ ] A 0% fee, 0% rate offer: net savings ≥ 0 for every amount. This is a property over 50 seeded random households.
- [ ] Property: the recommended amount's net savings are ≥ those of every candidate tried. Also, amount + fee ≤ room.
- [ ] A partial move from a source with a planned payment: freed is 0.

### Task 3: The form

**Files:** Modify `src/domain/debt-form.ts`. Test `src/domain/__tests__/debt-form.test.ts`.

- [ ] Add these `DebtFormValues` fields:
  - `has_offer`
  - `offer_ends`: `'months' | 'until' | 'never'`
  - `offer_rate`, `offer_months`, `offer_until`
  - `offer_fee`, `offer_fee_min`
  - `offer_by`
  - `offer_charged_back`: `'no' | 'yes'`, default `'no'`

  Then:
  - `parseDebtForm` builds `DebtInput.transferOffer` and puts each problem next to its box.
  - `debtFormValuesOf` and `debtFormValuesFrom` round-trip the new fields.
- [ ] Add `parseTryCard(get): { ok: true; target: TransferTarget } | { ok: false; problems }`. It reuses `parseDebtForm` with balance `'0'` and requires an offer.
- [ ] Tests: the round trip, each problem, and Try a card without a minimum is a problem.

### Task 4: Store it

**Files:**
- `drizzle/0030_transfer_offer.sql` and its snapshot via `npm run db:generate`
- `src/db/schema.ts`
- `src/server/engine.ts`: `createDebt`, `updateDebt`, `toDebt`, and `transfer_offer` in `debt_added` terms and `debt_updated` before/after
- Test `src/server/__tests__/debt.integration.test.ts`

- [ ] Integration tests:
  - an offer is saved and read back
  - an update records `transfer_offer` in its before/after and the history says "transfer offer"
  - an invalid offer is refused by the engine

### Task 5: Screens

**Files:**
- `src/app/(app)/debts/debt-form.tsx`: the offer fields
- `src/app/(app)/debts/transfer/page.tsx` (new)
- `src/app/(app)/debts/page.tsx` and `debt-table.tsx`: "Try a card", and the offer line with its link
- `src/app/(app)/debts/[id]/page.tsx`: the offer and its link

- [ ] Build the page in this order:
  1. the answer sentence
  2. the figures
  3. clears before the 0% ends
  4. left out
  5. the "Try a different amount" GET form

  A stored target with no limit gets a `limit` box.
- [ ] Run `npm run typecheck`, `npm test` (with the database) and `npm run build`. Then click through the screens in the dev server with Playwright.

### Task 6: Notes

- [ ] Add a D61 bullet to CLAUDE.md and update the test count. Then commit, open a PR and merge it.
