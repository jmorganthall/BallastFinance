import { describe, expect, it } from 'vitest'
import { INTAKE_CONTRACT_VERSION, validateIntake, type IntakeContext } from '../intake'
import type { ReserveAccount } from '../types'

const annual: ReserveAccount = {
  id: 'acct-annual',
  householdId: 'hh-1',
  name: 'Annual Expenses',
  institutionLabel: 'Capital One 360 — Annual Expenses',
  scope: 'household',
  ownerUserId: null,
  active: true,
}

const context: IntakeContext = {
  today: '2026-09-19',
  accounts: [annual],
  packages: [],
}

function intake(over: Record<string, unknown> = {}) {
  return {
    contract_version: INTAKE_CONTRACT_VERSION,
    package: { name: 'Disney Feb 2027', module: 'manual' },
    line_items: [
      {
        label: 'Park tickets',
        unit_amount: '600',
        quantity: 3,
        due_date: '2027-01-16',
        reserve_account: 'Annual Expenses',
      },
    ],
    ...over,
  }
}

describe('a valid intake', () => {
  it('normalises amounts to cents and resolves the account by name', () => {
    const result = validateIntake(intake(), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.name).toBe('Disney Feb 2027')
    expect(result.value.lineItems).toEqual([
      {
        label: 'Park tickets',
        unitAmountCents: 60000,
        quantity: 3,
        dueDate: '2027-01-16',
        reserveAccountId: 'acct-annual',
        recurrence: null,
      },
    ])
  })

  it('carries a recurrence when the producer sends one', () => {
    const result = validateIntake(
      intake({
        line_items: [{ ...intake().line_items[0], recurrence: { every: 3, unit: 'week' } }],
      }),
      context,
    )
    expect(result.ok && result.value.lineItems[0]!.recurrence).toEqual({ every: 3, unit: 'week' })
  })

  it('still understands the fixed names the first version used', () => {
    const result = validateIntake(
      intake({ line_items: [{ ...intake().line_items[0], recurrence: 'annual' }] }),
      context,
    )
    expect(result.ok && result.value.lineItems[0]!.recurrence).toEqual({ every: 1, unit: 'year' })
  })

  it('rolls a recurring item entered with a past date to its next occurrence', () => {
    // "The insurance renews every September; the last one was 2025." Not an
    // error, a series -- the next one is the plan.
    const result = validateIntake(
      intake({
        line_items: [{ ...intake().line_items[0], due_date: '2025-09-01', recurrence: 'annual' }],
      }),
      context,
    )
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.lineItems[0]!.dueDate).toBe('2027-09-01')
  })

  it('refuses an unknown recurrence rather than guessing', () => {
    const result = validateIntake(
      intake({ line_items: [{ ...intake().line_items[0], recurrence: 'fortnightly' }] }),
      context,
    )
    expect(result.ok).toBe(false)
  })

  it('always lands in simulated state -- commit is a separate action', () => {
    const result = validateIntake(intake(), context)
    expect(result.ok && result.value.state).toBe('simulated')
  })

  it('resolves an account by id as well as by name', () => {
    const result = validateIntake(
      intake({
        line_items: [
          { label: 'x', unit_amount: 100, due_date: '2027-01-16', reserve_account: 'acct-annual', quantity: 1 },
        ],
      }),
      context,
    )
    expect(result.ok && result.value.lineItems[0]!.reserveAccountId).toBe('acct-annual')
  })

  it('defaults quantity to one', () => {
    const result = validateIntake(
      intake({
        line_items: [
          { label: 'x', unit_amount: '100', due_date: '2027-01-16', reserve_account: 'acct-annual' },
        ],
      }),
      context,
    )
    expect(result.ok && result.value.lineItems[0]!.quantity).toBe(1)
  })

  it('keeps the module detail blob opaque', () => {
    const detail = { travelers: 3, park: 'Magic Kingdom' }
    const result = validateIntake(
      intake({ package: { name: 'Disney', module: 'vacation', detail } }),
      context,
    )
    expect(result.ok && result.value.detail).toEqual(detail)
    expect(result.ok && result.value.module).toBe('vacation')
  })
})

describe('an intake the engine must refuse', () => {
  it('rejects an unknown contract version loudly rather than guessing', () => {
    const result = validateIntake(intake({ contract_version: '2' }), context)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.path).toBe('contract_version')
    expect(result.problems[0]!.message).toContain('Unsupported intake contract version')
  })

  it('rejects a due date in the past', () => {
    const result = validateIntake(
      intake({
        line_items: [
          { label: 'x', unit_amount: '100', quantity: 1, due_date: '2026-01-01', reserve_account: 'acct-annual' },
        ],
      }),
      context,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.message).toContain('not in the future')
  })

  it('rejects a due date of today -- there is no week left to spread it over', () => {
    const result = validateIntake(
      intake({
        line_items: [
          { label: 'x', unit_amount: '100', quantity: 1, due_date: context.today, reserve_account: 'acct-annual' },
        ],
      }),
      context,
    )
    expect(result.ok).toBe(false)
  })

  it('rejects a zero or negative amount', () => {
    for (const unit_amount of ['0', '-50']) {
      const result = validateIntake(
        intake({
          line_items: [
            { label: 'x', unit_amount, quantity: 1, due_date: '2027-01-16', reserve_account: 'acct-annual' },
          ],
        }),
        context,
      )
      expect(result.ok, `unit_amount ${unit_amount}`).toBe(false)
    }
  })

  it('rejects an account it cannot resolve', () => {
    const result = validateIntake(
      intake({
        line_items: [
          { label: 'x', unit_amount: '100', quantity: 1, due_date: '2027-01-16', reserve_account: 'Vacation Fund' },
        ],
      }),
      context,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.message).toContain('No reserve account matches')
  })

  it('rejects a duplicate package name among non-retired packages', () => {
    const result = validateIntake(intake(), {
      ...context,
      packages: [{ name: 'disney feb 2027', state: 'active' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.path).toBe('package.name')
  })

  it('allows reusing the name of a retired package', () => {
    const result = validateIntake(intake(), {
      ...context,
      packages: [{ name: 'Disney Feb 2027', state: 'retired' }],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a package with no line items', () => {
    const result = validateIntake(intake({ line_items: [] }), context)
    expect(result.ok).toBe(false)
  })

  it('reports every problem at once rather than one per submission', () => {
    const result = validateIntake(
      intake({
        line_items: [
          { label: 'a', unit_amount: 'abc', quantity: 1, due_date: 'nope', reserve_account: 'Missing' },
        ],
      }),
      context,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.length).toBe(3)
    expect(result.problems.map((p) => p.path.split('.').pop()).sort()).toEqual([
      'due_date',
      'reserve_account',
      'unit_amount',
    ])
  })
})
