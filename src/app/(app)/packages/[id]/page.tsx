/**
 * Package detail (PRD §9, screen 2).
 *
 * Editing a part is an ordinary inline change, not a planning session -- that
 * is the whole point of the product. Every field of every part can be changed
 * here, parts can be added and taken out, the plan renamed or stopped. Each
 * save posts straight to the engine, which records the event and recomputes;
 * the new decomposed weekly number is on screen immediately.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireEngine } from '@/server/session'
import { Card, Hint, humanDate, Money, Pill } from '@/components/ui'
import { EditableTitle } from '@/components/editable-title'
import { WeeklyNumber } from '@/components/weekly-number'
import { AccrualChart } from '@/components/accrual-chart'
import { ProgressBar } from '@/components/progress-bar'
import {
  addLineItemAction,
  commitPackageAction,
  deletePackageAction,
  renamePackageAction,
  retireLineItemAction,
  retirePackageAction,
  updateLineItemAction,
} from '@/server/actions'
import { describeRecurrence, formatCents, previousOccurrence } from '@/domain'
import { RecurrenceFields } from '@/components/recurrence-fields'
import { DeletePlan } from './delete-plan'

export const dynamic = 'force-dynamic'

const field =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

/** "600.00": what a person types back into an amount box. */
const plain = (cents: number) => formatCents(cents).replace('$', '').replace(/,/g, '')

export default async function PackageDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; saved?: string; confirm?: string }>
}) {
  const { id } = await params
  const { error, saved, confirm } = await searchParams
  const { engine } = await requireEngine()

  const view = (await engine.packageViews()).find((v) => v.package.id === id)
  if (!view) notFound()

  const isDraft = view.package.state === 'simulated'
  // What a repeating part would already hold, had saving started the last
  // time it came round. With the timeline starting there (D30, the default)
  // that is what the part should hold today; with it starting at the commit
  // it is offered as an opening instead, never assumed (D8). One figure, one
  // arithmetic, read here as if every part started at the commit so the
  // screen can show it either way.
  const repeating = view.items.filter((i) => i.lineItem.state !== 'retired' && i.lineItem.recurrence !== null)
  const elapsed = isDraft
    ? await engine.suggestedOpenings(view.package.id, {
        timelineStartByLineItem: Object.fromEntries(repeating.map((i) => [i.lineItem.id, 'commit'])),
      })
    : []
  const isDone = view.package.state === 'retired'
  const whatIf = isDraft ? await engine.whatIf(id) : []
  const curve = isDraft || isDone ? null : await engine.packageCurve(id)
  const accounts = await engine.reserveAccountsForViewer()
  const accountName = (accountId: string) =>
    accounts.find((a) => a.id === accountId)?.name ?? 'Unknown account'
  const defaultAccount = accounts.find((a) => a.writable)?.id ?? accounts[0]?.id ?? ''

  const live = view.items.filter((i) => i.lineItem.state !== 'retired')
  const retired = view.items.filter((i) => i.lineItem.state === 'retired')

  // Whether the money counted in each account this plan draws on would sit
  // differently if reshuffled; the line beside a part says so, and points at
  // the check-in, where the reshuffle lives.
  const spreads = new Map(
    await Promise.all(
      [...new Set(live.map((i) => i.lineItem.reserveAccountId))].map(
        async (accountId) =>
          [accountId, isDraft || isDone ? null : await engine.reshufflePreview(accountId)] as const,
      ),
    ),
  )

  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id} disabled={!a.writable}>
      {a.name}
      {a.scope === 'individual' ? (a.writable ? ' (yours)' : ' — theirs') : ''}
    </option>
  ))

  return (
    <>
      <EditableTitle
        name={view.package.name}
        packageId={view.package.id}
        action={renamePackageAction}
        canEdit={!isDone}
        subtitle={
          isDraft
            ? 'A draft. Nothing is being set aside yet.'
            : isDone
              ? 'Finished. Nothing more is being set aside for this.'
              : `Saving since ${humanDate(view.package.committedAt!)}.`
        }
      />

      {error ? (
        <p className="mb-4 rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="mb-4 rounded-xl bg-[var(--color-ahead-soft)] p-3 text-sm font-medium text-[var(--color-ahead)]">
          Saved. The weekly amount has been worked out again.
        </p>
      ) : null}

      <Card className="mb-4">
        <p className="text-sm text-[var(--color-ink-soft)]">Total cost of this plan</p>
        <p className="mt-1 text-2xl font-semibold">
          <Money cents={view.totalCents} />
        </p>

        {isDraft ? (
          <>
            <div className="mt-4 rounded-xl bg-[var(--color-surface)] p-3">
              <p className="text-sm font-medium">If you commit this today</p>
              {whatIf.length === 0 ? (
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  Nothing to set aside — check the dates and amounts below.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {whatIf.map((line) => (
                    <li key={line.accountId} className="flex justify-between gap-3">
                      <span>{line.accountName}</span>
                      <span className="tabular">
                        <Money cents={line.currentPerWeekCents} /> →{' '}
                        <strong>
                          <Money cents={line.projectedPerWeekCents} />
                        </strong>
                        /wk
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/*
              One form. A repeating part starts its timeline from the last
              time it came round unless its box is unticked; an unticked part
              starts today and is offered what it would have set aside by
              now. The reveals are CSS on the checkbox state, so the page
              stays server-rendered: nothing here is worked out in the browser.
            */}
            <form action={commitPackageAction} className="group mt-4 space-y-3">
              <input type="hidden" name="package_id" value={view.package.id} />

              {elapsed.length > 0 ? (
                <div className="space-y-2 rounded-xl border-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3">
                  <p className="text-sm font-medium">Parts that come round again</p>
                  {elapsed.map((s) => (
                    <div key={s.lineItemId} className="rounded-lg bg-[var(--color-card)] p-2">
                      <input type="hidden" name="timeline_part" value={s.lineItemId} />
                      <input
                        type="checkbox"
                        id={`timeline-${s.lineItemId}`}
                        name="timeline_from_last"
                        value={s.lineItemId}
                        defaultChecked
                        className="tl peer mr-2 align-middle"
                      />
                      <label htmlFor={`timeline-${s.lineItemId}`} className="text-sm">
                        <strong>{s.label}:</strong> start the timeline from the last time this came
                        round ({humanDate(s.lastOccurrence)})
                      </label>
                      <p className="mt-1 hidden text-xs text-[var(--color-ink-soft)] peer-checked:block">
                        Should hold <Money cents={s.cents} /> today; the check-in will say if it is
                        not there.
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-ink-soft)] peer-checked:hidden">
                        Starts today instead. You would have <Money cents={s.cents} /> set aside by
                        now if you had been saving since {humanDate(s.lastOccurrence)} — is that
                        about what you have?
                      </p>
                    </div>
                  ))}
                  <button
                    type="submit"
                    name="use_suggested"
                    value="1"
                    className="hidden w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white group-has-[.tl:not(:checked)]:block"
                  >
                    Yes, start with what I would have set aside by now
                  </button>
                </div>
              ) : null}

              <label
                className={`block text-sm font-medium ${
                  live.some((i) => i.lineItem.recurrence === null) || elapsed.length === 0
                    ? ''
                    : 'hidden group-has-[.tl:not(:checked)]:block'
                }`}
              >
                Already set aside for this (optional)
                <input name="opening" inputMode="decimal" placeholder="0" className={field} />
                <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
                  Money you already have toward it. Shared by cost across the parts that start
                  today, so the weekly amount is right from the first week.
                </span>
              </label>
              <button
                type="submit"
                className={`w-full rounded-xl px-4 py-3 font-medium ${
                  elapsed.length > 0
                    ? 'border border-[var(--color-line)] group-has-[.tl:not(:checked)]:bg-transparent group-has-[.tl:not(:checked)]:text-[var(--color-ink)] bg-[var(--color-accent)] text-white'
                    : 'bg-[var(--color-accent)] text-white'
                }`}
              >
                Start saving for this
              </button>
            </form>
          </>
        ) : !isDone ? (
          <div className="mt-4">
            <WeeklyNumber weekly={view.weekly} size="small" />
            <ProgressBar
              className="mt-4"
              totalCents={view.totalCents}
              setAsideCents={view.shouldHaveSavedCents}
              paceCents={view.paceCents}
            />
          </div>
        ) : null}
      </Card>

      {curve ? (
        <Card className="mb-4">
          <h2 className="mb-3 text-sm font-semibold">How the money builds up</h2>
          <AccrualChart
            points={curve.points}
            confirmed={curve.confirmed}
            today={engine.today()}
            targetCents={curve.targetCents}
          />
        </Card>
      ) : null}

      <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
        What it is made of
      </h2>

      <ul className="space-y-3">
        {live.map((item) => {
          const spread = spreads.get(item.lineItem.reserveAccountId) ?? null
          const spreadLine = spread?.lines.find((l) => l.lineItemId === item.lineItem.id) ?? null
          const wouldMove =
            spread !== null && spreadLine !== null && spreadLine.holdsAfterCents !== spreadLine.holdsNowCents
          return (
          <li key={item.lineItem.id}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium">{item.lineItem.label}</h3>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
                    {accountName(item.lineItem.reserveAccountId)}
                    {' · '}
                    {item.lineItem.recurrence === null
                      ? `needed by ${humanDate(item.lineItem.dueDate)}`
                      : `${describeRecurrence(item.lineItem.recurrence).toLowerCase()}, next ${humanDate(item.lineItem.dueDate)}`}
                  </p>
                </div>
                {item.isOverdue ? <Pill tone="behind">Date has passed</Pill> : null}
              </div>

              <p className="mt-2 text-sm">
                {item.lineItem.quantity} × <Money cents={item.lineItem.unitAmountCents} /> ={' '}
                <strong>
                  <Money cents={item.totalCents} />
                </strong>
              </p>

              {!isDraft && !isDone ? (
                <>
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                    <Money cents={item.shouldHaveSavedCents} /> set aside ·{' '}
                    <Money cents={item.remainingCents} /> to go ·{' '}
                    {formatCents(item.weekly.totalPerWeekCents)}/wk
                  </p>
                  <ProgressBar
                    className="mt-3"
                    totalCents={item.totalCents}
                    setAsideCents={item.shouldHaveSavedCents}
                    paceCents={item.paceCents}
                    paceSince={item.paceSince}
                    dueDate={item.lineItem.dueDate}
                  />
                  {wouldMove && spread && spreadLine ? (
                    <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                      Reshuffled, this part would count <Money cents={spreadLine.holdsAfterCents} /> and
                      the {spread.accountName} transfer would go from{' '}
                      <Money cents={spread.perWeekNowCents} /> to <Money cents={spread.perWeekAfterCents} />{' '}
                      a week.{' '}
                      <Link
                        href={`/check-in#spread-${spread.accountId}`}
                        className="text-[var(--color-accent)] underline underline-offset-4"
                      >
                        Reshuffle {spread.accountName}
                      </Link>
                    </p>
                  ) : null}
                </>
              ) : null}

              {!isDone ? (
                <details className="mt-3 border-t border-[var(--color-line)] pt-3">
                  <summary className="cursor-pointer text-sm font-medium text-[var(--color-accent)]">
                    Change this part
                  </summary>
                  <form action={updateLineItemAction} className="mt-3 space-y-3">
                    <input type="hidden" name="line_item_id" value={item.lineItem.id} />
                    <input type="hidden" name="package_id" value={view.package.id} />
                    <label className="block text-sm font-medium">
                      What is it?
                      <input name="label" defaultValue={item.lineItem.label} required className={field} />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block text-sm font-medium">
                        Cost of one
                        <input
                          name="unit_amount"
                          inputMode="decimal"
                          defaultValue={plain(item.lineItem.unitAmountCents)}
                          className={field}
                        />
                      </label>
                      <label className="block text-sm font-medium">
                        How many
                        <input
                          name="quantity"
                          type="number"
                          min={1}
                          defaultValue={item.lineItem.quantity}
                          className={field}
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block text-sm font-medium">
                        Needed by
                        <input
                          name="due_date"
                          type="date"
                          defaultValue={item.lineItem.dueDate}
                          className={field}
                        />
                      </label>
                      <RecurrenceFields defaultValue={item.lineItem.recurrence} />
                    </div>
                    {item.lineItem.recurrence !== null ? (
                      <div className="text-sm">
                        <input type="hidden" name="timeline_shown" value="1" />
                        <input type="hidden" name="timeline_part" value={item.lineItem.id} />
                        <input
                          type="checkbox"
                          id={`edit-timeline-${item.lineItem.id}`}
                          name="timeline_from_last"
                          value={item.lineItem.id}
                          defaultChecked={item.lineItem.timelineStart === 'last_occurrence'}
                          className="mr-2 align-middle"
                        />
                        <label htmlFor={`edit-timeline-${item.lineItem.id}`}>
                          Start the timeline from the last time this came round (
                          {humanDate(previousOccurrence(item.lineItem.dueDate, item.lineItem.recurrence)!)})
                        </label>
                        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                          Ticked, it should already hold its share of the cycle and the weekly
                          amount is the steady one. Unticked, it starts from the day the plan did.
                        </p>
                      </div>
                    ) : null}
                    <label className="block text-sm font-medium">
                      Save it in
                      <select
                        name="reserve_account"
                        defaultValue={item.lineItem.reserveAccountId}
                        className={field}
                      >
                        {accountOptions}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
                    >
                      Save this part
                    </button>
                  </form>
                  <form action={retireLineItemAction} className="mt-2">
                    <input type="hidden" name="line_item_id" value={item.lineItem.id} />
                    <input type="hidden" name="package_id" value={view.package.id} />
                    <button
                      type="submit"
                      className="w-full rounded-xl border border-[var(--color-line)] px-4 py-2 text-sm text-[var(--color-ink-soft)]"
                    >
                      Take this part out of the plan
                    </button>
                  </form>
                </details>
              ) : null}

              {!isDraft &&
              (item.components.length > 1 ||
                item.components.some(
                  (c) => c.kind === 'base' && c.startDate < (view.package.committedAt ?? c.startDate),
                )) ? (
                <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
                  <Hint
                    detail={item.components
                      .map(
                        (c) =>
                          `${
                            c.kind === 'base'
                              ? c.startDate < (view.package.committedAt ?? c.startDate)
                                ? 'Since last time it came round'
                                : 'Original plan'
                              : c.kind === 'opening'
                                ? 'Already set aside'
                                : 'Added when the plan changed'
                          }: ${formatCents(c.amountCents)} over ${c.weeks} week${c.weeks === 1 ? '' : 's'}, ${c.startDate} to ${c.endDate}`,
                      )
                      .join(' · ')}
                  >
                    {item.components.length > 1
                      ? `Made of ${item.components.length} pieces`
                      : 'Counted since last time it came round'}
                  </Hint>
                </p>
              ) : null}
            </Card>
          </li>
          )
        })}
      </ul>

      {!isDone ? (
        <Card className="mt-3">
          <details>
            <summary className="cursor-pointer text-sm font-medium text-[var(--color-accent)]">
              Add another part
            </summary>
            <form action={addLineItemAction} className="mt-3 space-y-3">
              <input type="hidden" name="package_id" value={view.package.id} />
              <label className="block text-sm font-medium">
                What is it?
                <input name="label" required placeholder="Hotel" className={field} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium">
                  Cost of one
                  <input name="unit_amount" inputMode="decimal" placeholder="600" className={field} />
                </label>
                <label className="block text-sm font-medium">
                  How many
                  <input name="quantity" type="number" min={1} defaultValue={1} className={field} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium">
                  Needed by
                  <input name="due_date" type="date" className={field} />
                </label>
                <RecurrenceFields />
              </div>
              <label className="block text-sm font-medium">
                Save it in
                <select name="reserve_account" defaultValue={defaultAccount} className={field}>
                  {accountOptions}
                </select>
              </label>
              {!isDraft ? (
                <p className="text-xs text-[var(--color-ink-soft)]">
                  A one-off starts being set aside from today. A part that comes round again
                  counts from the last time it did, and should already hold its share.
                </p>
              ) : null}
              <button
                type="submit"
                className="w-full rounded-xl border border-[var(--color-line)] px-4 py-2 text-sm font-medium"
              >
                Add it
              </button>
            </form>
          </details>
        </Card>
      ) : null}

      {retired.length > 0 ? (
        <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
          No longer part of this plan: {retired.map((i) => i.lineItem.label).join(', ')}.
        </p>
      ) : null}

      {isDone ? (
        <>
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            The plan itself
          </h2>
          <Card>
            <DeletePlan packageId={view.package.id} name={view.package.name} action={deletePackageAction} />
          </Card>
        </>
      ) : (
        <>
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            The plan itself
          </h2>
          <Card>
            {/* Renaming lives beside the name at the top, where the name is. */}
            <div>
              {confirm === 'stop' ? (
                <div className="rounded-xl bg-[var(--color-behind-soft)] p-3">
                  <p className="text-sm font-medium text-[var(--color-behind)]">
                    Stop saving for {view.package.name}?
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                    Nothing is deleted and no money moves. Whatever is already in the account
                    shows up as extra at your next check-in, where you can decide what to do
                    with it.
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <form action={retirePackageAction}>
                      <input type="hidden" name="package_id" value={view.package.id} />
                      <button
                        type="submit"
                        className="w-full rounded-lg bg-[var(--color-behind)] px-3 py-2 text-sm font-medium text-white"
                      >
                        Yes, stop it
                      </button>
                    </form>
                    <Link
                      href={`/packages/${view.package.id}`}
                      className="flex items-center justify-center rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
                    >
                      Keep it
                    </Link>
                  </div>
                </div>
              ) : (
                <Link
                  href={`/packages/${view.package.id}?confirm=stop`}
                  className="block text-center text-sm text-[var(--color-ink-soft)] underline"
                >
                  {isDraft ? 'Throw this draft away' : 'Stop saving for this'}
                </Link>
              )}
            </div>
          </Card>
        </>
      )}

      <p className="mt-6 text-center text-sm">
        <Link href="/packages" className="text-[var(--color-accent)] underline">
          Back to plans
        </Link>
      </p>
    </>
  )
}
