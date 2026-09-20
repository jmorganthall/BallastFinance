/**
 * The Package Intake contract (PRD §4).
 *
 * The single write path for creating packages. Every producer emits this shape:
 * the manual builder in v1, and every planner module later (vacations, vehicles,
 * college). The engine validates it and creates a Package in SIMULATED state --
 * commit is always a separate, explicit action, never part of intake.
 *
 * Validation is pure: it takes the intake plus the context it must resolve
 * against (existing accounts, existing package names, today's date) and returns
 * either a normalised result or a list of problems. Nothing here touches a
 * database.
 */

import { z } from 'zod'
import { assertCivilDate, compareDates, type CivilDate } from './dates'
import { parseAmountToCents, type Cents } from './money'
import type { Id, Package, PackageState, ReserveAccount } from './types'

/** Bump only for a breaking change. Unknown versions are rejected loudly (PRD §4). */
export const INTAKE_CONTRACT_VERSION = '1'
export const SUPPORTED_INTAKE_VERSIONS = new Set([INTAKE_CONTRACT_VERSION])

const amount = z.union([z.string(), z.number()])

const intakeLineItemSchema = z.object({
  label: z.string().trim().min(1, 'Every line item needs a label'),
  unit_amount: amount,
  quantity: z.number().int().min(1).default(1),
  due_date: z.string(),
  /** An account id, or a ReserveAccount name matched exactly. */
  reserve_account: z.string().trim().min(1),
})

const intakePackageSchema = z.object({
  name: z.string().trim().min(1, 'Every package needs a name'),
  module: z.string().trim().min(1).default('manual'),
  /** Module-owned; the core never reads it (abstract, data-model principle 4). */
  detail: z.unknown().optional(),
})

export const packageIntakeSchema = z.object({
  contract_version: z.string(),
  package: intakePackageSchema,
  line_items: z.array(intakeLineItemSchema).min(1, 'A package needs at least one line item'),
})

export type PackageIntake = z.input<typeof packageIntakeSchema>

export interface IntakeProblem {
  path: string
  message: string
}

export interface NormalisedLineItem {
  label: string
  unitAmountCents: Cents
  quantity: number
  dueDate: CivilDate
  reserveAccountId: Id
}

export interface NormalisedIntake {
  name: string
  module: string
  detail: unknown
  state: Extract<PackageState, 'simulated'>
  lineItems: NormalisedLineItem[]
}

export type IntakeResult =
  | { ok: true; value: NormalisedIntake }
  | { ok: false; problems: IntakeProblem[] }

export interface IntakeContext {
  today: CivilDate
  accounts: readonly ReserveAccount[]
  /** Existing packages, to enforce name uniqueness among non-retired ones. */
  packages: readonly Pick<Package, 'name' | 'state'>[]
}

function resolveAccount(ref: string, accounts: readonly ReserveAccount[]): ReserveAccount | null {
  return (
    accounts.find((a) => a.id === ref) ??
    accounts.find((a) => a.name === ref) ??
    null
  )
}

/**
 * Validate and normalise an intake.
 *
 * Collects every problem rather than throwing on the first, so a builder can
 * show all of them at once instead of making the user resubmit repeatedly.
 */
export function validateIntake(raw: unknown, context: IntakeContext): IntakeResult {
  const parsed = packageIntakeSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      })),
    }
  }

  const intake = parsed.data
  const problems: IntakeProblem[] = []

  // Reject an unknown contract version loudly rather than guessing (PRD §4).
  if (!SUPPORTED_INTAKE_VERSIONS.has(intake.contract_version)) {
    return {
      ok: false,
      problems: [
        {
          path: 'contract_version',
          message: `Unsupported intake contract version "${intake.contract_version}". This engine accepts: ${[...SUPPORTED_INTAKE_VERSIONS].join(', ')}.`,
        },
      ],
    }
  }

  const clashes = context.packages.some(
    (p) => p.state !== 'retired' && p.name.toLowerCase() === intake.package.name.toLowerCase(),
  )
  if (clashes) {
    problems.push({
      path: 'package.name',
      message: `There is already a package called "${intake.package.name}".`,
    })
  }

  const lineItems: NormalisedLineItem[] = []

  intake.line_items.forEach((item, index) => {
    const at = (field: string) => `line_items.${index}.${field}`

    let unitAmountCents = 0
    try {
      unitAmountCents =
        typeof item.unit_amount === 'number'
          ? Math.round(item.unit_amount * 100)
          : parseAmountToCents(item.unit_amount)
      if (unitAmountCents <= 0) {
        problems.push({ path: at('unit_amount'), message: 'Amount must be more than zero.' })
      }
    } catch {
      problems.push({ path: at('unit_amount'), message: `Not an amount: "${item.unit_amount}".` })
    }

    let dueDate: CivilDate | null = null
    try {
      assertCivilDate(item.due_date)
      dueDate = item.due_date
      // D8: dated one-shot items only, and the date has to still be ahead of us.
      if (compareDates(dueDate, context.today) <= 0) {
        problems.push({
          path: at('due_date'),
          message: `Due date ${dueDate} is not in the future. A package plans for what is still ahead.`,
        })
      }
    } catch {
      problems.push({
        path: at('due_date'),
        message: `Not a date: "${item.due_date}". Use YYYY-MM-DD.`,
      })
    }

    const account = resolveAccount(item.reserve_account, context.accounts)
    if (!account) {
      problems.push({
        path: at('reserve_account'),
        message: `No reserve account matches "${item.reserve_account}".`,
      })
    }

    if (dueDate && account && unitAmountCents > 0) {
      lineItems.push({
        label: item.label,
        unitAmountCents,
        quantity: item.quantity,
        dueDate,
        reserveAccountId: account.id,
      })
    }
  })

  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    value: {
      name: intake.package.name,
      module: intake.package.module,
      detail: intake.package.detail ?? null,
      state: 'simulated', // always; commit is a separate engine action (PRD §4)
      lineItems,
    },
  }
}
