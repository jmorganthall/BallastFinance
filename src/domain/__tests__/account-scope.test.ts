import { describe, expect, it } from 'vitest'
import { canWriteAccount, type ReserveAccount } from '../types'
import { INTAKE_CONTRACT_VERSION, validateIntake, type IntakeContext } from '../intake'

const JOSH = 'user-josh'
const SHELBY = 'user-shelby'

function account(over: Partial<ReserveAccount> & Pick<ReserveAccount, 'id' | 'name'>): ReserveAccount {
  return {
    householdId: 'hh',
    institutionLabel: 'Capital One 360',
    scope: 'household',
    ownerUserId: null,
    active: true,
    ...over,
  }
}

describe('who may write to an account', () => {
  it('lets anyone in the household write to a shared account', () => {
    const shared = account({ id: 'a', name: 'Annual Expenses' })
    expect(canWriteAccount(shared, JOSH)).toBe(true)
    expect(canWriteAccount(shared, SHELBY)).toBe(true)
  })

  it('lets only the owner write to an individual account', () => {
    const mine = account({ id: 'b', name: "Josh's fun money", scope: 'individual', ownerUserId: JOSH })
    expect(canWriteAccount(mine, JOSH)).toBe(true)
    expect(canWriteAccount(mine, SHELBY)).toBe(false)
  })

  it('refuses an anonymous writer on an individual account but allows one on a shared account', () => {
    expect(canWriteAccount(account({ id: 'a', name: 'Shared' }), null)).toBe(true)
    expect(
      canWriteAccount(
        account({ id: 'b', name: 'Mine', scope: 'individual', ownerUserId: JOSH }),
        null,
      ),
    ).toBe(false)
  })

  it('says nothing about reading -- both spouses see everything', () => {
    // Deliberately no canReadAccount: the scope is ownership, not secrecy, and a
    // household total that hid an account would be a lie rather than a privacy
    // feature. This test exists so removing that property is a visible choice.
    expect(Object.keys({ canWriteAccount })).toEqual(['canWriteAccount'])
  })
})

describe('intake refuses to fund an account you do not own', () => {
  const shared = account({ id: 'shared', name: 'Annual Expenses' })
  const hers = account({
    id: 'hers',
    name: "Shelby's spending",
    scope: 'individual',
    ownerUserId: SHELBY,
  })

  const context = (actorUserId: string | null): IntakeContext => ({
    today: '2026-09-19',
    accounts: [shared, hers],
    packages: [],
    actorUserId,
  })

  function intake(reserve_account: string) {
    return {
      contract_version: INTAKE_CONTRACT_VERSION,
      package: { name: 'Christmas 2026' },
      line_items: [
        { label: 'Gifts', unit_amount: '400', quantity: 1, due_date: '2026-12-19', reserve_account },
      ],
    }
  }

  it('accepts a shared account from either spouse', () => {
    expect(validateIntake(intake('shared'), context(JOSH)).ok).toBe(true)
    expect(validateIntake(intake('shared'), context(SHELBY)).ok).toBe(true)
  })

  it('accepts an individual account from its owner', () => {
    expect(validateIntake(intake('hers'), context(SHELBY)).ok).toBe(true)
  })

  it('rejects an individual account from the other spouse, at submission', () => {
    const result = validateIntake(intake('hers'), context(JOSH))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]!.path).toBe('line_items.0.reserve_account')
    expect(result.problems[0]!.message).toContain('belongs to someone else')
  })

  it('does not leak the account out of a rejected intake', () => {
    const result = validateIntake(intake('hers'), context(JOSH))
    expect(result.ok).toBe(false)
    // The line item must not survive validation into a package.
    if (!result.ok) expect(result.problems).toHaveLength(1)
  })
})
