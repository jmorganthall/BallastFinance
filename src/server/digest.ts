/**
 * The weekly digest and the other scheduled prompts (PRD §8).
 *
 * Composition only: every figure here comes from the derivation module, and the
 * wording follows §9's plain-language rule, because this text is read on a phone
 * lock screen by someone who is not thinking about accruals.
 */

import { Engine } from '@/server/engine'
import type { Db } from '@/db/client'
import type { NotificationPayload } from '@/server/notifications'
import { formatCents, instructionSentence, transferWeeksBetween } from '@/domain'

export interface DigestInput {
  householdId: string
  baseUrl: string
  timezone?: string
  /** Injectable so a digest can be asserted against a test database. */
  db?: Db
  /** Injectable so a digest is reproducible rather than clock-dependent. */
  today?: string
}

/** User ids who have muted themselves, passed through so n8n can skip them. */
async function mutedUserIds(engine: Engine): Promise<string[]> {
  const prefs = await engine.getSetting<Record<string, boolean>>('notification_prefs', {})
  return Object.entries(prefs)
    .filter(([, receives]) => receives === false)
    .map(([userId]) => userId)
}

function engineFor(input: DigestInput): Engine {
  return new Engine({
    householdId: input.householdId,
    actorUserId: null,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.db ? { db: input.db } : {}),
    ...(input.today ? { today: input.today } : {}),
  })
}

export async function buildWeeklyDigest(input: DigestInput): Promise<NotificationPayload> {
  const engine = engineFor(input)
  const today = engine.today()

  const [accounts, outstanding, closeOuts] = await Promise.all([
    engine.accountViews(),
    engine.outstandingInstructions(),
    engine.closeOutPrompts(),
  ])

  const active = accounts.filter((a) => a.weekly.totalPerWeekCents !== 0)
  const total = active.reduce((s, a) => s + a.weekly.totalPerWeekCents, 0)

  const lines: string[] = [`## This week — ${today}`, '']

  if (active.length === 0) {
    lines.push('Nothing to move this week.')
  } else {
    lines.push(`**Move ${formatCents(total)} in total.**`, '')
    for (const view of active) {
      const w = view.weekly
      const parts =
        w.catchUp.length > 0
          ? ` (${formatCents(w.ongoingPerWeekCents)} ongoing${w.catchUp
              .map((g) => ` + ${formatCents(g.perWeekCents)} extra until ${g.endDate}`)
              .join('')})`
          : ''
      lines.push(`- **${view.account.name}**: ${formatCents(w.totalPerWeekCents)}/week${parts}`)
      lines.push(`  - should hold ${formatCents(view.shouldHaveSavedCents)} today`)
    }
  }

  if (closeOuts.length > 0) {
    lines.push('', '## Did these get spent?', '')
    for (const prompt of closeOuts) {
      lines.push(
        `- **${prompt.label}** (${formatCents(prompt.plannedCents)}) was due ${prompt.dueDate}`,
      )
    }
  }

  if (outstanding.length > 0) {
    lines.push('', '## Still to do', '')
    for (const instruction of outstanding) {
      lines.push(`- ${instructionSentence(instruction)}`)
    }
  }

  // Anything landing in the next fortnight, so nothing arrives as a surprise.
  const upcoming = accounts
    .flatMap((a) => a.items)
    .filter((item) => {
      const weeks = transferWeeksBetween(today, item.lineItem.dueDate)
      return weeks > 0 && weeks <= 2
    })
  if (upcoming.length > 0) {
    lines.push('', '## Coming up in the next two weeks', '')
    for (const item of upcoming) {
      lines.push(
        `- **${item.lineItem.label}** — ${formatCents(item.totalCents)} on ${item.lineItem.dueDate}`,
      )
    }
  }

  const summary =
    active.length === 0
      ? 'Ballast: nothing to move this week.'
      : `Ballast: move ${formatCents(total)} this week` +
        (closeOuts.length > 0 ? `, and ${closeOuts.length} thing(s) need confirming.` : '.')

  return {
    kind: 'weekly_digest',
    householdId: input.householdId,
    mutedUserIds: await mutedUserIds(engine),
    summary,
    body: lines.join('\n'),
    link: `${input.baseUrl}/`,
    detail: {
      total_per_week_cents: total,
      accounts: active.map((a) => ({
        id: a.account.id,
        name: a.account.name,
        per_week_cents: a.weekly.totalPerWeekCents,
        should_hold_cents: a.shouldHaveSavedCents,
      })),
      outstanding_count: outstanding.length,
      close_out_count: closeOuts.length,
    },
  }
}

/** Repeated weekly until confirmed (PRD §8). */
export async function buildDueDatePrompts(input: DigestInput): Promise<NotificationPayload[]> {
  const engine = engineFor(input)
  const [prompts, accounts] = await Promise.all([
    engine.closeOutPrompts(),
    engine.listReserveAccounts(),
  ])
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'your savings'

  return prompts.map((prompt) => ({
    kind: 'due_date_prompt' as const,
    householdId: input.householdId,
    summary: `Ballast: did the ${prompt.label} money get spent from ${accountName(prompt.reserveAccountId)}?`,
    body: `**${prompt.label}** was due ${prompt.dueDate}${
      prompt.daysOverdue > 0 ? ` (${prompt.daysOverdue} days ago)` : ''
    }.\n\nThe plan set aside ${formatCents(prompt.plannedCents)} in ${accountName(
      prompt.reserveAccountId,
    )}. Until you confirm, it stays counted in your totals.`,
    link: `${input.baseUrl}/`,
    detail: { line_item_id: prompt.lineItemId, days_overdue: prompt.daysOverdue },
  }))
}

/** Nudge when no balance has been confirmed for a while (PRD §8, default 2 weeks). */
export async function buildCheckInNudge(
  input: DigestInput & { afterWeeks?: number },
): Promise<NotificationPayload | null> {
  const engine = engineFor(input)
  const afterWeeks = input.afterWeeks ?? (await engine.getSetting('check_in_nudge_weeks', 2))
  const today = engine.today()

  const confirmed = await engine.latestConfirmedBalances()
  const accounts = (await engine.accountViews()).filter((a) => a.items.length > 0)
  if (accounts.length === 0) return null

  const stale = accounts.filter((view) => {
    const last = confirmed.get(view.account.id)
    if (!last) return true
    return transferWeeksBetween(last.on, today) >= afterWeeks
  })
  if (stale.length === 0) return null

  return {
    kind: 'check_in_nudge',
    householdId: input.householdId,
    summary: `Ballast: it has been a while since you checked ${stale.length === 1 ? stale[0]!.account.name : 'your savings accounts'}.`,
    body: `No balance recorded in the last ${afterWeeks} weeks for:\n\n${stale
      .map((v) => `- ${v.account.name} (should hold ${formatCents(v.shouldHaveSavedCents)})`)
      .join('\n')}\n\nA check-in takes under a minute.`,
    link: `${input.baseUrl}/check-in`,
    detail: { stale_account_ids: stale.map((v) => v.account.id) },
  }
}

/**
 * Promo-expiry warnings (PRD §8). Fired early enough to act on: the whole point
 * is clearing the balance before the rate resets, not being told afterwards.
 */
export async function buildPromoWarnings(input: DigestInput): Promise<NotificationPayload[]> {
  const engine = engineFor(input)
  const warnings = await engine.promoWarnings()

  return warnings.map((warning) => ({
    kind: 'promo_expiry_warning' as const,
    householdId: input.householdId,
    summary: `Ballast: ${warning.debt.name} stops being 0% on ${warning.untilDate}.`,
    body: `**${warning.debt.name}** has ${formatCents(warning.debt.balanceCents)} on a promotional rate that ends ${warning.untilDate}.\n\nTo clear it before interest starts, it needs ${formatCents(warning.monthlyToClearCents)} a month from here. After that date it costs ${(warning.debt.aprBasisPoints / 100).toFixed(2)}%.`,
    link: `${input.baseUrl}/debts`,
    detail: {
      debt_id: warning.debt.id,
      until_date: warning.untilDate,
      monthly_to_clear_cents: warning.monthlyToClearCents,
    },
  }))
}
