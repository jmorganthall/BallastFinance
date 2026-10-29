# "Update now" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an "Update now" button in the footer's update notice asks Watchtower to update only
Ballast, and every start with a migration waiting takes a `pg_dump` first, starting anyway if
the backup fails and saying so.

**Architecture:** there are two new server-side modules:
- `src/server/self-update.ts`: the Watchtower call, the connection test, and settling an
  attempt's outcome.
- `src/server/db-backup.ts`: whether a migration is waiting, the mount check, and the dump.

They have pure helpers beside them, tested the way `version.ts` is. Three tables that belong
to no household (migration 0024) are written through new `Engine` methods. The bootstrap
writes its backup record directly, as it already does the seed. The footer gets a small client
component that calls a server action and polls a public `/api/version` route.

**Tech Stack:** Next.js 15 server actions, Drizzle (`drizzle-kit generate` for 0024), postgres.js,
vitest, Node `child_process` + `zlib`, Alpine `postgresql16-client`.

**Spec:** `docs/superpowers/specs/2026-10-29-update-now-design.md`

## Global Constraints

- **Environment variables:**
  - `WATCHTOWER_URL` and `WATCHTOWER_TOKEN`, unprefixed. Empty URL means no button.
  - The token is never sent to a page or the browser, never stored, never logged.
- **The Watchtower call:**
  - It is `POST {WATCHTOWER_URL}/v1/update?image=<repo>`, with header
    `Authorization: Bearer <token>`.
  - `<repo>` is `BALLAST_IMAGE_REPO` or `DEFAULT_IMAGE` (`ghcr.io/jmorganthall/ballastfinance`),
    never with a tag.
  - Every outbound request has `User-Agent: Ballast-self-update` and never `origin` or `referer`.
- **"Test connection" never calls `/v1/update`.** It sends a GET to `{WATCHTOWER_URL}/` only.
- **Timings:**
  - The request times out after 15 s.
  - The page gives up waiting after 4 minutes.
  - A pending attempt settles as "no change" 10 minutes after it was made.
  - The backup is capped at 2 minutes.
- **Backup files:**
  - Names are `ballast-<YYYY-MM-DDTHH-MM-SSZ>-before-update.sql.gz` (UTC), so the prune glob
    `ballast-*.sql.gz` in `backup.sh` covers them.
  - They are written as `.partial` first, kept only if the dump contains
    `CREATE TABLE public.events`, then renamed.
- **The backup folder:**
  - Inside the container it is `BALLAST_BACKUP_DIR`, default `/backups`.
  - The compose host variable is `BACKUP_DIR`.
  - It must be a mount point, or the backup is refused with "/backups is not mounted".
- **A failed backup never stops the start.**
- **On-screen words:** "Update now", "Starting…", "Updating — back in a minute",
  "Updated", "No change", "Didn't start", "Waiting to see".

## Review Focus

1. **Watchtower recreates Ballast before the server action returns.** The browser's call
   rejects with a network error, and the page must treat that as started and begin polling,
   never show an error. *Test:* the component's `outcomeOfCallError` test, Task 6.
2. **A Watchtower address that times out on connect** (a wrong IP on the LAN) must read as
   unreachable, not as started. Undici reports this as `UND_ERR_CONNECT_TIMEOUT`. *Test:*
   Task 2, `classifyFetchError`.
3. **A start with migrations waiting on a database that has never been migrated** (first
   install) must take no backup and record nothing, and must not crash on the missing
   `drizzle.__drizzle_migrations` table. *Test:* Task 4, the `pendingMigrations` fresh-database
   case.
4. **`pg_dump` exits non-zero part-way, or hits the cap.** No `.partial` and no misleading file
   may be left behind, and the reason must be recorded. *Test:* Task 3, the fake-spawn failure
   and timeout cases.
5. **The new build answers the version poll while the old session cookie is still in
   flight.** `/api/version` must answer without sign-in, so a reload never lands on an error.
   *Test:* Task 6, the route test asserts no `requireViewer` is needed.

---

### Task 1: Tables (migration 0024) and the Engine methods

**Files:**
- Modify: `src/db/schema.ts` (append three tables)
- Create: `drizzle/0024_*.sql` + snapshot/journal via `npm run db:generate`, with a header comment added by hand
- Modify: `src/server/engine.ts` (a new "server upkeep" section)
- Test: `src/server/__tests__/self-update.integration.test.ts`

**Interfaces:**
- **Tables:** the outcome and verdict columns are plain text with CHECK constraints, not
  enums.
  - `update_attempts`: `id` uuid pk; `created_at` timestamptz default now; `actor_user_id`
    uuid → users, set null on delete; `url` text not null; `token_sent` boolean not null;
    `revision_before` text; `outcome` text not null, one of
    `requested|accepted|dropped|rejected|unreachable`; `http_status` int; `response_body`
    text; `error` text; `elapsed_ms` int; `verdict` text not null default `pending`, one of
    `pending|updated|no_change|failed`; `verdict_at` timestamptz; `revision_after` text.
  - `database_backups`: `id` uuid pk; `taken_at` timestamptz default now; `revision` text;
    `migrations` text[] not null; `ok` boolean not null; `file` text; `bytes` bigint (mode
    number); `elapsed_ms` int not null; `reason` text. CHECK: `ok` exactly when `file` is not
    null.
  - `backup_notice_dismissals`: `backup_id` → database_backups (cascade); `user_id` → users
    (cascade); `dismissed_at` timestamptz default now. The primary key is
    (`backup_id`, `user_id`).
- **Engine methods, produced in `engine.ts`:**
  - `recordUpdateAttempt(input: { url: string; tokenSent: boolean; revisionBefore: string | null }): Promise<Id>`
  - `finishUpdateAttempt(id: Id, fields: AttemptFinish): Promise<void>`, where
    `AttemptFinish = { outcome: AttemptOutcome; httpStatus?: number | null; responseBody?: string | null; error?: string | null; elapsedMs?: number | null; verdict?: AttemptVerdict }`.
    The types are exported from `self-update.ts` (Task 2).
  - `updateHistory(input: { runningRevision: string | null; now?: Date; limit?: number }): Promise<UpdateAttempt[]>`
    settles pending rows through `settleAttempt` (Task 2), writes the settled ones back, and
    returns the newest first. The default limit is 10.
  - `backupNotice(): Promise<{ id: Id; takenAt: Date; reason: string; migrations: string[] } | null>`
    returns the latest `database_backups` row, only when it is not ok and this actor has not
    dismissed it.
  - `latestBackup(): Promise<DatabaseBackup | null>`
  - `dismissBackupNotice(backupId: Id): Promise<void>`. It is idempotent, and it refuses with
    `EngineError` when there is no actor.

- [ ] **Step 1: Write the failing integration test.** It uses `describeDb` like
  `engine.integration.test.ts`. The cases:
  - Recording, then finishing as `dropped`, then calling `updateHistory` at `created_at` + 11
    minutes with `runningRevision` equal to `revision_before` gives verdict `no_change`.
  - The same with a different revision gives `updated` and sets `revision_after`.
  - `rejected` with verdict `failed` stays failed.
  - A failed `database_backups` row gives a `backupNotice` for user A until A dismisses it.
    User B still sees it.
  - An ok row gives a null notice.
- [ ] **Step 2:** run `DATABASE_URL=postgres://ballast@localhost:5432/ballast npx vitest run src/server/__tests__/self-update.integration.test.ts`. Expected: FAIL (no tables/methods).
- [ ] **Step 3:** add the tables to the schema, then run `npm run db:generate`. Rename the file
  to `0024_update_now.sql` in the journal and the file name, and add the header comment.
- [ ] **Step 4:** implement the Engine methods. Because the tables belong to no household, the
  methods ignore `householdId`; say so in the section comment.
- [ ] **Step 5:** apply migrations to the test database (`DATABASE_MIGRATION_URL=… npx tsx scripts/bootstrap.ts`), then run the test. Expected: PASS.
- [ ] **Step 6:** commit.

### Task 2: `src/server/self-update.ts`: config, the call, the test, settling

**Files:**
- Create: `src/server/self-update.ts`
- Test: `src/server/__tests__/self-update.test.ts`

**Interfaces (produced):**
- `type AttemptOutcome = 'requested'|'accepted'|'dropped'|'rejected'|'unreachable'`
- `type AttemptVerdict = 'pending'|'updated'|'no_change'|'failed'`
- `interface UpdateAttempt { id; createdAt: Date; url; tokenSent; revisionBefore; outcome; httpStatus; responseBody; error; elapsedMs; verdict; verdictAt: Date|null; revisionAfter }`
- `selfUpdateConfig(env?: Env): { configured: boolean; url: string | null; tokenSet: boolean; image: string }`.
  `url` has its trailing slashes removed.
- `selfUpdateOffered(env?: Env): boolean` is true when the address is configured AND:
  - `BALLAST_IMAGE` is unset; or
  - it parses (through `version.ts` `parseImage`, extended or wrapped to keep the tag) to the
    same host and path as the image repo, with tag equal to `BALLAST_UPDATE_TAG`, or `latest`
    when no tag is given.
- `classifyFetchError(error: unknown): { kind: 'dropped' | 'unreachable'; reason: string }`:
  - **dropped:** `ECONNRESET`, `UND_ERR_SOCKET`, `EPIPE`, `UND_ERR_HEADERS_TIMEOUT`,
    `UND_ERR_BODY_TIMEOUT`, or an `AbortSignal.timeout` `TimeoutError`. The error code is read
    from `error.cause.code`.
  - **unreachable:** everything else (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
    `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, unknown).
- `callWatchtower(input: { url: string; token: string | null; image: string; fetchImpl?: Fetch; timeoutMs?: number }): Promise<{ outcome: 'accepted'|'rejected'|'dropped'|'unreachable'; httpStatus: number|null; body: string|null; reason: string|null; elapsedMs: number }>`.
  A 2xx is accepted, any other status is rejected, and a thrown error goes through
  `classifyFetchError`. The body is cut to 2048 characters.
- `testWatchtower(input: { url: string; fetchImpl?: Fetch }): Promise<{ reachable: boolean; httpStatus: number | null; reason: string | null }>`.
  GET `{url}/`, timeout 6 s. Any HTTP status counts as reachable.
- `settleAttempt(a: Pick<UpdateAttempt,'createdAt'|'outcome'|'verdict'|'revisionBefore'>, runningRevision: string|null, now: Date): { verdict: AttemptVerdict; revisionAfter: string|null } | null`.
  It returns null when nothing changes. The rules:
  - `rejected` or `unreachable` gives `failed`.
  - Revisions differing (through `compareRevisions` `'behind'`) gives `updated`.
  - Ten minutes or more since `createdAt` gives `no_change`.
  - Otherwise null.
- `attemptWords(a: UpdateAttempt): { label: 'Updated'|'No change'|"Didn't start"|'Waiting to see'; detail: string }`.
  The plain sentences, adapted from PathBrain's `verify_pending_updates` detail strings. "No
  change" names the usual causes: outside Watchtower's scope or labels, already current, or no
  registry access.

- [ ] **Step 1: Write the failing tests.**
  - `callWatchtower` with a fake fetch:
    - It asserts the URL is `http://wt:8080/v1/update?image=ghcr.io%2Fjmorganthall%2Fballastfinance`
      (or the unencoded equivalent; pick one and assert it), the method is `POST`, the headers
      are `Authorization: Bearer tok` and `User-Agent: Ballast-self-update`, and there is no
      `origin` and no `referer`.
    - 200 gives accepted.
    - 401 gives rejected with status 401.
    - Throwing `Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })`
      gives dropped.
    - `ECONNREFUSED` gives unreachable.
    - `UND_ERR_CONNECT_TIMEOUT` gives unreachable.
    - `new DOMException('x','TimeoutError')` gives dropped.
    - With no token, there is no Authorization header.
  - `testWatchtower`:
    - The URL is `http://wt:8080/` and the method is GET.
    - A 404 counts as reachable.
    - Refused counts as not reachable.
  - `selfUpdateOffered`:
    - The empty URL case gives false.
    - URL set with `BALLAST_IMAGE` unset gives true.
    - `ghcr.io/jmorganthall/ballastfinance:latest` gives true.
    - `:v1.2.0` gives false.
    - `ghcr.io/someone/fork:latest` gives false.
    - `BALLAST_UPDATE_TAG=edge` with `:edge` gives true.
  - `settleAttempt`:
    - Each rule above.
    - A 9-minute pending same-revision attempt gives null.
- [ ] **Step 2:** run `npx vitest run src/server/__tests__/self-update.test.ts`. Expected: FAIL.
- [ ] **Step 3:** implement. Reuse `compareRevisions` and `parseImage` from `version.ts`, and
  do not copy them.
- [ ] **Step 4:** run the tests. Expected: PASS.
- [ ] **Step 5:** commit.

### Task 3: `src/server/db-backup.ts`: the dump and the mount check

**Files:**
- Create: `src/server/db-backup.ts`. It must have no Next.js or `@/db/client` imports, because
  the bootstrap bundles it.
- Test: `src/server/__tests__/db-backup.test.ts`

**Interfaces (produced):**
- `backupFileName(now: Date): string` gives `ballast-2026-10-29T01-58-03Z-before-update.sql.gz`.
- `isMountPoint(dir: string, mountinfo: string): boolean`. Field 5 of each
  `/proc/self/mountinfo` line is the mount point. Compare against the resolved dir, with octal
  escapes like `\040` decoded.
- `checkBackupFolder(dir: string, deps?: { readMountinfo?: () => Promise<string> }): Promise<{ ok: true } | { ok: false; reason: string }>`.
  The reasons, verbatim:
  - `"<dir> does not exist"`
  - `"<dir> is not mounted from the host, so a backup there would vanish with the container"`
  - `"<dir> cannot be written by this container (it runs as user 1001)"`

  The write check creates and deletes `.ballast-write-test`.
- `takeBackup(input: { databaseUrl: string; dir: string; now?: Date; timeoutMs?: number; spawnImpl?: typeof spawn; checkFolder?: typeof checkBackupFolder }): Promise<{ ok: true; file: string; bytes: number; elapsedMs: number } | { ok: false; reason: string; elapsedMs: number }>`.
  - It runs `checkFolder` first.
  - It then spawns `pg_dump --no-owner --no-privileges --format=plain --dbname=<url with the password removed>`,
    with `PGPASSWORD` in the child's env.
  - It pipes stdout through `zlib.createGzip({ level: 9 })` into `<file>.partial`, watching the
    uncompressed stream for `CREATE TABLE public.events`.
  - On non-zero exit, a spawn error (ENOENT reads "pg_dump is not installed in this image"),
    the timeout (`SIGKILL` and "the backup took longer than 2 minutes"), or a missing events
    table, it removes the partial file.
  - On success it renames the file and returns its size.

- [ ] **Step 1: Write the failing tests.**
  - `backupFileName` with a fixed date.
  - `isMountPoint` with a mountinfo fixture that has `/backups`, `/` and `/mnt/my\040dir`.
  - `checkBackupFolder` on a temp dir with a fake mountinfo listing it (ok), and not listing
    it (the "not mounted" reason), and on a missing dir.
  - `takeBackup` with a fake spawn that emits stdout `CREATE TABLE public.events (...);` and
    exits 0:
    - The file exists and the `.partial` does not.
    - `gunzip` of the file gives the text back.
    - The args contain no password, and the env carries `PGPASSWORD`.
  - The fake exits 1: `ok: false`, the reason names `pg_dump exited with code 1` plus its
    stderr tail, and no files are left.
  - The fake never exits with `timeoutMs: 50`: the reason is the timeout one, the child was
    killed, and no files are left.
  - The stdout lacks the events table: refused, and no file is left.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run. Expected: PASS. Also run it once against the real local `pg_dump` and the
  test database through a scratch script, outside the test suite.
- [ ] **Step 5:** commit.

### Task 4: Bootstrap backs up before a waiting migration

**Files:**
- Modify: `scripts/bootstrap.ts`
- Modify: `src/server/db-backup.ts` (add `pendingMigrations`)
- Modify: `Dockerfile` (runner: `RUN apk add --no-cache postgresql16-client`, before `USER`)
- Test: `src/server/__tests__/db-backup.test.ts`, plus a `describeDb` case

**Interfaces:**
- `pendingMigrations(sql: postgres.Sql, journal: { entries: { tag: string; when: number }[] }): Promise<{ fresh: boolean; pending: string[] }>`.
  - `fresh` is true when the table `drizzle.__drizzle_migrations` does not exist.
  - `pending` holds the tags whose `when` is greater than `max(created_at)` in that table.
    This is drizzle's own rule.
- **In `main()`, after `waitForDatabase`:**
  - Read `${MIGRATIONS_FOLDER}/meta/_journal.json`.
  - When `!fresh && pending.length`, call `takeBackup({ databaseUrl: migrationUrl, dir: process.env.BALLAST_BACKUP_DIR || '/backups' })`
    and log either `backed up to <file> (<bytes> bytes) before migrating` or
    `WARNING: no backup before migrating: <reason> — starting anyway`.
  - After `migrate()`, insert one `database_backups` row through the owner connection:
    `revision = BALLAST_BUILD_SHA || null`, `migrations = pending`, and the outcome's fields.
  - An insert failure is logged and never fatal.

- [ ] **Step 1: Write the failing database test.**
  - Against the migrated test database, `pendingMigrations` with the real journal gives
    `{ fresh: false, pending: [] }`.
  - With a journal plus a fake entry `{ tag: '9999_x', when: Date.now() + 1e6 }`, it gives
    `pending: ['9999_x']`.
  - Against a newly created empty database (`create database ballast_fresh_<rand>`, dropped
    after), it gives `fresh: true`.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement `pendingMigrations` and the bootstrap wiring, plus the Dockerfile
  line.
- [ ] **Step 4:** run the tests, then `npm run build:bootstrap`. Expected: both succeed.
- [ ] **Step 5:** do a manual check. Drop the last row of `drizzle.__drizzle_migrations` in the
  test database. Run `BALLAST_BACKUP_DIR=<scratch dir> npx tsx scripts/bootstrap.ts`, and
  expect the "no backup … not mounted" warning, the start carrying on, and a failed row.
- [ ] **Step 6:** commit.

### Task 5: Server actions

**Files:**
- Modify: `src/server/actions.ts`

**Interfaces (produced):**
- `updateNowAction(): Promise<{ started: boolean; message: string }>`:
  - It calls `requireEngine`.
  - When the update is not offered, it returns `{ started: false, message: 'Updates through Watchtower are not set up.' }`.
  - Otherwise it records the attempt (before the request), calls `callWatchtower`, finishes the
    attempt, and maps the outcome:
    - accepted or dropped: `started: true`, "Updating — back in a minute".
    - rejected 401 or 403: "Watchtower turned it down (HTTP 401) — check WATCHTOWER_TOKEN.
      Nothing was updated."
    - unreachable: "Could not reach Watchtower at <url>: <reason>. Nothing was updated."
- `testUpdateConnectionAction(): Promise<{ watchtower: string; backups: string; ok: boolean }>`
  reports `testWatchtower` plus `checkBackupFolder(BALLAST_BACKUP_DIR || '/backups')`, in plain
  sentences.
- `dismissBackupNoticeAction(formData: FormData): Promise<void>` reads `backup_id` and calls
  `revalidatePath('/', 'layout')`.

- [ ] **Step 1:** implement. The logic is covered by Tasks 1 to 3; the actions only connect
  the pieces.
- [ ] **Step 2:** `npm run typecheck`. Expected: clean.
- [ ] **Step 3:** commit.

### Task 6: Footer button, version route, Settings card

**Files:**
- Create: `src/app/api/version/route.ts`. It is a GET returning `{ revision: runningBuild().revision }`,
  with `dynamic = 'force-dynamic'` and no sign-in.
- Create: `src/components/shell/update-now.tsx` ('use client')
- Modify: `src/components/shell/footer.tsx`
- Create: `src/app/(app)/settings/update-card.tsx`; Modify: `src/app/(app)/settings/page.tsx`
- Test: `src/components/__tests__/update-now.test.ts`, `src/app/api/version/__tests__/route.test.ts`

**Interfaces:**
- `outcomeOfCallError(error: unknown): 'started'`, exported from `update-now.tsx`. Any thrown
  error from the action call means the container went away, so the page polls.
- `shouldReload(fromRevision: string | null, polled: { revision: string | null } | null): boolean`
  is true when the polled revision is set and differs.
- `UpdateNow({ revision }: { revision: string | null })` has these states:
  - `idle`: an "Update now" button.
  - `starting`: "Starting…", disabled.
  - `updating`: "Updating — back in a minute", polling `/api/version` every 3 s with
    `cache: 'no-store'` and reloading on `shouldReload`.
  - `stuck`: after 4 min, "Watchtower took the request, but Ballast is still on <rev>.", with a
    link to `/settings#updates`.
  - `error`: the action's message, plus the button again.
- **Footer:**
  - When behind and `selfUpdateOffered()`, the sentence becomes "Press Update now to install
    it, or pull the latest image and restart the container.", with `<UpdateNow>` below it.
    When not offered, it stays the current wording. The "migrates itself on start" sentence
    gets "and takes a backup first" added.
  - When `currentViewer()` is not null and `engine.backupNotice()` gives a notice, the footer
    shows a line above the build line in the caution colour: "The last update changed the
    database without a backup: <reason>." It has a "Got it" form button posting
    `dismissBackupNoticeAction`.
- **Settings card**, with id `updates`, titled "Updates":
  - Watchtower: "Set up at <url>", with "token set" or "no token", or "Not set up — set
    WATCHTOWER_URL and WATCHTOWER_TOKEN".
  - A "Test connection" client button showing the action's two sentences.
  - "Last backup before an update": file and size, or the reason, with a relative time.
  - "Update history": up to 10 attempts through `attemptWords`, each with its time, label and
    detail, newest first, read from `engine.updateHistory({ runningRevision })`.

- [ ] **Step 1: Write the failing tests.**
  - `outcomeOfCallError(new TypeError('Failed to fetch'))` gives `'started'`.
  - `shouldReload('aaa', { revision: 'bbb' })` gives true.
  - `shouldReload('aaa', { revision: 'aaa' })` gives false.
  - `shouldReload('aaa', null)` gives false.
  - `shouldReload('aaa', { revision: null })` gives false.
  - The route test calls `GET()` with `BALLAST_BUILD_SHA` set, and asserts the JSON and that
    no auth module is imported. Mock `@/auth` to throw if called.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** implement the components and the route, using the existing `Card` and
  `When` from `ui.tsx`.
- [ ] **Step 4:** run `npm test && npm run typecheck && npm run build`. Expected: all pass, and
  the build needs no `DATABASE_URL`.
- [ ] **Step 5:** commit.

### Task 7: Compose, env example, docs, CLAUDE.md

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.ghcr.yml`, `docker-compose.quickstart.yml`
- Modify: `.env.example`, `docs/running-it.md`, `CLAUDE.md`, `README.md` (the troubleshooting
  row, only if it is needed)

**Changes:**
- **App service, in each compose file:**
  - Under a `# Watchtower` comment: `WATCHTOWER_URL: "${WATCHTOWER_URL:-}"` and
    `WATCHTOWER_TOKEN: "${WATCHTOWER_TOKEN:-}"`.
  - `BALLAST_BACKUP_DIR: /backups`, and the volume `- ${BACKUP_DIR:-./backups}:/backups`.
  - In the ghcr file only: `BALLAST_IMAGE: "${BALLAST_IMAGE:-ghcr.io/jmorganthall/ballastfinance:latest}"`.
  - The label `com.centurylinklabs.watchtower.enable: 'true'`.
- **`.env.example`:** `WATCHTOWER_URL=http://192.168.2.6:8998` (commented as the household's
  example), `WATCHTOWER_TOKEN=`, and `BACKUP_DIR=/mnt/user/backups/ballast`, with the
  ownership note.
- **`running-it.md`:** a new section "Updating from the app". It covers:
  - The Watchtower flags: `--http-api-update`, `WATCHTOWER_HTTP_API_TOKEN`, and
    `--http-api-periodic-polls` to keep the schedule.
  - The two variables.
  - The backup mount and `chown 1001` on the host folder.
  - That the 30-day prune covers the files.
  - What "No change" usually means.
  - It also replaces "Updating is what it always was" in "Knowing when to update".
- **`CLAUDE.md`:**
  - Add `self-update.ts` (Watchtower on the LAN) to the outbound-calls sentence in the Layout
    table, and `db-backup.ts` to the server row.
  - Add a "Things that will bite you" bullet, "Update now goes through Watchtower, and a
    migration is backed up first". It summarises the rules from Global Constraints, the three
    tables, that the tables belong to no household and are not events, and that a failed
    backup never stops a start.
  - Update the test count.

- [ ] **Step 1:** make the edits.
- [ ] **Step 2:** `docker compose -f <each> config` if docker is available. Otherwise check the
  YAML with `node -e` and the `yaml` package if present, or by eye.
- [ ] **Step 3:** run `npm test`, and record the new test count in `CLAUDE.md`.
- [ ] **Step 4:** commit and push.
