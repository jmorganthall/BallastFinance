# Running Ballast

Two ways: locally for development, or on the homelab via Docker Compose (PRD §10).

Just trying it out? The [quick start](../README.md#quick-start) is one command and needs
none of this.

## What you need first

- A Google OAuth client (Web application) with an authorised redirect URI of
  `<your app URL>/api/auth/callback/google`
- PostgreSQL 16
- Node 22 for local development

## Local development

```bash
npm install
cp .env.example .env          # fill in AUTH_* and the database URLs
SEED_ALLOWED_EMAILS=you@example.com,spouse@example.com npm run bootstrap
npm run dev
```

`npm run seed` creates the household, the signup allowlist and the reserve
accounts. **Nobody can sign in until their email is on the allowlist** — that is
what gates signup in v1 (PRD §2), and a refused sign-in writes no rows.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | The full suite. Database tests skip themselves when `DATABASE_URL` is unset |
| `npm run typecheck` | TypeScript, no emit |
| `npm run demo` | Prints the Disney scenario for checking against the spreadsheet |
| `npm run db:generate` | New migration from a schema change |
| `npm run bootstrap` | Migrate, set the app role's password and seed, exactly as the container does |

## The two database roles

The app and the migrations connect as **different roles on purpose**.

| Role | Used by | Can it rewrite history? |
| --- | --- | --- |
| `ballast` (owner) | migrations, `db:migrate` | Blocked by trigger |
| `ballast_app` | the running app | Blocked by trigger **and** by revoked privilege |

Events are the audit trail, and every current balance is a fold over them. If
they can be edited, no derived figure is falsifiable any more — so migration
`0001` revokes `UPDATE`/`DELETE` on `events` from `ballast_app` and installs a
trigger that fires regardless of role. Giving the app the owner's credentials
silently undoes half of that. Don't.

Migration `0001` creates the `ballast_app` role but deliberately sets **no password** — a
password does not belong in a migration that gets committed. The container bootstrap sets
it from `APP_DB_PASSWORD` on every start, so in Docker there is nothing to do.

Outside Docker, set it once yourself:

```bash
psql "$DATABASE_MIGRATION_URL" -c "ALTER ROLE ballast_app PASSWORD 'the-value-of-APP_DB_PASSWORD';"
```

## Unraid

```bash
cp .env.example .env          # fill everything in; generate AUTH_SECRET with: openssl rand -base64 32
docker compose up -d --build
docker compose logs -f app    # watch the bootstrap
```

There are no manual first-run steps. On every start the container runs
`scripts/bootstrap.ts` (bundled into the image as a single file), which waits for the
database, applies migrations as the owner, sets the restricted role's password from
`APP_DB_PASSWORD`, and seeds the household and allowlist. All of it is idempotent.

A failed bootstrap stops the container rather than serving against a half-migrated
database, so a crash-looping app container means: read the log.

`SKIP_BOOTSTRAP=1` starts the server without any of that. Only useful when you are
deliberately managing migrations yourself.

### Keeping the bank figure steady

Each account's weekly transfer is rounded **up** to a step (Settings, "The weekly
transfer"; the nearest $10 unless you change it, 0 for the exact figure), so a plan
that moves by a few cents does not mean editing Capital One every week. The screen
shows the exact figure beside the rounded one. The little extra the rounding leaves
behind is deliberate and shows up as "ahead" at a check-in, where it is counted
toward your plans like any other extra.

### Where the money is counted

What an account holds is counted toward its parts, and where it is counted sets each
part's weekly figure. Every plan and every part shows a progress bar: how much is set
aside against the total, with a tick at where the money should be by now had it been
saved evenly since the part last came round (or since the plan started, for a one-off).
Green past the tick is on track; yellow short of it is behind; a solid green bar is
fully funded.

Money can land on a part for reasons that have nothing to do with the weekly figure:
the spreadsheet's Reserved Now, an opening typed at commit, an extra counted toward
whichever parts came soonest. The check-in screen's "Where the money is counted" says,
per account, whether a reshuffle would change anything, and a part that would move says
so beside its bar. A reshuffle spreads the account's counted total again: every part up
to where it should be by now, soonest due first, then whatever is left to the parts due
soonest. It changes where money is counted, never how much: the account's total and its
behind or ahead are the same afterwards, and nothing moves in the bank.

### Knowing when to update

The footer of every page names the running build and, when the published image has
moved on, says so. The published image carries the git revision it was built from; the
running app compares its own against the `latest` tag on `ghcr.io` (four small anonymous
requests, at most once an hour, never on the page's critical path) and shows a
notice when they differ. Updating is what it always was: pull the image and restart.

- `BALLAST_UPDATE_CHECK=off` skips the check, for a box with no outbound network or a
  fork that publishes its own image. `BALLAST_IMAGE_REPO` points it at a different image.
- A local build only knows its revision if `GIT_SHA` was passed as a build argument.
  `scripts/quickstart.sh` does this for you; by hand it is
  `GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build`. Without it the footer
  says the check is unavailable rather than guessing.

Point `DATA_DIR` at the array (`/mnt/user/appdata/ballast/pgdata`) rather than a
docker volume, so the database is covered by the array's parity and by your
existing backup routine.

Postgres is not published to the LAN — only the app container reaches it.

### Getting to it from a phone

Still an open decision in the PRD (§13): Tailscale on the Unraid box and both
phones, or Cloudflare Tunnel with Access in front. The app is transport-agnostic
either way; whichever you pick, `AUTH_URL` must be the URL the PWA is actually
opened at, or the OAuth redirect will not come back.

## Bringing in the old spreadsheet

Settings has a one-off importer for the sheet's two tabs, kept until everything
lives in Ballast. Copy the rows out of the sheet with their header line (both
tabs at once is fine) and paste them in. "Check it first" shows what would be
made, which lines would be skipped and why, and which columns are thrown away
on purpose; "Bring in" makes it.

What it keeps, and what it drops:

| Tab | Kept (the raw inputs) | Dropped (the sheet worked these out) |
| --- | --- | --- |
| Expenses | Account, Expense, Due Every, Next Due, Reserved Now, Amount | In Simplifi, Bracket, Monthly, Weekly |
| Loans | Loan, Category, APR, %, $, Monthly (what you actually pay), Balance, Limit, As of | Freed Up, Principal/Month, Int/Month, Interest at Min Pmt, Months @ Min, Util, Fixed Pmt., Long Term, Short Term, Priority |

Each expense row becomes a live plan of its own, saving from today, with "Reserved
Now" counted as already set aside so the weekly amount is right from the first
week. A recurring row whose Next Due has passed rolls to its next occurrence, and its
Reserved Now still counts toward that next one (the import says so; a reshuffle at the
check-in spreads it better if that is not right). Each
loan row becomes a debt with its balance dated "As of", and its Monthly kept as what
you actually pay when that is more than the minimum -- that is what decides whether
a 0% balance is on track to clear before the rate ends. Anything wrong afterwards
is changed on the plan's or the debt's own screen.

"Due Every" is read as a number of days (the sheet's 7, 14, 90, 183, 365, 730,
1825), as words ("year", "6 months", "every 3 weeks", "once"), or as a count and
a unit ("18 months", "2 yrs"). Day counts that are really calendar periods become
those periods, so a yearly bill keeps its date rather than drifting a day every
leap year; anything else stays the interval it says (203 days is every 203
days). The preview shows the interval in plain words before anything is made.

## Backups

Nightly `pg_dump` to the array, retained 30 days (PRD §11). **Test a restore
before the Google Sheet is retired** — an untested backup is a guess.
