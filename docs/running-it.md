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

### Knowing when to update

The footer of every page names the running build and, when the published image has
moved on, says so. The published image carries the git revision it was built from; the
running app compares its own against the `latest` tag on `ghcr.io` (four small anonymous
requests, at most once every six hours, never on the page's critical path) and shows a
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

## Backups

Nightly `pg_dump` to the array, retained 30 days (PRD §11). **Test a restore
before the Google Sheet is retired** — an untested backup is a guess.
