/**
 * Home / This Week (PRD §9, screen 1).
 *
 * The one question the product exists to answer, answered at the top of the
 * screen: is every account going to have the money when something is due,
 * on the transfers set up at the bank -- and if not, what to do this week.
 * Every figure is the one position's (D35); nothing here is computed in the
 * component (PRD §10), and the check-in draws the same account cards, so the
 * two screens can never disagree.
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Empty, humanDate, Money, PageHeader, Pill, When, Zzz } from '@/components/ui'
import { AccountPositionCard } from '@/components/account-position'
import { CloseOutCard } from '@/components/close-out-card'
import {
  awakeCloseOuts,
  derivedTodoSentenceParts,
  latestSnoozeDay,
  snoozeDays,
  doneMovesSummary,
  formatCents,
  instructionSentenceParts,
  runningAdjustments,
  taskBucket,
  type CivilDate,
  type DerivedTodo,
  type IssuedInstruction,
  type SentencePart,
  type Weekday,
} from '@/domain'
import {
  confirmBalancesAction,
  confirmInstructionAction,
  confirmMoveInAction,
  confirmTransferAction,
  endInstructionAction,
  toggleTaskAction,
  wakeCloseOutAction,
} from '@/server/actions'

export const dynamic = 'force-dynamic'

/**
 * A to-do sentence, with the account the money goes to set apart (D34):
 * bold and a gentle accent, so it is the first thing the eye finds. A date
 * is said as a distance from today, with the date on hover (D38). The words
 * are the domain's; this only decides how one piece looks.
 */
function Parts({ parts, today }: { parts: SentencePart[]; today: CivilDate }) {
  return (
    <p className="text-sm">
      {parts.map((part, i) =>
        part.target ? (
          <strong key={i} className="font-semibold text-[var(--color-accent)]">
            {part.text}
          </strong>
        ) : part.date ? (
          <When key={i} date={part.date.on} today={today} as={part.date.as} />
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  )
}

function Sentence({
  instruction,
  transferWeekday,
  today,
}: {
  instruction: IssuedInstruction
  transferWeekday: Weekday
  today: CivilDate
}) {
  return <Parts parts={instructionSentenceParts(instruction, transferWeekday)} today={today} />
}

const plain = (cents: number) => formatCents(cents).replace('$', '').replace(/,/g, '')

/**
 * A to-do the position derived (D35). Marking it done records what the
 * person says they did, at the amount in the box, and the run-forward uses
 * it from then on.
 */
function DerivedTodoCard({ todo, today }: { todo: DerivedTodo; today: CivilDate }) {
  const amount = todo.kind === 'move_in' ? todo.amountCents : todo.toCents
  return (
    <Card className={todo.blocking ? '' : 'border-dashed'}>
      <Parts parts={derivedTodoSentenceParts(todo, humanDate)} today={today} />
      <form
        action={todo.kind === 'move_in' ? confirmMoveInAction : confirmTransferAction}
        className="mt-3 flex items-end gap-2"
      >
        <input type="hidden" name="reserve_account_id" value={todo.accountId} />
        <label className="flex-1 text-xs text-[var(--color-ink-soft)]">
          {todo.kind === 'move_in' ? 'How much you moved' : 'What the transfer is now, per week'}
          <input
            name="amount"
            inputMode="decimal"
            defaultValue={plain(amount)}
            className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
        >
          {todo.kind === 'set_transfer' && todo.reason === 'confirm' ? "That's it" : 'Done'}
        </button>
      </form>
      {!todo.blocking ? (
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
          Optional: leaving it as it is only saves a little more.
        </p>
      ) : null}
    </Card>
  )
}

export default async function ThisWeekPage({
  searchParams,
}: {
  searchParams: Promise<{
    balances?: string
    snoozed?: string
    until?: string
    snooze_error?: string
    item?: string
  }>
}) {
  const { balances, snoozed, until, snooze_error: snoozeError, item: errorItem } = await searchParams
  const { engine, viewer } = await requireEngine()
  const [position, outstanding, allCloseOuts, commitments, tripToDos, transferWeekday, lastCounts] =
    await Promise.all([
      engine.position(),
      engine.outstandingInstructions(),
      engine.closeOutPrompts(),
      engine.openCommitmentsByAccount(),
      engine.comingUpTripTasks(3),
      engine.transferWeekday(),
      engine.latestConfirmedBalances(),
    ])
  const today = engine.today()
  // A snoozed "did this get spent?" is off this screen until it wakes (D38);
  // the one just snoozed stays as a line with an undo, so a slip is cheap.
  const closeOuts = awakeCloseOuts(allCloseOuts)
  const justSnoozed = snoozed ? allCloseOuts.find((p) => p.lineItemId === snoozed && p.snoozedUntil) : undefined
  const snoozeOn = snoozeDays(today, transferWeekday)

  // Accounts a done move has changed since they were last counted (D34): the
  // position already carries the moves; what is missing is the count.
  const toCount = position.accounts
    .map((a) => {
      const moves = commitments.get(a.account.id)?.doneMoves ?? []
      return {
        a,
        moves,
        last: lastCounts.get(a.account.id) ?? null,
        summary: doneMovesSummary(moves),
      }
    })
    .filter((x) => x.moves.length > 0)

  // What can be done today, and what is held back until a later day (the
  // second half of the fun money). Different lists, so "now" is never in doubt.
  const dueNow = outstanding.filter((i) => i.dueNow)
  const comingUp = outstanding.filter((i) => !i.dueNow)
  const todos = position.todos
  const anythingToDo = todos.length > 0 || dueNow.length > 0

  // Every account with a plan or a transfer, and every bump or cut from
  // before D35 still changing a transfer, so it can be stopped (D18).
  const shown = position.accounts.filter((a) => a.parts.length > 0 || a.bank !== null)
  const running = new Map(
    shown.map((a) => [
      a.account.id,
      runningAdjustments({
        running: commitments.get(a.account.id)?.running ?? [],
        today,
        transferWeekday,
      }),
    ]),
  )
  const needAttention = shown.filter((a) => a.status !== 'on_track').length

  const firstName = viewer.name?.split(' ')[0] ?? 'there'

  return (
    <>
      <PageHeader
        title="This week"
        subtitle={`Hi ${firstName} — here is where everything stands, as of ${humanDate(today)}.`}
      />

      {/*
        * The headline (D35). "All caught up" means every account, run forward
        * on the transfer the bank actually has, has the money on every date
        * something is due, with no to-do it depends on. It is the position's
        * verdict, never this screen's.
        */}
      {shown.some((a) => a.parts.length > 0) ? (
        position.allCaughtUp ? (
          <Card className="mb-5 bg-[var(--color-ahead-soft)]">
            <p className="font-semibold text-[var(--color-ahead)]">All caught up.</p>
            <p className="mt-1 text-sm">
              On autopilot, every account covers everything due
              {position.coveredThrough ? (
                <>
                  {' '}
                  <When date={position.coveredThrough} today={today} as="until" />.
                </>
              ) : (
                '.'
              )}{' '}
              The
              bank moves <Money cents={position.bankPerWeekCents} /> a week in all.
            </p>
            {todos.length > 0 ? (
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                There is an optional to-do below; nothing depends on it.
              </p>
            ) : null}
          </Card>
        ) : (
          <Card className="mb-5 bg-[var(--color-caution-soft)]">
            <p className="font-semibold">
              {needAttention === 1 ? 'One account needs' : `${needAttention} accounts need`} you
              this week.
            </p>
            <p className="mt-1 text-sm">
              The to-dos below are what it takes. Once they are done, every account has the money
              for everything on its date without anyone lifting a finger.
            </p>
          </Card>
        )
      ) : null}

      {/*
        * Confirmations are the product's heartbeat (PRD §9): always one tap plus
        * an optional amount edit, never a form. They come first because an
        * unconfirmed ask is the only thing that can silently rot.
        */}
      {justSnoozed?.snoozedUntil ? (
        <Card className="mb-5 flex items-center justify-between gap-3 border-dashed">
          <p className="text-sm">
            <Zzz className="mr-1 text-[var(--color-accent)]" />
            {justSnoozed.label} is snoozed: it asks again{' '}
            <When date={justSnoozed.snoozedUntil} today={today} />. The money stays held.
          </p>
          <form action={wakeCloseOutAction}>
            <input type="hidden" name="line_item_id" value={justSnoozed.lineItemId} />
            <button type="submit" className="shrink-0 rounded-lg px-3 py-2 text-sm text-[var(--color-ink-soft)] underline">
              Undo
            </button>
          </form>
        </Card>
      ) : null}

      {closeOuts.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Did this get spent?
          </h2>
          <ul className="space-y-3">
            {closeOuts.map((prompt) => (
              <li key={prompt.lineItemId}>
                <CloseOutCard
                  prompt={prompt}
                  today={today}
                  snoozeOn={snoozeOn}
                  latestSnooze={latestSnoozeDay(today)}
                  error={errorItem === prompt.lineItemId ? snoozeError : null}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {anythingToDo ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            To do
          </h2>
          <ul className="space-y-3">
            {todos.map((todo) => (
              <li key={`${todo.kind}:${todo.accountId}`}>
                <DerivedTodoCard todo={todo} today={today} />
              </li>
            ))}
            {dueNow.map((instruction) => (
              <li key={instruction.instructionId}>
                <Card>
                  <Sentence instruction={instruction} transferWeekday={transferWeekday} today={today} />
                  {instruction.note ? (
                    <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{instruction.note}</p>
                  ) : null}
                  <div className="mt-3 flex gap-2">
                    <form action={confirmInstructionAction} className="flex-1">
                      <input type="hidden" name="instruction_id" value={instruction.instructionId} />
                      <button
                        type="submit"
                        className="w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium"
                      >
                        Done
                      </button>
                    </form>
                    {/* Withdraws the ask (PRD D18): it leaves the list and stops
                        counting as on the way. Nothing in the bank changes. */}
                    <form action={endInstructionAction}>
                      <input type="hidden" name="instruction_id" value={instruction.instructionId} />
                      <button
                        type="submit"
                        className="rounded-lg px-3 py-2 text-sm text-[var(--color-ink-soft)] underline"
                      >
                        Not doing this
                      </button>
                    </form>
                  </div>
                  {instruction.ageInDays > 6 ? (
                    <p className="mt-2 text-xs text-[var(--color-behind)]">
                      Asked {instruction.ageInDays} days ago.
                    </p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
          {toCount.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
              When these are done, update what{' '}
              {toCount.map((x) => x.a.account.name).join(' and ')} {toCount.length === 1 ? 'holds' : 'hold'}.
            </p>
          ) : null}
        </section>
      ) : null}

      {balances ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <p className="text-sm font-medium text-[var(--color-ahead)]">Balances recorded.</p>
        </Card>
      ) : null}

      {/*
        * A move marked done is money the account holds (D34). The figures
        * already carry it; once nothing is left to do, ask for the count that
        * makes it a fact. The likely balance is the position's, never stored.
        */}
      {!anythingToDo && toCount.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Update what these accounts hold
          </h2>
          <form action={confirmBalancesAction} className="space-y-3">
            <input type="hidden" name="back" value="home" />
            {toCount.map(({ a, last, summary }) => (
              <Card key={a.account.id}>
                <p className="font-medium">{a.account.name}</p>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  {last ? (
                    <>
                      Since you last counted it <When date={last.on} today={today} /> at <Money cents={last.amountCents} />, you moved
                    </>
                  ) : (
                    <>It has never been counted, and you moved</>
                  )}
                  {summary.inCents > 0 ? (
                    <>
                      {' '}
                      <Money cents={summary.inCents} /> in
                    </>
                  ) : null}
                  {summary.inCents > 0 && summary.outCents > 0 ? ' and' : null}
                  {summary.outCents > 0 ? (
                    <>
                      {' '}
                      <Money cents={summary.outCents} /> out
                    </>
                  ) : null}
                  {a.money.transfersSinceCents > 0 ? (
                    <>
                      , and the transfers since added <Money cents={a.money.transfersSinceCents} />
                    </>
                  ) : null}
                  , so it likely holds <Money cents={a.money.totalCents} /> now.
                </p>
                <label className="mt-3 block text-sm font-medium">
                  What it actually holds
                  <input
                    name={`balance_${a.account.id}`}
                    inputMode="decimal"
                    defaultValue={plain(a.money.totalCents)}
                    className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
                  />
                </label>
              </Card>
            ))}
            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
            >
              Record these balances
            </button>
            <p className="text-center text-xs text-[var(--color-ink-soft)]">
              Open Capital One and check the figure first; clear a box to skip that account.
            </p>
          </form>
        </section>
      ) : null}

      {comingUp.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Coming up
          </h2>
          <ul className="space-y-3">
            {comingUp.map((instruction) => (
              <li key={instruction.instructionId}>
                <Card className="border-dashed">
                  <Sentence instruction={instruction} transferWeekday={transferWeekday} today={today} />
                  {instruction.note ? (
                    <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{instruction.note}</p>
                  ) : null}
                  <div className="mt-3 flex gap-2">
                    <form action={confirmInstructionAction} className="flex-1">
                      <input
                        type="hidden"
                        name="instruction_id"
                        value={instruction.instructionId}
                      />
                      <button
                        type="submit"
                        className="w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium text-[var(--color-ink-soft)]"
                      >
                        Done early
                      </button>
                    </form>
                    <form action={endInstructionAction}>
                      <input
                        type="hidden"
                        name="instruction_id"
                        value={instruction.instructionId}
                      />
                      <button
                        type="submit"
                        className="rounded-lg px-3 py-2 text-sm text-[var(--color-ink-soft)] underline"
                      >
                        Not doing this
                      </button>
                    </form>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        * Trip to-dos are not money to-dos (PRD §16 D22): booking a table moves
        * nothing in the bank. They get a small card of their own, only when
        * there are any, so the weekly number is never crowded by them.
        */}
      {tripToDos.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Coming up for trips
          </h2>
          <Card>
            <ul className="divide-y divide-[var(--color-line)]">
              {tripToDos.map((task) => (
                <li key={task.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-sm">{task.label}</p>
                    <p className="text-xs text-[var(--color-ink-soft)]">
                      {taskBucket(task, today) === 'overdue' ? 'Was due ' : 'By '}
                      {humanDate(task.dueOn)} ·{' '}
                      <Link href={`/trips/${task.tripId}#to-do`} className="text-[var(--color-accent)] underline underline-offset-4">
                        {task.tripName}
                      </Link>
                    </p>
                  </div>
                  <form action={toggleTaskAction}>
                    <input type="hidden" name="trip_id" value={task.tripId} />
                    <input type="hidden" name="task_id" value={task.id} />
                    <input type="hidden" name="done" value="0" />
                    <input type="hidden" name="back" value="home" />
                    <button type="submit" className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium">
                      Done
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {shown.length === 0 ? (
        <Empty title="Nothing to move this week.">
          <p>
            When you commit a plan, the weekly amounts show up here.{' '}
            <Link href="/packages/new" className="text-[var(--color-accent)] underline">
              Start a plan
            </Link>
          </p>
        </Empty>
      ) : (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Your accounts
          </h2>
          <ul className="space-y-4">
            {shown.map((a) => (
              <li key={a.account.id}>
                <AccountPositionCard account={a} today={today} />
                {(running.get(a.account.id) ?? []).length > 0 ? (
                  <Card className="mt-2">
                    <ul className="space-y-2 text-sm">
                      {(running.get(a.account.id) ?? []).map((r) => (
                        <li key={r.instructionId} className="flex items-center justify-between gap-3">
                          <span>
                            {r.perWeekCents > 0
                              ? `A catch-up from before: ${formatCents(r.perWeekCents)} a week extra`
                              : `An ease-off from before: ${formatCents(-r.perWeekCents)} a week less`}
                            <span className="block text-xs text-[var(--color-ink-soft)]">
                              It runs <When date={r.endDate} today={today} as="until" />. Setting the transfer to what Ballast
                              asks replaces it; so does stopping it here.
                            </span>
                          </span>
                          <form action={endInstructionAction}>
                            <input type="hidden" name="instruction_id" value={r.instructionId} />
                            <button
                              type="submit"
                              className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
                            >
                              Stop this
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
