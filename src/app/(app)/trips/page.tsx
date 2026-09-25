/**
 * Trips (PRD §16): every trip being priced, a new one, and the household's
 * usual figures and home. A trip is a price tag and a due date on its way to
 * becoming a plan; this screen only renders what the engine reads.
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Empty, humanDate, PageHeader, Pill } from '@/components/ui'
import {
  addSchoolDayOffAction,
  createTripAction,
  discardSchoolCalendarAction,
  keepSchoolCalendarAction,
  readSchoolCalendarSourceAction,
  removeSchoolDayOffAction,
  saveBlackoutDatesAction,
  saveHomeAddressAction,
  savePackTemplateAction,
  saveReferencePricesAction,
  saveSchoolCalendarSourcesAction,
  saveWeekSettingsAction,
} from '@/server/actions'
import { readerEnabled } from '@/server/reader'
import {
  dollarsForInput,
  headCount,
  homeIsLocated,
  percentForInput,
  referenceFreshness,
  shortDate,
  sourceName,
  weekdayName,
  type SchoolCalendarSourceKind,
  type SchoolDayOff,
  type Trip,
} from '@/domain'
import { TravelerFields } from './traveler-fields'

export const dynamic = 'force-dynamic'

const input =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const primaryButton = 'w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white'
const secondaryButton = 'w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium'
const sectionTitle = 'mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'
const smallButton = 'rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium'

const SOURCE_KIND_WORDS: Record<SchoolCalendarSourceKind, string> = { ical: 'Calendar feed (.ics)', pdf: 'PDF', page: 'Web page' }

/** Where a day off came from, in a word or two. */
function dayOffSourceName(source: string): string {
  if (source === 'typed') return 'typed'
  if (source === 'ical') return 'from the feed'
  if (source.startsWith('read:')) return 'read from the document'
  return source
}

function bySchoolYear(days: readonly SchoolDayOff[]): { schoolYear: string; days: SchoolDayOff[] }[] {
  const groups = new Map<string, SchoolDayOff[]>()
  for (const d of days) groups.set(d.schoolYear, [...(groups.get(d.schoolYear) ?? []), d])
  return [...groups].map(([schoolYear, list]) => ({ schoolYear, days: list })).sort((a, b) => a.schoolYear.localeCompare(b.schoolYear))
}

function tripStatus(trip: Trip): { tone: 'neutral' | 'accent' | 'ahead'; label: string } {
  if (trip.retiredAt) return { tone: 'neutral', label: 'Put away' }
  if (trip.packageId) return { tone: 'ahead', label: 'A plan now' }
  return { tone: 'accent', label: 'Working it out' }
}

export default async function TripsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>
}) {
  const { error, saved } = await searchParams
  const { engine } = await requireEngine()
  const [trips, prices, home, blackouts, packTemplate, today, daysOff, calendarSources, pendingCalendar, horizonMonths, weekWeights] = await Promise.all([
    engine.listTrips(),
    engine.referencePrices(),
    engine.homeLocation(),
    engine.blackoutDates(),
    engine.packTemplate(),
    Promise.resolve(engine.today()),
    engine.schoolDaysOff(),
    engine.schoolCalendarSources(),
    engine.pendingSchoolCalendar(),
    engine.horizonMonths(),
    engine.weekWeights(),
  ])
  const readerOn = readerEnabled()
  const open = trips.filter((t) => !t.retiredAt)
  const putAway = trips.filter((t) => t.retiredAt)
  const stale = prices.filter((p) => referenceFreshness(p, today).stale)

  return (
    <>
      <PageHeader title="Trips" subtitle="Price a trip, pick a way to do it, and add it to Plans in one tap." />

      {error ? (
        <p className="mb-4 rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">{error}</p>
      ) : saved === 'home' ? (
        <p className="mb-4 rounded-xl bg-[var(--color-ahead-soft)] p-3 text-sm text-[var(--color-ahead)]">
          Home saved{home?.resolvedName ? ` and found on the map: ${home.resolvedName}` : ''}.
        </p>
      ) : saved ? (
        <p className="mb-4 rounded-xl bg-[var(--color-ahead-soft)] p-3 text-sm text-[var(--color-ahead)]">Saved.</p>
      ) : null}

      {open.length === 0 ? (
        <Empty title="No trips yet.">
          <p>Start one below: dates and who is going. Then try a few ways to do it, side by side.</p>
        </Empty>
      ) : (
        <ul className="space-y-3">
          {open.map((trip) => {
            const status = tripStatus(trip)
            const heads = headCount(trip.travelers)
            return (
              <li key={trip.id}>
                <Link href={`/trips/${trip.id}`}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-semibold">{trip.name}</h2>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </div>
                    <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                      {humanDate(trip.startDate)} to {humanDate(trip.endDate)} · {heads.everyone} going
                      {heads.infants > 0 ? ` (${heads.infants} under 3)` : ''}
                    </p>
                  </Card>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      <h2 className={sectionTitle}>New trip</h2>
      <Card>
        <form action={createTripAction} className="space-y-3">
          <label className="block text-sm font-medium">
            What to call it
            <input name="name" required placeholder="Disney, June 2027" className={input} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              First day
              <input name="start_date" type="date" required className={input} />
            </label>
            <label className="block text-sm font-medium">
              Last day
              <input name="end_date" type="date" required className={input} />
            </label>
          </div>
          <TravelerFields />
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              Car, miles per gallon
              <input name="car_mpg" inputMode="numeric" placeholder="25" className={input} />
            </label>
            <label className="block text-sm font-medium">
              Seats
              <input name="car_seats" inputMode="numeric" placeholder="7" className={input} />
            </label>
          </div>
          <p className="text-xs text-[var(--color-ink-soft)]">
            The car is only for pricing the drive. Leave it blank if you would fly.
            {home
              ? homeIsLocated(home)
                ? ` Home is ${home.label}, from the settings below.`
                : ` Home is ${home.label}, but it has not been found on the map yet, so the drive will wait.`
              : ' Set where home is below so the drive can be looked up.'}
          </p>
          <button type="submit" className={primaryButton}>
            Start the trip
          </button>
        </form>
      </Card>

      {putAway.length > 0 ? (
        <>
          <h2 className={sectionTitle}>Put away</h2>
          <ul className="space-y-2">
            {putAway.map((trip) => (
              <li key={trip.id} className="text-sm text-[var(--color-ink-soft)]">
                <Link href={`/trips/${trip.id}`} className="underline underline-offset-4">
                  {trip.name}
                </Link>{' '}
                · {humanDate(trip.startDate)}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 className={sectionTitle}>Where home is</h2>
      <Card>
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          For looking up the drive to Orlando. Type the address; saving finds it on the map once, through the public
          OpenStreetMap service, and keeps the spot. Nothing is sent anywhere except when you press save.
        </p>
        {home ? (
          <p className="mb-3 text-sm">
            {homeIsLocated(home) ? (
              <>
                <strong>{home.address ?? home.label}</strong>
                {home.resolvedName ? (
                  <span className="block text-xs text-[var(--color-ink-soft)]">
                    Found on the map as {home.resolvedName}
                    {home.geocodedOn ? `, ${humanDate(home.geocodedOn)}` : ''}.
                  </span>
                ) : (
                  <span className="block text-xs text-[var(--color-ink-soft)]">Saved as a spot on the map, before addresses were typed here.</span>
                )}
              </>
            ) : (
              <>
                <strong>{home.address ?? home.label}</strong>
                <span className="block text-xs text-[var(--color-behind)]">
                  Not found on the map yet, so the drive cannot be looked up. Check the address and save it again.
                </span>
              </>
            )}
          </p>
        ) : null}
        <form action={saveHomeAddressAction} className="space-y-3">
          <label className="block text-sm font-medium">
            Address
            <input
              name="address"
              required
              defaultValue={home?.address ?? ''}
              placeholder="123 Main St, Springfield, IL 62701"
              autoComplete="street-address"
              className={input}
            />
          </label>
          <button type="submit" className={secondaryButton}>
            Save and find it on the map
          </button>
        </form>
      </Card>

      <h2 className={sectionTitle}>Weeks we cannot go</h2>
      <Card>
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          School terms, work trips, the recital. A trip&apos;s &ldquo;When&rdquo; section flags any week that runs into
          one of these. Leave a row blank to drop it.
        </p>
        <form action={saveBlackoutDatesAction} className="space-y-2">
          {[...blackouts, { from: '', to: '', label: '' }, { from: '', to: '', label: '' }].map((b, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr] gap-2">
              <label className="block text-xs text-[var(--color-ink-soft)]">
                From
                <input name="blackout_from" type="date" defaultValue={b.from} className={input} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                To
                <input name="blackout_to" type="date" defaultValue={b.to} className={input} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                What
                <input name="blackout_label" defaultValue={b.label} placeholder="School term" className={input} />
              </label>
            </div>
          ))}
          <button type="submit" className={secondaryButton}>
            Save these weeks
          </button>
        </form>
      </Card>

      <h2 id="school" className={sectionTitle}>
        School calendar
      </h2>
      {pendingCalendar ? (
        <Card className="mb-3 bg-[var(--color-accent-soft)]">
          <h3 className="font-semibold">Days off school, as {pendingCalendar.label} lists them</h3>
          <p className="mt-1 text-sm">
            {pendingCalendar.items.length} {pendingCalendar.items.length === 1 ? 'day' : 'days'}
            {pendingCalendar.schoolYear ? ` for ${pendingCalendar.schoolYear}` : ''}, {dayOffSourceName(pendingCalendar.source)} on{' '}
            {humanDate(pendingCalendar.readOn)}. Look them over; nothing is a day off until you keep
            them.
            {pendingCalendar.source.startsWith('read:') ? ' The reader can misread a table, so check the dates against the document.' : ''}
          </p>
          <ul className="mt-2 max-h-64 overflow-y-auto text-xs text-[var(--color-ink-soft)]">
            {pendingCalendar.items.map((d) => (
              <li key={`${d.date}|${d.label}`}>
                {weekdayName(d.date).slice(0, 3)} {shortDate(d.date)}, {d.date.slice(0, 4)} · {d.label}
              </li>
            ))}
            {pendingCalendar.notes.map((n) => (
              <li key={n} className="mt-1 italic">
                {n}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <form action={keepSchoolCalendarAction} className="flex-1">
              <button type="submit" className={primaryButton}>
                Keep these
              </button>
            </form>
            <form action={discardSchoolCalendarAction} className="flex-1">
              <button type="submit" className={secondaryButton}>
                Not now
              </button>
            </form>
          </div>
        </Card>
      ) : null}
      <Card>
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          Days off school make long weekends, and a trip on a school day is a day missed. The best-weeks list on each trip
          uses both. Type the days, or point at the district&apos;s calendar below and read it in.
        </p>
        {daysOff.length === 0 ? (
          <p className="mb-3 text-sm text-[var(--color-ink-soft)]">
            No days off yet, so every weekday counts as school. Federal holidays are already known.
          </p>
        ) : (
          bySchoolYear(daysOff).map((group) => (
            <div key={group.schoolYear} className="mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">{group.schoolYear}</h3>
              <ul className="mt-1 divide-y divide-[var(--color-line)]">
                {group.days.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                    <span className="min-w-0">
                      {weekdayName(d.date).slice(0, 3)} {shortDate(d.date)}, {d.date.slice(0, 4)} · {d.label}
                      <span className="block text-xs text-[var(--color-ink-soft)]">{dayOffSourceName(d.source)}</span>
                    </span>
                    <form action={removeSchoolDayOffAction}>
                      <input type="hidden" name="day_off_id" value={d.id} />
                      <button type="submit" className="text-xs text-[var(--color-behind)] underline underline-offset-4">
                        Remove
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        <form action={addSchoolDayOffAction} className="grid grid-cols-[1fr_1.4fr_0.8fr_auto] items-end gap-2">
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Date
            <input name="date" type="date" required className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            What
            <input name="label" required placeholder="Teacher work day" className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            School year
            <input name="school_year" placeholder="2026-27" className={input} />
          </label>
          <button type="submit" className={smallButton}>
            Add
          </button>
        </form>

        <h3 className="mt-5 text-sm font-semibold">Where the calendar is</h3>
        <p className="mb-2 text-xs leading-snug text-[var(--color-ink-soft)]">
          A district&apos;s calendar feed is read straight in. A PDF or a web page has no fixed shape, so those go to the
          reader, which shows you what it found before anything is kept.
          {readerOn
            ? ''
            : ' The reader is off on this machine: add a reader key in the environment to read PDFs and pages.'}
        </p>
        {calendarSources.length > 0 ? (
          <ul className="mb-3 divide-y divide-[var(--color-line)]">
            {calendarSources.map((s, i) => (
              <li key={`${s.url}|${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  {s.label}
                  <span className="block truncate text-xs text-[var(--color-ink-soft)]">
                    {SOURCE_KIND_WORDS[s.kind]} · {s.url}
                  </span>
                </span>
                <form action={readSchoolCalendarSourceAction}>
                  <input type="hidden" name="source_index" value={i} />
                  <button type="submit" className={smallButton} disabled={s.kind !== 'ical' && !readerOn}>
                    Read it
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <form action={saveSchoolCalendarSourcesAction} className="space-y-2">
          {[...calendarSources, { label: '', url: '', kind: 'ical' as SchoolCalendarSourceKind }].map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.6fr_1fr] gap-2">
              <label className="block text-xs text-[var(--color-ink-soft)]">
                Name
                <input name="source_label" defaultValue={s.label} placeholder="District calendar" className={input} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                Link
                <input name="source_url" type="url" defaultValue={s.url} placeholder="https://" className={input} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                Kind
                <select name="source_kind" defaultValue={s.kind} className={input}>
                  {(Object.keys(SOURCE_KIND_WORDS) as SchoolCalendarSourceKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {SOURCE_KIND_WORDS[kind]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
          <button type="submit" className={secondaryButton}>
            Save the calendar links
          </button>
        </form>
      </Card>

      <h2 id="best-weeks" className={sectionTitle}>
        How the best weeks are picked
      </h2>
      <Card>
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          Each trip lists its ten best weeks across the months ahead: every week of the trip&apos;s length, and every long
          weekend a holiday or a day off school makes. Quiet counts most, then cheap, then no school missed; a week you
          cannot go is left out. Change the weights to say what matters more to you.
        </p>
        <form action={saveWeekSettingsAction} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Months ahead
            <input name="horizon_months" inputMode="numeric" defaultValue={horizonMonths} className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Quiet matters
            <input name="weight_busy" inputMode="decimal" defaultValue={weekWeights.busy} className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Cheap matters
            <input name="weight_price" inputMode="decimal" defaultValue={weekWeights.price} className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            School matters
            <input name="weight_school" inputMode="decimal" defaultValue={weekWeights.school} className={input} />
          </label>
          <button type="submit" className={secondaryButton + ' col-span-2 sm:col-span-4'}>
            Save how weeks are picked
          </button>
        </form>
      </Card>

      <h2 className={sectionTitle}>What we always pack</h2>
      <Card>
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          One item a line. Every trip&apos;s to-do list gets these, due the day before it starts. Changing the list
          here reaches a trip when its timeline is rebuilt.
        </p>
        <form action={savePackTemplateAction} className="space-y-2">
          <textarea name="pack_template" rows={Math.max(4, packTemplate.length + 1)} defaultValue={packTemplate.join('\n')} className={input} />
          <button type="submit" className={secondaryButton}>
            Save the packing list
          </button>
        </form>
      </Card>

      <h2 className={sectionTitle}>Our usual figures</h2>
      <Card>
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          Where every new trip&apos;s figures start. Each one has the date it was checked and where; nothing Disney
          sells can be looked up by the app, so these are yours to keep current. Changing a figure marks it checked
          today unless you type a date.
          {stale.length > 0 ? ` ${stale.length} ${stale.length === 1 ? 'is' : 'are'} over six months old.` : ''}
        </p>
        <form action={saveReferencePricesAction} className="space-y-3">
          <ul className="divide-y divide-[var(--color-line)]">
            {prices.map((price) => {
              const fresh = referenceFreshness(price, today)
              return (
                <li key={price.key} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-medium">{price.label}</span>
                    <span className="text-xs text-[var(--color-ink-soft)]">
                      {sourceName(price.sourceUrl)}, {humanDate(price.asOf)}
                      {fresh.stale ? (
                        <>
                          {' '}
                          <Pill tone="caution">over six months old</Pill>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <label className="block text-xs text-[var(--color-ink-soft)]">
                      {price.unit === 'percent' ? 'Percent' : 'Amount'}
                      <input
                        name={`amount_${price.key}`}
                        inputMode="decimal"
                        defaultValue={price.unit === 'percent' ? percentForInput(price.amountCents) : dollarsForInput(price.amountCents)}
                        className={input}
                      />
                    </label>
                    <label className="block text-xs text-[var(--color-ink-soft)]">
                      Checked on
                      <input name={`as_of_${price.key}`} type="date" defaultValue={price.asOf} className={input} />
                    </label>
                    <label className="col-span-2 block text-xs text-[var(--color-ink-soft)] sm:col-span-1">
                      Where (link)
                      <input name={`source_${price.key}`} type="url" defaultValue={price.sourceUrl ?? ''} placeholder="Blank if it is our own guess" className={input} />
                    </label>
                  </div>
                </li>
              )
            })}
          </ul>
          <button type="submit" className={secondaryButton}>
            Save the usual figures
          </button>
        </form>
      </Card>
    </>
  )
}
