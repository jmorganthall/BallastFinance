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
import { Card, Hint, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import { WeeklyNumber } from '@/components/weekly-number'
import { AccrualChart } from '@/components/accrual-chart'
import {
  addLineItemAction,
  commitPackageAction,
  renamePackageAction,
  retireLineItemAction,
  retirePackageAction,
  updateLineItemAction,
} from '@/server/actions'
import { describeRecurrence, formatCents } from '@/domain'
import { RecurrenceFields } from '@/components/recurrence-fields'

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
  // What a recurring part would already hold, had saving started last time
  // round. Offered, never assumed: the person picks it or types their own.
  const suggested = isDraft ? await engine.suggestedOpenings(view.package.id) : []
  const suggestedTotal = suggested.reduce((sum, s) => sum + s.cents, 0)
  const isDone = view.package.state === 'retired'
  const whatIf = isDraft ? await engine.whatIf(id) : []
  const curve = isDraft || isDone ? null : await engine.packageCurve(id)
  const accounts = await engine.reserveAccountsForViewer()
  const accountName = (accountId: string) =>
    accounts.find((a) => a.id === accountId)?.name ?? 'Unknown account'
  const defaultAccount = accounts.find((a) => a.writable)?.id ?? accounts[0]?.id ?? ''

  const live = view.items.filter((i) => i.lineItem.state !== 'retired')
  const retired = view.items.filter((i) => i.lineItem.state === 'retired')

  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id} disabled={!a.writable}>
      {a.name}
      {a.scope === 'individual' ? (a.writable ? ' (yours)' : ' — theirs') : ''}
    </option>
  ))

  return (
    <>
      <PageHeader
        title={view.package.name}
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

            {suggested.length > 0 ? (
              <form
                action={commitPackageAction}
                className="mt-4 rounded-xl border-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3"
              >
                <input type="hidden" name="package_id" value={view.package.id} />
                <p className="text-sm font-medium">
                  You would have <Money cents={suggestedTotal} /> set aside by now
                </p>
                <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                  If you had been saving since the last time this came round. Is that about what
                  you have?
                </p>
                <ul className="mt-2 space-y-1 text-sm">
                  {suggested.map((s) => (
                    <li key={s.lineItemId} className="flex justify-between gap-3">
                      <span>
                        {s.label}
                        <span className="block text-xs text-[var(--color-ink-soft)]">
                          last due {humanDate(s.lastOccurrence)}
                        </span>
                      </span>
                      <span className="shrink-0 tabular">
                        <Money cents={s.cents} />
                      </span>
                    </li>
                  ))}
                </ul>
                <button
                  type="submit"
                  name="use_suggested"
                  value="1"
                  className="mt-3 w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
                >
                  Yes, start with <Money cents={suggestedTotal} /> set aside
                </button>
              </form>
            ) : null}

            <form action={commitPackageAction} className="mt-4 space-y-3">
              <input type="hidden" name="package_id" value={view.package.id} />
              <label className="block text-sm font-medium">
                {suggested.length > 0
                  ? 'Or tell us what is actually set aside'
                  : 'Already set aside for this (optional)'}
                <input name="opening" inputMode="decimal" placeholder="0" className={field} />
                <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
                  Money you already have toward it. Shared across the parts by cost, so the
                  weekly amount is right from the first week.
                </span>
              </label>
              <button
                type="submit"
                className={`w-full rounded-xl px-4 py-3 font-medium ${
                  suggested.length > 0
                    ? 'border border-[var(--color-line)]'
                    : 'bg-[var(--color-accent)] text-white'
                }`}
              >
                {suggested.length > 0 ? 'Start with this amount instead' : 'Start saving for this'}
              </button>
            </form>
          </>
        ) : !isDone ? (
          <div className="mt-4">
            <WeeklyNumber weekly={view.weekly} size="small" />
            <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
              <Money cents={view.shouldHaveSavedCents} /> should be set aside for this so far.
            </p>
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
        {live.map((item) => (
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
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  <Money cents={item.shouldHaveSavedCents} /> set aside ·{' '}
                  <Money cents={item.remainingCents} /> to go ·{' '}
                  {formatCents(item.weekly.totalPerWeekCents)}/wk
                </p>
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

              {!isDraft && item.components.length > 1 ? (
                <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
                  <Hint
                    detail={item.components
                      .map(
                        (c) =>
                          `${c.kind === 'base' ? 'Original plan' : c.kind === 'opening' ? 'Already set aside' : 'Added when the plan changed'}: ${formatCents(c.amountCents)} over ${c.weeks} week${c.weeks === 1 ? '' : 's'}, ${c.startDate} to ${c.endDate}`,
                      )
                      .join(' · ')}
                  >
                    Made of {item.components.length} pieces
                  </Hint>
                </p>
              ) : null}
            </Card>
          </li>
        ))}
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
                  It starts being set aside from today.
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

      {!isDone ? (
        <>
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            The plan itself
          </h2>
          <Card>
            <form action={renamePackageAction} className="flex items-end gap-2">
              <input type="hidden" name="package_id" value={view.package.id} />
              <label className="flex-1 text-sm font-medium">
                What it is called
                <input name="name" defaultValue={view.package.name} required className={field} />
              </label>
              <button
                type="submit"
                className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium"
              >
                Rename
              </button>
            </form>

            <div className="mt-4 border-t border-[var(--color-line)] pt-4">
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
      ) : null}

      <p className="mt-6 text-center text-sm">
        <Link href="/packages" className="text-[var(--color-accent)] underline">
          Back to plans
        </Link>
      </p>
    </>
  )
}
