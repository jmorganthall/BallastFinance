// The same ratchet as `npm run archguard`, inside the test suite. Hooks don't run in every
// Claude Code session (cloud threads in a project ignore them); tests and CI always do.
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('no data shape escapes the domain model (archguard ratchet)', () => {
  let out = ''
  try {
    execFileSync('node', ['scripts/archguard.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  expect(out, out).toBe('')
})
