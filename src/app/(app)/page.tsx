/**
 * Home / This Week (PRD §9, screen 1).
 *
 * The one question the product exists to answer, answered at the top of the
 * screen: how much moves into each account this week. Every figure is
 * decomposed, and nothing here is computed in the component -- the derivation
 * module produced all of it (PRD §10).
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Empty, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import { WeeklyNumber } from '@/components/weekly-number'
import { formatCents, instructionSentence, respreadEquivalentPerWeekCents } from '@/domain'
import { confirmInstructionAction, confirmSpendAction } from '@/server/actions'

export const dynamic = 'force-dynamic'

export default async function ThisWeekPage() {
  const { engine, viewer } = await requireEngine()
  const [accounts, outstanding, closeOuts] = await Promise.all([
    engine.accountViews(),
    engine.outstandingInstructions(),
    engine.closeOutPrompts(),
  ])
  const today = engine.today()

  // What can be done today, and what is held back until a later day (the
  // second half of the fun money). Different lists, so "now" is never in doubt.
  const dueNow = outstanding.filter((i) => i.dueNow)
  const comingUp = outstanding.filter((i) => !i.dueNow)

  const withWork = accounts.filter((a) => a.weekly.transferPerWeekCents !== 0)
  const grandTotal = withWork.reduce((s, a) => s + a.weekly.transferPerWeekCents, 0)
  const shouldHold = accounts.reduce((s, a) => s + a.shouldHaveSavedCents, 0)

  // An open bump or cut moves nothing until it is marked done. The engine has
  // already priced what "done" turns each transfer into (pendingWeekly); the
  // screen only has to put that number next to the ask, so the to-do and the
  // account card read as one instruction instead of two that do not add up.
  const byAccount = new Map(accounts.map((a) => [a.account.id, a]))
  const anyPending = accounts.some((a) => a.pendingWeekly !== null)
  const grandTotalOnceDone = withWork.reduce(
    (s, a) => s + (a.pendingWeekly ?? a.weekly).transferPerWeekCents,
    0,
  )

  const firstName = viewer.name?.split(' ')[0] ?? 'there'

  return (
    <>
      <PageHeader
        title="This week"
        subtitle={`Hi ${firstName} — here is what to move, as of ${today}.`}
      />

      {/*
        * Confirmations are the product's heartbeat (PRD §9): always one tap plus
        * an optional amount edit, never a form. They come first because an
        * unconfirmed ask is the only thing that can silently rot.
        */}
      {closeOuts.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            Did this get spent?
          </h2>
          <ul className="space-y-3">
            {closeOuts.map((prompt) => (
              <li key={prompt.lineItemId}>
                <Card className="border-[var(--color-behind)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{prompt.label}</p>
                      <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
                        Was due {prompt.dueDate}
                        {prompt.daysOverdue > 0 ? ` — ${prompt.daysOverdue} days ago` : ''}
                      </p>
                    </div>
                    <Pill tone="behind">Needs an answer</Pill>
                  </div>

                  <form action={confirmSpendAction} className="mt-3 flex items-end gap-2">
                    <input type="hidden" name="line_item_id" value={prompt.lineItemId} />
                    <input type="hidden" name="planned_cents" value={prompt.plannedCents} />
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
                  <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                    Until you answer, this money stays counted in your totals.
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {dueNow.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            To do
          </h2>
          <ul className="space-y-3">
            {dueNow.map((instruction) => {
              const dated = instruction.type === 'rate_bump' || instruction.type === 'rate_cut'
              const target = dated ? byAccount.get(instruction.targetId) : undefined
              const onceDone = target?.pendingWeekly
              return (
              <li key={instruction.instructionId}>
                <Card>
                  <p className="text-sm">{instructionSentence(instruction)}</p>
                  {target && onceDone ? (
                    <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                      That makes the {target.account.name} transfer{' '}
                      <strong>{formatCents(onceDone.transferPerWeekCents)} per week</strong>
                      {' '}(it is {formatCents(target.weekly.transferPerWeekCents)} now). The
                      numbers below change once you mark this done.
                    </p>
                  ) : null}
                  {instruction.note ? (
                    <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{instruction.note}</p>
                  ) : null}
                  <form action={confirmInstructionAction} className="mt-3">
                    <input
                      type="hidden"
                      name="instruction_id"
                      value={instruction.instructionId}
                    />
                    <button
                      type="submit"
                      className="w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium"
                    >
                      Done
                    </button>
                  </form>
                  {instruction.ageInDays > 6 ? (
                    <p className="mt-2 text-xs text-[var(--color-behind)]">
                      Asked {instruction.ageInDays} days ago.
                    </p>
                  ) : null}
                </Card>
              </li>
              )
            })}
          </ul>
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
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm">{instructionSentence(instruction)}</p>
                    <Pill tone="neutral">From {humanDate(instruction.availableOn!)}</Pill>
                  </div>
                  {instruction.note ? (
                    <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{instruction.note}</p>
                  ) : null}
                  <form action={confirmInstructionAction} className="mt-3">
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
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {withWork.length === 0 ? (
        <Empty title="Nothing to move this week.">
          <p>
            When you commit a plan, the weekly amounts show up here.{' '}
            <Link href="/packages/new" className="text-[var(--color-accent)] underline">
              Start a plan
            </Link>
          </p>
        </Empty>
      ) : (
        <>
          <Card className="mb-4 bg-[var(--color-accent-soft)]">
            <p className="text-sm text-[var(--color-ink-soft)]">Total across every account</p>
            <p className="mt-1 text-3xl font-semibold">
              <Money cents={grandTotal} />
              <span className="text-base font-normal text-[var(--color-ink-soft)]"> / week</span>
            </p>
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              Your accounts should hold <Money cents={shouldHold} /> in total today.
            </p>
            {anyPending && grandTotalOnceDone !== grandTotal ? (
              <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                Once the to-dos above are done: <Money cents={grandTotalOnceDone} /> / week.
              </p>
            ) : null}
          </Card>

          <ul className="space-y-4">
            {withWork.map((view) => {
              const outstanding = view.outstandingCents
              const soonest = view.items
                .map((i) => i.lineItem.dueDate)
                .sort()
                .at(0)
              const respread = respreadEquivalentPerWeekCents({
                remainingCents: outstanding,
                asOf: today,
                dueDate: soonest ?? today,
              })

              return (
                <li key={view.account.id}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="font-semibold">{view.account.name}</h2>
                        <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
                          {view.account.institutionLabel}
                        </p>
                      </div>
                      {view.items.some((i) => i.isOverdue) ? (
                        <Pill tone="behind">Needs a check</Pill>
                      ) : null}
                    </div>

                    <div className="mt-4">
                      <WeeklyNumber weekly={view.weekly} respreadCents={respread} />
                    </div>

                    <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--color-line)] pt-3 text-sm">
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">Should hold today</dt>
                        <dd className="mt-0.5 font-medium">
                          <Money cents={view.shouldHaveSavedCents} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--color-ink-soft)]">Still to set aside</dt>
                        <dd className="mt-0.5 font-medium">
                          <Money cents={outstanding} />
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-4 rounded-xl bg-[var(--color-surface)] p-3 text-sm">
                      In Capital One 360, set the recurring transfer into{' '}
                      <strong>{view.account.name}</strong> to{' '}
                      <strong>{formatCents(view.weekly.transferPerWeekCents)} per week</strong>.
                    </p>
                    {view.pendingWeekly ? (
                      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                        Waiting on you: a to-do above changes this. Once you mark it done, set
                        the transfer to{' '}
                        <strong>{formatCents(view.pendingWeekly.transferPerWeekCents)} per week</strong>{' '}
                        instead, and the figures here will show it.
                      </p>
                    ) : null}
                  </Card>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </>
  )
}
