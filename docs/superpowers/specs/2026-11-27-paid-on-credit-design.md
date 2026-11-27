# Paid on credit

Asked for by the household on Nov 27, 2026. Not yet a PRD decision; proposed
as D63.

## The problem

A plan's money often goes out on a card, not straight from the plan's
account. Putting it right takes two steps at the bank: move the plan's money
into the account the household pays bills from, then pay the card from
there. Ballast recorded the spend but not the card, so nothing kept the
household honest about the move and the payment.

## What the household said

1. The card's balance goes up by the charge at once and comes down when the
   payment is done.
2. The charge stays out of the debt payoff math (the share-out's debt share,
   the payoff order, the statuses): it is the plan's money, already set aside.
3. A plan held in the bills account skips the move and goes straight to the
   payment. However many charges, one move and one payment where possible.
4. Pay right away, not by the statement's due date.
5. Always paid in full, never in part; a charge may be only part of what a
   plan spent.

## Facts

- `spend_recorded` gains an optional `debt_id` (a `consumer` debt: a card or
  line of credit). Absent means paid straight from the account.
- `credit_moved` `{ from_reserve_account_id, to_reserve_account_id | null,
  charge_ids, amount_cents }` and `credit_paid` `{ debt_id, charge_ids,
  amount_cents }` (migration 0031). Each names the charges (spend event ids)
  it covered. Payloads are declared and parsed with zod in
  `src/domain/credit.ts`.
- The `bills_account` setting: `{ kind: 'reserve_account', accountId }` or
  `{ kind: 'named', name }`. No setting means not said yet; the to-dos then
  say "the account you pay bills from". Not seeded: account names are the
  household's.

## Derived

- **To-dos** (`creditTodos`): one move per plans' account covering every
  charge not yet moved or paid whose account is not the bills account; once
  no charge on a card waits to be moved, one payment per card covering every
  charge on it not yet paid. They always block All caught up and count as
  money to do, so the count ask waits for them. "Done" records the charges
  the page showed at the to-do's amount; if what is open changed, nothing is
  recorded and the person looks again. A second press counts once.
- **Account money** (ledger): a charge is a spend the moment it is recorded.
  A count of an account while a charge's money is still in it (not yet
  moved, or moved in and not yet paid) keeps it counted as spent, since the
  money is in the count and promised to the card. The move itself changes
  no figure a second time.
- **The card** (`debtWithCharges`): shown balance = likely balance + charges
  since the statement - payments for them since the statement.
  `balanceCents` (everything that ranks or judges debts) = shown - charges
  not yet paid. `onCardFromPlansCents` = charges not yet paid; screens show
  `cardBalanceCents` with "$X from plans". Charges and payments before the
  statement are already in it.
- **History**: the card's page lists "A plan put $X on it" and "Paid $X for
  what plans put on it"; the plan's "What went out" says which card.

## Limits

- A charge cannot be taken back once its money is moved or the card paid.
- No undo for the move or the payment, like the other to-dos (D62 is not
  built yet).
- Interest on a charge is not modelled: it is paid right away.
