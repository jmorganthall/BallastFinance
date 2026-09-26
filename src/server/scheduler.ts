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
import {
  buildCheckInNudge,
  buildDueDatePrompts,
  buildPromoWarnings,
  buildWeeklyDigestIfDue,
  weeklyDigestDueToday,
} from '@/server/digest'
import { sendNotification } from '@/server/notifications'
import { Engine } from '@/server/engine'
import { fetchMarketMortgageRate, marketRateFetchEnabled } from '@/server/market-rate'
import { parkDataFetchEnabled } from '@/server/park-fetch'

const TIMEZONE = process.env.HOUSEHOLD_TIMEZONE ?? 'America/Chicago'

/**
 * The time of day the digest goes out (PRD D31). It is checked every morning
 * and sent to a household only on its own transfer day, so the numbers in it
 * describe the week the reader is in. An older value naming a weekday, like
 * "0 8 * * 6", still works: it just never checks on the other days.
 */
const WEEKLY_DIGEST_CRON = process.env.DIGEST_CRON ?? '0 8 * * *'
// Daily, like the digest: the job checks each household's transfer day itself (D31).
const DUE_PROMPT_CRON = process.env.DUE_PROMPT_CRON ?? '0 9 * * *'
const CHECK_IN_NUDGE_CRON = process.env.CHECK_IN_NUDGE_CRON ?? '0 17 * * 0'
const PROMO_WARNING_CRON = process.env.PROMO_WARNING_CRON ?? '0 10 * * 1'
/**
 * Daily, though the survey is weekly (Thursdays): one small download a day
 * means a missed week heals itself the next morning, not the next Thursday.
 */
const MARKET_RATE_CRON = process.env.MARKET_RATE_CRON ?? '0 9 * * *'
/**
 * Ballast's own park data (PRD §16, D28). Weather and park hours overnight,
 * when the sources have posted the day ahead; the live waits every five
 * minutes, which is how often the feed itself changes. Each is switched off
 * on its own by setting its cron to "off", and all three by PARK_DATA_FETCH=off.
 * They are reference data shared by every household, so each runs once.
 */
const PARK_WEATHER_CRON = process.env.PARK_WEATHER_CRON ?? '15 3 * * *'
const PARK_HOURS_CRON = process.env.PARK_HOURS_CRON ?? '45 3 * * *'
const WAIT_POLL_CRON = process.env.WAIT_POLL_CRON ?? '*/5 * * * *'

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

/**
 * Reference data belongs to no household, but every write goes through an
 * engine bound to one (PRD §10). The first household stands in: the rows it
 * writes carry no household, and the settings it reads (park ids, the
 * outlook link) are the ones the screen's button would read too.
 */
async function referenceEngine(): Promise<Engine | null> {
  const [household] = await db.select().from(households).limit(1)
  if (!household) return null
  return new Engine({ householdId: household.id, actorUserId: null, timezone: household.timezone })
}

function schedule(expression: string, label: string, job: () => Promise<void>): void {
  if (expression.trim().toLowerCase() === 'off') {
    console.log(`[cron] ${label} is off`)
    return
  }
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

/** One download, stored for every household. A failure leaves the last rate in place. */
async function refreshMarketRate(): Promise<void> {
  const rate = await fetchMarketMortgageRate()
  if (!rate) {
    console.error('[cron:market-rate] FRED returned nothing that reads as a mortgage rate; keeping the last one')
    return
  }
  await forEachHousehold('market-rate', async (householdId, timezone) => {
    await new Engine({ householdId, actorUserId: null, timezone }).recordMarketMortgageRate(rate)
  })
}

async function refreshParkWeather(): Promise<void> {
  const engine = await referenceEngine()
  if (!engine) return
  const done = await engine.refreshParkData({ parts: ['weather', 'outlook'] })
  for (const line of done.notes) console.error(`[cron:park-weather] ${line}`)
  console.log(`[cron:park-weather] stored ${done.weather} weather days and ${done.outlook} outlook park-days`)
}

async function refreshParkHours(): Promise<void> {
  const engine = await referenceEngine()
  if (!engine) return
  const done = await engine.refreshParkData({ parts: ['hours'] })
  for (const line of done.notes) console.error(`[cron:park-hours] ${line}`)
  console.log(`[cron:park-hours] stored ${done.hours} park-days of hours`)
}

async function pollWaits(): Promise<void> {
  const engine = await referenceEngine()
  if (!engine) return
  const done = await engine.pollWaits()
  for (const line of done.notes) console.error(`[cron:wait-poll] ${line}`)
  if (done.inserted > 0) console.log(`[cron:wait-poll] ${done.inserted} new postings`)
}

export function startScheduler(): void {
  if (tasks.length > 0) return // already started

  if (parkDataFetchEnabled()) {
    schedule(PARK_WEATHER_CRON, 'park-weather', refreshParkWeather)
    schedule(PARK_HOURS_CRON, 'park-hours', refreshParkHours)
    schedule(WAIT_POLL_CRON, 'wait-poll', pollWaits)
  }

  if (marketRateFetchEnabled()) {
    schedule(MARKET_RATE_CRON, 'market-rate', refreshMarketRate)
    // Once at start, so a fresh install has a rate before its first morning.
    void refreshMarketRate().catch((error) => console.error('[cron:market-rate] failed:', error))
  }

  schedule(WEEKLY_DIGEST_CRON, 'weekly-digest', async () => {
    await forEachHousehold('weekly-digest', async (householdId, timezone) => {
      const payload = await buildWeeklyDigestIfDue({ householdId, baseUrl: baseUrl(), timezone })
      if (payload) await sendNotification(payload)
    })
  })

  schedule(DUE_PROMPT_CRON, 'due-date-prompts', async () => {
    await forEachHousehold('due-date-prompts', async (householdId, timezone) => {
      // "Did this get spent?" lands with the digest, on the household's transfer day.
      if (!(await weeklyDigestDueToday({ householdId, baseUrl: baseUrl(), timezone }))) return
      for (const payload of await buildDueDatePrompts({
        householdId,
        baseUrl: baseUrl(),
        timezone,
      })) {
        await sendNotification(payload)
      }
    })
  })

  schedule(PROMO_WARNING_CRON, 'promo-expiry-warnings', async () => {
    await forEachHousehold('promo-expiry-warnings', async (householdId, timezone) => {
      for (const payload of await buildPromoWarnings({
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
