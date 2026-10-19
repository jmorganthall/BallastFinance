/**
 * The recurring list (PRD §14, D52): what Simplifi says comes round again,
 * and how each row ties back to what Ballast already knows.
 *
 * Simplifi is the source of the list. A person pastes its recurring page as
 * text; `parseSimplifiRecurring` reads it, `diffSimplifiPaste` says what
 * changed since the last paste, and nothing is kept until a person looks.
 * Simplifi's own fields are never edited here: the name is the key that ties
 * a row to the next paste.
 *
 * Ballast is the authority on its own figures. A reserve account, a debt or an
 * income source carries the Simplifi names it is "known as"; a row with one of
 * those names is linked, the figure it stands for is Ballast's (the confirmed
 * weekly transfer, the debt's monthly payment, the take-home), and when
 * Simplifi's differs it is flagged, never corrected.
 *
 * Every figure is amount x frequency. Simplifi's "Yearly" column is not read:
 * in the household's paste a monthly row came to anything from 7 to 14
 * payments a year, so it is not a yearly figure this module can stand behind.
 */

import { assertCivilDate, type CivilDate } from './dates'
import { ceilDiv, parseAmountOrNull, type Cents } from './money'
import type { Id } from './types'

// ---------------------------------------------------------------- frequency

export const FREQUENCIES = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'semiannual',
  'yearly',
] as const
export type Frequency = (typeof FREQUENCIES)[number]

/** How many times a year. A week is 1/52 of a year, as the household's sheet counts it. */
export const PERIODS_PER_YEAR: Record<Frequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  yearly: 1,
}

export const FREQUENCY_WORDS: Record<Frequency, string> = {
  weekly: 'every week',
  biweekly: 'every 2 weeks',
  semimonthly: 'twice a month',
  monthly: 'every month',
  quarterly: 'every 3 months',
  semiannual: 'every 6 months',
  yearly: 'every year',
}

export function isFrequency(value: unknown): value is Frequency {
  return typeof value === 'string' && (FREQUENCIES as readonly string[]).includes(value)
}

/** The amount over a year: exact, because every frequency is a whole number of times a year. */
export function yearlyCents(amountCents: Cents, frequency: Frequency): Cents {
  return amountCents * PERIODS_PER_YEAR[frequency]
}

/**
 * The same money at another frequency. Money going out rounds up and money
 * coming in rounds down, so neither side ever flatters what is left.
 */
export function atFrequency(
  amountCents: Cents,
  from: Frequency,
  to: Frequency,
  direction: Direction,
): Cents {
  const yearly = yearlyCents(amountCents, from)
  const n = PERIODS_PER_YEAR[to]
  return direction === 'out' ? ceilDiv(yearly, n) : Math.floor(yearly / n)
}

/** Read a frequency the way Simplifi writes it ("Every 2 weeks", "Twice a month"), or null. */
export function parseFrequency(text: string): Frequency | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const table: Record<string, Frequency> = {
    'every week': 'weekly',
    weekly: 'weekly',
    'every 1 week': 'weekly',
    'every 2 weeks': 'biweekly',
    'every other week': 'biweekly',
    biweekly: 'biweekly',
    'twice a month': 'semimonthly',
    semimonthly: 'semimonthly',
    'every month': 'monthly',
    'every 1 month': 'monthly',
    monthly: 'monthly',
    'every 3 months': 'quarterly',
    quarterly: 'quarterly',
    'every 6 months': 'semiannual',
    'twice a year': 'semiannual',
    'every year': 'yearly',
    'every 12 months': 'yearly',
    yearly: 'yearly',
    annually: 'yearly',
  }
  return table[t] ?? null
}

// ---------------------------------------------------------------- the paste

export type Direction = 'out' | 'in'

/** One row of Simplifi's recurring list, as pasted. Amounts are positive; `direction` says which way. */
export interface SimplifiRow {
  name: string
  direction: Direction
  amountCents: Cents
  frequency: Frequency
  /** "Next: $361.90 on Nov 5, 2026". Can differ from the usual amount; a card's assumes it is paid in full. */
  nextAmountCents: Cents | null
  nextDate: CivilDate | null
  /** Simplifi's account the money moves through, e.g. "Checking (Joint)". */
  account: string
  /** "Checking", "Credit Card". */
  accountType: string
  category: string
  /** "Bill", "Subscription", "Transfer", "Income". */
  kind: string
}

export interface SimplifiProblem {
  /** The row's name when one was read. */
  name: string | null
  /** 1-based line in the paste. */
  line: number
  message: string
}

export interface SimplifiPaste {
  rows: SimplifiRow[]
  problems: SimplifiProblem[]
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** "Oct 26, 2026" or "October 26, 2026" as a calendar date, or null. */
export function parseSimplifiDate(text: string): CivilDate | null {
  const m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text.trim())
  if (!m) return null
  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()]
  const day = Number(m[2])
  if (!month || day < 1 || day > 31) return null
  const date = `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  try {
    assertCivilDate(date)
  } catch {
    return null
  }
  return date
}

const MONEY_LINE = /^([+-])?\$[\d,]+(?:\.\d{1,2})?$/
const NEXT_LINE = /^Next:\s*([+-]?\$[\d,]+(?:\.\d{1,2})?)\s+on\s+(.+)$/i

function moneyOf(text: string): Cents | null {
  const cents = parseAmountOrNull(text.replace(/^[+-]/, ''))
  return cents === null ? null : Math.abs(cents)
}

/**
 * Read Simplifi's recurring page pasted as text. Each entry is a run of lines:
 *
 *   Streaming Co                  the name
 *   Next: $15.49 on Oct 26, 2026  the next payment
 *   Checking (Joint)              Simplifi's account
 *   Checking                      its type
 *   Entertainment                 the category
 *   Subscription                  Bill / Subscription / Transfer / Income
 *   $15.49                        the usual amount ("+$" is money coming in)
 *   Every month                   how often
 *   $280.67 / Yearly              ignored (see the top of this file)
 *
 * An entry starts at a line followed by "Next:"; lines before the first are
 * the page's own headings and are skipped. A row that cannot be read is a
 * problem with its line, never a guess.
 */
export function parseSimplifiRecurring(text: string): SimplifiPaste {
  const lines = text
    .split(/\r?\n/)
    .map((raw, i) => ({ text: raw.replace(/ /g, ' ').trim(), line: i + 1 }))
    .filter((l) => l.text !== '')

  const starts: number[] = []
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (NEXT_LINE.test(lines[i + 1]!.text) && !NEXT_LINE.test(lines[i]!.text)) starts.push(i)
  }

  const rows: SimplifiRow[] = []
  const problems: SimplifiProblem[] = []
  if (starts.length === 0) {
    problems.push({ name: null, line: 1, message: "Nothing here reads like Simplifi's recurring list." })
    return { rows, problems }
  }

  const seen = new Set<string>()
  starts.forEach((start, n) => {
    const block = lines.slice(start, starts[n + 1] ?? lines.length)
    const name = block[0]!.text
    const at = block[0]!.line
    const problem = (message: string) => problems.push({ name, line: at, message })

    const next = NEXT_LINE.exec(block[1]!.text)!
    const nextAmountCents = moneyOf(next[1]!)
    const nextDate = parseSimplifiDate(next[2]!)

    const amountAt = block.findIndex((l, i) => i >= 2 && MONEY_LINE.test(l.text))
    if (amountAt < 0) return problem(`No amount found for "${name}".`)
    const attrs = block.slice(2, amountAt).map((l) => l.text)
    const amountText = block[amountAt]!.text
    const amountCents = moneyOf(amountText)
    if (amountCents === null) return problem(`"${amountText}" is not an amount.`)
    const frequencyText = block[amountAt + 1]?.text ?? ''
    const frequency = parseFrequency(frequencyText)
    if (!frequency) return problem(`Ballast can't read how often "${frequencyText || '(nothing)'}" is.`)

    const key = simplifiKey(name)
    if (seen.has(key)) return problem(`"${name}" is in the paste twice; only the first is kept.`)
    seen.add(key)

    const kind = attrs.length > 0 ? attrs[attrs.length - 1]! : ''
    rows.push({
      name,
      direction: amountText.startsWith('+') || kind.toLowerCase() === 'income' ? 'in' : 'out',
      amountCents,
      frequency,
      nextAmountCents,
      nextDate,
      account: attrs[0] ?? '',
      accountType: attrs.length >= 3 ? attrs[1]! : '',
      category: attrs.slice(2, -1).join(' / '),
      kind: attrs.length >= 2 ? kind : '',
    })
  })
  return { rows, problems }
}

/** The key a name is matched on: case and spacing do not make two rows different. */
export function simplifiKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

// ---------------------------------------------------------------- the stored list

/** A recurring item as stored: from Simplifi (its fields read-only) or added here. */
export interface RecurringItem extends Omit<SimplifiRow, 'name'> {
  id: Id
  name: string
  source: 'simplifi' | 'manual'
  /** Set once the item is gone: confirmed off a paste, or ended by hand. */
  endedOn: CivilDate | null
}

/** The fields that make a row "changed" in a paste. The next date and amount move every month and are taken quietly. */
const COMPARED = ['direction', 'amountCents', 'frequency', 'account', 'accountType', 'category', 'kind'] as const

export interface PasteChange {
  item: RecurringItem
  row: SimplifiRow
  fields: (typeof COMPARED)[number][]
}

export interface PasteDiff {
  added: SimplifiRow[]
  changed: PasteChange[]
  /** Same as before, apart perhaps from the next date and amount. */
  unchanged: { item: RecurringItem; row: SimplifiRow }[]
  /** Live Simplifi items the paste no longer has: proposed for removal, ended only when a person confirms. */
  gone: RecurringItem[]
}

/** What a paste would change, against the live items that came from Simplifi. Hand-added items are never touched. */
export function diffSimplifiPaste(items: readonly RecurringItem[], rows: readonly SimplifiRow[]): PasteDiff {
  const live = new Map(
    items.filter((i) => i.source === 'simplifi' && i.endedOn === null).map((i) => [simplifiKey(i.name), i]),
  )
  const diff: PasteDiff = { added: [], changed: [], unchanged: [], gone: [] }
  const matched = new Set<string>()
  for (const row of rows) {
    const key = simplifiKey(row.name)
    const item = live.get(key)
    if (!item) {
      diff.added.push(row)
      continue
    }
    matched.add(key)
    const fields = COMPARED.filter((f) => item[f] !== row[f])
    if (fields.length > 0) diff.changed.push({ item, row, fields })
    else diff.unchanged.push({ item, row })
  }
  for (const [key, item] of live) if (!matched.has(key)) diff.gone.push(item)
  return diff
}

// ---------------------------------------------------------------- links

export type LinkKind = 'account' | 'debt' | 'income'

/** Something in Ballast a Simplifi row can be known as. */
export interface SimplifiTarget {
  kind: LinkKind
  id: Id
  name: string
  simplifiNames: readonly string[]
}

export const LINK_KIND_WORDS: Record<LinkKind, string> = {
  account: 'reserve account',
  debt: 'debt',
  income: 'income',
}

/** The target a Simplifi name is known as, if any. */
export function linkFor(name: string, targets: readonly SimplifiTarget[]): SimplifiTarget | null {
  const key = simplifiKey(name)
  return targets.find((t) => t.simplifiNames.some((n) => simplifiKey(n) === key)) ?? null
}

/** An unlinked row whose name is exactly a target's own name: offered first, so existing accounts link in one step. */
export function suggestedLink(name: string, targets: readonly SimplifiTarget[]): SimplifiTarget | null {
  const key = simplifiKey(name)
  return targets.find((t) => simplifiKey(t.name) === key) ?? null
}

/**
 * Tidy a list of Simplifi names a person typed, one per line or comma: blanks
 * and repeats dropped, and refused when another target already has one.
 */
export function cleanSimplifiNames(
  input: readonly string[],
  self: { kind: LinkKind; id: Id },
  targets: readonly SimplifiTarget[],
): { ok: true; names: string[] } | { ok: false; problem: string } {
  const names: string[] = []
  const keys = new Set<string>()
  for (const raw of input) {
    const name = raw.trim().replace(/\s+/g, ' ')
    if (!name || keys.has(simplifiKey(name))) continue
    const other = targets.find(
      (t) => !(t.kind === self.kind && t.id === self.id) && t.simplifiNames.some((n) => simplifiKey(n) === simplifiKey(name)),
    )
    if (other) {
      return { ok: false, problem: `"${name}" is already how Simplifi knows the ${LINK_KIND_WORDS[other.kind]} "${other.name}".` }
    }
    keys.add(simplifiKey(name))
    names.push(name)
  }
  return { ok: true, names }
}

// ---------------------------------------------------------------- the view

/** Ballast's own figure for each target, in its native frequency; null when Ballast has none yet. */
export interface BallastFigures {
  /** The account's confirmed weekly transfer (D35); null while unconfirmed. */
  accountPerWeekCents: ReadonlyMap<Id, Cents | null>
  /** The debt's monthly payment (`monthlyPaymentCents`). */
  debtPerMonthCents: ReadonlyMap<Id, Cents>
  /** The source's take-home per check, at its frequency. */
  incomePerCheck: ReadonlyMap<Id, { cents: Cents; frequency: Frequency }>
}

export interface BallastFigure {
  cents: Cents
  frequency: Frequency
}

export function ballastFigureOf(target: SimplifiTarget, figures: BallastFigures): BallastFigure | null {
  if (target.kind === 'account') {
    const perWeek = figures.accountPerWeekCents.get(target.id)
    return perWeek === null || perWeek === undefined ? null : { cents: perWeek, frequency: 'weekly' }
  }
  if (target.kind === 'debt') {
    const perMonth = figures.debtPerMonthCents.get(target.id)
    return perMonth === undefined ? null : { cents: perMonth, frequency: 'monthly' }
  }
  return figures.incomePerCheck.get(target.id) ?? null
}

export interface RecurringRowView {
  item: RecurringItem
  link: SimplifiTarget | null
  /** An unlinked row whose name is exactly a Ballast account, debt or source. */
  suggestion: SimplifiTarget | null
  /** The item's own amount a month (out rounds up, in rounds down). */
  perMonthCents: Cents
}

/** One linked target with the Simplifi rows known as it, and whether the two agree. */
export interface LinkCheck {
  target: SimplifiTarget
  items: RecurringItem[]
  /** Simplifi's rows added up over a year. */
  simplifiYearlyCents: Cents
  ballast: BallastFigure | null
  ballastYearlyCents: Cents | null
  /** Simplifi says something different from Ballast. Never corrected: Ballast is the authority. */
  differs: boolean
  /** Simplifi's year less Ballast's: above zero when Simplifi says more. Zero when Ballast has no figure. */
  differenceYearlyCents: Cents
}

export interface RecurringView {
  rows: RecurringRowView[]
  checks: LinkCheck[]
  /** Reserve accounts with a confirmed transfer that no live Simplifi row is known as. */
  notInSimplifi: SimplifiTarget[]
  /** Everything going out, a month: Ballast's figure for a linked target, the row's own otherwise. */
  outPerMonthCents: Cents
}

/**
 * The live list, each row with its link, every linked target checked against
 * Simplifi, and the monthly total going out. A target linked by several rows
 * (two paychecks a month for one source) is compared on their sum, and counted
 * once in the total.
 */
export function recurringView(
  items: readonly RecurringItem[],
  targets: readonly SimplifiTarget[],
  figures: BallastFigures,
): RecurringView {
  const live = items.filter((i) => i.endedOn === null)
  const rows: RecurringRowView[] = live.map((item) => {
    const link = item.source === 'simplifi' ? linkFor(item.name, targets) : null
    return {
      item,
      link,
      suggestion: item.source === 'simplifi' && !link ? suggestedLink(item.name, targets) : null,
      perMonthCents: atFrequency(item.amountCents, item.frequency, 'monthly', item.direction),
    }
  })

  const byTarget = new Map<string, { target: SimplifiTarget; items: RecurringItem[] }>()
  for (const row of rows) {
    if (!row.link) continue
    const key = `${row.link.kind}:${row.link.id}`
    const entry = byTarget.get(key) ?? { target: row.link, items: [] }
    entry.items.push(row.item)
    byTarget.set(key, entry)
  }

  const checks: LinkCheck[] = [...byTarget.values()].map(({ target, items: linked }) => {
    const simplifiYearlyCents = linked.reduce((sum, i) => sum + yearlyCents(i.amountCents, i.frequency), 0)
    const ballast = ballastFigureOf(target, figures)
    const ballastYearlyCents = ballast ? yearlyCents(ballast.cents, ballast.frequency) : null
    return {
      target,
      items: linked,
      simplifiYearlyCents,
      ballast,
      ballastYearlyCents,
      differs: ballastYearlyCents !== null && ballastYearlyCents !== simplifiYearlyCents,
      differenceYearlyCents: ballastYearlyCents === null ? 0 : simplifiYearlyCents - ballastYearlyCents,
    }
  })

  const linkedAccounts = new Set(checks.filter((c) => c.target.kind === 'account').map((c) => c.target.id))
  const notInSimplifi = targets.filter(
    (t) => t.kind === 'account' && !linkedAccounts.has(t.id) && (figures.accountPerWeekCents.get(t.id) ?? 0) > 0,
  )

  let outYearly = 0
  for (const row of rows) {
    if (row.item.direction !== 'out' || row.link) continue
    outYearly += yearlyCents(row.item.amountCents, row.item.frequency)
  }
  for (const check of checks) {
    if (check.items.every((i) => i.direction !== 'out')) continue
    outYearly += check.ballastYearlyCents ?? check.simplifiYearlyCents
  }

  return { rows, checks, notInSimplifi, outPerMonthCents: ceilDiv(outYearly, 12) }
}

