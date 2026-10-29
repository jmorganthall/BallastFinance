import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { backupFileName, checkBackupFolder, isMountPoint, takeBackup } from '../db-backup'

const MOUNTINFO = [
  '22 1 0:21 / / rw,relatime - overlay overlay rw',
  '35 22 8:1 /mnt/user/backups/ballast /backups rw,relatime - ext4 /dev/sda1 rw',
  '36 22 8:1 /x /mnt/my\\040dir rw,relatime - ext4 /dev/sda1 rw',
].join('\n')

describe('naming a backup', () => {
  it('matches the nightly backup pattern, so its 30-day prune covers it', () => {
    expect(backupFileName(new Date('2026-10-29T01:58:03.456Z'))).toBe(
      'ballast-2026-10-29T01-58-03Z-before-update.sql.gz',
    )
  })
})

describe('whether a folder is mounted from the host', () => {
  it('reads the mount point column of /proc/self/mountinfo', () => {
    expect(isMountPoint('/backups', MOUNTINFO)).toBe(true)
    expect(isMountPoint('/backups/', MOUNTINFO)).toBe(true)
    expect(isMountPoint('/mnt/my dir', MOUNTINFO)).toBe(true)
    expect(isMountPoint('/app', MOUNTINFO)).toBe(false)
  })
})

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ballast-backup-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const mountedAt = (dir: string) => async () => `22 1 0:21 / / rw - overlay overlay rw\n35 22 8:1 /h ${dir} rw - ext4 /dev/sda1 rw`

describe('checking the backup folder', () => {
  it('is fine when it exists, is mounted and can be written', async () => {
    const dir = tempDir()
    expect(await checkBackupFolder(dir, { readMountinfo: mountedAt(dir) })).toEqual({ ok: true })
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a folder that is not mounted, because a backup there vanishes with the container', async () => {
    const dir = tempDir()
    const result = await checkBackupFolder(dir, { readMountinfo: async () => MOUNTINFO })
    expect(result).toEqual({
      ok: false,
      reason: `${dir} is not mounted from the host, so a backup there would vanish with the container`,
    })
  })

  it('refuses a folder that does not exist', async () => {
    const result = await checkBackupFolder('/no/such/place', { readMountinfo: async () => MOUNTINFO })
    expect(result).toEqual({ ok: false, reason: '/no/such/place does not exist' })
  })
})

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: (signal?: string) => boolean
}

function fakeSpawn(script: (child: FakeChild) => void, seen: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  return ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen.args = args
    seen.env = options.env
    const child = new EventEmitter() as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('close', null, 'SIGKILL'))
      return true
    }
    setImmediate(() => script(child))
    return child
  }) as unknown as typeof import('node:child_process').spawn
}

const DUMP = 'SET x;\nCREATE TABLE public.events (\n  id uuid\n);\n'
const URL = 'postgres://ballast:s3cret@db:5432/ballast'

describe('taking a backup', () => {
  it('writes the gzipped dump, with the password kept out of the arguments', async () => {
    const dir = tempDir()
    const seen: { args?: string[]; env?: NodeJS.ProcessEnv } = {}
    const result = await takeBackup({
      databaseUrl: URL,
      dir,
      now: new Date('2026-10-29T01:58:03Z'),
      checkFolder: async () => ({ ok: true }),
      spawnImpl: fakeSpawn((child) => {
        child.stdout.end(DUMP)
        child.emit('close', 0, null)
      }, seen),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBe(join(dir, 'ballast-2026-10-29T01-58-03Z-before-update.sql.gz'))
    expect(readdirSync(dir)).toEqual(['ballast-2026-10-29T01-58-03Z-before-update.sql.gz'])
    expect(gunzipSync(readFileSync(result.file)).toString()).toBe(DUMP)
    expect(result.bytes).toBeGreaterThan(0)
    expect(seen.args).toContain('--no-owner')
    expect(seen.args).toContain('--no-privileges')
    expect(seen.args!.join(' ')).not.toContain('s3cret')
    expect(seen.args).toContain('--dbname=postgres://ballast@db:5432/ballast')
    expect(seen.env?.PGPASSWORD).toBe('s3cret')
  })

  it('says why and leaves nothing behind when pg_dump fails', async () => {
    const dir = tempDir()
    const result = await takeBackup({
      databaseUrl: URL,
      dir,
      checkFolder: async () => ({ ok: true }),
      spawnImpl: fakeSpawn((child) => {
        child.stdout.write('SET x;\n')
        child.stderr.end('pg_dump: error: connection refused\n')
        child.stdout.end()
        child.emit('close', 1, null)
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('pg_dump exited with code 1: pg_dump: error: connection refused')
    expect(readdirSync(dir)).toEqual([])
  })

  it('stops a backup that runs past its time and leaves nothing behind', async () => {
    const dir = tempDir()
    let killed = false
    const result = await takeBackup({
      databaseUrl: URL,
      dir,
      timeoutMs: 50,
      checkFolder: async () => ({ ok: true }),
      spawnImpl: fakeSpawn((child) => {
        child.stdout.write('SET x;\n')
        const kill = child.kill
        child.kill = (signal) => {
          killed = true
          return kill(signal)
        }
      }),
    })
    expect(killed).toBe(true)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('the backup took longer than 0.05 seconds')
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a dump with no events table, which is a dump of the wrong database', async () => {
    const dir = tempDir()
    const result = await takeBackup({
      databaseUrl: URL,
      dir,
      checkFolder: async () => ({ ok: true }),
      spawnImpl: fakeSpawn((child) => {
        child.stdout.end('SET x;\n')
        child.emit('close', 0, null)
      }),
    })
    expect(result).toMatchObject({ ok: false, reason: 'the dump has no events table, so it was not kept' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('says pg_dump is missing when the image has none', async () => {
    const dir = tempDir()
    const result = await takeBackup({
      databaseUrl: URL,
      dir,
      checkFolder: async () => ({ ok: true }),
      spawnImpl: fakeSpawn((child) => {
        child.emit('error', Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' }))
      }),
    })
    expect(result).toMatchObject({ ok: false, reason: 'pg_dump is not installed in this image' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not run pg_dump when the folder is not fit', async () => {
    let ran = false
    const result = await takeBackup({
      databaseUrl: URL,
      dir: '/backups',
      checkFolder: async () => ({ ok: false, reason: '/backups does not exist' }),
      spawnImpl: fakeSpawn(() => {
        ran = true
      }),
    })
    expect(ran).toBe(false)
    expect(result).toMatchObject({ ok: false, reason: '/backups does not exist' })
    expect(existsSync('/backups/x')).toBe(false)
  })
})
