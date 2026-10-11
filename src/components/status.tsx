/**
 * The words (D35, D38): Ready to spend, On track, Catching up, Short. Every screen that
 * says how a part, a plan or an account stands uses these, with the colour
 * never standing alone -- the word is always printed. The status itself is
 * the position's; this only draws it.
 */

import { Pill } from '@/components/ui'
import {
  ACCOUNT_STATUS_WORDS,
  PART_STATUS_WORDS,
  type AccountStatus,
  type PartStatus,
} from '@/domain'

const PART_TONE = {
  ready_to_spend: 'accent',
  on_track: 'ahead',
  // Catching up is fine by definition -- it will be there on the day (D38 (5)).
  catching_up: 'ahead',
  short: 'behind',
} as const
// Running down is calm amber: not an emergency, but the one thing worth doing (D39).
const ACCOUNT_TONE = {
  on_track: 'ahead',
  running_down: 'caution',
  short: 'behind',
  unconfirmed: 'neutral',
} as const

export function PartStatusPill({ status }: { status: PartStatus }) {
  return <Pill tone={PART_TONE[status]}>{PART_STATUS_WORDS[status]}</Pill>
}

export function AccountStatusPill({ status }: { status: AccountStatus }) {
  return <Pill tone={ACCOUNT_TONE[status]}>{ACCOUNT_STATUS_WORDS[status]}</Pill>
}

/** The fill colour for a part's bar, by its status. */
export const STATUS_FILL: Record<PartStatus, string> = {
  // All the money there, waiting to be spent (D38): the accent blue.
  ready_to_spend: 'var(--color-accent)',
  on_track: 'var(--color-ahead)',
  catching_up: 'var(--color-ahead)',
  short: 'var(--color-behind)',
}
