/**
 * Scheduled jobs (PRD §8, §10).
 *
 * The app owns all computation on its own scheduler; n8n holds no logic, only
 * delivery. A cron expression here decides WHEN, the digest builders decide
 * WHAT, and the webhook decides only HOW it reaches a phone.
 *
 * Every job is wrapped so a failure in one household's digest cannot stop
 * another household's, and cannot crash the server.
 */

import cron, { type ScheduledTask } from 'node-cron'
import { db } from '@/db/client'
import { households } from '@/db/schema'
import { buildCheckInNudge, buildDueDatePrompts, buildWeeklyDigest } from '@/server/digest'
import { sendNotification } from '@/server/notifications'

const TIMEZONE = process.env.HOUSEHOLD_TIMEZONE ?? 'America/Chicago'

/**
 * Saturday morning, matching the household week boundary. If the digest arrived
 * on a different day than the transfer runs, the numbers in it would describe a
 * week the reader is not in.
 */
const WEEKLY_DIGEST_CRON = process.env.DIGEST_CRON ?? '0 8 * * 6'
const DUE_PROMPT_CRON = process.env.DUE_PROMPT_CRON ?? '0 9 * * 6'
const CHECK_IN_NUDGE_CRON = process.env.CHECK_IN_NUDGE_CRON ?? '0 17 * * 0'

const tasks: ScheduledTask[] = []

function baseUrl(): string {
  return process.env.AUTH_URL ?? 'http://localhost:3000'
}

async function forEachHousehold(
  label: string,
  run: (householdId: string, timezone: string) => Promise<void>,
): Promise<void> {
  try {
    const rows = await db.select().from(households)
    for (const household of rows) {
      try {
        await run(household.id, household.timezone)
      } catch (error) {
        console.error(`[cron:${label}] household ${household.id} failed:`, error)
      }
    }
  } catch (error) {
    console.error(`[cron:${label}] could not list households:`, error)
  }
}

function schedule(expression: string, label: string, job: () => Promise<void>): void {
  if (!cron.validate(expression)) {
    console.error(`[cron:${label}] invalid expression "${expression}"; job not scheduled`)
    return
  }
  tasks.push(
    cron.schedule(
      expression,
      () => {
        void job().catch((error) => console.error(`[cron:${label}] failed:`, error))
      },
      { timezone: TIMEZONE },
    ),
  )
  console.log(`[cron] ${label} scheduled at "${expression}" (${TIMEZONE})`)
}

export function startScheduler(): void {
  if (tasks.length > 0) return // already started

  schedule(WEEKLY_DIGEST_CRON, 'weekly-digest', async () => {
    await forEachHousehold('weekly-digest', async (householdId, timezone) => {
      const payload = await buildWeeklyDigest({ householdId, baseUrl: baseUrl(), timezone })
      await sendNotification(payload)
    })
  })

  schedule(DUE_PROMPT_CRON, 'due-date-prompts', async () => {
    await forEachHousehold('due-date-prompts', async (householdId, timezone) => {
      for (const payload of await buildDueDatePrompts({
        householdId,
        baseUrl: baseUrl(),
        timezone,
      })) {
        await sendNotification(payload)
      }
    })
  })

  schedule(CHECK_IN_NUDGE_CRON, 'check-in-nudge', async () => {
    await forEachHousehold('check-in-nudge', async (householdId, timezone) => {
      const payload = await buildCheckInNudge({ householdId, baseUrl: baseUrl(), timezone })
      if (payload) await sendNotification(payload)
    })
  })
}

export function stopScheduler(): void {
  for (const task of tasks) void task.stop()
  tasks.length = 0
}
