/**
 * Recurring (PRD §14, D52): what comes round again, as Simplifi lists it.
 *
 * Paste Simplifi's recurring page; see what the paste changes; keep it. A row
 * gone from Simplifi is only proposed for removal, and goes when a person
 * ticks it. Simplifi's rows are read-only here: their names are what tie them
 * to the next paste. A row known by the name of a reserve account, a debt or
 * an income source counts at Ballast's figure, and a difference is flagged,
 * never corrected. Every figure comes from `recurringView` in the domain.
 */

import { requireEngine } from '@/server/session'
import { Card, Hint, Money, PageHeader, Pill, When, humanDate } from '@/components/ui'
import {
  addRecurringAction,
  discardSimplifiPasteAction,
  endRecurringAction,
  keepSimplifiPasteAction,
  linkSimplifiRowAction,
  pasteSimplifiAction,
  unlinkSimplifiRowAction,
  updateRecurringAction,
} from '@/server/actions'
import {
  FREQUENCIES,
  FREQUENCY_WORDS,
  LINK_KIND_WORDS,
  formatCents,
  linkFor,
  suggestedLink,
  type BallastFigure,
  type RecurringRowView,
  type SimplifiTarget,
} from '@/domain'

export const dynamic = 'force-dynamic'

const field =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const small =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-ink)]'
const heading = 'mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'

function figureWords(f: { amountCents: number; frequency: keyof typeof FREQUENCY_WORDS }) {
  return `${formatCents(f.amountCents)} ${FREQUENCY_WORDS[f.frequency]}`
}

function ballastWords(target: SimplifiTarget, figure: BallastFigure | null): string {
  if (!figure) return target.kind === 'account' ? 'no transfer confirmed yet' : 'no figure yet'
  const what = target.kind === 'account' ? 'the bank transfer' : target.kind === 'debt' ? 'the payment' : 'take-home'
  return `${what} is ${figureWords({ amountCents: figure.cents, frequency: figure.frequency })}`
}

function TargetPicker({ targets, selected, name = 'link_target' }: { targets: SimplifiTarget[]; selected?: SimplifiTarget | null; name?: string }) {
  const groups: SimplifiTarget['kind'][] = ['account', 'debt', 'income']
  return (
    <select name={name} defaultValue={selected ? `${selected.kind}:${selected.id}` : ''} className={`${small} w-full max-w-52`} aria-label="Link to">
      <option value="">Not linked</option>
      {groups.map((kind) => {
        const list = targets.filter((t) => t.kind === kind)
        if (list.length === 0) return null
        return (
          <optgroup key={kind} label={kind === 'account' ? 'Reserve accounts' : kind === 'debt' ? 'Debts' : 'Income'}>
            {list.map((t) => (
              <option key={t.id} value={`${t.kind}:${t.id}`}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )
      })}
    </select>
  )
}

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const { saved, error } = await searchParams
  const { engine } = await requireEngine()
  const today = engine.today()
  const [view, pending, targets] = await Promise.all([
    engine.recurringView(),
    engine.pendingSimplifiPaste(),
    engine.simplifiTargets(),
  ])

  const out = view.rows.filter((r) => r.item.direction === 'out' && r.item.source === 'simplifi')
  const incoming = view.rows.filter((r) => r.item.direction === 'in')
  const manual = view.rows.filter((r) => r.item.source === 'manual' && r.item.direction === 'out')
  const differing = view.checks.filter((c) => c.differs)
  const checkOf = new Map(view.checks.map((c) => [`${c.target.kind}:${c.target.id}`, c]))

  return (
    <>
      <PageHeader
        title="Recurring"
        subtitle={
          view.lastPastedOn
            ? `What comes round again, from Simplifi. Last pasted ${humanDate(view.lastPastedOn)}.`
            : 'What comes round again, from Simplifi. Nothing pasted yet.'
        }
      />

      {saved ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <p className="text-sm font-medium text-[var(--color-ahead)]">{saved === '1' ? 'Saved.' : saved}</p>
        </Card>
      ) : null}
      {error ? (
        <Card className="mb-4 bg-[var(--color-behind-soft)]">
          <p className="text-sm text-[var(--color-behind)]">{error}</p>
        </Card>
      ) : null}

      {pending ? (
        <PastePreview pending={pending} targets={targets} />
      ) : (
        <>
          {view.rows.length > 0 ? (
            <Card className="mb-6">
              <p className="text-sm text-[var(--color-ink-soft)]">Going out, a month</p>
              <p className="text-3xl font-semibold tracking-tight">
                <Hint detail="Every live item going out, at a month: Ballast's own figure for one linked to an account or debt (the confirmed bank transfer, the monthly payment), Simplifi's for the rest. Weekly money is x52 / 12, rounded up.">
                  <Money cents={view.outPerMonthCents} />
                </Hint>
              </p>
            </Card>
          ) : null}

          {differing.length > 0 || view.notInSimplifi.length > 0 ? (
            <>
              <h2 className={heading}>Where Simplifi and Ballast differ</h2>
              <Card className="mb-6 space-y-2 text-sm">
                {differing.map((c) => (
                  <p key={`${c.target.kind}:${c.target.id}`}>
                    <span className="font-medium">{c.target.name}</span>: Simplifi has{' '}
                    {c.items.map((i) => figureWords(i)).join(' + ')}; {ballastWords(c.target, c.ballast)}. Ballast&apos;s
                    figure is the one that counts; update Simplifi to match.
                  </p>
                ))}
                {view.notInSimplifi.map((t) => (
                  <p key={t.id}>
                    <span className="font-medium">{t.name}</span> has a bank transfer confirmed, but no Simplifi row
                    is known as it. Not in Simplifi yet, or link its row below.
                  </p>
                ))}
              </Card>
            </>
          ) : null}

          <h2 className={heading}>From Simplifi</h2>
          <Card className="mb-6">
            {out.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-soft)]">Nothing yet. Paste the list below.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {out.map((row) => (
                  <RowLine key={row.item.id} row={row} today={today} targets={targets} check={row.link ? checkOf.get(`${row.link.kind}:${row.link.id}`) : undefined} />
                ))}
              </ul>
            )}
          </Card>

          {incoming.length > 0 ? (
            <>
              <h2 className={heading}>Coming in, per Simplifi</h2>
              <Card className="mb-6">
                <p className="mb-2 text-xs text-[var(--color-ink-soft)]">
                  A cross-check only: what comes in is worked out on Income, from the paystubs.
                </p>
                <ul className="divide-y divide-[var(--color-line)]">
                  {incoming.map((row) => (
                    <RowLine key={row.item.id} row={row} today={today} targets={targets} check={row.link ? checkOf.get(`${row.link.kind}:${row.link.id}`) : undefined} />
                  ))}
                </ul>
              </Card>
            </>
          ) : null}

          <h2 className={heading}>Added here</h2>
          <Card className="mb-6">
            {manual.length > 0 ? (
              <ul className="mb-4 divide-y divide-[var(--color-line)]">
                {manual.map((row) => (
                  <li key={row.item.id} className="py-2">
                    <details>
                      <summary className="flex cursor-pointer items-start justify-between gap-3 text-sm">
                        <span>
                          <span className="font-medium">{row.item.name}</span>{' '}
                          <Pill tone="neutral">Not in Simplifi</Pill>
                        </span>
                        <span className="text-right">
                          {figureWords(row.item)}
                          <span className="block text-xs text-[var(--color-ink-soft)]">
                            {formatCents(row.perMonthCents)} a month
                          </span>
                        </span>
                      </summary>
                      <form action={updateRecurringAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_8rem_10rem_auto]">
                        <input type="hidden" name="id" value={row.item.id} />
                        <input name="name" defaultValue={row.item.name} className={small} aria-label="Name" />
                        <input name="amount" defaultValue={(row.item.amountCents / 100).toFixed(2)} inputMode="decimal" className={small} aria-label="Amount" />
                        <select name="frequency" defaultValue={row.item.frequency} className={small} aria-label="How often">
                          {FREQUENCIES.map((f) => (
                            <option key={f} value={f}>
                              {FREQUENCY_WORDS[f]}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm font-medium">
                          Save
                        </button>
                      </form>
                      <form action={endRecurringAction} className="mt-2">
                        <input type="hidden" name="id" value={row.item.id} />
                        <button type="submit" className="text-sm text-[var(--color-behind)] underline">
                          It has stopped
                        </button>
                      </form>
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-sm text-[var(--color-ink-soft)]">
                Anything Simplifi does not catch, such as cash.
              </p>
            )}
            <form action={addRecurringAction} className="grid gap-2 border-t border-[var(--color-line)] pt-4 sm:grid-cols-[1fr_8rem_10rem_auto]">
              <input name="name" required placeholder="Babysitter" className={small} aria-label="Name" />
              <input name="amount" required inputMode="decimal" placeholder="60.00" className={small} aria-label="Amount" />
              <select name="frequency" defaultValue="monthly" className={small} aria-label="How often">
                {FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_WORDS[f]}
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm font-medium">
                Add
              </button>
            </form>
          </Card>

          <h2 className={heading}>Paste from Simplifi</h2>
          <Card className="mb-6">
            <form action={pasteSimplifiAction} className="space-y-3">
              <label className="block text-sm font-medium">
                Simplifi&apos;s recurring list
                <textarea
                  name="paste"
                  rows={8}
                  placeholder={'Streaming Co\nNext: $15.49 on Oct 26, 2026\nChecking (Joint)\nChecking\n…'}
                  className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-ink)]"
                />
                <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
                  Select the whole list on Simplifi&apos;s Recurring page, copy, and paste it here. You see
                  what changes before anything is kept. Simplifi&apos;s Yearly column is not used: every
                  figure is the amount times how often.
                </span>
              </label>
              <button type="submit" className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white">
                Read it
              </button>
            </form>
          </Card>
        </>
      )}
    </>
  )
}

function RowLine({
  row,
  today,
  targets,
  check,
}: {
  row: RecurringRowView
  today: string
  targets: SimplifiTarget[]
  check?: { differs: boolean }
}) {
  const { item, link } = row
  return (
    <li className="py-2">
      <div className="flex items-start justify-between gap-3 text-sm">
        <span className="min-w-0">
          <span className="font-medium">{item.name}</span>
          <span className="block text-xs text-[var(--color-ink-soft)]">
            {[item.category, item.kind, item.accountType === 'Checking' ? null : item.account].filter(Boolean).join(' · ')}
            {item.nextDate ? (
              <>
                {' · next '}
                {item.nextAmountCents !== null && item.nextAmountCents !== item.amountCents ? `${formatCents(item.nextAmountCents)} ` : ''}
                <When date={item.nextDate} today={today} />
              </>
            ) : null}
          </span>
        </span>
        <span className="shrink-0 text-right">
          {figureWords(item)}
          <span className="block text-xs text-[var(--color-ink-soft)]">{formatCents(row.perMonthCents)} a month</span>
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {link ? (
          <form action={unlinkSimplifiRowAction} className="flex items-center gap-2">
            <Pill tone={check?.differs ? 'caution' : 'accent'}>
              {LINK_KIND_WORDS[link.kind]}: {link.name}
              {check?.differs ? ' · differs' : ''}
            </Pill>
            <input type="hidden" name="link_name" value={item.name} />
            <input type="hidden" name="link_target" value={`${link.kind}:${link.id}`} />
            <button type="submit" className="text-xs text-[var(--color-ink-soft)] underline">
              Unlink
            </button>
          </form>
        ) : (
          <form action={linkSimplifiRowAction} className="flex items-center gap-2">
            <input type="hidden" name="link_name" value={item.name} />
            <TargetPicker targets={targets} selected={row.suggestion} />
            <button type="submit" className="text-xs underline">
              Link
            </button>
          </form>
        )}
      </div>
    </li>
  )
}

function PastePreview({
  pending,
  targets,
}: {
  pending: NonNullable<Awaited<ReturnType<import('@/server/engine').Engine['pendingSimplifiPaste']>>>
  targets: SimplifiTarget[]
}) {
  const { paste, diff } = pending
  const linkable = (name: string) => ({ linked: linkFor(name, targets), suggested: suggestedLink(name, targets) })
  return (
    <>
      <h2 className={heading}>What this paste changes</h2>
      <Card className="mb-6">
        <form action={keepSimplifiPasteAction} className="space-y-5 text-sm">
          <p>
            {paste.rows.length} rows read: {diff.added.length} new, {diff.changed.length} changed,{' '}
            {diff.unchanged.length} the same, {diff.gone.length} no longer in Simplifi.
          </p>

          {paste.problems.length > 0 ? (
            <div className="rounded-xl bg-[var(--color-behind-soft)] p-3 text-[var(--color-behind)]">
              <p className="font-medium">Not read:</p>
              <ul className="mt-1 list-disc pl-5">
                {paste.problems.map((p, i) => (
                  <li key={i}>
                    Line {p.line}: {p.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {diff.added.length > 0 ? (
            <div>
              <p className="mb-2 font-medium">New</p>
              <ul className="space-y-2">
                {diff.added.map((row) => {
                  const { linked, suggested } = linkable(row.name)
                  return (
                    <li key={row.name} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 flex-1">
                        {row.name}{' '}
                        <span className="text-[var(--color-ink-soft)]">
                          {row.direction === 'in' ? '+' : ''}
                          {figureWords(row)}
                        </span>
                      </span>
                      <span className="w-40 shrink-0 text-right sm:w-52">
                        {linked ? (
                          <Pill tone="accent">{LINK_KIND_WORDS[linked.kind]}: {linked.name}</Pill>
                        ) : (
                          <>
                            <input type="hidden" name="link_name" value={row.name} />
                            <TargetPicker targets={targets} selected={suggested} />
                          </>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                Link a row that is one of Ballast&apos;s own: a weekly transfer to a reserve account, a debt payment,
                a paycheck. Its figure then comes from Ballast.
              </p>
            </div>
          ) : null}

          {diff.changed.length > 0 ? (
            <div>
              <p className="mb-2 font-medium">Changed in Simplifi</p>
              <ul className="space-y-1">
                {diff.changed.map((c) => (
                  <li key={c.item.id}>
                    {c.item.name}: {figureWords(c.item)} → {figureWords(c.row)}
                    {c.fields.some((f) => f !== 'amountCents' && f !== 'frequency') ? (
                      <span className="text-[var(--color-ink-soft)]"> (and its {c.fields.filter((f) => f !== 'amountCents' && f !== 'frequency').map((f) => (f === 'accountType' ? 'account type' : f)).join(', ')})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {diff.gone.length > 0 ? (
            <div>
              <p className="mb-2 font-medium">No longer in Simplifi</p>
              <ul className="space-y-1">
                {diff.gone.map((item) => (
                  <li key={item.id}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="end" value={item.id} />
                      Remove {item.name} ({figureWords(item)})
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                Ticked ones are ended today; the rest stay until you say. Renamed in Simplifi? Leave the old one, and
                link the new name to the same account.
              </p>
            </div>
          ) : null}

          <button type="submit" className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white">
            Keep this
          </button>
        </form>
        <form action={discardSimplifiPasteAction} className="mt-2">
          <button type="submit" className="w-full rounded-xl border border-[var(--color-line)] px-4 py-3 font-medium">
            Throw it away
          </button>
        </form>
      </Card>
    </>
  )
}
