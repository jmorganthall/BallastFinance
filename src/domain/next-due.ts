/**
 * "The next thing coming out of this plan is due in..." (PRD §9: plain words).
 *
 * The next due part of a plan is the one with the earliest due date that has
 * not been confirmed spent, and that includes one already past its date: it
 * is still the next thing to come out, and it keeps nagging (PRD §5). How far
 * away it is comes back both as a day count, for anything that wants to
 * compare, and as a rough spoken distance ("3 weeks") for the screen, with a
 * weight the screen uses to make the near ones stand out.
 */

import { compareDates, type CivilDate } from './dates'
import type { LineItem } from './types'

export interface NextDue {
  lineItemId: string
  label: string
  dueDate: CivilDate
  /** Calendar days from today; negative once it is overdue. */
  daysAway: number
  /** "3 weeks", "tomorrow", "4 days ago": how a person would say it. */
  distance: string
  urgency: DueUrgency
}

/** How hard the screen should lean on it: inside 30 days, 30 to 60, beyond. */
export type DueUrgency = 'soon' | 'near' | 'far'

export function dueUrgency(daysAway: number): DueUrgency {
  if (daysAway < 30) return 'soon'
  if (daysAway <= 60) return 'near'
  return 'far'
}

/**
 * A rough distance in the largest unit that reads naturally, rounded to the
 * nearest whole one. Days up to a week, weeks up to a month, months up to a
 * year, then years.
 */
export function humanDistance(daysAway: number): string {
  if (daysAway === 0) return 'today'
  if (daysAway === 1) return 'tomorrow'
  if (daysAway === -1) return 'yesterday'
  const away = Math.abs(daysAway)
  const phrase = unitPhrase(away)
  return daysAway > 0 ? `in ${phrase}` : `${phrase} ago`
}

function unitPhrase(days: number): string {
  if (days < 7) return plural(days, 'day')
  if (days < 30) return plural(Math.max(1, Math.round(days / 7)), 'week')
  if (days < 365) return plural(Math.max(1, Math.round(days / 30)), 'month')
  return plural(Math.max(1, Math.round(days / 365)), 'year')
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

export function nextDue(
  items: readonly Pick<LineItem, 'id' | 'label' | 'dueDate' | 'state'>[],
  today: CivilDate,
): NextDue | null {
  let next: Pick<LineItem, 'id' | 'label' | 'dueDate' | 'state'> | null = null
  for (const item of items) {
    if (item.state === 'retired') continue
    if (next === null || compareDates(item.dueDate, next.dueDate) < 0) next = item
  }
  if (next === null) return null
  const daysAway = compareDates(next.dueDate, today)
  return {
    lineItemId: next.id,
    label: next.label,
    dueDate: next.dueDate,
    daysAway,
    distance: humanDistance(daysAway),
    urgency: dueUrgency(daysAway),
  }
}
