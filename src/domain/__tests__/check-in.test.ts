import { describe, expect, it } from 'vitest'
import { balanceField, countsFromForm, ITS_FIELD, itsValue } from '../check-in'

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null

describe('what a balance form records (D57 (1))', () => {
  it('records what was typed, and nothing for an empty box', () => {
    expect(
      countsFromForm({
        accountIds: ['gifts', 'annual'],
        field: form({ [balanceField('gifts')]: '1,070.50', [balanceField('annual')]: '' }),
      }),
    ).toEqual([{ accountId: 'gifts', amountCents: 107050 }])
  })

  it('records exactly the figure "It\'s $X" showed, over anything typed for that account', () => {
    expect(
      countsFromForm({
        accountIds: ['gifts', 'annual'],
        field: form({
          [ITS_FIELD]: itsValue('gifts', 107000),
          [balanceField('gifts')]: '5',
          [balanceField('annual')]: '200',
        }),
      }),
    ).toEqual([
      { accountId: 'gifts', amountCents: 107000 },
      { accountId: 'annual', amountCents: 20000 },
    ])
  })

  it('skips a box that is not an amount, and a button for no account it knows', () => {
    expect(
      countsFromForm({
        accountIds: ['gifts'],
        field: form({ [ITS_FIELD]: 'someone-else:500', [balanceField('gifts')]: 'about a thousand' }),
      }),
    ).toEqual([])
  })
})
