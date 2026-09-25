/**
 * One trip (PRD §16): dates and who is going, then the ways to do it side by
 * side, each with its price tag and first money due, and each opening to its
 * parts with figure, source and age. "Add to Plans" hands one way to the
 * reservation engine through the intake contract; after that the plan is
 * the truth and the figures here are read-only.
 *
 * Every figure is the derivation module's, through engine.tripView(). This
 * screen renders.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireEngine } from '@/server/session'
import { Card, Hint, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import {
  addTripLineAction,
  addVariantAction,
  checkDriveAction,
  checkGasPriceAction,
  removeTripLineAction,
  removeVariantAction,
  retireTripAction,
  sendToPlansAction,
  updateTripAction,
  updateTripLineAction,
  updateVariantAction,
  useDriveAction,
  useGasPriceAction,
} from '@/server/actions'
import {
  CATEGORY_LABELS,
  describeSource,
  dollarsForInput,
  headCount,
  lineTotalCents,
  referenceFreshness,
  tripNights,
  TRIP_LINE_CATEGORIES,
  type ReserveAccount,
  type TripLine,
  type TripLineCategory,
  type VariantChoices,
} from '@/domain'
import { TravelerFields } from '../traveler-fields'

export const dynamic = 'force-dynamic'

const input =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const primaryButton = 'w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white'
const secondaryButton = 'w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium'
const quietButton = 'text-sm text-[var(--color-behind)] underline underline-offset-4'
const sectionTitle = 'mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'

const CHOICE_WORDS = {
  travel: { drive: 'Drive', fly: 'Fly' },
  lodging: { disney_resort: 'Disney resort', dvc_rental: 'DVC rental', rental: 'House or condo rental' },
  lightningLane: { none: 'No Lightning Lane', multi_pass: 'Multi Pass', premier: 'Premier Pass' },
  dining: { plan: 'Dining plan', out_of_pocket: 'Food out of pocket' },
} as const

const hoursAndMinutes = (minutes: number) => `${Math.floor(minutes / 60)} h ${minutes % 60} min`

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string; saved?: string; drive?: string; gas?: string }>
}) {
  const { id } = await params
  const { error, saved, drive: pendingDrive, gas: pendingGas } = await searchParams
  const { engine } = await requireEngine()
  const view = await engine.tripView(id)
  if (!view) notFound()
  const accounts = await engine.reserveAccountsForViewer()
  const today = engine.today()
  const { trip } = view
  const heads = headCount(trip.travelers)
  const nights = tripNights(trip)
  const editable = !trip.packageId && !trip.retiredAt
  const chosen = view.variants.find((v) => v.id === trip.chosenVariantId) ?? null

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
            {trip.sentOn ? ` on ${humanDate(trip.sentOn)}` : ''}. Changes are made on the plan from here; the figures
            below are what was sent.
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
          {trip.home ? `Home: ${trip.home.label}.` : 'No home set, so the drive cannot be looked up.'}
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
                Changing who is going or the dates re-counts every part. Figures you typed stay as you typed them.
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

      {editable ? (
        <Card className="mb-4">
          <h2 className="font-semibold">Looking things up</h2>
          <p className="mt-1 text-xs leading-snug text-[var(--color-ink-soft)]">
            The two figures the app can fetch, from public services with no account: the drive, and this week&apos;s
            gas price. Nothing Disney sells can be looked up. A figure you type yourself is never overwritten.
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
                <button type="submit" className={secondaryButton} disabled={!trip.home}>
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
                <button type="submit" className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium">
                  Use it
                </button>
              </form>
            </div>
          </div>
        </Card>
      ) : null}

      <h2 className={sectionTitle}>Ways to do it</h2>
      {view.variants.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--color-ink-soft)]">
            None yet. Add one below: drive or fly, where to stay, how many park days. Each gets its own price tag.
          </p>
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {view.variants.map((variant) => {
          const isChosen = variant.id === trip.chosenVariantId
          const grouped = TRIP_LINE_CATEGORIES.map((category) => ({
            category,
            lines: variant.lines.filter((l) => l.category === category),
          })).filter((g) => g.lines.length > 0)
          const unpriced = variant.lines.filter((l) => l.category !== 'promotion' && lineTotalCents(l) === 0).length
          const c = variant.choices
          return (
            <Card key={variant.id} className={isChosen ? 'border-[var(--color-ahead)]' : ''}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold">{variant.name}</h3>
                {isChosen ? <Pill tone="ahead">This is the plan</Pill> : null}
              </div>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                {CHOICE_WORDS.travel[c.travel]} · {CHOICE_WORDS.lodging[c.lodging]} · {CHOICE_WORDS.lightningLane[c.lightningLane]} ·{' '}
                {CHOICE_WORDS.dining[c.dining]} · {c.parkDays} park {c.parkDays === 1 ? 'day' : 'days'}
                {c.promotion ? ` · ${c.promotion.name}` : ''}
              </p>

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
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
                        {CATEGORY_LABELS[group.category]}
                      </h4>
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

              {editable ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium">Change the choices</summary>
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
            </Card>
          )
        })}
      </div>

      {editable ? (
        <>
          <h2 className={sectionTitle}>Another way to do it</h2>
          <Card>
            <form action={addVariantAction} className="space-y-2">
              <input type="hidden" name="trip_id" value={trip.id} />
              <ChoiceFields maxParkDays={nights + 1} />
              <button type="submit" className={primaryButton}>
                Price it
              </button>
            </form>
          </Card>
        </>
      ) : null}
    </>
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
              <button type="submit" className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium">
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
