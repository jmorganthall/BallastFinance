/**
 * Bringing in the spreadsheet (temporary).
 *
 * The household's existing sheet has two tabs, and each carries a mix of
 * facts a person typed and figures the sheet worked out from them. Ballast
 * stores facts and computes derivations (PRD §10), so this reads only the raw
 * inputs and names, out loud, every column it throws away. Nothing here
 * writes anything: it turns pasted text into what the engine would be asked
 * to create, plus the problems and the assumptions, for a person to check.
 *
 * Expense tab, as pasted with its header row:
 *   Account | In Simplifi | Expense | Bracket | Due Every | Next Due | Reserved Now | Amount | Monthly | Weekly
 * Debt tab:
 *   Loan | Category | Freed Up | Monthly | APR | % | $ | Principal/Month | Int/Month
 *   | Interest at Min Pmt | Months @ Min | Balance | Limit | Util | As of | Fixed Pmt.
 *   | Long Term | Short Term | Priority
 */

import { assertCivilDate, compareDates, type CivilDate } from './dates'
import type { DebtCategory, MinPaymentRule } from './debt'
import { parseAmountOrNull, parsePercentOrNull, type Cents } from './money'
import { rollToFuture, type Recurrence } from './recurrence'

export interface ImportedExpense {
  row: number
  label: string
  account: string
  amountCents: Cents
  dueDate: CivilDate
  recurrence: Recurrence
  /** "Reserved Now": what is already set aside, which becomes the opening balance. */
  openingCents: Cents
  notes: string[]
}

export interface ImportedDebt {
  row: number
  name: string
  category: DebtCategory
  balanceCents: Cents
  balanceAsOf: CivilDate | null
  aprBasisPoints: number
  minPaymentRule: MinPaymentRule
  creditLimitCents: Cents | null
  notes: string[]
}

export interface SheetProblem {
  row: number
  message: string
}

export interface SheetImport {
  expenses: ImportedExpense[]
  debts: ImportedDebt[]
  problems: SheetProblem[]
  /** Columns present in the paste that Ballast deliberately does not keep. */
  ignoredColumns: string[]
  /** Account names in the expense rows that do not exist yet. */
  accountsToCreate: string[]
}

const EXPENSE_USED = ['account', 'expense', 'due every', 'next due', 'reserved now', 'amount'] as const
const DEBT_USED = ['loan', 'category', 'apr', '%', '$', 'balance', 'limit', 'as of', 'monthly'] as const

function norm(cell: string): string {
  return cell.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Split one line on tabs, or on commas with double-quote fields when there are no tabs. */
function splitLine(line: string, delimiter: '\t' | ','): string[] {
  if (delimiter === '\t') return line.split('\t').map((c) => c.trim())
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current.trim())
  return cells
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/** "2027-02-15", "2/15/2027", "2/15/27", "Feb 15, 2027", "15 Feb 2027" -> a civil date, or null. */
export function parseSheetDate(input: string): CivilDate | null {
  const text = input.trim()
  if (!text) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const finish = (y: number, m: number, d: number): CivilDate | null => {
    const year = y < 100 ? 2000 + y : y
    const candidate = `${year}-${pad(m)}-${pad(d)}`
    try {
      assertCivilDate(candidate)
      return candidate
    } catch {
      return null
    }
  }
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return finish(Number(m[1]), Number(m[2]), Number(m[3]))
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) return finish(Number(m[3]), Number(m[1]), Number(m[2]))
  m = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/)
  if (m) {
    const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()]
    return month ? finish(Number(m[3]), month, Number(m[2])) : null
  }
  m = text.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-](\d{2,4})$/)
  if (m) {
    const month = MONTHS[m[2]!.slice(0, 3).toLowerCase()]
    return month ? finish(Number(m[3]), month, Number(m[1])) : null
  }
  return null
}

/** "Year", "6 months", "Quarterly", "Once" -> a recurrence, or null when it is none of ours. */
export function parseDueEvery(input: string): Recurrence | null {
  const text = norm(input).replace(/[^a-z0-9 ]/g, '')
  if (text === '' || /^(once|one time|onetime|none|no|na|n a|single)$/.test(text)) return 'none'
  if (/^(1|1 month|month|monthly|every month|mo)$/.test(text)) return 'monthly'
  if (/^(3|3 months|quarter|quarterly|every quarter|qtr)$/.test(text)) return 'quarterly'
  if (/^(6|6 months|semi|semiannual|semi annual|semiannually|half year|half yearly|twice a year|biannual)$/.test(text)) {
    return 'semiannual'
  }
  if (/^(12|12 months|year|yearly|annual|annually|every year|yr|1 year)$/.test(text)) return 'annual'
  return null
}

function money(cell: string): Cents | null {
  const text = cell.trim()
  if (text === '' || text === '-' || text === '—') return null
  const negative = /^\(.*\)$/.test(text)
  const cents = parseAmountOrNull(text.replace(/[()]/g, ''))
  return cents === null ? null : negative ? -cents : cents
}

function categoryOf(cell: string): DebtCategory {
  const text = norm(cell)
  // Whole words: "Credit Card" must not read as a car.
  if (/\b(auto|car|vehicle|truck)\b/.test(text)) return 'auto'
  if (/\b(mortgage|home|house|heloc|property)\b/.test(text)) return 'mortgage'
  return 'consumer'
}

type Block = { kind: 'expense' | 'debt'; header: string[]; rows: { line: number; cells: string[] }[] }

/** Cut the paste into blocks, each starting at a header line it recognises. */
function blocksOf(text: string): { blocks: Block[]; problems: SheetProblem[] } {
  const blocks: Block[] = []
  const problems: SheetProblem[] = []
  let current: Block | null = null
  let delimiter: '\t' | ',' = '\t'

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    if (raw.trim() === '') return
    const guess: '\t' | ',' = raw.includes('\t') ? '\t' : ','
    const cells = splitLine(raw, guess)
    const names = cells.map(norm)
    if (names.includes('expense') && names.includes('amount')) {
      current = { kind: 'expense', header: names, rows: [] }
      delimiter = guess
      blocks.push(current)
      return
    }
    if (names.includes('loan') && names.includes('balance')) {
      current = { kind: 'debt', header: names, rows: [] }
      delimiter = guess
      blocks.push(current)
      return
    }
    if (!current) {
      problems.push({
        row: line,
        message: 'This line came before any header row. Paste the header row (Account, Expense, … or Loan, Category, …) first.',
      })
      return
    }
    const rowCells = splitLine(raw, delimiter)
    if (rowCells.every((c) => c === '')) return
    current.rows.push({ line, cells: rowCells })
  })

  return { blocks, problems }
}

export function parseSheet(
  text: string,
  context: { today: CivilDate; existingAccounts: readonly string[] },
): SheetImport {
  const { blocks, problems } = blocksOf(text)
  const expenses: ImportedExpense[] = []
  const debts: ImportedDebt[] = []
  const ignored = new Set<string>()
  const accountsToCreate: string[] = []
  const existing = new Set(context.existingAccounts.map((a) => a.toLowerCase()))

  for (const block of blocks) {
    const used: readonly string[] = block.kind === 'expense' ? EXPENSE_USED : DEBT_USED
    const col = (name: string) => block.header.indexOf(name)
    for (const name of block.header) {
      if (name && !used.includes(name)) ignored.add(name)
    }

    for (const { line, cells } of block.rows) {
      const cell = (name: string) => {
        const i = col(name)
        return i >= 0 ? (cells[i] ?? '') : ''
      }
      const notes: string[] = []
      const fail = (message: string) => problems.push({ row: line, message })

      if (block.kind === 'expense') {
        const label = cell('expense').trim()
        const account = cell('account').trim()
        const amountCents = money(cell('amount'))
        const recurrence = parseDueEvery(cell('due every'))
        const due = parseSheetDate(cell('next due'))
        const opening = cell('reserved now').trim() === '' ? 0 : money(cell('reserved now'))

        if (!label) fail('No expense name.')
        if (!account) fail('No account.')
        if (amountCents === null || amountCents <= 0) fail(`Amount "${cell('amount')}" is not an amount above zero.`)
        if (recurrence === null) {
          fail(
            `Due Every "${cell('due every')}" is not one Ballast plans by (once, month, quarter, 6 months, year). A weekly bill is better entered as its monthly amount.`,
          )
        }
        if (!due) fail(`Next Due "${cell('next due')}" is not a date.`)
        if (opening === null || opening < 0) fail(`Reserved Now "${cell('reserved now')}" is not an amount.`)
        if (!label || !account || amountCents === null || amountCents <= 0 || recurrence === null || !due || opening === null || opening < 0) {
          continue
        }

        let dueDate = due
        if (compareDates(dueDate, context.today) <= 0) {
          if (recurrence === 'none') {
            fail(`Next Due ${dueDate} has passed and this does not repeat, so there is nothing left to save for.`)
            continue
          }
          dueDate = rollToFuture(dueDate, recurrence, context.today)
          notes.push(`Next Due ${due} has passed; the next one, ${dueDate}, is what gets planned.`)
        }
        if (opening > amountCents) notes.push('Reserved Now is more than the amount; only the amount is counted, the rest stays in the account.')
        if (!existing.has(account.toLowerCase()) && !accountsToCreate.some((a) => a.toLowerCase() === account.toLowerCase())) {
          accountsToCreate.push(account)
        }
        expenses.push({
          row: line,
          label,
          account,
          amountCents,
          dueDate,
          recurrence,
          openingCents: Math.min(opening, amountCents),
          notes,
        })
      } else {
        const name = cell('loan').trim()
        const balanceCents = money(cell('balance'))
        const aprBasisPoints = parsePercentOrNull(cell('apr'))
        const percent = cell('%').trim() === '' ? null : parsePercentOrNull(cell('%'))
        const floor = cell('$').trim() === '' ? null : money(cell('$'))
        const monthly = cell('monthly').trim() === '' ? null : money(cell('monthly'))
        const limitRaw = cell('limit').trim()
        const limit = limitRaw === '' ? null : money(limitRaw)
        const asOfRaw = cell('as of').trim()
        const balanceAsOf = asOfRaw === '' ? null : parseSheetDate(asOfRaw)

        if (!name) fail('No loan name.')
        if (balanceCents === null || balanceCents < 0) fail(`Balance "${cell('balance')}" is not an amount.`)
        if (aprBasisPoints === null || aprBasisPoints < 0) fail(`APR "${cell('apr')}" is not a rate.`)
        if (cell('%').trim() !== '' && percent === null) fail(`% "${cell('%')}" is not a percentage.`)
        if (cell('$').trim() !== '' && floor === null) fail(`$ "${cell('$')}" is not an amount.`)
        if (limitRaw !== '' && limit === null) fail(`Limit "${limitRaw}" is not an amount.`)
        if (asOfRaw !== '' && balanceAsOf === null) fail(`As of "${asOfRaw}" is not a date.`)

        let minPaymentRule: MinPaymentRule | null = null
        if (percent !== null && percent > 0 && floor !== null && floor > 0) {
          minPaymentRule = { type: 'percent_with_floor', basisPoints: percent, floorCents: floor }
        } else if (percent !== null && percent > 0) {
          minPaymentRule = { type: 'percent', basisPoints: percent }
        } else if (floor !== null && floor > 0) {
          minPaymentRule = { type: 'fixed', amountCents: floor }
        } else if (monthly !== null && monthly > 0) {
          minPaymentRule = { type: 'fixed', amountCents: monthly }
          notes.push('No % or $ minimum given, so the Monthly figure is taken as a set minimum payment.')
        } else {
          fail('No minimum payment: fill in % (of the balance) and/or $ (a set amount), or Monthly.')
        }
        if (balanceAsOf === null && asOfRaw === '') notes.push('No "As of" date; today will be used.')
        if (limit !== null && limit <= 0) notes.push('Limit is zero; treated as none.')

        if (!name || balanceCents === null || balanceCents < 0 || aprBasisPoints === null || aprBasisPoints < 0 || !minPaymentRule) {
          continue
        }
        if ((cell('%').trim() !== '' && percent === null) || (cell('$').trim() !== '' && floor === null)) continue
        if ((limitRaw !== '' && limit === null) || (asOfRaw !== '' && balanceAsOf === null)) continue

        debts.push({
          row: line,
          name,
          category: categoryOf(cell('category')),
          balanceCents,
          balanceAsOf,
          aprBasisPoints,
          minPaymentRule,
          creditLimitCents: limit !== null && limit > 0 ? limit : null,
          notes,
        })
      }
    }
  }

  if (blocks.length === 0 && problems.length === 0) {
    problems.push({ row: 0, message: 'No header row found. Paste the rows with their header line at the top.' })
  }

  return {
    expenses,
    debts,
    problems: problems.sort((a, b) => a.row - b.row),
    ignoredColumns: [...ignored],
    accountsToCreate,
  }
}
