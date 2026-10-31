/**
 * Explore (PRD D42, D55): the best times to go, in the family's shape, on
 * the Trips page before there is a trip. Server-rendered: the length chips
 * are links that put park days in the address, never a setting. Every
 * figure is the domain's (explore, shapeWindow); this file lays them out.
 */

import Link from 'next/link'
import { checkHomeDriveAction, useHomeDriveAction } from '@/server/actions'
import { Hint } from '@/components/ui'
import {
  exploreTripName,
  hoursWords,
  priceDetail,
  priceWords,
  RESORTINGS_CREDIT,
  shapeCode,
  shortDate,
  stayWords,
  weekdayName,
  type DriveEstimate,
  type Explore,
  type TripShape,
} from '@/domain'

const smallButton = 'rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium'
const chip = 'rounded-full border px-3 py-1 text-sm'
const input = 'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'

const CHIPS: readonly { label: string; parks: string | null }[] = [
  { label: 'Our usual', parks: null },
  { label: '2 park days', parks: '2' },
  { label: '5', parks: '5' },
  { label: '6', parks: '6' },
]

function dayWord(date: string): string {
  return weekdayName(date).slice(0, 3)
}

export function ExploreSection({
  result,
  parks,
  drive,
  lookedUp,
  judged,
}: {
  result: Explore & { shape: TripShape; stay: string }
  /** The park days asked for in the address, as written there; null is the family's usual. */
  parks: string | null
  drive: DriveEstimate | null
  /** A drive just looked up, shown before it is kept. */
  lookedUp: { miles: number; minutes: number } | null
  /** How a week is judged, in words (weightsSentence). */
  judged: string
}) {
  const { shape } = result
  const usual = shape.parkDaysMin === shape.parkDaysMax ? `${shape.parkDaysMin}` : `${shape.parkDaysMin} to ${shape.parkDaysMax}`
  const asked = result.parkDays.min === result.parkDays.max ? `${result.parkDays.min}` : `${result.parkDays.min} to ${result.parkDays.max}`
  const href = (p: string | null) => (p ? `/trips?parks=${p}#explore` : '/trips#explore')
  const exact = parks !== null && !CHIPS.some((c) => c.parks === parks)
  return (
    <div>
      <p className="text-sm">
        {asked} park {asked === '1' ? 'day' : 'days'} with a travel day each side.
        {drive ? ` The drive is ${hoursWords(drive.minutes)}, in easy stretches of ${hoursWords(result.stretchMinutes)}.` : ''}
        {parks === null ? ' Our usual.' : ` Our usual is ${usual}.`}
      </p>

      <nav aria-label="How many park days" className="mt-2 flex flex-wrap items-center gap-2">
        {CHIPS.map((c) => {
          const on = c.parks === parks
          return (
            <Link
              key={c.label}
              href={href(c.parks)}
              aria-current={on ? 'true' : undefined}
              className={`${chip} ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium' : 'border-[var(--color-line)]'}`}
            >
              {c.label}
            </Link>
          )
        })}
        <form action="/trips#explore" method="get" className="flex items-center gap-1">
          <label className="sr-only" htmlFor="explore-parks">
            Park days, like 2-6
          </label>
          <input
            id="explore-parks"
            name="parks"
            defaultValue={exact ? parks : ''}
            placeholder="2-6"
            inputMode="numeric"
            className={`w-16 rounded-full border px-3 py-1 text-sm ${exact ? 'border-[var(--color-accent)]' : 'border-[var(--color-line)]'} bg-[var(--color-surface)]`}
          />
          <button type="submit" className={chip + ' border-[var(--color-line)]'}>
            Exact
          </button>
        </form>
      </nav>

      {lookedUp ? (
        <div className="mt-3 rounded-xl bg-[var(--color-accent-soft)] p-3 text-sm">
          <p>
            The route says {lookedUp.miles} miles, {hoursWords(lookedUp.minutes)} one way. Keep it? Every trip from home uses it.
          </p>
          <form action={useHomeDriveAction} className="mt-2">
            <input type="hidden" name="miles" value={lookedUp.miles} />
            <input type="hidden" name="minutes" value={lookedUp.minutes} />
            <button type="submit" className={smallButton}>
              Keep this drive
            </button>
          </form>
        </div>
      ) : !drive ? (
        <div className="mt-3 rounded-xl border border-[var(--color-line)] p-3 text-sm">
          <p>The drive has not been looked up, so every travel day is a full one. Look it up, or type it.</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <form action={checkHomeDriveAction}>
              <button type="submit" className={smallButton}>
                Look up the drive
              </button>
            </form>
            <form action={useHomeDriveAction} className="flex items-end gap-2">
              <label className="block text-xs text-[var(--color-ink-soft)]">
                Miles
                <input name="miles" inputMode="numeric" placeholder="480" className={input + ' w-20'} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                Hours
                <input name="hours" inputMode="decimal" placeholder="7.5" className={input + ' w-20'} />
              </label>
              <button type="submit" className={smallButton}>
                Save
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {result.top.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-ink-soft)]">Every window ahead runs into a day we cannot go.</p>
      ) : (
        <ol className="mt-3 divide-y divide-[var(--color-line)]">
          {result.top.map((w, i) => (
            <li key={`${w.startDate}|${w.parkDays}`} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0 text-sm">
                <span className="font-medium">
                  {i + 1}. {dayWord(w.startDate)} {shortDate(w.startDate)} – {dayWord(w.endDate)} {shortDate(w.endDate)}, {w.endDate.slice(0, 4)}
                </span>
                <span className="block text-[var(--color-ink-soft)]">{w.words}</span>
                <span className="block text-xs text-[var(--color-ink-soft)]">
                  {w.reasons.map((r, j) => (
                    <span key={r}>
                      {j > 0 ? ' · ' : ''}
                      {r === priceWords(w.price) ? <Hint detail={priceDetail(w.price)}>{r}</Hint> : r}
                    </span>
                  ))}
                </span>
              </div>
              <Link
                href={`/trips?start=${w.startDate}&end=${w.endDate}&layout=${shapeCode(w)}&name=${encodeURIComponent(exploreTripName(w))}#new-trip`}
                className={smallButton + ' shrink-0'}
              >
                Plan this
              </Link>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-2 text-xs leading-snug text-[var(--color-ink-soft)]">
        From {shortDate(result.horizonFrom)} to {shortDate(result.horizonTo)}, {result.horizonTo.slice(0, 4)}: {result.considered} ways to go looked at.{' '}
        {judged} Cheap is what it costs to sleep at {stayWords(result.stay)}, night by night from the surest price we have;
        a week with no price yet is neither cheap nor dear. The strip above shades each day by how good a trip leaving it is, and the numbers on the month
        are this list.
        {result.excludedByBlackout > 0 ? ` ${result.excludedByBlackout} left out for days we cannot go.` : ''}
        {result.daysOffKnown ? '' : ' No school calendar yet, so every weekday counts as school; add one below.'}
        {result.top.some((w) => w.price?.lodging.weakest === 'rates_week' || w.price?.lodging.weakest === 'rates_month') ? (
          <>
            {' '}
            <a href={RESORTINGS_CREDIT.url} className="underline">
              {RESORTINGS_CREDIT.text}
            </a>
            .
          </>
        ) : null}
      </p>
    </div>
  )
}
