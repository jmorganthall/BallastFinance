/**
 * A backup of the database, taken by the bootstrap just before it migrates.
 *
 * Every start runs the migrations, so a new image -- from "Update now",
 * Watchtower's own schedule or a manual pull -- can change the household's
 * money data hours after the nightly backup (`scripts/backup.sh`, from cron on
 * the host). So when a migration is waiting, the bootstrap takes a `pg_dump`
 * first, the same way the nightly script does: plain SQL, gzipped, written as
 * `.partial` and kept only if it holds the events table, named so the nightly
 * script's 30-day prune (`ballast-*.sql.gz`) covers it.
 *
 * A failed backup never stops a start (the household's decision): the reason
 * is returned, recorded, and shown in the app until each person says "Got it".
 *
 * A backup only counts when the folder is mounted from the host. One written
 * to the container's own disk would vanish with the next recreate -- exactly
 * the update it was meant to protect against.
 *
 * Imported by the bootstrap bundle, so nothing here may import Next.js or the
 * app's database client.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, constants, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createGzip } from 'node:zlib'
import type postgres from 'postgres'

export const DEFAULT_BACKUP_DIR = '/backups'
export const BACKUP_TIMEOUT_MS = 2 * 60 * 1000
const EVENTS_TABLE = 'CREATE TABLE public.events'

/** `ballast-2026-10-29T01-58-03Z-before-update.sql.gz`, in UTC like the nightly one. */
export function backupFileName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
  return `ballast-${stamp}-before-update.sql.gz`
}

/** `/proc/self/mountinfo` escapes spaces and the like as octal: `\040`. */
function unescapeMount(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/** Whether `dir` is itself a mount point. Field 5 of each mountinfo line is where it is mounted. */
export function isMountPoint(dir: string, mountinfo: string): boolean {
  const wanted = resolve(dir)
  return mountinfo
    .split('\n')
    .some((line) => {
      const point = line.split(' ')[4]
      return point !== undefined && unescapeMount(point) === wanted
    })
}

export type FolderCheck = { ok: true } | { ok: false; reason: string }

export async function checkBackupFolder(
  dir: string,
  deps: { readMountinfo?: () => Promise<string> } = {},
): Promise<FolderCheck> {
  const readMountinfo = deps.readMountinfo ?? (() => readFile('/proc/self/mountinfo', 'utf8'))
  try {
    if (!(await stat(dir)).isDirectory()) return { ok: false, reason: `${dir} is not a folder` }
  } catch {
    return { ok: false, reason: `${dir} does not exist` }
  }
  let mountinfo: string
  try {
    mountinfo = await readMountinfo()
  } catch {
    return { ok: false, reason: `could not tell whether ${dir} is mounted from the host` }
  }
  if (!isMountPoint(dir, mountinfo)) {
    return { ok: false, reason: `${dir} is not mounted from the host, so a backup there would vanish with the container` }
  }
  const probe = join(dir, '.ballast-write-test')
  try {
    await access(dir, constants.W_OK)
    await writeFile(probe, '')
    await unlink(probe)
  } catch {
    return { ok: false, reason: `${dir} cannot be written by this container (it runs as user ${process.getuid?.() ?? 1001})` }
  }
  return { ok: true }
}

function durationWords(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`
}

/** The connection string without its password, and the password for `PGPASSWORD`. */
function splitPassword(databaseUrl: string): { url: string; password: string | null } {
  try {
    const parsed = new URL(databaseUrl)
    const password = parsed.password ? decodeURIComponent(parsed.password) : null
    parsed.password = ''
    return { url: parsed.toString(), password }
  } catch {
    return { url: databaseUrl, password: null }
  }
}

export type BackupResult =
  | { ok: true; file: string; bytes: number; elapsedMs: number }
  | { ok: false; reason: string; elapsedMs: number }

export async function takeBackup(input: {
  databaseUrl: string
  dir: string
  now?: Date
  timeoutMs?: number
  spawnImpl?: typeof nodeSpawn
  checkFolder?: (dir: string) => Promise<FolderCheck>
}): Promise<BackupResult> {
  const started = Date.now()
  const elapsed = () => Date.now() - started
  const folder = await (input.checkFolder ?? checkBackupFolder)(input.dir)
  if (!folder.ok) return { ok: false, reason: folder.reason, elapsedMs: elapsed() }

  const file = join(input.dir, backupFileName(input.now ?? new Date()))
  const partial = `${file}.partial`
  const timeoutMs = input.timeoutMs ?? BACKUP_TIMEOUT_MS
  const { url, password } = splitPassword(input.databaseUrl)

  const outcome = await new Promise<{ ok: true } | { ok: false; reason: string }>((settle) => {
    let done = false
    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(result)
    }

    const child = (input.spawnImpl ?? nodeSpawn)(
      'pg_dump',
      ['--no-owner', '--no-privileges', '--format=plain', `--dbname=${url}`],
      { env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, reason: `the backup took longer than ${durationWords(timeoutMs)}` })
    }, timeoutMs)

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1000)
    })

    // Watch the uncompressed dump for the events table, across chunk edges.
    let sawEvents = false
    let carry = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (sawEvents) return
      const text = carry + chunk.toString()
      sawEvents = text.includes(EVENTS_TABLE)
      carry = text.slice(-EVENTS_TABLE.length)
    })

    const out = createWriteStream(partial)
    const gzip = createGzip({ level: 9 })
    child.stdout?.pipe(gzip).pipe(out)
    out.on('error', (error) => finish({ ok: false, reason: `could not write the backup: ${error.message}` }))

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: error.code === 'ENOENT' ? 'pg_dump is not installed in this image' : `pg_dump did not start: ${error.message}`,
      })
    })
    // Done when pg_dump has exited cleanly AND the file is fully written.
    let exited = false
    let written = false
    const maybeDone = () => {
      if (!exited || !written) return
      finish(sawEvents ? { ok: true } : { ok: false, reason: 'the dump has no events table, so it was not kept' })
    }
    out.on('finish', () => {
      written = true
      maybeDone()
    })
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const tail = stderr.trim().split('\n').pop()
        finish({ ok: false, reason: `pg_dump exited with code ${code ?? 'none'}${tail ? `: ${tail}` : ''}` })
        return
      }
      exited = true
      maybeDone()
    })
  })

  if (!outcome.ok) {
    await unlink(partial).catch(() => {})
    return { ok: false, reason: outcome.reason, elapsedMs: elapsed() }
  }
  await rename(partial, file)
  return { ok: true, file, bytes: (await stat(file)).size, elapsedMs: elapsed() }
}

export interface MigrationJournal {
  entries: { tag: string; when: number }[]
}

/**
 * Which migrations are waiting, by drizzle's own rule: an entry is applied
 * when its `when` is at or before the newest `created_at` in
 * `drizzle.__drizzle_migrations`. No such table means a database never
 * migrated -- a first install, with nothing in it to back up. Asked as the
 * owner: the app's role cannot see the drizzle schema.
 */
export async function pendingMigrations(
  sql: postgres.Sql,
  journal: MigrationJournal,
): Promise<{ fresh: boolean; pending: string[] }> {
  const [exists] = await sql<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present
  `
  if (!exists?.present) return { fresh: true, pending: journal.entries.map((e) => e.tag) }
  const [last] = await sql<{ at: string | null }[]>`
    select max(created_at)::text as at from drizzle.__drizzle_migrations
  `
  const lastAt = last?.at == null ? null : Number(last.at)
  return {
    fresh: false,
    pending: journal.entries.filter((e) => lastAt === null || e.when > lastAt).map((e) => e.tag),
  }
}
