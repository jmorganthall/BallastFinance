/**
 * One trip (PRD §16, D22): planned here, not only priced. In the PRD's
 * order: when to go (the candidate weeks side by side), how to do it (the
 * ways), what to book and when (the checklist), the days themselves, the
 * reservations, and the money. "Add to Plans" hands one way to the
 * reservation engine through the intake contract; after that the money is
 * read-only and the plan is the truth, while the days, reservations and
 * to-dos go on being planned.
 *
 * Every figure is the derivation module's, through engine.tripView() and
 * engine.tripPlanView(). This screen renders. Each section is a card that
 * folds up with its headline still showing, so a phone reads top to bottom.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { requireEngine } from '@/server/session'
import { Card, Hint, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import {
  addReservationAction,
  addTaskAction,
  addTripLineAction,
  addVariantAction,
  checkCrowdsAction,
  checkDriveAction,
  checkGasPriceAction,
  discardCrowdPullAction,
  keepCrowdPullAction,
  rebuildTimelineAction,
  removeReservationAction,
  removeTaskAction,
  removeTripLineAction,
  removeVariantAction,
  retireTripAction,
  sendToPlansAction,
  toggleTaskAction,
  typeCrowdLevelAction,
  updateReservationAction,
  updateTaskAction,
  updateTripAction,
  updateTripDayAction,
  updateTripLineAction,
  updateVariantAction,
  useDriveAction,
  useGasPriceAction,
  useWeekAction,
} from '@/server/actions'
import {
  CATEGORY_LABELS,
  CROWD_SOURCES,
  CROWD_STALE_AFTER_DAYS,
  crowdFreshness,
  crowdPullSummary,
  crowdWord,
  describeSource,
  dollarsForInput,
  formatCents,
  headCount,
  homeIsLocated,
  lineTotalCents,
  PARK_LABELS,
  referenceFreshness,
  RESERVATION_KIND_LABELS,
  RESERVATION_KINDS,
  reservationCostCents,
  shortDate,
  TASK_KIND_LABELS,
  TASK_KINDS,
  taskBucket,
  THEME_PARKS,
  TRIP_LINE_CATEGORIES,
  TRIP_PARKS,
  tripNights,
  weekdayName,
  type CrowdLevel,
  type DayView,
  type ReserveAccount,
  type TripLine,
  type TripLineCategory,
  type TripReservation,
  type TripTask,
  type VariantChoices,
} from '@/domain'
import { TravelerFields } from '../traveler-fields'

export const dynamic = 'force-dynamic'

const input =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const primaryButton = 'w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white'
const secondaryButton = 'w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium'
const smallButton = 'rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium'
const quietButton = 'text-sm text-[var(--color-behind)] underline underline-offset-4'
const subTitle = 'text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'

const CHOICE_WORDS = {
  travel: { drive: 'Drive', fly: 'Fly' },
  lodging: { disney_resort: 'Disney resort', dvc_rental: 'DVC rental', rental: 'House or condo rental' },
  lightningLane: { none: 'No Lightning Lane', multi_pass: 'Multi Pass', premier: 'Premier Pass' },
  dining: { plan: 'Dining plan', out_of_pocket: 'Food out of pocket' },
} as const

const hoursAndMinutes = (minutes: number) => `${Math.floor(minutes / 60)} h ${minutes % 60} min`

/** Where a crowd level came from, in a word or two. */
function crowdSourceName(source: string): string {
  if (source === 'typed') return 'typed'
  return CROWD_SOURCES.find((s) => s.key === source)?.label ?? source
}

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; saved?: string; drive?: string; gas?: string; crowds?: string }>
}) {
  const { id } = await params
  const { error, saved, drive: pendingDrive, gas: pendingGas } = await searchParams
  const { engine } = await requireEngine()
  const view = await engine.tripView(id)
  if (!view) notFound()
  const plan = (await engine.tripPlanView(id))!
  const accounts = await engine.reserveAccountsForViewer()
  const today = engine.today()
  const { trip } = view
  const heads = headCount(trip.travelers)
  const nights = tripNights(trip)
  const editable = !trip.packageId && !trip.retiredAt
  const planning = !trip.retiredAt
  const chosen = view.variants.find((v) => v.id === trip.chosenVariantId) ?? null
  const followed = plan.variant

  // A looked-up figure waits in the URL until the person accepts it; anything that does not read as one is ignored.
  const driveParts = pendingDrive?.split(':').map(Number) ?? []
  const gasParts = pendingGas?.split(':') ?? []
  const pending = {
    drive: driveParts.length === 2 && driveParts.every((n) => Number.isInteger(n) && n > 0) ? (driveParts as [number, number]) : null,
    gas:
      gasParts.length === 2 && Number.isInteger(Number(gasParts[0])) && Number(gasParts[0]) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(gasParts[1]!)
        ? { centsPerGallon: Number(gasParts[0]), observationDate: gasParts[1]! }
        : null,
  }

  const openTasks = plan.tasks.filter((t) => !t.doneOn)
  const buckets = {
    overdue: plan.tasks.filter((t) => taskBucket(t, today) === 'overdue'),
    this_month: plan.tasks.filter((t) => taskBucket(t, today) === 'this_month'),
    later: plan.tasks.filter((t) => taskBucket(t, today) === 'later'),
    done: plan.tasks.filter((t) => taskBucket(t, today) === 'done'),
  }
  const currentWeek = plan.weeks.find((w) => w.current)
  const lineName = (lineId: string | null) => (lineId ? followed?.lines.find((l) => l.id === lineId)?.label ?? null : null)
  const parkDays = plan.dayViews.filter((d) => THEME_PARKS.includes(d.park)).length
  const withConfirmation = plan.reservations.filter((r) => r.confirmation).length
  const followedPrice = followed ? (view.variants.find((v) => v.id === followed.id)?.price.totalCents ?? null) : null

  return (
    <>
      <PageHeader
        title={trip.name}
        subtitle={`${humanDate(trip.startDate)} to ${humanDate(trip.endDate)} · ${nights} ${nights === 1 ? 'night' : 'nights'} · ${heads.everyone} going`}
      />

      <p className="-mt-3 mb-4 text-sm">
        <Link href="/trips" className="text-[var(--color-accent)] underline underline-offset-4">
          All trips
        </Link>
      </p>

      {error ? (
        <p className="mb-4 rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">{error}</p>
      ) : saved ? (
        <p className="mb-4 rounded-xl bg-[var(--color-ahead-soft)] p-3 text-sm text-[var(--color-ahead)]">Saved.</p>
      ) : null}

      {trip.packageId ? (
        <Card className="mb-4 bg-[var(--color-ahead-soft)]">
          <h2 className="font-semibold text-[var(--color-ahead)]">This is a plan now</h2>
          <p className="mt-1 text-sm">
            {chosen ? `"${chosen.name}"` : 'One way of doing it'} went to Plans
            {trip.sentOn ? ` on ${humanDate(trip.sentOn)}` : ''}. Money changes are made on the plan from here; the
            days, reservations and to-dos below still go on.
          </p>
          <p className="mt-2 text-sm">
            <Link href={`/packages/${trip.packageId}`} className="font-medium text-[var(--color-accent)] underline underline-offset-4">
              Open the plan
            </Link>
          </p>
        </Card>
      ) : trip.retiredAt ? (
        <Card className="mb-4">
          <p className="text-sm">Put away on {humanDate(trip.retiredAt)}. Nothing here changes any more.</p>
        </Card>
      ) : null}

      {pending.drive && editable ? (
        <Card className="mb-4 bg-[var(--color-accent-soft)]">
          <h2 className="font-semibold">The drive, as the route service sees it</h2>
          <p className="mt-1 text-sm">
            About <strong>{pending.drive[0].toLocaleString('en-US')} miles</strong> and{' '}
            <strong>{hoursAndMinutes(pending.drive[1])}</strong> each way from {trip.home?.label ?? 'home'}. Use it?
            {pending.drive[1] > view.maxDriveMinutes ? ' That is more than a day at the wheel, so a hotel on the way will be added.' : ''}
          </p>
          <form action={useDriveAction} className="mt-3 flex gap-2">
            <input type="hidden" name="trip_id" value={trip.id} />
            <input type="hidden" name="miles" value={pending.drive[0]} />
            <input type="hidden" name="minutes" value={pending.drive[1]} />
            <button type="submit" className={primaryButton}>
              Use this drive
            </button>
            <Link href={`/trips/${trip.id}`} className={secondaryButton + ' text-center'}>
              Not now
            </Link>
          </form>
        </Card>
      ) : null}

      {pending.gas && editable ? (
        <Card className="mb-4 bg-[var(--color-accent-soft)]">
          <h2 className="font-semibold">Gas this week</h2>
          <p className="mt-1 text-sm">
            The US average for regular is <strong><Money cents={pending.gas.centsPerGallon} /></strong> a gallon for the week of{' '}
            {humanDate(pending.gas.observationDate)}. Use it?
          </p>
          <form action={useGasPriceAction} className="mt-3 flex gap-2">
            <input type="hidden" name="trip_id" value={trip.id} />
            <input type="hidden" name="dollars_per_gallon" value={dollarsForInput(pending.gas.centsPerGallon)} />
            <input type="hidden" name="observation_date" value={pending.gas.observationDate} />
            <button type="submit" className={primaryButton}>
              Use this price
            </button>
            <Link href={`/trips/${trip.id}`} className={secondaryButton + ' text-center'}>
              Not now
            </Link>
          </form>
        </Card>
      ) : null}

      {plan.pendingPull && planning ? (
        <Card className="mb-4 bg-[var(--color-accent-soft)]">
          <h2 className="font-semibold">How busy, as {plan.pendingPull.label} sees it</h2>
          <p className="mt-1 text-sm">
            {plan.pendingPull.levels.length} park-days read for {plan.pendingPull.months.join(', ')}, fetched{' '}
            {humanDate(plan.pendingPull.fetchedOn)}. Keep them? A level you typed yourself is always shown over these.
          </p>
          <ul className="mt-2 text-xs text-[var(--color-ink-soft)]">
            {crowdPullSummary(plan.pendingPull.levels).map((s) => (
              <li key={s.park}>
                {PARK_LABELS[s.park]}: {s.days} days, {shortDate(s.from)} to {shortDate(s.to)}, how busy {s.lowest} to {s.highest}
              </li>
            ))}
            {plan.pendingPull.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <form action={keepCrowdPullAction} className="flex-1">
              <input type="hidden" name="trip_id" value={trip.id} />
              <button type="submit" className={primaryButton}>
                Keep these
              </button>
            </form>
            <form action={discardCrowdPullAction} className="flex-1">
              <input type="hidden" name="trip_id" value={trip.id} />
              <button type="submit" className={secondaryButton}>
                Not now
              </button>
            </form>
          </div>
        </Card>
      ) : null}

      <Card className="mb-4">
        <p className="text-sm">
          <strong>{trip.travelers.map((t) => t.name).join(', ')}</strong>
          {heads.children > 0 || heads.infants > 0 ? (
            <span className="text-[var(--color-ink-soft)]">
              {' '}
              — {heads.adults} {heads.adults === 1 ? 'adult' : 'adults'}
              {heads.children > 0 ? `, ${heads.children} ${heads.children === 1 ? 'child' : 'children'}` : ''}
              {heads.infants > 0 ? `, ${heads.infants} under 3` : ''}
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
          {trip.car ? `Car: ${trip.car.mpg} mpg, ${trip.car.seats} seats.` : 'No car on this trip.'}{' '}
          {trip.home
            ? homeIsLocated(trip.home)
              ? `Home: ${trip.home.label}.`
              : `Home: ${trip.home.label}, not found on the map yet, so the drive cannot be looked up.`
            : 'No home set, so the drive cannot be looked up.'}
        </p>
        {editable ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">Change the trip</summary>
            <form action={updateTripAction} className="mt-3 space-y-3">
              <input type="hidden" name="trip_id" value={trip.id} />
              <label className="block text-sm font-medium">
                What to call it
                <input name="name" required defaultValue={trip.name} className={input} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium">
                  First day
                  <input name="start_date" type="date" required defaultValue={trip.startDate} className={input} />
                </label>
                <label className="block text-sm font-medium">
                  Last day
                  <input name="end_date" type="date" required defaultValue={trip.endDate} className={input} />
                </label>
              </div>
              <TravelerFields initial={trip.travelers} />
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-medium">
                  Car, miles per gallon
                  <input name="car_mpg" inputMode="numeric" defaultValue={trip.car?.mpg ?? ''} className={input} />
                </label>
                <label className="block text-sm font-medium">
                  Seats
                  <input name="car_seats" inputMode="numeric" defaultValue={trip.car?.seats ?? ''} className={input} />
                </label>
              </div>
              <p className="text-xs text-[var(--color-ink-soft)]">
                Changing who is going or the dates re-counts every part. Figures you typed stay as you typed them; days
                that are still in the trip keep their plans.
              </p>
              <button type="submit" className={secondaryButton}>
                Save the trip
              </button>
            </form>
            <form action={retireTripAction} className="mt-3">
              <input type="hidden" name="trip_id" value={trip.id} />
              <button type="submit" className={quietButton}>
                Put this trip away
              </button>
            </form>
          </details>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------ When */}
      <Section
        id="when"
        title="When"
        headline={
          currentWeek?.crowd.average !== null && currentWeek?.crowd.average !== undefined
            ? `This week: how busy ${currentWeek.crowd.average} on average, ${currentWeek.crowd.worst} at worst`
            : 'No crowd calendar yet for these dates'
        }
      >
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          The same trip a few weeks either side: how busy the parks are on{' '}
          {parkDays > 0 ? 'the park days' : 'each day'}, what it costs, and what it runs into. How busy is 1 (quiet)
          to 10 (packed).
        </p>
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--color-ink-soft)]">
                <th className="py-1 pr-2 font-medium">Week</th>
                <th className="py-1 pr-2 font-medium">How busy</th>
                <th className="py-1 pr-2 font-medium">Price</th>
                <th className="py-1 pr-2 font-medium">Getting there</th>
                <th className="py-1 pr-2 font-medium">Runs into</th>
                <th className="py-1 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {plan.weeks.map((w) => (
                <tr key={w.startDate} className={w.current ? 'bg-[var(--color-accent-soft)]' : ''}>
                  <td className="py-2 pr-2 align-top">
                    {shortDate(w.startDate)} – {shortDate(w.endDate)}
                    <span className="block text-xs text-[var(--color-ink-soft)]">
                      {weekdayName(w.startDate)}s{w.current ? ' · this trip' : w.past ? ' · already gone' : ''}
                    </span>
                  </td>
                  <td className="py-2 pr-2 align-top">
                    {w.crowd.average === null ? (
                      <span className="text-[var(--color-ink-soft)]">no data</span>
                    ) : (
                      <>
                        <strong>{w.crowd.average}</strong> <span className="text-xs text-[var(--color-ink-soft)]">avg</span>, {w.crowd.worst}{' '}
                        <span className="text-xs text-[var(--color-ink-soft)]">worst</span>
                        {w.crowd.daysWithData < w.crowd.parkDays ? (
                          <span className="block text-xs text-[var(--color-caution)]">
                            {w.crowd.daysWithData} of {w.crowd.parkDays} days known
                          </span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="py-2 pr-2 align-top">
                    <Money cents={w.price.totalCents} />
                  </td>
                  <td className="py-2 pr-2 align-top">
                    <Money cents={w.travelCents} />
                  </td>
                  <td className="py-2 pr-2 align-top">
                    {w.blackouts.length > 0 ? <Pill tone="behind">{w.blackouts.join(', ')}</Pill> : <span className="text-[var(--color-ink-soft)]">—</span>}
                  </td>
                  <td className="py-2 align-top">
                    {editable && !w.current && !w.past ? (
                      <form action={useWeekAction}>
                        <input type="hidden" name="trip_id" value={trip.id} />
                        <input type="hidden" name="start_date" value={w.startDate} />
                        <button type="submit" className={smallButton}>
                          Use this week
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
          &ldquo;Use this week&rdquo; moves the whole trip, days and unconfirmed reservations with it. Weeks you cannot go
          are set under Trips.
        </p>
      </Section>

      {/* ------------------------------------------------------------ How */}
      <Section
        id="how"
        title="How"
        headline={
          view.variants.length === 0
            ? 'No way of doing it priced yet'
            : `${view.variants.length} ${view.variants.length === 1 ? 'way' : 'ways'} priced${followed ? ` · to-dos follow "${followed.name}"` : ''}`
        }
      >
        {view.variants.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-soft)]">
            None yet. Add one below: drive or fly, where to stay, how many park days. Each gets its own price tag under Money.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {view.variants.map((variant) => {
              const c = variant.choices
              const isChosen = variant.id === trip.chosenVariantId
              return (
                <li key={variant.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{variant.name}</h3>
                      <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
                        {CHOICE_WORDS.travel[c.travel]} · {CHOICE_WORDS.lodging[c.lodging]} · {CHOICE_WORDS.lightningLane[c.lightningLane]} ·{' '}
                        {CHOICE_WORDS.dining[c.dining]} · {c.parkDays} park {c.parkDays === 1 ? 'day' : 'days'}
                        {c.promotion ? ` · ${c.promotion.name}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <Money cents={variant.price.totalCents} className="font-semibold" />
                      {isChosen ? (
                        <div className="mt-1">
                          <Pill tone="ahead">This is the plan</Pill>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {editable ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-[var(--color-accent)]">Change the choices</summary>
                      <form action={updateVariantAction} className="mt-2 space-y-2">
                        <input type="hidden" name="trip_id" value={trip.id} />
                        <input type="hidden" name="variant_id" value={variant.id} />
                        <ChoiceFields choices={c} name={variant.name} maxParkDays={nights + 1} />
                        <p className="text-xs text-[var(--color-ink-soft)]">
                          The parts are re-listed for the new choices. Figures you typed stay; parts you added stay.
                        </p>
                        <button type="submit" className={secondaryButton}>
                          Save the choices
                        </button>
                      </form>
                      <form action={removeVariantAction} className="mt-3">
                        <input type="hidden" name="trip_id" value={trip.id} />
                        <input type="hidden" name="variant_id" value={variant.id} />
                        <button type="submit" className={quietButton}>
                          Take this way off
                        </button>
                      </form>
                    </details>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        {editable ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">Another way to do it</summary>
            <form action={addVariantAction} className="mt-2 space-y-2">
              <input type="hidden" name="trip_id" value={trip.id} />
              <ChoiceFields maxParkDays={nights + 1} />
              <button type="submit" className={primaryButton}>
                Price it
              </button>
            </form>
          </details>
        ) : null}
      </Section>

      {/* ------------------------------------------------------------ What to book, and when */}
      <Section
        id="to-do"
        title="What to book, and when"
        headline={
          openTasks.length === 0
            ? plan.tasks.length === 0
              ? 'Nothing yet'
              : 'All done'
            : [
                buckets.overdue.length > 0 ? `${buckets.overdue.length} overdue` : null,
                buckets.this_month.length > 0 ? `${buckets.this_month.length} this month` : null,
                buckets.later.length > 0 ? `${buckets.later.length} later` : null,
              ]
                .filter(Boolean)
                .join(', ')
        }
      >
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          When Disney opens each thing, and when the money is due, for the way the plan follows
          {followed ? ` ("${followed.name}")` : ''}. Edit a to-do and it is yours; a rebuild leaves it alone.
        </p>
        {(['overdue', 'this_month', 'later', 'done'] as const).map((bucket) => {
          const tasks = buckets[bucket]
          if (tasks.length === 0) return null
          const title = { overdue: 'Overdue', this_month: 'This month', later: 'Later', done: 'Done' }[bucket]
          return (
            <div key={bucket} className="mb-4 last:mb-0">
              <h3 className={subTitle}>{title}</h3>
              <ul className="mt-1 divide-y divide-[var(--color-line)]">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} tripId={trip.id} editable={planning} lineName={lineName(task.lineId)} lines={followed?.lines ?? []} overdue={bucket === 'overdue'} />
                ))}
              </ul>
            </div>
          )
        })}
        {planning ? (
          <div className="mt-4 space-y-3">
            <details>
              <summary className="cursor-pointer text-sm font-medium">Add a to-do</summary>
              <form action={addTaskAction} className="mt-2 space-y-2">
                <input type="hidden" name="trip_id" value={trip.id} />
                <label className="block text-xs text-[var(--color-ink-soft)]">
                  What
                  <input name="label" required placeholder="Book the airport parking" className={input} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    Kind
                    <select name="kind" defaultValue="do" className={input}>
                      {TASK_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {TASK_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    By
                    <input name="due_on" type="date" required defaultValue={trip.startDate} className={input} />
                  </label>
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    Link (optional)
                    <input name="link" type="url" placeholder="https://" className={input} />
                  </label>
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    Part of the trip
                    <select name="line_id" defaultValue="" className={input}>
                      <option value="">None</option>
                      {(followed?.lines ?? []).map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button type="submit" className={secondaryButton}>
                  Add it
                </button>
              </form>
            </details>
            <form action={rebuildTimelineAction}>
              <input type="hidden" name="trip_id" value={trip.id} />
              <button type="submit" className={secondaryButton}>
                Rebuild the timeline
              </button>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                Re-dates the to-dos the app made from the trip&apos;s dates and choices, and the packing list under Trips.
                Anything you edited or ticked stays as it is.
              </p>
            </form>
          </div>
        ) : null}
      </Section>

      {/* ------------------------------------------------------------ The days */}
      <Section
        id="days"
        title="The days"
        headline={`${plan.dayViews.length} ${plan.dayViews.length === 1 ? 'day' : 'days'}, ${parkDays} in the parks`}
      >
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <p className="text-xs leading-snug text-[var(--color-ink-soft)]">
            Which park, rope drop or a lie-in, and what is booked that day. How busy comes from a public crowd calendar
            (1 quiet to 10 packed), fetched only when you ask, shown before it is kept, and never over a level you typed.
            A level over {CROWD_STALE_AFTER_DAYS} days old is marked.
          </p>
          {planning ? (
            <form action={checkCrowdsAction} className="shrink-0">
              <input type="hidden" name="trip_id" value={trip.id} />
              <button type="submit" className={smallButton}>
                Check how busy
              </button>
            </form>
          ) : null}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {plan.dayViews.map((d) => (
            <DayCard key={d.date} day={d} tripId={trip.id} today={today} editable={planning} />
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------ Reservations */}
      <Section
        id="reservations"
        title="Reservations"
        headline={
          plan.reservations.length === 0
            ? 'Nothing booked yet'
            : `${plan.reservations.length} booked${withConfirmation > 0 ? `, ${withConfirmation} with a confirmation` : ''}${
                plan.money.uncountedCents > 0 ? ` · ${formatCents(plan.money.uncountedCents)} not in any part of the trip` : ''
              }`
        }
      >
        {plan.reservations.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-soft)]">Tables, Lightning Lanes, flights, the room: each with its confirmation number, by date.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {plan.reservations.map((r) => (
              <ReservationRow key={r.id} reservation={r} tripId={trip.id} editable={planning} lines={followed?.lines ?? []} lineName={lineName(r.lineId)} />
            ))}
          </ul>
        )}
        {plan.money.countedIn.length > 0 || plan.money.uncountedCents > 0 ? (
          <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
            {plan.money.countedIn.map((c) => (
              <span key={c.lineId} className="block">
                <Money cents={c.cents} /> counted in {lineName(c.lineId) ?? 'a part of the trip'}.
              </span>
            ))}
            {plan.money.uncountedCents > 0 ? (
              <span className="block text-[var(--color-caution)]">
                <Money cents={plan.money.uncountedCents} /> of reservations is not counted in any part of the trip. Pick the part each is
                counted in, or add a part under Money.
              </span>
            ) : null}
          </p>
        ) : null}
        {planning ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">Add a reservation</summary>
            <form action={addReservationAction} className="mt-2 space-y-2">
              <input type="hidden" name="trip_id" value={trip.id} />
              <ReservationFields tripStart={trip.startDate} lines={followed?.lines ?? []} />
              <button type="submit" className={secondaryButton}>
                Add it
              </button>
            </form>
          </details>
        ) : null}
      </Section>

      {/* ------------------------------------------------------------ Money */}
      <Section
        id="money"
        title="Money"
        headline={followedPrice !== null && followed ? `${formatCents(followedPrice)} for "${followed.name}"` : 'Nothing priced yet'}
      >
        {editable ? (
          <div className="mb-4 rounded-xl bg-[var(--color-surface)] p-3">
            <h3 className="font-semibold">Looking things up</h3>
            <p className="mt-1 text-xs leading-snug text-[var(--color-ink-soft)]">
              The two money figures the app can fetch, from public services with no account: the drive, and this
              week&apos;s gas price. Nothing Disney sells can be looked up. A figure you type yourself is never overwritten.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-sm">
                  <strong>The drive.</strong>{' '}
                  {view.drive
                    ? `${view.drive.miles.toLocaleString('en-US')} miles, ${hoursAndMinutes(view.drive.minutes)} each way (looked up ${humanDate(view.drive.fetchedOn)}).`
                    : 'Not looked up yet.'}
                </p>
                <form action={checkDriveAction} className="mt-2">
                  <input type="hidden" name="trip_id" value={trip.id} />
                  <button type="submit" className={secondaryButton} disabled={!homeIsLocated(trip.home)}>
                    Check the drive
                  </button>
                </form>
              </div>
              <div>
                <p className="text-sm">
                  <strong>Gas.</strong>{' '}
                  {view.gasPrice ? (
                    <>
                      <Money cents={view.gasPrice.centsPerGallon} /> a gallon, week of {humanDate(view.gasPrice.observationDate)}.
                    </>
                  ) : (
                    'No price yet.'
                  )}
                </p>
                <form action={checkGasPriceAction} className="mt-2">
                  <input type="hidden" name="trip_id" value={trip.id} />
                  <button type="submit" className={secondaryButton}>
                    Check gas price
                  </button>
                </form>
                <form action={useGasPriceAction} className="mt-2 flex items-end gap-2">
                  <input type="hidden" name="trip_id" value={trip.id} />
                  <label className="min-w-0 flex-1 text-xs text-[var(--color-ink-soft)]">
                    Or type a price a gallon
                    <input name="dollars_per_gallon" inputMode="decimal" placeholder="3.05" className={input} />
                  </label>
                  <button type="submit" className={smallButton}>
                    Use it
                  </button>
                </form>
              </div>
            </div>
          </div>
        ) : null}

        {view.variants.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-soft)]">Price a way of doing it under How, and its price tag appears here.</p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          {view.variants.map((variant) => {
            const isChosen = variant.id === trip.chosenVariantId
            const grouped = TRIP_LINE_CATEGORIES.map((category) => ({
              category,
              lines: variant.lines.filter((l) => l.category === category),
            })).filter((g) => g.lines.length > 0)
            const unpriced = variant.lines.filter((l) => l.category !== 'promotion' && lineTotalCents(l) === 0).length
            return (
              <Card key={variant.id} className={isChosen ? 'border-[var(--color-ahead)]' : ''}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold">{variant.name}</h3>
                  {isChosen ? <Pill tone="ahead">This is the plan</Pill> : null}
                </div>

                <p className="mt-3 text-3xl font-semibold tracking-tight">
                  <Money cents={variant.price.totalCents} />
                </p>
                <p className="text-xs text-[var(--color-ink-soft)]">
                  <Money cents={variant.price.partsCents} /> of parts
                  {variant.price.promotionCents < 0 ? (
                    <>
                      , <Money cents={variant.price.promotionCents} /> off
                    </>
                  ) : null}
                  , plus a <Hint detail="A percent of everything else, rounded up to the dollar, for what the list forgot. Set under Our usual figures."><span>cushion</span></Hint> of{' '}
                  <Money cents={variant.price.cushionCents} />.
                  {unpriced > 0 ? ` ${unpriced} ${unpriced === 1 ? 'part still needs' : 'parts still need'} a figure.` : ''}
                </p>
                <p className="mt-2 text-sm">
                  <Hint detail="The earliest due date among parts worth more than the cushion you keep back before sharing anything out (under Settings). Small parts and deals do not set it.">
                    First money due
                  </Hint>
                  : <strong>{humanDate(variant.firstMoneyDue)}</strong>
                </p>

                {editable ? (
                  <form action={sendToPlansAction} className="mt-3 space-y-2">
                    <input type="hidden" name="trip_id" value={trip.id} />
                    <input type="hidden" name="variant_id" value={variant.id} />
                    <label className="block text-xs text-[var(--color-ink-soft)]">
                      Saves into
                      <select name="reserve_account" required className={input} defaultValue="">
                        <option value="" disabled>
                          Pick an account
                        </option>
                        {accounts
                          .filter((a) => a.writable && a.active)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button type="submit" className={primaryButton}>
                      Add to Plans
                    </button>
                    <p className="text-xs text-[var(--color-ink-soft)]">
                      Makes a draft plan you can look over and start saving for. A part with its own account keeps it.
                    </p>
                  </form>
                ) : null}

                <details className="mt-4" open={view.variants.length === 1}>
                  <summary className="cursor-pointer text-sm font-medium">What&apos;s in it</summary>
                  <div className="mt-2 space-y-4">
                    {grouped.map((group) => (
                      <div key={group.category}>
                        <h4 className={subTitle}>{CATEGORY_LABELS[group.category]}</h4>
                        <ul className="mt-1 divide-y divide-[var(--color-line)]">
                          {group.lines.map((line) => (
                            <LineRow key={line.id} line={line} tripId={trip.id} today={today} editable={editable} accounts={accounts} />
                          ))}
                        </ul>
                      </div>
                    ))}
                    {editable ? (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">Add a part</summary>
                        <form action={addTripLineAction} className="mt-2 space-y-2">
                          <input type="hidden" name="trip_id" value={trip.id} />
                          <input type="hidden" name="variant_id" value={variant.id} />
                          <label className="block text-xs text-[var(--color-ink-soft)]">
                            What
                            <input name="label" required placeholder="Stroller rental" className={input} />
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="block text-xs text-[var(--color-ink-soft)]">
                              Part of
                              <select name="category" className={input} defaultValue="souvenirs">
                                {TRIP_LINE_CATEGORIES.map((category) => (
                                  <option key={category} value={category}>
                                    {CATEGORY_LABELS[category]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="block text-xs text-[var(--color-ink-soft)]">
                              Due
                              <input name="due_date" type="date" required defaultValue={trip.startDate} className={input} />
                            </label>
                            <label className="block text-xs text-[var(--color-ink-soft)]">
                              Each
                              <input name="unit_amount" required inputMode="decimal" placeholder="60" className={input} />
                            </label>
                            <label className="block text-xs text-[var(--color-ink-soft)]">
                              How many
                              <input name="quantity" inputMode="numeric" defaultValue={1} className={input} />
                            </label>
                          </div>
                          <button type="submit" className={secondaryButton}>
                            Add it
                          </button>
                        </form>
                      </details>
                    ) : null}
                  </div>
                </details>
              </Card>
            )
          })}
        </div>
      </Section>
    </>
  )
}

/** A section of the trip that folds up on a phone with its headline still showing. */
function Section({ id, title, headline, children }: { id: string; title: string; headline: string; children: ReactNode }) {
  return (
    <details id={id} open className="mb-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)]">
      <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <span className="min-w-0 truncate text-right text-sm text-[var(--color-ink-soft)]">{headline}</span>
        </div>
      </summary>
      <div className="border-t border-[var(--color-line)] px-4 pb-4 pt-3">{children}</div>
    </details>
  )
}

function TaskRow({
  task,
  tripId,
  editable,
  lineName,
  lines,
  overdue,
}: {
  task: TripTask
  tripId: string
  editable: boolean
  lineName: string | null
  lines: TripLine[]
  overdue: boolean
}) {
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        {editable ? (
          <form action={toggleTaskAction} className="shrink-0">
            <input type="hidden" name="trip_id" value={tripId} />
            <input type="hidden" name="task_id" value={task.id} />
            <input type="hidden" name="done" value={task.doneOn ? '1' : '0'} />
            <button
              type="submit"
              aria-label={task.doneOn ? 'Not done after all' : 'Done'}
              className={`mt-0.5 h-6 w-6 rounded-md border text-xs ${task.doneOn ? 'border-[var(--color-ahead)] bg-[var(--color-ahead-soft)] text-[var(--color-ahead)]' : 'border-[var(--color-line)]'}`}
            >
              {task.doneOn ? '✓' : ''}
            </button>
          </form>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${task.doneOn ? 'text-[var(--color-ink-soft)] line-through' : ''}`}>
            <span className="mr-1.5 text-xs text-[var(--color-ink-soft)]">{TASK_KIND_LABELS[task.kind]}</span>
            {task.label}
          </p>
          <p className="text-xs text-[var(--color-ink-soft)]">
            {task.doneOn ? `Done ${humanDate(task.doneOn)} · was due ` : overdue ? 'Was due ' : 'By '}
            <span className={overdue && !task.doneOn ? 'text-[var(--color-behind)]' : ''}>{humanDate(task.dueOn)}</span>
            {lineName ? ` · ${lineName}` : ''}
            {task.link ? (
              <>
                {' '}
                ·{' '}
                <a href={task.link} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline underline-offset-4">
                  open the link
                </a>
              </>
            ) : null}
            {!task.generated ? ' · yours' : ''}
          </p>
          {editable ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-[var(--color-accent)]">Change</summary>
              <form action={updateTaskAction} className="mt-2 space-y-2">
                <input type="hidden" name="trip_id" value={tripId} />
                <input type="hidden" name="task_id" value={task.id} />
                <label className="block text-xs text-[var(--color-ink-soft)]">
                  What
                  <input name="label" required defaultValue={task.label} className={input} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    Kind
                    <select name="kind" defaultValue={task.kind} className={input}>
                      {TASK_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {TASK_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    By
                    <input name="due_on" type="date" defaultValue={task.dueOn} className={input} />
                  </label>
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    Link
                    <input name="link" type="url" defaultValue={task.link ?? ''} className={input} />
                  </label>
                  <label className="block text-xs text-[var(--color-ink-soft)]">
                    Part of the trip
                    <select name="line_id" defaultValue={task.lineId ?? ''} className={input}>
                      <option value="">None</option>
                      {lines.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <button type="submit" className={smallButton}>
                    Save
                  </button>
                </div>
              </form>
              <form action={removeTaskAction} className="mt-2">
                <input type="hidden" name="trip_id" value={tripId} />
                <input type="hidden" name="task_id" value={task.id} />
                <button type="submit" className="text-xs text-[var(--color-behind)] underline underline-offset-4">
                  Take this off
                </button>
              </form>
            </details>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function CrowdMark({ level, today }: { level: CrowdLevel; today: string }) {
  const fresh = crowdFreshness(level, today)
  return (
    <span className="text-xs text-[var(--color-ink-soft)]">
      {crowdSourceName(level.source)}
      {level.source === 'typed' ? '' : `, ${humanDate(level.fetchedOn)}`}
      {fresh.stale ? (
        <>
          {' '}
          <Pill tone="caution">over a month old</Pill>
        </>
      ) : null}
    </span>
  )
}

function DayCard({ day, tripId, today, editable }: { day: DayView; tripId: string; today: string; editable: boolean }) {
  const inPark = THEME_PARKS.includes(day.park)
  const levelPark = inPark ? day.park : 'other'
  return (
    <Card>
      <div id={`day-${day.day?.id ?? day.date}`} className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">
          {weekdayName(day.date)} <span className="font-normal text-[var(--color-ink-soft)]">{shortDate(day.date)}</span>
        </h3>
        <span className="text-sm">{PARK_LABELS[day.park]}</span>
      </div>

      <p className="mt-2 text-sm">
        {day.level ? (
          <>
            <strong>How busy: {day.level.level}</strong> <span className="text-[var(--color-ink-soft)]">({crowdWord(day.level.level)})</span>{' '}
            <CrowdMark level={day.level} today={today} />
          </>
        ) : day.resortLevel !== null ? (
          <>
            <strong>How busy: about {day.resortLevel}</strong>{' '}
            <span className="text-[var(--color-ink-soft)]">across the parks</span>
          </>
        ) : (
          <span className="text-[var(--color-ink-soft)]">How busy: not known yet.</span>
        )}
        {day.quietest && (!inPark || day.quietest.park !== day.park) ? (
          <span className="block text-xs text-[var(--color-ink-soft)]">
            Quietest that day: {PARK_LABELS[day.quietest.park]} ({day.quietest.level}).
          </span>
        ) : null}
      </p>

      {day.reservations.length > 0 ? (
        <ul className="mt-2 text-sm">
          {day.reservations.map((r) => (
            <li key={r.id}>
              <span className="text-[var(--color-ink-soft)]">{r.time ?? 'any time'}</span> · {r.name}
              {r.confirmation ? <span className="text-xs text-[var(--color-ink-soft)]"> · #{r.confirmation}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {editable && day.day ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-[var(--color-accent)]">Plan this day</summary>
          <form action={updateTripDayAction} className="mt-2 space-y-2">
            <input type="hidden" name="trip_id" value={tripId} />
            <input type="hidden" name="day_id" value={day.day.id} />
            <label className="block text-xs text-[var(--color-ink-soft)]">
              Where
              <select name="park" defaultValue={day.day.park} className={input}>
                {TRIP_PARKS.map((p) => (
                  <option key={p} value={p}>
                    {PARK_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="rope_drop" defaultChecked={day.day.plan.ropeDrop} />
              Rope drop (be at the gate before it opens)
            </label>
            <label className="block text-xs text-[var(--color-ink-soft)]">
              Notes
              <textarea name="notes" rows={2} defaultValue={day.day.plan.notes} placeholder="Fireworks at 9. Nap after lunch." className={input} />
            </label>
            <button type="submit" className={smallButton}>
              Save the day
            </button>
          </form>
          <form action={typeCrowdLevelAction} className="mt-3 flex items-end gap-2">
            <input type="hidden" name="trip_id" value={tripId} />
            <input type="hidden" name="date" value={day.date} />
            <input type="hidden" name="park" value={levelPark} />
            <label className="min-w-0 flex-1 text-xs text-[var(--color-ink-soft)]">
              Or type how busy {inPark ? PARK_LABELS[day.park] : 'the parks are'} (1 quiet to 10 packed)
              <input name="level" inputMode="numeric" placeholder="6" className={input} />
            </label>
            <button type="submit" className={smallButton}>
              Use it
            </button>
          </form>
        </details>
      ) : null}
    </Card>
  )
}

function ReservationFields({ reservation, tripStart, lines }: { reservation?: TripReservation; tripStart: string; lines: TripLine[] }) {
  return (
    <>
      <label className="block text-xs text-[var(--color-ink-soft)]">
        What
        <input name="name" required defaultValue={reservation?.name ?? ''} placeholder="Chef Mickey's" className={input} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Kind
          <select name="kind" defaultValue={reservation?.kind ?? 'dining'} className={input}>
            {RESERVATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {RESERVATION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Where
          <select name="park" defaultValue={reservation?.park ?? ''} className={input}>
            <option value="">Not in a park</option>
            {TRIP_PARKS.filter((p) => p !== 'rest' && p !== 'travel').map((p) => (
              <option key={p} value={p}>
                {PARK_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Date
          <input name="date" type="date" required defaultValue={reservation?.date ?? tripStart} className={input} />
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Time
          <input name="time" type="time" defaultValue={reservation?.time ?? ''} className={input} />
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Confirmation number
          <input name="confirmation" defaultValue={reservation?.confirmation ?? ''} className={input} />
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          How many people
          <input name="party" inputMode="numeric" defaultValue={reservation?.party ?? 1} className={input} />
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Cost each (optional)
          <input name="per_person" inputMode="decimal" defaultValue={reservation?.perPersonCents != null ? dollarsForInput(reservation.perPersonCents) : ''} placeholder="65" className={input} />
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Counted in
          <select name="line_id" defaultValue={reservation?.lineId ?? ''} className={input}>
            <option value="">No part of the trip yet</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs text-[var(--color-ink-soft)]">
        Note
        <input name="note" defaultValue={reservation?.note ?? ''} placeholder="Ask for a window table" className={input} />
      </label>
    </>
  )
}

function ReservationRow({
  reservation: r,
  tripId,
  editable,
  lines,
  lineName,
}: {
  reservation: TripReservation
  tripId: string
  editable: boolean
  lines: TripLine[]
  lineName: string | null
}) {
  const cost = reservationCostCents(r)
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0">
          <span className="text-[var(--color-ink-soft)]">
            {shortDate(r.date)}
            {r.time ? ` ${r.time}` : ''}
          </span>{' '}
          · {r.name}
        </span>
        {cost > 0 ? (
          <span className="shrink-0 text-right">
            <Money cents={cost} className="font-medium" />
            <span className="block text-xs text-[var(--color-ink-soft)]">{lineName ? `counted in ${lineName}` : 'not counted anywhere'}</span>
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-ink-soft)]">
        {RESERVATION_KIND_LABELS[r.kind]}
        {r.park ? ` · ${PARK_LABELS[r.park]}` : ''}
        {r.party !== 1 ? ` · ${r.party} people` : ''}
        {r.confirmation ? ` · #${r.confirmation}` : ' · no confirmation yet'}
        {r.note ? ` · ${r.note}` : ''}
      </p>
      {editable ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-[var(--color-accent)]">Change</summary>
          <form action={updateReservationAction} className="mt-2 space-y-2">
            <input type="hidden" name="trip_id" value={tripId} />
            <input type="hidden" name="reservation_id" value={r.id} />
            <ReservationFields reservation={r} tripStart={r.date} lines={lines} />
            <div className="flex items-center gap-3">
              <button type="submit" className={smallButton}>
                Save
              </button>
            </div>
          </form>
          <form action={removeReservationAction} className="mt-2">
            <input type="hidden" name="trip_id" value={tripId} />
            <input type="hidden" name="reservation_id" value={r.id} />
            <button type="submit" className="text-xs text-[var(--color-behind)] underline underline-offset-4">
              Take this off
            </button>
          </form>
        </details>
      ) : null}
    </li>
  )
}

function LineRow({
  line,
  tripId,
  today,
  editable,
  accounts,
}: {
  line: TripLine
  tripId: string
  today: string
  editable: boolean
  accounts: (ReserveAccount & { writable: boolean })[]
}) {
  const total = lineTotalCents(line)
  const stale = line.source === 'quote' && referenceFreshness({ asOf: line.asOf }, today).stale
  const account = line.reserveAccountId ? accounts.find((a) => a.id === line.reserveAccountId) : null
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0">
          {line.label}
          {line.quantity !== 1 ? (
            <span className="text-[var(--color-ink-soft)]">
              {' '}
              × {line.quantity}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-medium">
          {total === 0 && line.category !== 'promotion' ? <span className="text-[var(--color-caution)]">needs a figure</span> : <Money cents={total} />}
        </span>
      </div>
      <p className="text-xs text-[var(--color-ink-soft)]">
        {line.quantity !== 1 ? (
          <>
            <Money cents={line.unitAmountCents} /> each,{' '}
          </>
        ) : null}
        {describeSource(line, today)} · due {humanDate(line.dueDate)}
        {account ? ` · from ${account.name}` : ''}
        {stale ? (
          <>
            {' '}
            <Pill tone="caution">over six months old</Pill>
          </>
        ) : null}
        {line.note && !line.note.startsWith('applies:') && !line.note.startsWith('http') ? ` · ${line.note}` : ''}
      </p>
      {editable ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-[var(--color-accent)]">Change</summary>
          <form action={updateTripLineAction} className="mt-2 space-y-2">
            <input type="hidden" name="trip_id" value={tripId} />
            <input type="hidden" name="line_id" value={line.id} />
            <input type="hidden" name="category" value={line.category} />
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-[var(--color-ink-soft)]">
                {line.category === 'promotion' ? 'Off' : 'Each'}
                <input name="unit_amount" inputMode="decimal" defaultValue={dollarsForInput(Math.abs(line.unitAmountCents))} className={input} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                How many
                <input name="quantity" inputMode="numeric" defaultValue={line.quantity} className={input} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                Due
                <input name="due_date" type="date" defaultValue={line.dueDate} className={input} />
              </label>
              <label className="block text-xs text-[var(--color-ink-soft)]">
                From
                <select name="reserve_account" defaultValue={line.reserveAccountId ?? ''} className={input}>
                  <option value="">The trip&apos;s account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {line.category !== 'promotion' ? (
              <label className="block text-xs text-[var(--color-ink-soft)]">
                Note
                <input name="note" defaultValue={line.note ?? ''} placeholder="Where the figure came from" className={input} />
              </label>
            ) : null}
            <div className="flex items-center gap-3">
              <button type="submit" className={smallButton}>
                Save
              </button>
            </div>
          </form>
          <form action={removeTripLineAction} className="mt-2">
            <input type="hidden" name="trip_id" value={tripId} />
            <input type="hidden" name="line_id" value={line.id} />
            <button type="submit" className="text-xs text-[var(--color-behind)] underline underline-offset-4">
              Take this part off
            </button>
          </form>
        </details>
      ) : null}
    </li>
  )
}

/** The choices behind a way of doing it, for adding one or changing one. */
function ChoiceFields({ choices, name, maxParkDays }: { choices?: VariantChoices; name?: string; maxParkDays: number }) {
  const promo = choices?.promotion
  return (
    <>
      <label className="block text-sm font-medium">
        What to call this way
        <input name="name" required defaultValue={name ?? ''} placeholder="Drive and stay at Pop" className={input} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Getting there
          <select name="travel" defaultValue={choices?.travel ?? 'drive'} className={input}>
            <option value="drive">Drive</option>
            <option value="fly">Fly</option>
          </select>
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Where we stay
          <select name="lodging" defaultValue={choices?.lodging ?? 'disney_resort'} className={input}>
            <option value="disney_resort">Disney resort</option>
            <option value="dvc_rental">DVC rental</option>
            <option value="rental">House or condo rental</option>
          </select>
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Lightning Lane
          <select name="lightning_lane" defaultValue={choices?.lightningLane ?? 'none'} className={input}>
            <option value="none">None</option>
            <option value="multi_pass">Multi Pass</option>
            <option value="premier">Premier Pass</option>
          </select>
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Food
          <select name="dining" defaultValue={choices?.dining ?? 'out_of_pocket'} className={input}>
            <option value="out_of_pocket">Out of pocket</option>
            <option value="plan">Dining plan (Disney resort only)</option>
          </select>
        </label>
        <label className="block text-xs text-[var(--color-ink-soft)]">
          Park days
          <input name="park_days" type="number" min={0} max={maxParkDays} defaultValue={choices?.parkDays ?? Math.min(4, maxParkDays)} className={input} />
        </label>
      </div>
      <details open={Boolean(promo)}>
        <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">A deal (optional)</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="col-span-2 block text-xs text-[var(--color-ink-soft)]">
            Name
            <input name="promo_name" defaultValue={promo?.name ?? ''} placeholder="Summer room offer" className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Percent off
            <input name="promo_percent" inputMode="decimal" defaultValue={promo?.percentOffBasisPoints !== undefined ? promo.percentOffBasisPoints / 100 : ''} placeholder="25" className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Or amount off
            <input name="promo_amount" inputMode="decimal" defaultValue={promo?.amountOffCents !== undefined ? dollarsForInput(promo.amountOffCents) : ''} placeholder="500" className={input} />
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Applies to
            <select name="promo_category" defaultValue={promo?.appliesToCategory ?? 'lodging'} className={input}>
              {TRIP_LINE_CATEGORIES.filter((c) => c !== 'promotion' && c !== 'contingency').map((category: TripLineCategory) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-[var(--color-ink-soft)]">
            Book by
            <input name="promo_book_by" type="date" defaultValue={promo?.bookBy ?? ''} className={input} />
          </label>
        </div>
      </details>
    </>
  )
}
