/**
 * "Did this get spent?" (PRD §5, capability 4), with its snooze (D38). One
 * tap answers it; one tap more puts the question off until a day, while the
 * money stays held -- nothing about a snooze reaches a figure. The same card
 * is on This week and, snoozed or not, on the plan's own page, where a
 * snoozed one can be answered early or woken up.
 */

import { Card, humanDate, Pill, When, Zzz } from '@/components/ui'
import {
  addDays,
  formatCents,
  SNOOZE_CHOICE_WORDS,
  type CivilDate,
  type CloseOutPrompt,
  type SnoozeChoice,
} from '@/domain'
import { confirmSpendAction, snoozeCloseOutAction, wakeCloseOutAction } from '@/server/actions'

const QUICK: Exclude<SnoozeChoice, 'date'>[] = ['tomorrow', 'transfer_day', 'week', 'month']

export function CloseOutCard({
  prompt,
  today,
  snoozeOn,
  latestSnooze,
  packageId,
  error,
}: {
  prompt: CloseOutPrompt
  today: CivilDate
  /** The day each quick choice wakes, from the domain's `snoozeDays`. */
  snoozeOn: Record<Exclude<SnoozeChoice, 'date'>, CivilDate>
  /** The furthest day a snooze may reach (`latestSnoozeDay`). */
  latestSnooze: CivilDate
  /** Set on a plan's page, so the forms come back to it. */
  packageId?: string
  error?: string | null
}) {
  const snoozed = prompt.snoozedUntil
  const back = packageId ? <input type="hidden" name="package_id" value={packageId} /> : null
  return (
    <Card className={snoozed ? 'border-dashed' : 'border-[var(--color-behind)]'}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{prompt.label}</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            <When date={prompt.dueDate} today={today} as="due" />
          </p>
        </div>
        {snoozed ? (
          <Pill tone="accent">
            <Zzz className="mr-1" />
            Snoozed
          </Pill>
        ) : (
          <Pill tone="behind">Needs an answer</Pill>
        )}
      </div>

      <form action={confirmSpendAction} className="mt-3 flex items-end gap-2">
        <input type="hidden" name="line_item_id" value={prompt.lineItemId} />
        {back}
        <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
          How much actually went out
          <input
            name="actual_amount"
            inputMode="decimal"
            defaultValue={formatCents(prompt.plannedCents).replace('$', '').replace(/,/g, '')}
            className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
        >
          Yes, spent
        </button>
      </form>

      {snoozed ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-[var(--color-ink-soft)]">
            Asks again <When date={snoozed} today={today} />. The money stays held until then.
          </p>
          <form action={wakeCloseOutAction}>
            <input type="hidden" name="line_item_id" value={prompt.lineItemId} />
            {back}
            <button
              type="submit"
              className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
            >
              Wake it up
            </button>
          </form>
        </div>
      ) : (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-[var(--color-ink-soft)] underline underline-offset-4">
            Not spent yet? Snooze it
          </summary>
          <form action={snoozeCloseOutAction} className="mt-2 space-y-2">
            <input type="hidden" name="line_item_id" value={prompt.lineItemId} />
            {back}
            <div className="flex flex-wrap gap-2">
              {QUICK.map((choice) => (
                <button
                  key={choice}
                  type="submit"
                  name="choice"
                  value={choice}
                  title={`Ask again on ${humanDate(snoozeOn[choice])}`}
                  className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
                >
                  {SNOOZE_CHOICE_WORDS[choice]}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
                Or ask again on
                <input
                  type="date"
                  name="snooze_date"
                  min={addDays(today, 1)}
                  max={latestSnooze}
                  className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
                />
              </label>
              <button
                type="submit"
                name="choice"
                value="date"
                className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
              >
                Snooze
              </button>
            </div>
          </form>
          <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
            The money stays held while it sleeps; only the asking stops.
          </p>
        </details>
      )}
      {error ? <p className="mt-2 text-sm text-[var(--color-behind)]">{error}</p> : null}
      {!snoozed ? (
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
          Until you answer, this money stays counted in your totals.
        </p>
      ) : null}
    </Card>
  )
}
