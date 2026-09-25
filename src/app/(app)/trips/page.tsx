/**
 * Trips (PRD §16): every trip being priced, a new one, and the household's
 * usual figures and home. A trip is a price tag and a due date on its way to
 * becoming a plan; this screen only renders what the engine reads.
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Empty, humanDate, PageHeader, Pill } from '@/components/ui'
import { createTripAction, saveHomeLocationAction, saveReferencePricesAction } from '@/server/actions'
import { dollarsForInput, headCount, percentForInput, referenceFreshness, sourceName, type Trip } from '@/domain'
import { TravelerFields } from './traveler-fields'

export const dynamic = 'force-dynamic'

const input =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const primaryButton = 'w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white'
const secondaryButton = 'w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium'
const sectionTitle = 'mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'

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
  const [trips, prices, home, today] = await Promise.all([
    engine.listTrips(),
    engine.referencePrices(),
    engine.homeLocation(),
    Promise.resolve(engine.today()),
  ])
  const open = trips.filter((t) => !t.retiredAt)
  const putAway = trips.filter((t) => t.retiredAt)
  const stale = prices.filter((p) => referenceFreshness(p, today).stale)

  return (
    <>
      <PageHeader title="Trips" subtitle="Price a trip, pick a way to do it, and add it to Plans in one tap." />

      {error ? (
        <p className="mb-4 rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">{error}</p>
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
            {home ? ` Home is ${home.label}, from the settings below.` : ' Set where home is below so the drive can be looked up.'}
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
          For looking up the drive to Orlando. Latitude and longitude from a map app (right-click your house); nothing
          here is sent anywhere but the public route service, and only when you press &ldquo;Check the drive&rdquo;.
        </p>
        <form action={saveHomeLocationAction} className="space-y-3">
          <label className="block text-sm font-medium">
            Label
            <input name="label" required defaultValue={home?.label ?? ''} placeholder="Home" className={input} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              Latitude
              <input name="latitude" required inputMode="decimal" defaultValue={home?.latitude ?? ''} placeholder="41.8781" className={input} />
            </label>
            <label className="block text-sm font-medium">
              Longitude
              <input name="longitude" required inputMode="decimal" defaultValue={home?.longitude ?? ''} placeholder="-87.6298" className={input} />
            </label>
          </div>
          <button type="submit" className={secondaryButton}>
            Save home
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
