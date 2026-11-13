/**
 * One account on Check in (D35, D57 (1)): how it stands, what it likely
 * holds, what the bank moves into it each week, and the box for what it
 * really holds -- one card, so the screen never draws the same account
 * twice. The long explanations live in tooltips; the card itself is a
 * status, two figures and a box. Every figure is the position's; this only
 * lays them out. This week still draws the fuller `AccountPositionCard`.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { Card, Hint, humanDate, Money, When } from "@/components/ui";
import { AccountStatusPill } from "@/components/status";
import { CountField } from "@/components/count-field";
import {
  formatCents,
  moneySinceSentence,
  type AccountPosition,
  type CivilDate,
} from "@/domain";

export function AccountCheckCard({
  account: a,
  today,
}: {
  account: AccountPosition;
  today: CivilDate;
}) {
  const money = a.money;
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold">{a.account.name}</h2>
          <StatusLine account={a} today={today} />
        </div>
        <AccountStatusPill status={a.status} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-[var(--color-line)]">
        <Stat
          label="Likely holds"
          detail={`${moneySinceSentence(money, humanDate)} What you type below replaces this.`}
        >
          <Money cents={money.totalCents} />
          <Caption>
            {money.from === "count" && money.on ? (
              <>
                Counted <When date={money.on} today={today} />
              </>
            ) : (
              "Not counted yet"
            )}
          </Caption>
          {a.extraCents > 0 && a.parts.length > 0 ? (
            <Caption>
              <Hint detail="What could leave this account today with every plan still covered on its date, on the transfer set up now. If another account is Short, This week asks to move it there first.">
                <span className="text-[var(--color-ahead)]">
                  <Money cents={a.extraCents} /> extra
                </span>
              </Hint>
            </Caption>
          ) : null}
        </Stat>
        <Stat label="Each week" detail={weeklyDetail(a)}>
          <WeeklyFigure account={a} today={today} />
        </Stat>
      </div>

      <CountField
        accountId={a.account.id}
        likelyCents={money.totalCents}
        label="What Capital One shows"
      />
    </Card>
  );
}

/** One short line under the name: how long the money lasts, in the status's colour. */
function StatusLine({
  account: a,
  today,
}: {
  account: AccountPosition;
  today: CivilDate;
}) {
  if (a.status === "short" && a.short) {
    return (
      <p className="mt-0.5 text-sm font-medium text-[var(--color-behind)]">
        <Money cents={a.short.byCents} /> short{" "}
        <When date={a.short.on} today={today} />
      </p>
    );
  }
  if (a.status === "running_down" && a.short) {
    const why =
      a.bank && a.bank.perWeekCents < a.runRatePerWeekCents
        ? `Every bill this time round is covered, but ${formatCents(a.bank.perWeekCents)} a week is less than these bills cost (${formatCents(a.runRatePerWeekCents)} a week), so it is using up what is already set aside.`
        : "Every bill it is saving for now is covered, but not the time after.";
    return (
      <p className="mt-0.5 text-sm text-[var(--color-caution)]">
        <Hint detail={why}>Runs out</Hint>{" "}
        <When date={a.short.on} today={today} />
      </p>
    );
  }
  if (a.status === "on_track" && a.horizon && a.parts.length > 0) {
    return (
      <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
        Covered <When date={a.horizon} today={today} as="until" />
      </p>
    );
  }
  return null;
}

/** What the weekly figure means, for the tooltip on its label. */
function weeklyDetail(a: AccountPosition): string {
  const needs = `Needs ${formatCents(a.neededPerWeekCents)} a week: the smallest steady transfer that has the money there on every date${a.horizon ? `, looking ahead to ${humanDate(a.horizon)}` : ""}. Each part saving on its own would come to ${formatCents(a.steadyPerWeekCents)}.`;
  const change = a.transferChange;
  if (!a.bank)
    return `Nobody has told Ballast what the bank moves into this account yet. ${needs}`;
  if (!change || change.reason === "confirm")
    return `What the bank moves into this account each week. ${needs}`;
  const why =
    change.reason === "raise"
      ? "so every date is covered"
      : change.reason === "keep_up"
        ? "so it keeps up with what its bills cost"
        : "since less now does the job";
  return `The bank moves ${formatCents(a.bank.perWeekCents)} a week now; This week asks to change it to ${formatCents(change.toCents)}, ${why}. ${needs}`;
}

/** What the bank moves a week, the change This week asks for, and any one-time move. */
function WeeklyFigure({
  account: a,
  today,
}: {
  account: AccountPosition;
  today: CivilDate;
}) {
  const change = a.transferChange;
  const asked =
    change && (change.reason !== "confirm" || !a.bank) ? change.toCents : null;
  return (
    <>
      {a.bank ? <Money cents={a.bank.perWeekCents} /> : "—"}
      {asked !== null ? (
        <Caption>
          <ToThisWeek>
            {a.bank ? "Change to" : "Set up"} <Money cents={asked} /> →
          </ToThisWeek>
        </Caption>
      ) : null}
      {a.oneTimeMove ? (
        <Caption>
          <ToThisWeek>
            + <Money cents={a.oneTimeMove.amountCents} /> once →
          </ToThisWeek>{" "}
          <When date={a.oneTimeMove.byDate} today={today} as="due" />
        </Caption>
      ) : null}
      {asked === null && !a.oneTimeMove ? (
        <Caption>
          {!a.bank ? (
            "Not set up yet"
          ) : a.bank.nextWeekCents !== a.bank.perWeekCents ? (
            <>
              <Money cents={a.bank.nextWeekCents} /> this week
            </>
          ) : (
            "At the bank"
          )}
        </Caption>
      ) : null}
    </>
  );
}

function Stat({
  label,
  detail,
  children,
}: {
  label: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-[var(--color-surface)] px-3 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
        <Hint detail={detail}>{label}</Hint>
      </p>
      <div className="mt-1 text-xl font-semibold tabular-nums">{children}</div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-xs font-normal text-[var(--color-ink-soft)]">
      {children}
    </p>
  );
}

function ToThisWeek({ children }: { children: ReactNode }) {
  return (
    <Link
      href="/"
      className="font-medium text-[var(--color-accent)] hover:underline"
    >
      {children}
    </Link>
  );
}
