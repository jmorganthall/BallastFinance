/**
 * Plans as a list: each package with its parts and its total. Nothing here
 * says how a plan stands -- what is set aside, how far along it is, what a
 * week costs. Since D35 every such figure is the one position's
 * (`position.ts`), so a list of plans and the position can never disagree:
 * this only groups parts under their plan and adds up what they cost, which
 * a draft or a finished plan needs too.
 */

import { compareDates, type CivilDate } from './dates'
import type { Cents } from './money'
import { lineItemTotalCents, type LineItem, type Package } from './types'

export interface LineItemView {
  lineItem: LineItem
  totalCents: Cents
  /** Past its due date and not yet confirmed spent -- it keeps nagging (PRD §5). */
  isOverdue: boolean
}

export interface PackageView {
  package: Package
  items: LineItemView[]
  /** What its live parts cost between them. */
  totalCents: Cents
}

export function packageViews(input: {
  today: CivilDate
  packages: readonly Package[]
  lineItems: readonly LineItem[]
}): PackageView[] {
  return input.packages.map((pkg) => {
    const items = input.lineItems
      .filter((li) => li.packageId === pkg.id)
      .map((lineItem) => ({
        lineItem,
        totalCents: lineItemTotalCents(lineItem),
        isOverdue: compareDates(input.today, lineItem.dueDate) > 0 && lineItem.state !== 'retired',
      }))
    return {
      package: pkg,
      items,
      totalCents: items
        .filter((v) => v.lineItem.state !== 'retired')
        .reduce((s, v) => s + v.totalCents, 0),
    }
  })
}
