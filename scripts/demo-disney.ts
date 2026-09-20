/**
 * Prints the Disney scenario the way the Home / This Week screen will show it.
 * A check against the spreadsheet, runnable any time: npx tsx scripts/demo-disney.ts
 */
import {
  accountViews,
  formatCents,
  packageViews,
  type DerivationInput,
  type LineItem,
} from '../src/domain/index'

const TODAY = '2026-09-19'
const annual = { id: 'a1', householdId: 'h', name: 'Annual Expenses', institutionLabel: '', scope: 'household' as const, ownerUserId: null, active: true }
const longTerm = { id: 'a2', householdId: 'h', name: 'Long Term Savings', institutionLabel: '', scope: 'household' as const, ownerUserId: null, active: true }

const items: LineItem[] = [
  { id: 'i1', packageId: 'p1', label: 'Park tickets', unitAmountCents: 60000, quantity: 3, dueDate: '2027-01-16', reserveAccountId: 'a1', state: 'accruing', recurrence: 'none' },
  { id: 'i2', packageId: 'p1', label: 'Airfare',      unitAmountCents: 45000, quantity: 3, dueDate: '2026-11-21', reserveAccountId: 'a1', state: 'accruing', recurrence: 'none' },
  { id: 'i3', packageId: 'p1', label: 'Lodging',      unitAmountCents: 120000, quantity: 1, dueDate: '2027-01-16', reserveAccountId: 'a2', state: 'accruing', recurrence: 'none' },
  { id: 'i4', packageId: 'p1', label: 'Park food',    unitAmountCents: 9000,  quantity: 5, dueDate: '2027-01-16', reserveAccountId: 'a1', state: 'accruing', recurrence: 'none' },
]

const input: DerivationInput = {
  today: TODAY,
  accounts: [annual, longTerm],
  packages: [{ id: 'p1', householdId: 'h', name: 'Disney Feb 2027', state: 'active', module: 'manual', detail: null, createdAt: TODAY, committedAt: TODAY }],
  lineItems: items,
}

console.log(`\nDisney Feb 2027 — as of ${TODAY}\n${'='.repeat(58)}`)
for (const item of packageViews(input)[0]!.items) {
  console.log(
    `  ${item.lineItem.label.padEnd(14)} ${String(item.lineItem.quantity)} x ${formatCents(item.lineItem.unitAmountCents).padStart(10)}` +
    ` = ${formatCents(item.totalCents).padStart(10)}  due ${item.lineItem.dueDate}  ${formatCents(item.weekly.totalPerWeekCents).padStart(8)}/wk`,
  )
}
const pkg = packageViews(input)[0]!
console.log(`  ${'—'.repeat(54)}`)
console.log(`  ${'Package total'.padEnd(14)} ${formatCents(pkg.totalCents).padStart(27)}  ${formatCents(pkg.weekly.totalPerWeekCents).padStart(19)}/wk`)

console.log(`\nWhat to move each week\n${'='.repeat(58)}`)
for (const view of accountViews(input)) {
  const w = view.weekly
  if (w.totalPerWeekCents === 0) continue
  console.log(`\n  ${view.account.name}: ${formatCents(w.totalPerWeekCents)}/week`)
  console.log(`    ${formatCents(w.ongoingPerWeekCents)} ongoing` +
    w.catchUp.map((g) => ` + ${formatCents(g.perWeekCents)} catch-up until ${g.endDate}`).join(''))
  console.log(`    Should hold today: ${formatCents(view.shouldHaveSavedCents)}   Still to set aside: ${formatCents(view.outstandingCents)}`)
}

console.log(`\n\nPlan change on 2026-10-17: two more travelers (park tickets 3 -> 5)\n${'='.repeat(58)}`)
const edited: DerivationInput = {
  ...input,
  lineItems: items.map((i) => (i.id === 'i1' ? { ...i, quantity: 5 } : i)),
  changes: [
    {
      lineItemId: 'i1',
      occurredAt: '2026-10-17',
      before: { unitAmountCents: 60000, quantity: 3, dueDate: '2027-01-16', reserveAccountId: 'a1' },
      after: { unitAmountCents: 60000, quantity: 5, dueDate: '2027-01-16', reserveAccountId: 'a1' },
    },
  ],
  today: '2026-10-17',
}
for (const view of accountViews(edited)) {
  const w = view.weekly
  if (w.totalPerWeekCents === 0) continue
  console.log(`\n  ${view.account.name}: ${formatCents(w.totalPerWeekCents)}/week`)
  console.log(`    ${formatCents(w.ongoingPerWeekCents)} ongoing` +
    w.catchUp.map((g) => ` + ${formatCents(g.perWeekCents)} catch-up until ${g.endDate}`).join(''))
}
console.log()
