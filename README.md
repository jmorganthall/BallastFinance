# Ballast Finance

A self-hosted family reservation engine that answers one question continuously:
**"How much needs to move into each reserve account this week, and are the reserves on pace?"**

It never moves money and holds no bank credentials. Capital One 360 recurring transfers
execute the plan; Simplifi keeps handling aggregation and budgeting. This is the decision
layer — the part that lives in a spreadsheet today.

---

## Quick start

You need [Docker](https://docs.docker.com/get-docker/) with the Compose plugin, and a
Google OAuth client. There is no password login by design, so the OAuth client is the one
step that cannot be skipped or generated for you.

**1. Create a Google OAuth client** at
[console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
→ *Create credentials* → *OAuth client ID* → **Web application**.

Set the authorised redirect URI to exactly:

```
http://localhost:3000/api/auth/callback/google
```

Plain `http` is fine here. Google requires HTTPS for redirect URIs but
[exempts localhost](https://developers.google.com/identity/protocols/oauth2/web-server)
specifically, so no certificate or tunnel is needed to try it out. The port must match
what the app is actually served on.

**Then add yourselves as test users.** On the OAuth consent screen, set the user type to
**External** and add every email that will sign in under *Test users*. An app left in
*Testing* with an empty test-user list rejects everyone, including you.

Keep the **client ID** and **client secret**.

**2. Run the quick start:**

```bash
git clone https://github.com/jmorganthall/BallastFinance.git
cd BallastFinance
./scripts/quickstart.sh
```

It generates the database passwords and the session secret, asks for your Google client ID
and secret and which email addresses may sign in, writes a `.env`, and brings the stack up.

<details>
<summary><strong>Or run the published image instead — no clone, no build</strong></summary>

```bash
curl -O https://raw.githubusercontent.com/jmorganthall/BallastFinance/main/docker-compose.ghcr.yml
```

Write a `.env` beside it with `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AUTH_SECRET`
(`openssl rand -base64 32`), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` and
`SEED_ALLOWED_EMAILS`, then:

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

Images are `ghcr.io/jmorganthall/ballastfinance`, built for `linux/amd64` and
`linux/arm64`. Set `BALLAST_IMAGE` to pin a version tag — `latest` follows the default
branch and will change under you.

</details>

**3. Open [http://localhost:3000](http://localhost:3000)** and sign in.

That is it. The first start migrates the database, creates the restricted database role,
and seeds the household and its reserve accounts. All of it is idempotent, so restarts and
upgrades need nothing extra.

### Without the script

If you would rather write the `.env` yourself, copy `.env.example`, fill in
`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AUTH_SECRET` (`openssl rand -base64 32`), the two
`AUTH_GOOGLE_*` values and `SEED_ALLOWED_EMAILS`, then:

```bash
docker compose -f docker-compose.quickstart.yml up -d --build
docker compose -f docker-compose.quickstart.yml logs -f app
```

Compose refuses to start rather than falling back to a default if any secret is missing,
and tells you which one.

### Common problems

| What you see | What it means |
| --- | --- |
| `redirect_uri_mismatch` from Google | The redirect URI on the OAuth client must match `AUTH_URL` exactly, including the scheme and port, and end in `/api/auth/callback/google` |
| `access_denied`, or "app is blocked" | Your Google account is not in the OAuth consent screen's *Test users* list |
| Sign-in bounces straight back | Your email is not in `SEED_ALLOWED_EMAILS`. Add it and restart the app container — the allowlist is what gates signup |
| `required variable ... is missing a value` | A secret is not set. Run `./scripts/quickstart.sh`, or fill in `.env` |
| App container restarts on boot | Read `docker compose logs app`. A failed bootstrap stops the container deliberately rather than serving against a half-migrated database |

### Running it for real

The quick start uses a Docker volume and `localhost`. For the homelab — the Unraid array,
a real hostname, backups, and how the phones reach it — see **[running it](docs/running-it.md)**,
which uses `docker-compose.yml` instead. Same image, same bootstrap, different defaults.

---

## Status

**All four build phases are implemented**, with 191 tests passing against a live
PostgreSQL 16.

| Phase | Contents | Status |
| --- | --- | --- |
| A | Schema, auth + household, reserve accounts, package builder, accrual derivations, Home/This Week | Built |
| B | Check-ins, drift, close-out, instructions, n8n notifications, weekly digest | Built |
| C | Simulate → commit, what-if overlay, Allocate screen | Built |
| D | Debt inventory, scoring + slider, ladder, projections, lump-sum optimizer | Built |

What remains is verification against reality rather than more building: the sheet-parity
test against the real eight debts, and Shelby completing a check-in unaided from her phone.
Those are in the PRD's acceptance criteria (§12).

## Documents

| Document | What it is |
| --- | --- |
| [PRD v1](docs/prd.md) | **Source of truth for the build.** Lives in Claude Docs, not in this repo — it changes over time, so read it live rather than trusting a copy |
| [Product abstract](docs/product-abstract.md) | The problem, v1 scope, core concepts, and data-model principles. Its open-questions list is superseded by the PRD's decisions log |
| [Running it](docs/running-it.md) | Local development, the two database roles, Unraid deployment and backups |

## How it is put together

The engine is the product; Capital One and Simplifi are adapters. Three rules hold the
shape (PRD §10):

1. **`src/domain` is the only place math lives.** Pure functions, zero I/O, "today" always
   a parameter. The UI, the jobs and the API all call it; nothing recomputes an accrual
   for itself.
2. **Facts are stored, derivations are computed.** No weekly rate, curve, drift figure or
   score is ever written to the database. If it can be recomputed, it is a view.
3. **One write path.** Everything goes through `src/server/engine.ts`, which is bound to a
   single household at construction — so cross-household access is not something a caller
   has to remember to avoid, it is something they cannot express.

### Why staying in Google's "Testing" mode is fine

Google expires refresh tokens after 7 days for apps in *Testing* status, which breaks a
lot of self-hosted projects and pushes people into app verification they do not need.

It does not apply here. Ballast never asks Google for offline access, so Google never
issues a refresh token: it is consulted once, at sign-in, to establish who you are. The
session after that is Ballast's own cookie, signed with `AUTH_SECRET` and good for 30 days
(PRD §2 — a check-in that demands a fresh sign-in is a check-in that does not happen).

Two people on a 100-test-user cap will not run out either. Leave it in Testing.

### The two database roles

Worth knowing before you change anything near the database. The app connects as
`ballast_app`, which **cannot** `UPDATE` or `DELETE` the events table; migrations run as
the owner. Events are the audit trail and every balance is a fold over them, so if they
can be edited, nothing the app tells you is falsifiable any more. Pointing both URLs at
the owner silently undoes that.

The container bootstrap sets this up on every start, so it is not something anyone has to
remember.

## License

[GNU AGPL-3.0](LICENSE).

You can run it, change it and share it. If you run a **modified** version as a
network service, section 13 obliges you to offer your users its source — which is why
Settings carries a link back here. Running it unmodified for your own household obliges
you to nothing.
