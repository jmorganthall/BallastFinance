/**
 * The calendar (PRD §16, D29, D48): the year at the parks, before a week is
 * picked. Server-rendered; the month and the tapped day travel in the URL,
 * so it works with no client JavaScript. Every figure on it is the
 * derivation module's (calendarMonth, yearStrip); this file lays out cells.
 *
 * Read at a glance, no legend (D48): the cell's background says whether
 * there is school, black stripes mean we cannot go, and the bar is how busy
 * on the green-to-red scale (--color-busy-1..5, D32) with the number printed
 * beside it, so colour is never the only carrier. Where each figure came
 * from is in the day's tooltip and in the detail a tap opens.
 */

import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { humanDate } from '@/components/ui'
import {
  BUSYNESS_SOURCE_WORDS,
  busynessStep,
  crowdWord,
  dataAge,
  monthLabel,
  PARK_LABELS,
  QUEUE_TIMES_ATTRIBUTION,
  THEME_PARKS,
  WEATHER_HORIZON_WORDS,
  weekdayName,
  type CalendarCell,
  type CalendarMonth,
  type YearStripMonth,
} from '@/domain'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Black diagonal stripes over a day we cannot go (D48); what is under them still shows. */
const CANT_GO: CSSProperties = { background: 'repeating-linear-gradient(135deg, var(--color-cantgo) 0 5px, transparent 5px 10px)' }

/** "9:00 pm" from "21:00". */
export function clockWords(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number]
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** The busy bar on a card-coloured track, so the scale's contrast holds on a tinted day, and its number. */
function BusyBar({ level }: { level: number }) {
  return (
    <span className="flex items-center gap-1">
      <span className="flex-1 rounded-sm bg-[var(--color-card)] p-px">
        <span className="block h-1.5 rounded-sm sm:h-2" style={{ background: `var(--color-busy-${busynessStep(level)})` }} />
      </span>
      <span className="text-[10px] font-semibold tabular-nums leading-none sm:text-xs">{Math.round(level)}</span>
    </span>
  )
}

/** Everything about a day in a sentence, for the tooltip and a screen reader. */
function dayWords(cell: CalendarCell): string {
  const parts = [`${weekdayName(cell.date)}, ${humanDate(cell.date)}`]
  if (cell.weather) parts.push(`${cell.weather.highF}° / ${cell.weather.lowF}° (${WEATHER_HORIZON_WORDS[cell.weather.horizon]})`)
  if (cell.busyness) parts.push(`how busy ${Math.round(cell.busyness.level)}, ${crowdWord(cell.busyness.level)} (${BUSYNESS_SOURCE_WORDS[cell.busyness.source]})`)
  else parts.push('how busy not known yet')
  if (cell.earliestClose) parts.push(`${PARK_LABELS[cell.earliestClose.park]} closes first, ${clockWords(cell.earliestClose.closes)}`)
  for (const h of cell.holidays) parts.push(h)
  if (cell.daysOff.length > 0) parts.push(`no school: ${cell.daysOff.join(', ')}`)
  else if (cell.weekend) parts.push('weekend')
  if (cell.blackouts.length > 0) parts.push(`cannot go: ${cell.blackouts.join(', ')}`)
  return parts.join(' · ')
}

export function ParkCalendar({
  calendar,
  year,
  today,
  selected,
  monthHref,
  dayHref,
  refresh,
  children,
}: {
  calendar: CalendarMonth
  /** The twelve-month strip above the month (D48). */
  year: YearStripMonth[]
  today: string
  /** The tapped day, shown beside the month (below it on a phone) with its sources and the action the page offers. */
  selected: string | null
  monthHref: (month: string) => string
  dayHref: (date: string) => string
  /** The "Refresh park data" form, rendered by the page so it can say where to come back to. */
  refresh: ReactNode
  /** What the page offers on the tapped day: "Use these dates" or "Start a trip here". */
  children?: ReactNode
}) {
  const cell = selected ? calendar.weeks.flat().find((c) => c?.date === selected) ?? null : null
  const hoursOn = (date: string) => calendar.hours.filter((h) => h.date === date)
  // Nothing for this month is not the same as never fetched: park hours are published about a month ahead.
  const age = (fetchedOn: string | null) => (fetchedOn ? dataAge(fetchedOn, today) : 'none yet for this month')
  return (
    <div>
      <YearStrip months={year} current={calendar.month} monthHref={monthHref} />

      <div className="mb-2 mt-4 flex items-center justify-between gap-2">
        <Link href={monthHref(calendar.previous)} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm" aria-label="Previous month">
          ‹
        </Link>
        <h3 className="text-lg font-semibold">{calendar.label}</h3>
        <Link href={monthHref(calendar.next)} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm" aria-label="Next month">
          ›
        </Link>
      </div>

      <div className={cell ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-4' : ''}>
        <table className="w-full table-fixed border-collapse text-center text-xs">
          <thead>
            <tr className="text-[var(--color-ink-soft)]">
              {WEEKDAYS.map((d, i) => (
                <th key={i} className="py-1 font-medium">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendar.weeks.map((week, i) => (
              <tr key={i}>
                {week.map((c, j) => (
                  <td
                    key={j}
                    className="relative h-16 border border-[var(--color-line)] p-0 align-top sm:h-20 lg:h-24"
                    style={c?.noSchool ? { background: 'var(--color-noschool)' } : undefined}
                  >
                    {c ? <DayCell cell={c} href={dayHref(c.date)} selected={c.date === selected} /> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {cell ? (
          <div className="mt-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-sm lg:mt-0">
            <h4 className="font-semibold">
              {weekdayName(cell.date)}, {humanDate(cell.date)}
            </h4>
            <ul className="mt-1 space-y-1">
              <li>
                {cell.weather ? (
                  <>
                    <strong>
                      {cell.weather.highF}° / {cell.weather.lowF}°
                    </strong>
                    {cell.weather.precipChance !== null ? `, ${cell.weather.precipChance}% chance of rain` : ''}{' '}
                    <span className="text-[var(--color-ink-soft)]">
                      ({WEATHER_HORIZON_WORDS[cell.weather.horizon]}, {dataAge(cell.weather.fetchedOn, today)})
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-ink-soft)]">No weather for this date yet.</span>
                )}
              </li>
              <li>
                {cell.busyness ? (
                  <>
                    <strong>How busy: {cell.busyness.level}</strong> <span className="text-[var(--color-ink-soft)]">({crowdWord(cell.busyness.level)})</span>{' '}
                    <span className="text-[var(--color-ink-soft)]">
                      — {BUSYNESS_SOURCE_WORDS[cell.busyness.source]}
                      {cell.busyness.detail && cell.busyness.source !== 'typed' ? `, ${cell.busyness.detail}` : ''}
                      {cell.busyness.fetchedOn ? `, ${dataAge(cell.busyness.fetchedOn, today)}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-ink-soft)]">How busy: not known yet.</span>
                )}
              </li>
              {hoursOn(cell.date).length > 0 ? (
                <li>
                  {THEME_PARKS.map((park) => {
                    const h = hoursOn(cell.date).find((x) => x.park === park)
                    return h ? (
                      <span key={park} className="block">
                        {PARK_LABELS[park]} {clockWords(h.opens)}–{clockWords(h.closes)}
                        {h.earlyEntry ? ` (early entry ${clockWords(h.earlyEntry)})` : ''}
                        {h.extendedEvening ? ` (extended to ${clockWords(h.extendedEvening)})` : ''}
                      </span>
                    ) : null
                  })}
                </li>
              ) : (
                <li className="text-[var(--color-ink-soft)]">No park hours for this date yet.</li>
              )}
              {cell.holidays.length > 0 ? <li>{cell.holidays.join(', ')}</li> : null}
              {cell.daysOff.length > 0 ? <li>No school: {cell.daysOff.join(', ')}</li> : null}
              {cell.blackouts.length > 0 ? <li className="text-[var(--color-behind)]">Cannot go: {cell.blackouts.join(', ')}</li> : null}
            </ul>
            {children ? <div className="mt-2">{children}</div> : null}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-[var(--color-ink-soft)]">
        <div title={`Weather ${age(calendar.freshness.weather)} · park hours ${age(calendar.freshness.hours)} · how busy ${age(calendar.freshness.busyness)}`}>{refresh}</div>
        <p>
          <a href={QUEUE_TIMES_ATTRIBUTION.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
            {QUEUE_TIMES_ATTRIBUTION.text}
          </a>
          . Weather by Open-Meteo. Park hours from ThemeParks.wiki.
        </p>
      </div>
    </div>
  )
}

/** Twelve months, a sliver a day, coloured by how busy (grey where nothing is known); a tap opens that month (D48). */
function YearStrip({ months, current, monthHref }: { months: YearStripMonth[]; current: string; monthHref: (month: string) => string }) {
  return (
    <nav aria-label="The next twelve months" className="grid grid-cols-4 gap-2 sm:grid-cols-6 xl:grid-cols-12">
      {months.map((m) => (
        <Link
          key={m.month}
          href={monthHref(m.month)}
          title={monthLabel(m.month)}
          aria-current={m.month === current ? 'true' : undefined}
          className={`block rounded-md p-1 ${m.month === current ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
        >
          <span className={`block text-[11px] leading-tight ${m.month === current ? 'font-semibold' : 'text-[var(--color-ink-soft)]'}`}>{m.label}</span>
          <span className="mt-0.5 flex h-5 overflow-hidden rounded-sm bg-[var(--color-card)]">
            {m.days.map((d) => (
              <span
                key={d.date}
                className={`relative flex-1 ${d.past ? 'opacity-30' : ''}`}
                style={{ background: d.level !== null ? `var(--color-busy-${busynessStep(d.level)})` : 'var(--color-line)' }}
              >
                {d.cantGo ? <span className="absolute inset-0" style={CANT_GO} /> : null}
              </span>
            ))}
          </span>
        </Link>
      ))}
    </nav>
  )
}

function DayCell({ cell, href, selected }: { cell: CalendarCell; href: string; selected: boolean }) {
  const words = dayWords(cell)
  const sure = cell.weather?.horizon === 'forecast'
  return (
    <Link
      href={href}
      title={words}
      aria-label={words}
      className={`absolute inset-0 block px-1 py-0.5 text-left sm:px-1.5 sm:py-1 ${selected ? 'ring-2 ring-inset ring-[var(--color-accent)]' : ''} ${cell.past ? 'opacity-50' : ''}`}
    >
      <span
        className={`inline-block min-w-[1.5em] rounded-full text-center text-xs font-semibold sm:text-sm ${cell.today ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
      >
        {cell.day}
      </span>
      {cell.weather ? (
        <span className={`block whitespace-nowrap text-[11px] leading-tight sm:text-sm ${sure ? '' : 'opacity-60'}`}>
          {cell.weather.highF}°<span className="text-[var(--color-ink-soft)]">/{cell.weather.lowF}°</span>
        </span>
      ) : null}
      {cell.busyness ? (
        <span className="absolute inset-x-1 bottom-1 sm:inset-x-1.5 sm:bottom-1.5">
          <BusyBar level={cell.busyness.level} />
        </span>
      ) : null}
      {cell.blackouts.length > 0 ? <span className="pointer-events-none absolute inset-0" style={CANT_GO} /> : null}
    </Link>
  )
}
