/**
 * What could we buy? (PRD §15.)
 *
 * What selling the homes and vehicles would leave, and what house that buys
 * at the payment the household makes now. Every figure comes from the
 * derivation module through engine.nextHome(); this screen only renders.
 *
 * The price box is a GET form, like the lump-sum box on Debts: looking at a
 * house is a what-if, and the URL can be shared.
 */

import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { Card, Hint, humanDate, Money, PageHeader, Pill } from '@/components/ui'
import {
  createAssetAction,
  linkDebtToAssetAction,
  removeAssetAction,
  saveHomeBuyingAction,
  updateAssetAction,
} from '@/server/actions'
import { dollarsForInput, homeBuyingFormValuesOf, percentForInput, parseAmountOrNull, valueFreshness, type HomeCost } from '@/domain'

export const dynamic = 'force-dynamic'

const rate = (basisPoints: number) => `${(basisPoints / 100).toFixed(2)}%`
const percentBox = percentForInput
const dollarsBox = dollarsForInput

const input =
  'mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]'
const secondaryButton = 'w-full rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium'
const primaryButton = 'w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white'
const sectionTitle = 'mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]'

export default async function EquityPage({
  searchParams,
}: {
  searchParams: Promise<{ price?: string; error?: string; saved?: string }>
}) {
  const { price, error, saved } = await searchParams
  const { engine } = await requireEngine()
  const priceCents = price ? parseAmountOrNull(price) : null
  const view = await engine.nextHome(priceCents)
  const { position, rate: rateUsed, assumptions, mostHouse, atPrice } = view

  const staleValues = position.assets.filter((row) => valueFreshness(row.asset, view.today).stale)
  const securedDebts = view.debts.filter(
    (d) => d.state === 'open' && (d.category === 'mortgage' || d.category === 'auto'),
  )
  const owned = view.assets.filter((a) => a.state === 'owned')
  const sold = view.assets.filter((a) => a.state === 'sold')
  const form = homeBuyingFormValuesOf(assumptions)
  const rateWords = rateUsed
    ? rateUsed.source === 'typed'
      ? `${rate(rateUsed.rateBasisPoints)}, the rate you typed`
      : `${rate(rateUsed.rateBasisPoints)}, this week's average 30-year rate`
    : null

  return (
    <>
      <PageHeader
        title="What could we buy?"
        subtitle="What selling would leave you, and the house that buys at the payment you make now."
      />

      <p className="-mt-3 mb-4 text-sm">
        <Link href="/debts" className="text-[var(--color-accent)] underline underline-offset-4">
          Back to payoff order
        </Link>
      </p>

      {error ? (
        <p className="mb-4 rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">{error}</p>
      ) : saved ? (
        <p className="mb-4 rounded-xl bg-[var(--color-ahead-soft)] p-3 text-sm text-[var(--color-ahead)]">Saved.</p>
      ) : null}

      {position.unlinkedSecuredDebts.length > 0 ? (
        <Card className="mb-4 bg-[var(--color-behind-soft)]">
          <h2 className="font-semibold text-[var(--color-behind)]">
            {position.unlinkedSecuredDebts.length === 1 ? 'A loan is' : 'Some loans are'} not tied to a home or car
          </h2>
          <p className="mt-1 text-sm">
            Until each one is, what you&apos;d walk away with could be too high by as much as its balance. Pick
            what it&apos;s on under <strong>Loans</strong> below.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {position.unlinkedSecuredDebts.map((d) => (
              <li key={d.id}>
                <strong>{d.name}</strong> — <Money cents={d.balanceCents} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mb-4">
        <p className="text-sm text-[var(--color-ink-soft)]">
          <Hint detail="Equity: value, less the cost of selling, less every loan on it. Only homes and cars with something left count; one worth less than its loan is shown but not taken off the others.">
            What you&apos;d walk away with
          </Hint>{' '}
          if you sold
        </p>
        <p className="mt-1 text-3xl font-semibold tracking-tight">
          <Money cents={position.countedCents} />
        </p>

        {mostHouse ? (
          <p className="mt-3 text-base">
            A house up to <strong><Money cents={mostHouse.priceCents} /></strong> keeps your{' '}
            <Hint detail="Principal, interest, property tax, home insurance, mortgage insurance and HOA.">
              full housing payment
            </Hint>{' '}
            at <strong><Money cents={view.targetPaymentCents} /></strong> a month, at {rateWords}.
          </p>
        ) : (
          <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
            {!rateUsed
              ? "There's no mortgage rate yet. The weekly average arrives on its own once the app can reach FRED; until then, type a rate under Your numbers."
              : view.targetPaymentCents <= 0
                ? 'Say what you pay for housing each month under Your numbers, or add your mortgage on the Debts page.'
                : 'Your housing payment does not cover the insurance and HOA on its own, so no price fits it.'}
          </p>
        )}

        {mostHouse ? <CostParts cost={mostHouse} /> : null}

        <p className="mt-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          A planning figure, not a loan approval: a lender also looks at income and your other debts.
          {rateUsed?.source === 'weekly_average' && rateUsed.observedOn
            ? ` The rate is Freddie Mac's national average for the week of ${humanDate(rateUsed.observedOn)}; your own quote may differ.`
            : ''}
        </p>
        {rateUsed?.stale ? (
          <p className="mt-2">
            <Pill tone="caution">The weekly rate has not updated in over two weeks</Pill>
          </p>
        ) : null}
      </Card>

      <Card className="mb-4">
        <form method="GET" className="space-y-3">
          <label className="block text-sm font-medium">
            What would a house at this price cost a month?
            <input name="price" inputMode="decimal" defaultValue={price ?? ''} placeholder="450000" className={input} />
          </label>
          <button type="submit" className={secondaryButton}>
            Work it out
          </button>
        </form>
        {price && priceCents === null ? (
          <p className="mt-3 text-sm text-[var(--color-behind)]">Enter a price like 450,000.</p>
        ) : null}
        {atPrice ? (
          <div className="mt-4 border-t border-[var(--color-line)] pt-4">
            <p className="text-base">
              A <strong><Money cents={atPrice.priceCents} /></strong> house would likely cost{' '}
              <strong><Money cents={atPrice.totalCents} /></strong> a month
              {view.targetPaymentCents > 0 ? (
                <>
                  {' '}— you pay <Money cents={view.targetPaymentCents} /> now.
                </>
              ) : (
                '.'
              )}
            </p>
            <CostParts cost={atPrice} />
          </div>
        ) : price && priceCents !== null && !rateUsed ? (
          <p className="mt-3 text-sm text-[var(--color-ink-soft)]">Needs a mortgage rate first.</p>
        ) : null}
      </Card>

      {staleValues.length > 0 ? (
        <Card className="mb-4 bg-[var(--color-accent-soft)]">
          <h2 className="font-semibold">
            {staleValues.length === 1 ? 'A value' : `${staleValues.length} values`} could do with a fresh look
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Check Zillow or KBB and type the new figure in below; today becomes the date it was checked.
          </p>
        </Card>
      ) : null}

      <h2 className={sectionTitle}>Homes and vehicles</h2>
      <div className="space-y-3">
        {position.assets.map((row) => {
          const freshness = valueFreshness(row.asset, view.today)
          return (
            <Card key={row.asset.id}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{row.asset.name}</span>
                  <Pill>{row.asset.kind === 'home' ? 'Home' : 'Vehicle'}</Pill>
                  {!row.counted ? <Pill tone="behind">Worth less than owed</Pill> : null}
                </span>
                <span className="shrink-0 font-semibold">
                  <Money cents={row.walkAwayCents} />
                </span>
              </div>
              <p className="mt-1 text-xs leading-snug text-[var(--color-ink-soft)]">
                Worth <Money cents={row.asset.valueCents} /> (checked {humanDate(row.asset.valueAsOf)}
                {freshness.stale ? `, ${freshness.ageDays} days ago` : ''}), less{' '}
                <Money cents={row.sellingCostCents} /> to sell, less <Money cents={row.owedCents} /> owed
                {row.debts.length > 0 ? ` on ${row.debts.map((d) => d.name).join(' and ')}` : ''}.
              </p>
              <AssetEditor
                asset={row.asset}
                valueBox={dollarsBox(row.asset.valueCents)}
                sellingBox={percentBox(row.asset.sellingCostBasisPoints)}
              />
            </Card>
          )
        })}

        {sold.map((asset) => (
          <Card key={asset.id} className="opacity-70">
            <span className="font-medium">{asset.name}</span> <Pill>Sold</Pill>
            <AssetEditor asset={asset} valueBox={dollarsBox(asset.valueCents)} sellingBox={percentBox(asset.sellingCostBasisPoints)} />
          </Card>
        ))}

        <Card>
          <details open={view.assets.length === 0}>
            <summary className="cursor-pointer text-sm font-medium">Add a home or vehicle</summary>
            <form action={createAssetAction} className="mt-3 space-y-3">
              <label className="block text-sm font-medium">
                Name
                <input name="name" required placeholder="Our house" className={input} />
              </label>
              <label className="block text-sm font-medium">
                Kind
                <select name="kind" className={input}>
                  <option value="home">Home</option>
                  <option value="vehicle">Vehicle</option>
                </select>
              </label>
              <label className="block text-sm font-medium">
                What it would sell for (from Zillow, KBB or an appraisal)
                <input name="value" required inputMode="decimal" placeholder="425000" className={input} />
              </label>
              <label className="block text-sm font-medium">
                Cost of selling, %
                <input name="selling_cost" inputMode="decimal" placeholder="7 for a home, 0 for a car" className={input} />
                <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
                  Agent and closing costs. Leave blank for 7% on a home and 0% on a vehicle.
                </span>
              </label>
              <button type="submit" className={primaryButton}>
                Add it
              </button>
            </form>
          </details>
        </Card>
      </div>

      {securedDebts.length > 0 ? (
        <>
          <h2 className={sectionTitle}>Loans</h2>
          <Card>
            <ul className="divide-y divide-[var(--color-line)]">
              {securedDebts.map((d) => (
                <li key={d.id} className="py-3 first:pt-0 last:pb-0">
                  <form action={linkDebtToAssetAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="debt_id" value={d.id} />
                    <label className="min-w-0 flex-1 text-sm font-medium">
                      {d.name} (<Money cents={d.balanceCents} />) is on
                      <select name="asset_id" defaultValue={d.assetId ?? ''} className={input}>
                        <option value="">Nothing I own</option>
                        {owned.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className="rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm font-medium">
                      Save
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}

      <h2 className={sectionTitle}>Your numbers</h2>
      <Card>
        <p className="mb-3 text-xs leading-snug text-[var(--color-ink-soft)]">
          Starting figures are estimates. Property tax varies most from place to place and moves the answer
          most, so put in your county&apos;s rate.
        </p>
        <form action={saveHomeBuyingAction} className="space-y-3">
          <label className="block text-sm font-medium">
            What you pay for housing each month now
            <input name="current_payment" inputMode="decimal" defaultValue={form.currentHousingPayment} placeholder={dollarsBox(view.mortgagePaymentsCents)} className={input} />
            <span className="mt-1 block text-xs font-normal text-[var(--color-ink-soft)]">
              Include property tax and insurance. Leave blank to use your mortgage payments on the Debts page (
              <Money cents={view.mortgagePaymentsCents} />) — only right if those already include them.
            </span>
          </label>
          <label className="block text-sm font-medium">
            Mortgage rate, %
            <input name="typed_rate" inputMode="decimal" defaultValue={rateUsed?.source === 'typed' ? percentBox(rateUsed.rateBasisPoints) : ''} placeholder="Blank = this week's average" className={input} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              Property tax, % a year
              <input name="property_tax" inputMode="decimal" defaultValue={form.propertyTaxPercent} className={input} />
            </label>
            <label className="block text-sm font-medium">
              Home insurance, $ a year
              <input name="insurance" inputMode="decimal" defaultValue={form.insurancePerYear} className={input} />
            </label>
            <label className="block text-sm font-medium">
              <Hint detail="PMI: charged while you put down less than 20%.">Mortgage insurance</Hint>, % a year
              <input name="mortgage_insurance" inputMode="decimal" defaultValue={form.mortgageInsurancePercent} className={input} />
            </label>
            <label className="block text-sm font-medium">
              HOA, $ a month
              <input name="hoa" inputMode="decimal" defaultValue={form.hoaPerMonth} className={input} />
            </label>
            <label className="block text-sm font-medium">
              Buying costs, % of price
              <input name="buying_cost" inputMode="decimal" defaultValue={form.buyingCostPercent} className={input} />
            </label>
            <label className="block text-sm font-medium">
              Loan length, years
              <input name="term_years" inputMode="numeric" defaultValue={form.termYears} className={input} />
            </label>
          </div>
          <button type="submit" className={primaryButton}>
            Save my numbers
          </button>
        </form>
      </Card>
    </>
  )
}

/** The parts of a monthly housing payment, and where the down payment came from. */
function CostParts({ cost }: { cost: HomeCost }) {
  const rows: [string, number][] = [
    ['Loan payment', cost.principalAndInterestCents],
    ['Property tax', cost.propertyTaxCents],
    ['Home insurance', cost.insuranceCents],
    ...(cost.mortgageInsuranceCents > 0 ? ([['Mortgage insurance (under 20% down)', cost.mortgageInsuranceCents]] as [string, number][]) : []),
    ...(cost.hoaCents > 0 ? ([['HOA', cost.hoaCents]] as [string, number][]) : []),
  ]
  return (
    <div className="mt-3 text-sm">
      <ul className="divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">
        {rows.map(([label, cents]) => (
          <li key={label} className="flex justify-between px-3 py-2">
            <span>{label}</span>
            <Money cents={cents} />
          </li>
        ))}
        <li className="flex justify-between px-3 py-2 font-semibold">
          <span>A month</span>
          <Money cents={cost.totalCents} />
        </li>
      </ul>
      <p className="mt-2 text-xs leading-snug text-[var(--color-ink-soft)]">
        <Money cents={cost.buyingCostsCents} /> of buying costs come out first, leaving{' '}
        <Money cents={cost.downPaymentCents} /> down ({(cost.downPaymentBasisPoints / 100).toFixed(1)}%) and a{' '}
        <Money cents={cost.loanCents} /> loan.
        {cost.buyingCostsShortCents > 0 ? (
          <>
            {' '}You&apos;d need another <Money cents={cost.buyingCostsShortCents} /> in cash to cover the buying costs.
          </>
        ) : null}
        {cost.leftOverCents > 0 ? (
          <>
            {' '}<Money cents={cost.leftOverCents} /> would be left over.
          </>
        ) : null}
      </p>
    </div>
  )
}

function AssetEditor({
  asset,
  valueBox,
  sellingBox,
}: {
  asset: { id: string; name: string; state: string }
  valueBox: string
  sellingBox: string
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-[var(--color-accent)]">Change</summary>
      <form action={updateAssetAction} className="mt-3 space-y-3">
        <input type="hidden" name="asset_id" value={asset.id} />
        <label className="block text-sm font-medium">
          Name
          <input name="name" defaultValue={asset.name} className={input} />
        </label>
        <label className="block text-sm font-medium">
          What it would sell for
          <input name="value" inputMode="decimal" defaultValue={valueBox} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Cost of selling, %
          <input name="selling_cost" inputMode="decimal" defaultValue={sellingBox} className={input} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="sold" defaultChecked={asset.state === 'sold'} /> We&apos;ve sold it
        </label>
        <button type="submit" className={secondaryButton}>
          Save
        </button>
      </form>
      <form action={removeAssetAction} className="mt-2">
        <input type="hidden" name="asset_id" value={asset.id} />
        <button type="submit" className="w-full rounded-lg px-4 py-2 text-sm text-[var(--color-behind)]">
          Remove — it was added by mistake
        </button>
      </form>
    </details>
  )
}
