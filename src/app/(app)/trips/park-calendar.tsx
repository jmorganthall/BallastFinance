/**
 * The calendar (PRD §16, D29): a month of the year at the parks, before a
 * week is picked. Server-rendered; the month and the tapped day travel in
 * the URL, so it works with no client JavaScript. Every figure on it is the
 * derivation module's (calendarMonth); this file lays out cells.
 *
 * Busyness is a colour from the app's one-hue ramp (--color-busy-1..5), two
 * levels a step, and the number is printed too, so colour is never the only
 * carrier. Tapping a day shows where each figure came from and offers to
 * start a window there.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { humanDate } from '@/components/ui'
import {
  BUSYNESS_SOURCE_WORDS,
  busynessStep,
  crowdWord,
  dataAge,
  PARK_LABELS,
  QUEUE_TIMES_ATTRIBUTION,
  THEME_PARKS,
  WEATHER_HORIZON_WORDS,
  weekdayName,
  type CalendarCell,
  type CalendarMonth,
  type WeatherHorizon,
} from '@/domain'

const HORIZON_MARKS: Record<WeatherHorizon, string> = { forecast: '', subseasonal: '~', normal: '≈' }
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** "9:00 pm" from "21:00". */
export function clockWords(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number]
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

function BusyBar({ level }: { level: number }) {
  return (
    <span
      className="mt-0.5 block h-1.5 w-full rounded-sm"
      style={{ background: `var(--color-busy-${busynessStep(level)})` }}
      aria-hidden
    />
  )
}

export function ParkCalendar({
  calendar,
  today,
  selected,
  monthHref,
  dayHref,
  refresh,
  children,
}: {
  calendar: CalendarMonth
  today: string
  /** The tapped day, shown below the grid with its sources and the action the page offers. */
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
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link href={monthHref(calendar.previous)} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm" aria-label="Previous month">
          ‹
        </Link>
        <h3 className="font-semibold">{calendar.label}</h3>
        <Link href={monthHref(calendar.next)} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm" aria-label="Next month">
          ›
        </Link>
      </div>

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
                <td key={j} className="h-16 border border-[var(--color-line)] p-0 align-top">
                  {c ? <DayCell cell={c} href={dayHref(c.date)} selected={c.date === selected} /> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-xs leading-snug text-[var(--color-ink-soft)]">
        High and low in °F: plain is the forecast, ~ the seasonal outlook (about six months, less sure the further out), ≈ typical for this date. The bar is how busy, 1
        (quiet) to 10 (packed). ⤓ is the earliest park close. ● a day off school, ★ a federal holiday; a struck-out day
        is one you cannot go. Tap a day for where each figure came from.
      </p>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        Weather {dataAge(calendar.freshness.weather, today)} · park hours {dataAge(calendar.freshness.hours, today)} · how busy{' '}
        {dataAge(calendar.freshness.busyness, today)}.
      </p>
      <div className="mt-2">{refresh}</div>

      {cell ? (
        <div className="mt-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-sm">
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
                    <span key={park} className="mr-2 inline-block">
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
            {cell.holidays.length > 0 ? <li>★ {cell.holidays.join(', ')}</li> : null}
            {cell.daysOff.length > 0 ? <li>● Off school: {cell.daysOff.join(', ')}</li> : null}
            {cell.blackouts.length > 0 ? <li className="text-[var(--color-behind)]">Cannot go: {cell.blackouts.join(', ')}</li> : null}
          </ul>
          {children ? <div className="mt-2">{children}</div> : null}
        </div>
      ) : null}

      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
        <a href={QUEUE_TIMES_ATTRIBUTION.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
          {QUEUE_TIMES_ATTRIBUTION.text}
        </a>
        . Weather by Open-Meteo. Park hours from ThemeParks.wiki.
      </p>
    </div>
  )
}

function DayCell({ cell, href, selected }: { cell: CalendarCell; href: string; selected: boolean }) {
  const struck = cell.blackouts.length > 0
  return (
    <Link
      href={href}
      className={`block h-full min-h-16 px-1 py-0.5 text-left ${selected ? 'bg-[var(--color-accent-soft)]' : cell.weekend ? 'bg-[var(--color-surface)]' : ''} ${cell.past ? 'opacity-50' : ''}`}
      aria-label={`${humanDate(cell.date)}${cell.busyness ? `, how busy ${cell.busyness.level}` : ''}${struck ? ', cannot go' : ''}`}
    >
      <span className="flex items-baseline justify-between">
        <span className={`font-medium ${cell.today ? 'rounded-full bg-[var(--color-accent)] px-1 text-white' : ''} ${struck ? 'line-through' : ''}`}>{cell.day}</span>
        <span className="text-[10px] leading-none">
          {cell.holidays.length > 0 ? '★' : ''}
          {cell.daysOff.length > 0 ? '●' : ''}
        </span>
      </span>
      {cell.weather ? (
        <span className="block whitespace-nowrap text-[11px] leading-tight text-[var(--color-ink)]">
          {HORIZON_MARKS[cell.weather.horizon]}
          {cell.weather.highF}°<span className="text-[var(--color-ink-soft)]">/{cell.weather.lowF}°</span>
        </span>
      ) : (
        <span className="block text-[11px] leading-tight text-[var(--color-ink-soft)]">—</span>
      )}
      {cell.busyness ? (
        <>
          <span className="block text-[11px] leading-tight text-[var(--color-ink-soft)]">busy {Math.round(cell.busyness.level)}</span>
          <BusyBar level={cell.busyness.level} />
        </>
      ) : null}
      {cell.earliestClose ? <span className="block text-[10px] leading-tight text-[var(--color-ink-soft)]">⤓{clockWords(cell.earliestClose.closes).replace(':00', '').replace(' ', '')}</span> : null}
    </Link>
  )
}
