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
import {
  awakeCloseOuts,
  debtStatusLabel,
  debtStatusLine,
  debtTodoSentence,
  derivedTodoSentence,
  formatCents,
  instructionSentence,
  isTransferDay,
  moneySinceSentence,
  accountsToCheckIn,
  dueWithinTransfers,
} from '@/domain'

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

/**
 * The digest goes out on the household's transfer day (PRD D31), so the
 * numbers in it describe the week the reader is in: the scheduler runs this
 * every morning and it says whether today is that day for this household.
 */
export async function weeklyDigestDueToday(input: DigestInput): Promise<boolean> {
  const engine = engineFor(input)
  return isTransferDay(engine.today(), await engine.transferWeekday())
}

/** The digest, or null when today is not this household's transfer day. */
export async function buildWeeklyDigestIfDue(
  input: DigestInput,
): Promise<NotificationPayload | null> {
  return (await weeklyDigestDueToday(input)) ? buildWeeklyDigest(input) : null
}

/**
 * The digest (PRD §8, D35). It says what the screens say, read from the same
 * position: the headline (All caught up, or what needs doing), each account's
 * transfer and status with the first date it would run short, the to-dos,
 * and what falls due in the next two weeks.
 */
export async function buildWeeklyDigest(input: DigestInput): Promise<NotificationPayload> {
  const engine = engineFor(input)
  const today = engine.today()

  // A snoozed "did this get spent?" stays out of the digest until it wakes (D38).
  const [{ position, debts: debtState, household }, closeOuts, transferWeekday] = await Promise.all([
    engine.view(),
    engine.closeOutPrompts().then(awakeCloseOuts),
    engine.transferWeekday(),
  ])
  // The headline and the list are the household view's (D56), as on This week.
  const caughtUp = household.caughtUp
  const debtsNeeding = debtState.debts.filter((d) => d.status !== 'on_track')

  const shown = position.accounts.filter((a) => a.parts.length > 0 || a.bank !== null)
  const lines: string[] = [`## This week — ${today}`, '']

  if (shown.length === 0 && debtsNeeding.length === 0) {
    lines.push('Nothing to move this week.')
  } else {
    lines.push(
      caughtUp
        ? `**All caught up.** On autopilot, every account covers everything due${position.coveredThrough ? ` through ${position.coveredThrough}` : ''}.`
        : '**Not caught up yet.** The to-dos below are what it takes.',
      '',
    )
    for (const a of shown) {
      const transfer = a.bank
        ? `${formatCents(a.bank.perWeekCents)}/week at the bank`
        : 'transfer not confirmed yet'
      const verdict =
        a.status === 'short' && a.short
          ? `runs short on ${a.short.on} by ${formatCents(a.short.byCents)}`
          : a.status === 'running_down' && a.short
            ? `covers this time round, but the transfer is below what its bills cost a year; the money runs out on ${a.short.on}`
            : a.status === 'unconfirmed'
              ? `needs ${formatCents(a.neededPerWeekCents)}/week`
              : a.horizon
                ? `covers everything through ${a.horizon}`
                : 'nothing due'
      lines.push(`- **${a.account.name}**: ${transfer} — ${verdict}`)
      if (a.transferChange && a.transferChange.reason !== 'confirm') {
        lines.push(
          `  - pending transfer change: ${formatCents(a.transferChange.fromCents ?? 0)} → ${formatCents(a.transferChange.toCents)}/week`,
        )
      }
    }
  }

  for (const view of debtsNeeding) {
    lines.push(
      `- **${view.debt.name}**: ${debtStatusLabel(view)} — ${debtStatusLine(view)
        .map((p) => p.text)
        .join('')}`,
    )
  }

  if (closeOuts.length > 0) {
    lines.push('', '## Did these get spent?', '')
    for (const prompt of closeOuts) {
      lines.push(
        `- **${prompt.label}** (${formatCents(prompt.plannedCents)}) was due ${prompt.dueDate}` +
          (prompt.spentCents > 0
            ? `: ${formatCents(prompt.spentCents)} spent so far, ${formatCents(prompt.needsCents)} still held`
            : ''),
      )
    }
  }

  const comingUp = household.comingUp
  if (household.todos.length > 0) {
    lines.push('', '## Still to do', '')
    for (const item of household.todos) {
      lines.push(
        `- ${
          item.from === 'position'
            ? derivedTodoSentence(item.todo)
            : item.from === 'debt'
              ? debtTodoSentence(item.todo)
              : `${instructionSentence(item.ask, transferWeekday)}${item.ask.note ? ` (${item.ask.note})` : ''}`
        }`,
      )
    }
  }
  // A move or a spend marked done since an account was counted (D34): the
  // same ask This week makes, in the same words, held back the same way until
  // nothing else that moves money is left to do.
  const toCount = position.accounts.filter((a) => a.money.countOwed)
  if (toCount.length > 0) {
    if (household.moneyToDo) {
      lines.push(`- When these are done, update what ${toCount.map((a) => a.account.name).join(' and ')} ${toCount.length === 1 ? 'holds' : 'hold'}.`)
    } else {
      lines.push('', '## Update what these accounts hold', '')
      for (const a of toCount) lines.push(`- **${a.account.name}**: ${moneySinceSentence(a.money)}`)
    }
  }
  if (comingUp.length > 0) {
    lines.push('', '## Coming up', '')
    for (const instruction of comingUp) {
      lines.push(
        `- ${instructionSentence(instruction, transferWeekday)}${instruction.note ? ` (${instruction.note})` : ''}`,
      )
    }
  }

  // Anything landing in the next fortnight, so nothing arrives as a surprise.
  const upcoming = dueWithinTransfers(position, 2, transferWeekday)
  if (upcoming.length > 0) {
    lines.push('', '## Coming up in the next two weeks', '')
    for (const part of upcoming) {
      lines.push(`- **${part.lineItem.label}** — ${formatCents(part.totalCents)} on ${part.lineItem.dueDate}`)
    }
  }

  const blocking = household.blockingCount
  const optional = household.optionalCount
  const summary =
    shown.length === 0 && debtsNeeding.length === 0
      ? 'Ballast: nothing to move this week.'
      : caughtUp
        ? 'Ballast: all caught up.' +
          (optional > 0 ? ` ${optional} optional to-do${optional === 1 ? '' : 's'}.` : '') +
          (closeOuts.length > 0 ? ` ${closeOuts.length} thing(s) need confirming.` : '')
        : `Ballast: ${blocking} thing(s) to do this week` +
          (closeOuts.length > 0 ? `, and ${closeOuts.length} to confirm.` : '.')

  return {
    kind: 'weekly_digest',
    householdId: input.householdId,
    mutedUserIds: await mutedUserIds(engine),
    summary,
    body: lines.join('\n'),
    link: `${input.baseUrl}/`,
    detail: {
      all_caught_up: caughtUp,
      bank_per_week_cents: position.bankPerWeekCents,
      accounts: shown.map((a) => ({
        id: a.account.id,
        name: a.account.name,
        status: a.status,
        bank_per_week_cents: a.bank?.perWeekCents ?? null,
        needs_per_week_cents: a.neededPerWeekCents,
        likely_holds_cents: a.money.totalCents,
        short_on: a.short?.on ?? null,
      })),
      debts: debtsNeeding.map((view) => ({
        id: view.debt.id,
        name: view.debt.name,
        status: view.status,
        deal_ends_on: view.miss?.untilDate ?? null,
        owed_at_end_cents: view.miss?.owedAtEndCents ?? null,
        clear_per_month_cents: view.miss?.clearPerMonthCents ?? null,
      })),
      todo_count: household.todos.length,
      outstanding_count: household.todos.filter((t) => t.from === 'ask').length + comingUp.length,
      close_out_count: closeOuts.length,
    },
  }
}

/** Repeated weekly until confirmed (PRD §8). */
export async function buildDueDatePrompts(input: DigestInput): Promise<NotificationPayload[]> {
  const engine = engineFor(input)
  const [prompts, accounts] = await Promise.all([
    engine.closeOutPrompts().then(awakeCloseOuts),
    engine.listReserveAccounts(),
  ])
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'your savings'

  return prompts.map((prompt) => ({
    kind: 'due_date_prompt' as const,
    householdId: input.householdId,
    summary: `Ballast: did the ${prompt.label} money get spent from ${accountName(prompt.reserveAccountId)}?`,
    body: `**${prompt.label}** was due ${prompt.dueDate}${
      prompt.daysOverdue > 0 ? ` (${prompt.daysOverdue} days ago)` : ''
    }.\n\nThe plan set aside ${formatCents(prompt.plannedCents)} in ${accountName(prompt.reserveAccountId)}${
      prompt.spentCents > 0 ? `, and ${formatCents(prompt.spentCents)} of it has gone out so far` : ''
    }. Until it is finished, the ${formatCents(prompt.needsCents)} still held stays counted in your totals.`,
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

  const [position, transferWeekday] = await Promise.all([engine.position(), engine.transferWeekday()])
  if (!position.accounts.some((a) => a.parts.length > 0)) return null
  const stale = accountsToCheckIn(position, afterWeeks, transferWeekday)
  if (stale.length === 0) return null

  return {
    kind: 'check_in_nudge',
    householdId: input.householdId,
    summary: `Ballast: it has been a while since you checked ${stale.length === 1 ? stale[0]!.account.name : 'your savings accounts'}.`,
    body: `No balance recorded in the last ${afterWeeks} weeks for:\n\n${stale
      .map((v) => `- ${v.account.name} (likely holds ${formatCents(v.money.totalCents)})`)
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
    body: `**${warning.debt.name}** has ${formatCents(warning.onDealCents)} on a promotional rate that ends ${warning.untilDate}, and the payments set up now will not clear it in time.\n\nTo clear it before interest starts, it needs ${formatCents(warning.monthlyToClearCents)} a month from here. After that date it costs ${(warning.debt.aprBasisPoints / 100).toFixed(2)}%.`,
    link: `${input.baseUrl}/debts`,
    detail: {
      debt_id: warning.debt.id,
      until_date: warning.untilDate,
      monthly_to_clear_cents: warning.monthlyToClearCents,
    },
  }))
}
