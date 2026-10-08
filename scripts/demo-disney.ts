/**
 * Prints the Disney scenario the way This week shows it, from the one
 * position (PRD D35). A check against the spreadsheet, runnable any time:
 * npx tsx scripts/demo-disney.ts
 */
import { formatCents, position, type LineItem, type PositionInput } from '../src/domain/index'

const TODAY = '2026-09-19'
const annual = { id: 'a1', householdId: 'h', name: 'Annual Expenses', institutionLabel: '', scope: 'household' as const, ownerUserId: null, active: true }
const longTerm = { id: 'a2', householdId: 'h', name: 'Long Term Savings', institutionLabel: '', scope: 'household' as const, ownerUserId: null, active: true }

const items: LineItem[] = [
  { id: 'i1', packageId: 'p1', label: 'Park tickets', unitAmountCents: 60000, quantity: 3, dueDate: '2027-01-16', reserveAccountId: 'a1', state: 'accruing', recurrence: null, timelineStart: 'commit', timelineStartDate: null },
  { id: 'i2', packageId: 'p1', label: 'Airfare',      unitAmountCents: 45000, quantity: 3, dueDate: '2026-11-21', reserveAccountId: 'a1', state: 'accruing', recurrence: null, timelineStart: 'commit', timelineStartDate: null },
  { id: 'i3', packageId: 'p1', label: 'Lodging',      unitAmountCents: 120000, quantity: 1, dueDate: '2027-01-16', reserveAccountId: 'a2', state: 'accruing', recurrence: null, timelineStart: 'commit', timelineStartDate: null },
  { id: 'i4', packageId: 'p1', label: 'Park food',    unitAmountCents: 9000,  quantity: 5, dueDate: '2027-01-16', reserveAccountId: 'a1', state: 'accruing', recurrence: null, timelineStart: 'commit', timelineStartDate: null },
]

const input: PositionInput = {
  today: TODAY,
  accounts: [annual, longTerm],
  packages: [{ id: 'p1', householdId: 'h', name: 'Disney Feb 2027', state: 'active', module: 'manual', detail: null, createdAt: TODAY, committedAt: TODAY }],
  lineItems: items,
  counts: [
    { accountId: 'a1', amountCents: 0, on: TODAY },
    { accountId: 'a2', amountCents: 0, on: TODAY },
  ],
}

function show(title: string, facts: PositionInput): void {
  const p = position(facts)
  console.log(`\n${title}\n${'='.repeat(58)}`)
  for (const plan of p.plans) {
    for (const part of plan.parts) {
      console.log(
        `  ${part.lineItem.label.padEnd(14)} ${formatCents(part.totalCents).padStart(10)}  due ${part.lineItem.dueDate}` +
          `  ${formatCents(part.steadyPerWeekCents).padStart(8)}/wk steady  ${part.status}`,
      )
    }
  }
  for (const a of p.accounts) {
    if (a.parts.length === 0) continue
    console.log(`\n  ${a.account.name}: needs ${formatCents(a.weeklyCents)}/week (exactly ${formatCents(a.weeklyExactCents)})`)
    console.log(`    steady shares ${formatCents(a.steadyPerWeekCents)}, likely holds ${formatCents(a.money.totalCents)}, looks ahead to ${a.horizon}`)
    if (a.oneTimeMove) console.log(`    and a one-time ${formatCents(a.oneTimeMove.amountCents)} by ${a.oneTimeMove.byDate}`)
  }
  console.log(`\n  All caught up: ${p.allCaughtUp ? 'yes' : 'no'} (${p.todos.length} to-do${p.todos.length === 1 ? '' : 's'})`)
}

show(`Disney Feb 2027 — as of ${TODAY}`, input)

show('Plan change on 2026-10-17: two more travelers (park tickets 3 -> 5)', {
  ...input,
  today: '2026-10-17',
  lineItems: items.map((i) => (i.id === 'i1' ? { ...i, quantity: 5 } : i)),
  transfers: [
    // The amounts the first run asked for, set up at the bank that day.
    { accountId: 'a1', perWeekCents: 21177, confirmedOn: TODAY },
    { accountId: 'a2', perWeekCents: 7059, confirmedOn: TODAY },
  ],
})

// A bill that comes round again (PRD D30, D33): its steady line starts where
// the person says the saving began.
console.log(`\n\nA repeating part, committed ${TODAY}: Progressive $844 every 6 months, next 2027-01-09\n${'='.repeat(58)}`)
for (const timelineStart of ['commit', 'last_occurrence'] as const) {
  const p = position({
    today: TODAY,
    accounts: [annual],
    packages: [{ id: 'p2', householdId: 'h', name: 'Car', state: 'active', module: 'manual', detail: null, createdAt: TODAY, committedAt: TODAY }],
    lineItems: [
      { id: 'i5', packageId: 'p2', label: 'Progressive', unitAmountCents: 84400, quantity: 1, dueDate: '2027-01-09', reserveAccountId: 'a1', state: 'accruing', recurrence: { every: 6, unit: 'month' }, timelineStart, timelineStartDate: null },
    ],
    counts: [{ accountId: 'a1', amountCents: 0, on: TODAY }],
  })
  const part = p.accounts[0]!.parts[0]!
  console.log(
    `  Saving since ${part.savingSince.date} (${part.savingSince.reason.padEnd(15)})` +
      `  ${formatCents(part.steadyPerWeekCents).padStart(8)}/wk steady  saved for ${formatCents(part.savedForCents).padStart(8)}  ${part.status}` +
      `  account needs ${formatCents(p.accounts[0]!.weeklyCents)}/wk`,
  )
}
console.log()
