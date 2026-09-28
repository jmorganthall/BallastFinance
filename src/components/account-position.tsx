/**
 * An account as the position sees it (D35): what it likely holds, what the
 * bank moves into it, what Ballast asks the transfer to be, and whether,
 * run forward, the money is there on every date something is due. This
 * week and the check-in both draw this one card, so the two screens can
 * never say different things about the same account. Every figure is the
 * domain's; this only lays them out.
 */

import { Card, Hint, humanDate, Money } from '@/components/ui'
import { AccountStatusPill } from '@/components/status'
import { formatCents, type AccountPosition } from '@/domain'

export function AccountPositionCard({ account: a }: { account: AccountPosition }) {
  const money = a.money
  const moneyDetail =
    money.from === 'count'
      ? `Counted ${formatCents(money.startCents)} on ${humanDate(money.on!)}, plus ${formatCents(money.transfersSinceCents)} transferred since, ${formatCents(money.movesSinceCents)} moved in or out, less ${formatCents(money.spendsSinceCents)} spent. A check-in replaces this with what the bank says.`
      : money.from === 'openings'
        ? `Never counted: this is what you said was already set aside when its plans started (${formatCents(money.startCents)}, ${humanDate(money.on!)}), plus transfers, moves and spends since. A check-in replaces it with what the bank says.`
        : 'Never counted, and nothing was said to be set aside when its plans started, so this counts only transfers and moves since. A check-in replaces it with what the bank says.'

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold">{a.account.name}</h3>
        <AccountStatusPill status={a.status} />
      </div>

      <p className="mt-1 text-sm">
        <Hint detail={moneyDetail}>
          Likely holds <Money cents={money.totalCents} /> today
        </Hint>
        {a.extraCents > 0 && a.parts.length > 0 ? (
          <>
            {' · '}
            <Hint detail="What could leave this account today with every plan still covered on its date, on the transfer set up now. Until then it is counted toward the plans due soonest. Nothing is asked of it; it is a cushion until you decide otherwise.">
              <Money cents={a.extraCents} /> extra
            </Hint>
          </>
        ) : null}
      </p>

      {a.status === 'short' && a.short ? (
        <p className="mt-2 text-sm font-medium text-[var(--color-behind)]">
          On the transfer set up now it runs short on {humanDate(a.short.on)}, by{' '}
          <Money cents={a.short.byCents} />.
        </p>
      ) : a.parts.length > 0 && a.horizon && a.status === 'on_track' ? (
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          Covers everything due through {humanDate(a.horizon)} on the transfer set up now
          {a.catchingUpParts > 0
            ? `, including ${a.catchingUpParts === 1 ? 'the part' : `the ${a.catchingUpParts} parts`} catching up.`
            : '.'}
        </p>
      ) : null}

      <div className="mt-3 rounded-xl bg-[var(--color-surface)] p-3 text-sm">
        {a.bank ? (
          <p>
            The bank moves <Money cents={a.bank.perWeekCents} /> a week
            {a.bank.nextWeekCents !== a.bank.perWeekCents ? (
              <>
                {' '}
                (<Money cents={a.bank.nextWeekCents} /> this week, with a catch-up from before)
              </>
            ) : null}
            .
          </p>
        ) : (
          <p>Nobody has told Ballast what the bank moves into this account yet.</p>
        )}
        {a.transferChange ? (
          <p className="mt-1 font-medium">
            {a.transferChange.reason === 'confirm' ? (
              <>
                Ballast suggests <Money cents={a.transferChange.toCents} /> a week; confirm it on
                This week.
              </>
            ) : (
              <>
                Pending transfer change:{' '}
                <Money cents={a.transferChange.fromCents ?? 0} /> →{' '}
                <Money cents={a.transferChange.toCents} /> a week
                {a.transferChange.reason === 'raise'
                  ? ', so every date is covered.'
                  : ', since less now does the job.'}
              </>
            )}
          </p>
        ) : a.parts.length > 0 ? (
          <p className="mt-1 text-[var(--color-ink-soft)]">That is what it needs.</p>
        ) : null}
        {a.oneTimeMove ? (
          <p className="mt-1 font-medium">
            And a one-time move of <Money cents={a.oneTimeMove.amountCents} /> by{' '}
            {humanDate(a.oneTimeMove.byDate)}, too soon for the weekly transfer to cover.
          </p>
        ) : null}
        {a.parts.length > 0 ? (
          <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
            <Hint
              detail={`The smallest steady transfer that has the money there on every date, looking ahead to ${a.horizon ? humanDate(a.horizon) : 'the last date'}: ${formatCents(a.neededExactPerWeekCents)} exactly${a.neededPerWeekCents !== a.neededExactPerWeekCents ? `, ${formatCents(a.neededPerWeekCents)} as the bank figure` : ''}. Each part saving steadily on its own would come to ${formatCents(a.steadyPerWeekCents)}.`}
            >
              Needs <Money cents={a.neededPerWeekCents} /> a week
              {a.catchUpPerWeekCents > 0 ? (
                <>
                  : <Money cents={a.steadyPerWeekCents} /> steady + <Money cents={a.catchUpPerWeekCents} />{' '}
                  catching up
                  {a.neededPerWeekCents !== a.neededExactPerWeekCents ? ', rounded up' : ''}
                </>
              ) : a.catchUpPerWeekCents < 0 ? (
                <>
                  {' '}
                  (<Money cents={a.neededExactPerWeekCents} /> exactly, less than the{' '}
                  <Money cents={a.steadyPerWeekCents} /> its parts would need each on their own, because
                  money already here or set aside for later plans covers the ones due sooner)
                </>
              ) : null}
            </Hint>
          </p>
        ) : null}
      </div>
    </Card>
  )
}
