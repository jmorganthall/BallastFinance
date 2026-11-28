# How sure a price is

Asked for by the household on Nov 28, 2026 ("define what is DEFINITE vs
what is prediction"). Not yet a PRD decision; proposed as D64 (6), against
PRD rev 121, on top of the resort model (D64 (1)-(5), PR 87).

## Decision (D64 (6), proposed)

1. **Every price says how sure it is**, in four labels:
   - **Definite:** a price for these very nights, quoted or looked up.
   - **Disney list price:** Disney's published rate for the week or month,
     before any discount.
   - **Predicted:** no published rate covers the night, so it is worked out.
   - **Unknown:** nothing to go on.
   A window's label is its least sure night's, and Unknown until every
   night is priced. Labels are derived from the ladder level; nothing is
   stored.
2. **A prediction fills only nights Disney has not priced.** It is level 5,
   below the month's rate and above the DVC levels still to come.
3. **How a night is predicted:** Disney's rate for the same week (52 weeks
   back) or month a year earlier, times
   - the year-on-year change the stored rates show: the median of later over
     earlier across months priced in both years, measured only from three
     such months up (`MIN_YEAR_PAIRS`); below that no change is applied and
     the basis says so. No rate of increase is assumed;
   - how the household's own quotes ran against Disney's rate on the nights
     both covered (median, night by night). A quote never becomes a
     prediction; it only moves the next one.
4. **The basis is said** on a tap, in words: the base rate and its period,
   the change applied and over how many months, and the quotes' lean.

## What changes in the app

- Explore prices weeks past Disney's published rates instead of treating
  them as neither cheap nor dear, and marks those prices "predicted".
- The price tap opens with the label.
- Explore reads two years of rates, so the year-earlier rates are there.

## Not in this change

- Rooms under resorts (no source here prices by room yet).
- Discount history (the one source found, MouseSavers, is personal use
  only).
- Crowds, weather and school calendars landing raw.
