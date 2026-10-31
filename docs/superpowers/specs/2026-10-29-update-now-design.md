# "Update now": one-click updates through Watchtower, with a backup first

Date: 2026-10-29. Status: design, not yet approved.

## Why

The footer already knows when a newer image is published (`src/server/version.ts`,
`src/components/shell/footer.tsx`), and then tells a person to pull the image and restart the
container by hand. The household wants to press a button instead. The pattern to copy is
PathBrain's (`jmorganthall/PathBrain`: `backend/pathbrain/updates.py`, `UpdateChip` in
`frontend/src/components/Layout.tsx`, `WatchtowerIntegration` in
`frontend/src/pages/Plugins.tsx`, and the "One-click self-update via Watchtower" note in its
`CLAUDE.md`), which the household says "has this built perfectly". It already runs against the
same Watchtower.

Ballast differs from PathBrain in one way that matters: every start runs database migrations
(`scripts/bootstrap.ts`) against the household's money data, and the only backup is a nightly
`pg_dump` from cron on the Unraid host (`scripts/backup.sh`). An update pressed in the evening
could migrate the data almost a day after the last backup. So this feature also takes a backup
right before a migration.

## Goals

1. When an update is available and Watchtower is configured, the update notice in the footer
   gets an **"Update now"** button. Pressing it asks Watchtower to pull the new image and
   recreate the Ballast container. The page then says it is updating, waits for the new build
   to answer, and reloads itself.
2. Before any start that has a migration waiting, Ballast takes a `pg_dump` of the database.
   This protects every way an update can arrive: the button, Watchtower's own schedule, and a
   manual pull.
3. If that backup fails, **Ballast starts anyway** (the household's decision) and says plainly,
   in the app, that the database was changed without a backup, and why.
4. A Watchtower card under Settings shows whether the connection is set up, has a
   **"Test connection"** that never starts an update, and keeps an **update history**: every
   press, and whether the build actually changed. This matters because Watchtower answers 200
   even when the container is outside its scope and nothing gets updated.

## Non-goals

- Nothing about Ballast's own update check changes: it still compares revisions against the
  registry (`version.ts`).
- No automatic updates triggered by Ballast, and no schedule inside Ballast.
- No restore button. Restoring stays the manual `psql` path in `scripts/backup.sh`.
- No replacement of the archived `containrrr/watchtower` (the household runs
  `containrrr/watchtower:latest`, which is v1.7.1, the last release). The forks speak the same
  API, so this works with either.

## Anti-goals (a failure even if it technically works)

- **The token must never reach the browser,** a page, the database or a log. It lives in the
  environment only, like the reader's key.
- **The button must not update the household's other containers.** PathBrain's request has no
  image filter, so it updates everything Watchtower watches. Ballast's must not.
- **No silent no-op.** An update that Watchtower accepted but that changed nothing must be
  reported as such, never as success, and never left spinning.
- **No silent missing backup.** A migration that ran without a backup is always visible.
- **"Test connection" must never call `/v1/update`,** because that call performs the update.

## Constraints and facts

**Watchtower v1.7.1, read from its source and docs at tag `v1.7.1` on GitHub:**
- **Turning the API on:** `--http-api-update`, with the token in `WATCHTOWER_HTTP_API_TOKEN`.
  The request needs the header `Authorization: Bearer <token>`.
- **The endpoint and port:** `/v1/update` on port 8080 inside the Watchtower container. The
  household maps it on the host; PathBrain's `.env.example` shows
  `http://192.168.2.6:8998`, which is probably that mapping.
- **Limiting it to Ballast:** `?image=ghcr.io/jmorganthall/ballastfinance` limits the update
  to containers whose image name, with the tag removed, equals that string exactly
  (`FilterByImage` in `pkg/filters/filters.go`).
- **The request doesn't come back:** the handler runs the update inside the request, so the
  request is cut off when the Ballast container is stopped. A dropped or reset connection, or
  a timeout after the request was sent, therefore means "it's happening". A refused connection
  or a failed address lookup means Watchtower isn't there. A 401 means the token is wrong.
- **The schedule:** turning the API on stops Watchtower's own scheduled checks unless
  `--http-api-periodic-polls` is also passed. This goes in the docs, because the household
  believes their Watchtower runs on a schedule.

**Ballast's own rules (`CLAUDE.md`):**
- Every outbound call has a named module, its own User-Agent, and never an `origin` or
  `referer` header. Add `src/server/self-update.ts` to that list in `CLAUDE.md`.
- Writes go through the engine. The update attempts and the backup records are about the
  server, not a household (like `crowd_levels`), and live in their own table(s). They are
  **not** events, because an attempt's outcome is filled in afterwards.
- The app connects as `ballast_app`. The backup needs the owner login, which the container
  already has as `DATABASE_MIGRATION_URL` for the bootstrap.
- Importing `src/db/client` must never connect. Nothing here may run during `next build`.
- Plain words on screen: "Update now", "Updating — back in a minute", "Updated", "No change",
  "Didn't start". No "trigger", "endpoint" or "verdict" in the interface.

**The image:** `node:22-alpine`, running as user 1001 (`ballast`). It has no PostgreSQL
client today. The database is `postgres:16-alpine`.

## Decided

**By the household:**
- Use the existing Watchtower (`containrrr/watchtower:latest`), at `http://192.168.2.6:8998`.
- Ballast on Unraid runs the published `ghcr.io/jmorganthall/ballastfinance:latest`, so
  Watchtower can pull it and the `?image=` filter matches. PathBrain's compose files carry no
  Watchtower label or scope, and its button works against the same Watchtower, so that
  Watchtower probably has no label or scope filter. If it does, the update history will
  report "No change", and the docs say to check this first.
- Model it on PathBrain's design.
- "Update now" must deal with the backup gap, provided the backup is quick.
- If the backup fails, start without one.

**My calls, which they may overturn:**
1. **Configuration:** `WATCHTOWER_URL` and `WATCHTOWER_TOKEN`, unprefixed to match PathBrain,
   under a `# Watchtower` comment in all three compose files as `"${WATCHTOWER_URL:-}"` and
   `"${WATCHTOWER_TOKEN:-}"`. The household's address, `http://192.168.2.6:8998` (given by the
   household; the same one PathBrain uses), goes in `.env.example` and the docs, and never as
   a default in a committed compose file: the image is public, and another install's button
   must not point at this household's LAN. Empty URL means no button, and the footer reads
   exactly as it does today.
2. **Image filter:** the request is `POST {WATCHTOWER_URL}/v1/update?image=<image>`, where
   `<image>` is `BALLAST_IMAGE_REPO` or `DEFAULT_IMAGE` from `version.ts`, i.e. the same
   setting the update check already uses.
3. **The call runs on the server:** a server action, for any signed-in member of the
   household; either spouse may press it. The browser only ever sees the outcome.
4. **Outcomes on screen:** a cut-off connection counts as started. A refused connection, a
   failed lookup or a non-2xx answer is an error shown beside the button, and no update
   starts.
5. **After pressing:** the button turns into "Updating — back in a minute". The page checks
   the running revision every few seconds (a tiny route returning `runningBuild()`) and
   reloads once it differs. After **4 minutes** with no new build it stops and says
   "Watchtower took the request, but Ballast is still on <rev>", with a link to the update
   history.
6. **The update history** is copied from PathBrain. An attempt row is written *before* the
   request, holding the URL (never the token), whether a token was sent, and the running
   revision. It is completed with how the call went: started, dropped, rejected, unreachable.
   It is settled later by comparing builds:
   - **updated:** the revision changed.
   - **no change:** still the same revision 10 minutes on.
   - **didn't start:** the request never got through.

   Settling happens when the history or the footer is read. There is no startup hook.
7. **When the backup runs:** in `scripts/bootstrap.ts`, after waiting for the database and
   before `migrate()`, but only when at least one migration file has not yet been applied.
   An ordinary restart takes no backup.
8. **Timing:** the backup is capped at **2 minutes**. Past that it counts as failed, and the
   start goes on.
9. **Where the file goes:** `pg_dump` from the `postgresql16-client` Alpine package (it must
   match or be newer than server 16), gzipped, into `/backups` in the container, mounted from
   `BACKUP_DIR`. The default is `/mnt/user/backups/ballast` in the docs and `./backups` in the
   compose files. The name pattern is the same as `backup.sh`'s, with `-before-update` in it,
   so the host's 30-day cleanup also deletes these.
10. **Recording the outcome:** file, size and duration on success, or the reason on failure,
    plus which migrations were waiting. It is recorded *after* the migrations, because the
    table that holds it may itself arrive in one of them.
11. **The missing-backup notice:** if the latest migration ran without a backup, the footer
    shows one line on every page: "The last update changed the database without a backup:
    <reason>". It has a "Got it" button that records a dismissal. The Settings card always
    shows it in the history.
12. **"Test connection"** does two things:
    - It sends a GET to Watchtower's root. Any HTTP answer counts as reachable. It never calls
      `/v1/update`.
    - It checks that `/backups` exists and that user 1001 can write to it.
13. **Docs:** a section in `docs/running-it.md`:
    - the Watchtower flags (`--http-api-update`, the token, and `--http-api-periodic-polls` to
      keep its schedule);
    - the two environment variables;
    - the `/backups` mount and its ownership (the container writes as 1001, while Unraid
      shares default to `nobody:users`);
    - a note that the 30-day cleanup in `backup.sh` covers these files.

14. **The button only shows when Watchtower can actually do the update.** The compose file
    passes the image reference the container runs (`BALLAST_IMAGE`) into the container.
    "Update now" appears only when that reference is the published image at the same tag the
    update check compares against (`BALLAST_UPDATE_TAG`, default `latest`). A locally built
    image, or one pinned to a version tag, keeps today's "pull and restart" wording.
15. **A backup only counts if it lands on a real mount.** Bootstrap checks that `/backups` is
    a mount point (via `/proc/self/mountinfo`) before writing. A dump written to the
    container's own disk would vanish with the next recreate, so a missing mount is recorded
    as "no backup: /backups is not mounted" and the start goes on.
16. **Dismissing the notice is per person.** One spouse's "Got it" does not hide it from the
    other.
17. **The backup folder default:** on Unraid the docs set `BACKUP_DIR` to the same folder as
    `backup.sh`'s `BALLAST_BACKUP_DIR` (`/mnt/user/backups/ballast`), so its 30-day cleanup
    covers the pre-update files. The quickstart default stays `./backups`.
18. **Label:** the compose files add `com.centurylinklabs.watchtower.enable=true` to the app
    service. Watchtower ignores it unless it runs with `--label-enable`, so it is harmless
    either way.

## Left to the builder

- How bootstrap tells that a migration is waiting. One way: compare drizzle's
  `drizzle.__drizzle_migrations` with `drizzle/meta/_journal.json`. A first start on an empty
  database has nothing to back up.
- The table shapes and the migration number (next is `0024`).
- How the server action reaches the engine for a table that belongs to no household.
- Test style: follow `version.test.ts`, with a fake `fetch` for every Watchtower outcome
  (accepted, dropped, refused, 401), and a fake `pg_dump` runner for the backup.
- The exact layout of the Settings card.
