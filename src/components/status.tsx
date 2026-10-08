/**
 * The three words (D35): On track, Catching up, Short. Every screen that
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

const PART_TONE = { on_track: 'ahead', catching_up: 'caution', short: 'behind' } as const
const ACCOUNT_TONE = { on_track: 'ahead', short: 'behind', unconfirmed: 'neutral' } as const

export function PartStatusPill({ status }: { status: PartStatus }) {
  return <Pill tone={PART_TONE[status]}>{PART_STATUS_WORDS[status]}</Pill>
}

export function AccountStatusPill({ status }: { status: AccountStatus }) {
  return <Pill tone={ACCOUNT_TONE[status]}>{ACCOUNT_STATUS_WORDS[status]}</Pill>
}

/** The fill colour for a part's bar, by its status. */
export const STATUS_FILL: Record<PartStatus, string> = {
  on_track: 'var(--color-ahead)',
  catching_up: 'var(--color-caution)',
  short: 'var(--color-behind)',
}
