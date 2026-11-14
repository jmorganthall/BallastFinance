# Ballast: This week, Check in, Share out, Plans, a plan, Debts, a debt, Trips and Settings

## Anti-Pattern Verdict

Clean. No deceptive, urgency, consent or engagement patterns.

- Share out's "First, cover what is short?" comes already ticked. It covers the household's own shortfall on its own debt, is labelled "Optional" and can be unticked, so it is a sensible default, not manipulation.
- The Smart saving headline ("With Ballast you set aside $X a month less") promotes Ballast's own method. It is shown only when the claim is true and never while any account is Short, so it stays honest.
- Status never rests on colour alone: every red, amber or green mark has its word beside it.

## Priority Issues

### Major

**Marking a to-do Done gives no confirmation and no undo, and the list rearranges itself.**
On This week, pressing Done on "set the recurring transfer into Annual Expenses to $420.00" removes the card without a word. The page re-renders with a different to-do at the top: "Move $43.46 from Annual Expenses into Car & Home", which did not exist a moment ago and comes with no reason. The person cannot see that their answer was recorded, cannot take it back if they pressed the wrong card, and has just been handed new work with no explanation. This is the screen they use every week, and these are instructions about real money. Violates *visibility of system status* and *user control and freedom*.
Change: after Done, keep a short line where the card was, for example "Recorded: Annual Expenses moves $420.00 a week. Undo". When the answer creates a new to-do, mark that to-do as new and say what caused it ("Now that Annual Expenses has extra, it can cover Car & Home").

**This week explains every figure twice and runs to about 3,000px on a phone.**
Each of the four to-dos is restated in the account cards below it ("Pending transfer change: $150.00 → $420.00 a week"). Under that comes the derivation in dotted-underline text: "Needs $420.00 a week ($415.18 exactly, less than the $536.99 its parts would need each on their own, because money already here or set aside for later plans covers the ones due sooner)". So a person reads each instruction twice, plus arithmetic they never need to act on. The rounding and pooling explanation is valuable, but it lands in the weekly path of someone who only came to make transfers. Violates *aesthetic and minimalist design*.
Change: on This week, each account card shows its status, what it likely holds and one line on its transfer. The derivation moves to the card's tooltip or the account's check-in card. Leave out the "Pending transfer change" line while the same change is a to-do on the same screen.

**Trips is one 12,700px page that mixes browsing with setup.**
On a phone, Trips holds all of these on one page:
- the year strip and calendar
- the ranked best times to go
- the drive lookup
- the new-trip form
- the school-year start and end dates
- blackout dates
- days off school
- lodging prices
- the crowd and DVC pulls

The forms that are filled in once a year sit between the things looked at every visit, so finding "when should we go?" means scrolling past school-calendar admin. Violates *aesthetic and minimalist design* and *recognition rather than recall*.
Change: keep the calendar, the best times to go and the trips on Trips. Move school years, days off, blackout dates, lodging prices and the drive from home to a separate "Trip settings" page, linked from the top of Trips and from each place that reads them ("no price yet" links to lodging prices; "drive not looked up yet" links to the drive).

### Minor

**To-do boxes come pre-filled with the figure being asked for.**
"What the transfer is now, per week: [420.00] Done" lets someone confirm a bank change with one tap whether or not they made it. This contradicts the rule that nothing is done until a person confirms it. Check in already solves this: an empty box with the likely figure as a grey hint, and a button that names the figure. Violates *error prevention*.
Change: make the to-do confirmation work like Check in. The box is empty with the asked figure as a hint, and the button reads "Done: it's $420.00".

**Settings saves each section on its own, with seven Save buttons on one page.**
The share-out rules, transfer day, rounding, reminders, notifications, accounts and Simplifi names each have their own Save. Likely, based on each Save being its own form: a person who edits the transfer day and the reminders, then presses only the second Save, loses the first change without a warning. Violates *error prevention*.
Change: warn when a different section has unsaved edits, or save each setting as it changes and say "Saved" beside it.

**The same thing goes by different names.**
- The Debts tab opens on a page titled "Payoff order".
- The same kind of confirmation is labelled "Done" on one to-do and "That's it" on the next.
- The Share out tab opens on "Share out spare money".

Violates *consistency and standards*.
Change: title each page with its tab's name ("Debts", with "Payoff order" as the table's own heading), and use one label for confirming a to-do.

**A computer-style date appears in a sentence on Share out.**
"The 0% ends 2027-04-30 with $1,000.00 still owed" uses year-month-day order, while the same sentence on Debts says "in 5 months". Violates *match between system and the real world* and *consistency and standards*.
Change: use the same distance-from-today wording, with the date on tap, as everywhere else.

**Best times to go ranks dates it knows almost nothing about.**
With no crowd data and no prices, the list still numbers its picks 1 to 10, and #1 is Thanksgiving week. That rank comes from school days alone. Each row does say "no crowd data · no price yet", but the numbered order reads as a recommendation. Violates *visibility of system status*.
Change: while crowd and price data are missing, say above the list "Ranked on school days only until park data and prices are in" and link to where each is added.

**Example figures in boxes look like real entries.**
Share out's "2500", the lump-sum "1075", the what-if "50" and "1000", and the drive's "480" and "7.5" are placeholders in a light grey close to that of a typed value. On a money screen they can be read as figures already entered. Violates *error prevention*.
Change: word them as examples ("e.g. 2,500"), or drop them where the label is enough.

**Every explained phrase is a tab stop.**
On This week, 10 of the 28 keyboard stops are dotted-underline explanations, so a keyboard user passes through them to reach each Done. Violates *flexibility and efficiency of use*.
Change: once the derivations move off This week (see above), keep the few that remain. Explanations inside a to-do sentence stay reachable by keyboard, but grouped behind one "Why" per card.

**The Settings page shows operator instructions to the family.**
"Not set up. Set WATCHTOWER_URL and WATCHTOWER_TOKEN for the app container to update from here." Violates *match between system and the real world*.
Change: "Not set up. Whoever runs Ballast's server can turn this on." The variable names go in the tooltip.

### Cosmetic

**Chart labels grow with the chart.**
On a debt's page at desktop width, the axis labels ("$300", "Dec 2026") are larger than the body text, because they are sized in the chart's own units and scale with it.
Change: size chart text in screen pixels so it matches the page's small print at every width.

**Lead figures carry cents nobody types.**
Lead figures such as "$23,160.00", "$4,800.00" and "$600.00 a week" show ".00" where whole dollars would read faster.
Change: drop zero cents on summary figures. Keep exact cents wherever a person will type the amount into the bank.

**Focus ring is the browser's default.**
One focus style exists in the whole app, so the keyboard ring is the browser's default rather than the accent colour.
Change: theme the focus ring from the accent colour, with an offset, on every control.

## Heuristic Verdicts

| Heuristic | Verdict | Deciding finding |
| --- | --- | --- |
| Visibility of system status | Broken | Marking a to-do Done gives no confirmation and no undo, and the list rearranges itself |
| Match between system and the real world | Strained | A computer-style date appears in a sentence on Share out |
| User control and freedom | Broken | Marking a to-do Done gives no confirmation and no undo, and the list rearranges itself |
| Consistency and standards | Strained | The same thing goes by different names |
| Error prevention | Strained | To-do boxes come pre-filled with the figure being asked for |
| Recognition rather than recall | Holds | Check in shows the likely balance and the transfer beside every box |
| Flexibility and efficiency of use | Strained | Every explained phrase is a tab stop |
| Aesthetic and minimalist design | Broken | This week explains every figure twice and runs to about 3,000px on a phone |
| Help and documentation | Holds | Tooltips carry the detail in plain words, so no screen needs a manual |

## Cognitive Walkthrough Results

Only steps that hesitate or fail are listed.

| Task | Step | Motivation | Visibility | Understanding | Feedback | Rating | Finding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Do this week's to-dos | Press Done on a transfer to-do | Yes | Yes | Yes | No | Hesitation | Marking a to-do Done gives no confirmation and no undo |
| Do this week's to-dos | Act on the to-do that appears next | No | Yes | Yes | No | Failure | Marking a to-do Done gives no confirmation and no undo |
| Do this week's to-dos | Confirm without having done it yet | Yes | Yes | No | Yes | Hesitation | To-do boxes come pre-filled with the figure being asked for |
| Choose when to go on a trip | Find the best weeks on a phone | Yes | No | Yes | Yes | Hesitation | Trips is one 12,700px page that mixes browsing with setup |
| Choose when to go on a trip | Read the #1 pick | Yes | Yes | No | Yes | Hesitation | Best times to go ranks dates it knows almost nothing about |

## Positive Findings

- Check in is the model for every confirmation: an empty box, the likely balance as a hint, and "It's $850.00" that records exactly the figure it shows.
- A Short plan says which account runs short, when, and the fix, right under its bar. No hunting.
- Debts and a debt's page answer real questions in place ("What if we paid more?", where each payment goes, when the 0% ends) with charts that read at a glance.
- The plain-language rule holds across nearly every screen: "Short", "Running down", "did this get spent?", never jargon in the main copy.
- "Download everything" and "Ballast never holds a bank login" make the household's trust in the tool explicit.
- The Debts table changes its columns based on its own width, so on a phone it keeps the figures that matter and never scrolls sideways.

## Recommended Actions

- Marking a to-do Done gives no confirmation and no undo, and the list rearranges itself
- This week explains every figure twice and runs to about 3,000px on a phone
- To-do boxes come pre-filled with the figure being asked for
- Trips is one 12,700px page that mixes browsing with setup
- Settings saves each section on its own, with seven Save buttons on one page
- The same thing goes by different names
- A computer-style date appears in a sentence on Share out
- Best times to go ranks dates it knows almost nothing about
- Every explained phrase is a tab stop
- Example figures in boxes look like real entries
- The Settings page shows operator instructions to the family
- Chart labels grow with the chart
- Lead figures carry cents nobody types
- Focus ring is the browser's default
