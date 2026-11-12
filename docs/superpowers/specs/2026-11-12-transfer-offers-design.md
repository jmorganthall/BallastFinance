# Is a transfer worth it? Standing transfer offers on debts

Status: design, agreed in conversation on 2026-11-12. Not yet in the PRD:
the PRD (rev 116 when this was written) has no standing offers and no
transfer math. Adding it as the next decision (D61) is step 0 of the
build. The PRD stays the source of truth once it says so.

## Why

Card issuers keep offering "0% on transfers for 18 months, 3% fee", and a
line of credit can charge less than the cards. Today Ballast can only
record a deal once it exists (`promo_rules`: a rate, an end date). It
can't answer the question that comes before that: **should we move
money onto this card, how much, and from which debt?** The family does
that math by hand today.

Ballast should answer that question **only when asked**, using the
debts it already knows, the payments it already assumes, and the
projection it already runs. A person then makes the transfer at the bank
and updates the debts by hand.

## Goals

1. **A standing offer is a fact on a debt.** A card or line of credit can
   carry one transfer offer: its rate, how long the rate lasts, the fee,
   and optionally the last day to transfer.
2. **"Is a transfer worth it?"** For a debt with an offer, Ballast:
   - recommends how much to move and from which debts
   - shows the interest saved, the fee, the net savings (interest saved
     minus the fee), and how much sooner the debts are paid off
   - shows whether the current payment clears the transfer before the
     rate ends
3. **Try a card.** The same calculation for a card or line of credit
   that isn't in Debts yet. It's typed on a form and nothing is stored.
4. **A balance already on a 0% deal is never moved.**

## Non-goals

- **Recording the transfer.** There's no "We moved it" button. The person
  edits the source debt's balance and the target's balance and deal by
  hand, as they do today.
- **Suggesting on its own.** Nothing on Debts, This week or the digest
  says a transfer is available or worth it. No to-do is created, and
  nothing affects "All caught up" or a debt's status.
- **Comparing several offers at once, or splitting money across two
  targets.** Each calculation has one target.
- **Annual fees, credit score effects, or the chance an issuer approves a
  lower limit than asked.**
- **Mixed-rate cards created by this feature** (see the rule under
  "Target").

## Anti-goals (it would be a failure even if it worked)

- Recommending a move whose fee costs more than it saves. If nothing comes
  out ahead, the answer says so in those words.
- Savings that look better than they are because the "with" side quietly
  assumes bigger payments. Both sides use the same payment rules (see
  "Current course and speed").
- Moving a balance that's sitting at 0%.
- Any float or blended rate in the projection (CLAUDE.md: money is cents,
  rates are basis points, never project with the effective APR).

## Decided in conversation

### Current course and speed

Both sides of the comparison run on **the payment Ballast already uses
for each debt**: its planned payment if one is set, otherwise its minimum
under its `min_payment_rule` (D51: a percentage minimum is the month's
interest plus the share). No one pays more in the "with" case.

- **Without:** every involved debt as it is today, through
  `projectPayoff` / `simulateMonths`.
- **With:** each source debt with its balance lowered by what it moves,
  same rules. The target holds what moved plus the fee, on a deal at the
  offer's rate, paid at the target's own rule.

"Involved debts" means the target and every debt that moves money.

### Target: a 0% card holds only 0% money

A transfer always lands as a deal on the target's **whole** balance
(`appliesTo: 'full'`). Ballast never builds a card that holds part of
its balance at the full rate and part at a deal rate. So a target is
eligible only when:

- its balance is zero, **or**
- the offer has no end date and its rate equals the debt's APR. This is
  a line of credit whose normal rate is the low rate, so everything on it
  is at one rate anyway.

Any other target is refused with the reason in words, for example: "This
card already carries $1,200 at 24.99%. Moving money onto it would leave
two rates on one card." Existing debts that already have a partial deal
(`appliesTo: 'amount'`) are left as they are. The feature only declines
to create new ones.

### Sources

A debt can give money when all of these hold:

- it's open, not the target, and has a balance
- it has **no live deal** (`currentDeal(debt, today)` is null). This
  covers both "never moves 0% money" and the rule above, since a deal
  card holds only deal money.
- it is a `consumer` debt (auto loans and mortgages never give money)
- its APR is higher than the offer's rate

Sources fill **highest APR first**: the costliest debt gives all it has,
then the next. Each debt that's left out is listed with its reason
("On its 0% until Mar 2027", "Charges 6.9%, less than ...").

### Only when asked

Two ways in, and no others:

- **A debt with an offer.** The offer line on Debts and on the debt's
  page links to "Is a transfer worth it?"
- **Try a card**, a link on Debts that opens the same screen with a form
  for an imagined card.

### Just the calculation

Nothing is written but the offer itself (a fact typed on the debt
form). The calculation is a derivation from a GET request, like the
what-if on a debt's page.

## The standing offer (stored fact)

New nullable column `debts.transfer_offer` (jsonb, migration 0030), with
the offer as `TransferOffer` in `src/domain/debt.ts`:

| Field | Meaning |
| --- | --- |
| `rateBasisPoints` | The rate on what's moved, e.g. `0`. Absent when the offer has no end: then the rate is the debt's own APR (a line of credit), and the form doesn't ask for it |
| `months` *or* `untilDate` | How long the rate lasts: a number of months from the day of the transfer, or a fixed end date. Neither one means the rate doesn't end (a line of credit) |
| `feeBasisPoints` | The fee as a percentage of what's moved, e.g. `300`. `0` is allowed |
| `feeMinCents` | Optional. Some offers charge "3% or $5, whichever is more" |
| `transferBy` | Optional. The last day a transfer gets the offer |
| `chargedBack` | Whether interest is charged back to the transfer day if the balance isn't cleared in time (D49 (9)). The form asks every time and starts on "No", with a hint that most transfers don't; it's only asked when the offer ends |

- Entered on the debt form under a checkbox: "It has an offer for
  balance transfers". It sits beside "It has a promotional rate", which
  stays as is and records a deal that already exists.
- The offer is recorded with the terms on `debt_added` / `debt_updated`
  (`transfer_offer`), shown in the debt's history as "transfer offer",
  and in `debtTermsChanged`. That follows `link_url` (D60).
- An offer whose `transferBy` has passed is still shown, with "The offer
  said transfers by Oct 1". The calculation still runs.
- An offer that ends must have a rate lower than the debt's APR; the
  form says so in words, the way the deal form does today. An offer with
  no end has no rate of its own: it is the debt's APR, so `PromoRule`
  never needs a deal without an end date.
- Only `consumer` debts can carry an offer. A line of credit is entered
  as `consumer` (the form's hint says so).

## The calculation (`src/domain/debt-transfer.ts`, pure)

`transferCheck({ debts, target, today, amountCents? })`, where `target`
is either a debt with an offer, or an imagined card: limit, current
balance 0, APR after the offer, minimum rule, planned payment if any,
and the offer.

1. **Eligibility** of the target (rule above). If it's refused, return
   the reason and nothing else.
2. **Room** = credit limit minus the target's balance today. A stored
   debt with no limit stated: the screen asks for one in a GET field
   (`?limit=`), used for this calculation only and never stored, with a
   link to the debt's form to save it.
3. **Fee** for an amount A = max(`feeMinCents`, A × `feeBasisPoints` /
   10 000 rounded **up** to the cent). It rounds up so savings are never
   overstated. **The most A can be:** the largest whole dollar where A +
   fee ≤ room and A ≤ the sources' total.
4. **Allocation** of A across sources, highest APR first (ties: the
   larger balance first, then name).
5. **The target after the move** is a `Debt` with balance A + fee and one
   rule `{ rateBasisPoints, appliesTo: 'full', untilDate: <today +
   months, or the stated untilDate>, chargedBack, startDate: today }`, or
   no rule when the offer has no end and the rate is already the APR.
   The transfer is taken to happen today.
6. **Net savings(A)** = interest without − (interest with + fee), where
   each side's interest is the involved debts' `totalInterestCents` to
   payoff, added up.
7. **The recommendation** is the A with the largest net savings, tried
   in $100 steps from $100 to the most, plus the most itself. Ties go to
   the smaller amount. If no A saves anything, the answer is "Not worth
   it at today's payments", and the screen still shows the figures for
   the most.
8. **A typed amount** (`amountCents`, from `?amount=`) replaces the
   recommendation and is held to the same limits. The recommended figure
   is still shown beside it.
9. **Paid off sooner.**
   - Each involved debt's months, with and without.
   - Headline: the day the last involved debt is paid off, with against
     without, in months.
10. **Does it clear in time?** Use `promoCliff` on the target after the
    move. If it doesn't clear, show the monthly payment that would:
    the balance ÷ the months in the deal, rounded up to the dollar. This
    is information only, never a to-do.
11. **Never paid off.** If either side has a debt that its payment never
    clears (`months: null`), compare interest over the next 10 years
    instead, and say so in the sentence. `simulateMonths` already takes
    `horizonMonths` and only needs exporting or wrapping.

Every figure comes from `simulateMonths`, so the transfer screen, Debts
and a debt's page can't disagree about how a balance pays down.

## The screen

`/debts/transfer?debt=<id>` (a debt's offer), or `/debts/transfer` with
the card's fields in the query (Try a card), plus an optional
`&amount=`. It's read inside `engine.reading(...)` like the debt's page,
and is one column (CLAUDE.md: a screen that reads top to bottom stays
one column). The words below are my draft:

- **Answer first:** "Move $6,400 from Chase Freedom (and $1,100 from
  Discover). Saves $1,312 after the $225 fee. Paid off 2 years 3
  months sooner." Or: "Not worth it at today's payments: the most you
  could move saves $40 in interest and costs $225 in fees."
- **The figures:** interest without, interest with, the fee, net
  savings. Then each involved debt's payoff, before and after.
- **"Clears before the 0% ends?"** Yes, or "No: about $X would be left
  on Jan 2028, when the rate goes to 24.99%. Paying $Y a month clears
  it."
- **Left out**, each with its reason.
- **"Try a different amount"**, a GET form.

The plain-language dictionary applies (PRD §9): "fee", "transfer",
"0% deal", "paid off", "saves". Never "arbitrage", "APR delta" or
"optimal".

## Constraints from the codebase

- The math lives in `src/domain` only. The page may not import the
  calculation if `layers.test.ts` forbids it; read it through an engine
  method (`Engine.transferCheck`) as the layers rules require.
- Money is integer cents, rates basis points. The fee rounds up (above).
- The offer is a fact; every result is derived and never stored.
- Writing the offer goes through the existing debt create and update
  path, with its event in the same transaction (migration 0027 rules).
- Tests: the domain module gets unit tests on worked examples, with
  figures checked by hand, plus properties:
  - net savings for the recommended A is ≥ net savings for every other
    A tried
  - a source with a live deal is never used
  - A + fee never exceeds the room
  - with a 0% fee and 0% rate, net savings are never negative

## Calls I made (not discussed; check these)

1. **Auto loans and mortgages are never sources**, only `consumer`
   debts. Card offers rarely take them, and their rates are usually
   below the card's rate after the offer.
2. **Charged back is asked on the offer, starting on "No".** Transfers
   are rarely deferred interest, unlike the store-card deals D49 (9) was
   written for; asking every time keeps a wrong "no" from being silent.
3. **$100 steps** for the recommendation. People transfer round amounts,
   and the step keeps it fast.
4. **The transfer is taken as today**, and the deal's months count from
   today.
5. **No annual fee** on an imagined card.
8. **A missing credit limit is typed on the screen** for that one
   calculation, never stored.
9. **A HELOC entered as `mortgage` is out**; a line of credit is
   `consumer`.
6. **10 years** as the comparison window when something is never paid
   off.
7. Highest-APR-first allocation, ties to the larger balance.

## Left to the builder

The form layout for the offer and for Try a card, the exact copy, the
offer's JSON key spelling, where the link sits on Debts, and whether
the hypothetical card's fields reuse `DebtFormValues`.
