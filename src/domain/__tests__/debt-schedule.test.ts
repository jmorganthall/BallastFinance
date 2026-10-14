import { describe, expect, it } from 'vitest'
import { debtWhatIf, payoffSchedule, projectPayoff, type Debt } from '../debt'

// PRD D49 (11): a debt's page draws the projection's own months.

const TODAY = '2026-10-14'
const shield: Debt = {
  id: '0568',
  householdId: 'hh',
  name: 'Shield 0568',
  category: 'consumer',
  balanceCents: 670239,
  balanceAsOf: TODAY,
  aprBasisPoints: 3049,
  promoRules: [{ rateBasisPoints: 0, appliesTo: 'full', untilDate: '2028-01-12', chargedBack: true }],
  minPaymentRule: { type: 'fixed', amountCents: 4000 },
  plannedPaymentCents: 47500,
  fixedPayment: false,
  state: 'open',
  enteredOn: '2026-09-20',
}

describe('payoffSchedule', () => {
  it('is the projection month by month: same months, same interest, ending at nothing', () => {
    const months = payoffSchedule({ debt: shield, today: TODAY })
    const projection = projectPayoff({ debt: shield, today: TODAY })
    expect(months).toHaveLength(projection.months!)
    expect(months.reduce((sum, m) => sum + m.interestCents, 0)).toBe(projection.totalInterestCents)
    expect(months.at(-1)!.balanceAfterCents).toBe(0)
    expect(months[0]!.on).toBe('2026-11-14')
  })

  it('shows the month the deal ends unpaid and charges its interest back', () => {
    const months = payoffSchedule({ debt: shield, today: TODAY })
    const charged = months.filter((m) => m.chargedBackCents > 0)
    expect(charged).toHaveLength(1)
    // The first payment after Jan 12, 2028.
    expect(charged[0]!.on).toBe('2028-01-14')
    // Before it, nothing but deal-rate months at 0%.
    expect(months.slice(0, 14).every((m) => m.interestCents === 0)).toBe(true)
  })

  it('has no months for a debt its payment never pays off: the page says so instead', () => {
    const never = { ...shield, promoRules: [], plannedPaymentCents: null, minPaymentRule: { type: 'fixed' as const, amountCents: 100 } }
    expect(projectPayoff({ debt: never, today: TODAY }).months).toBeNull()
    expect(payoffSchedule({ debt: never, today: TODAY })).toEqual([])
  })
})

describe('debtWhatIf', () => {
  it('a little more a month clears the deal in time and saves what it would have charged back', () => {
    const result = debtWhatIf({ debt: shield, today: TODAY, extraPerMonthCents: 375 })
    // $478.75 a month: 14 x 478.75 = $6,702.50 covers $6,702.39 before the deal ends.
    expect(result.then.totalInterestCents).toBe(0)
    expect(result.interestSavedCents).toBe(result.now.totalInterestCents)
    expect(result.monthsSooner).toBeGreaterThan(0)
  })

  it('a one-off payment comes off today, never more than is owed', () => {
    const result = debtWhatIf({ debt: shield, today: TODAY, onceCents: 10_000_000 })
    expect(result.then.months).toBe(0)
    expect(result.interestSavedCents).toBe(result.now.totalInterestCents)
  })
})
