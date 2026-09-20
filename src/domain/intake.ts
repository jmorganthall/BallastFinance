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
import { recurrenceOf, rollToFuture, RECURRENCE_UNITS, type Recurrence } from './recurrence'
import { canWriteAccount, type Id, type Package, type PackageState, type ReserveAccount } from './types'

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
  /**
   * How often it comes round (PRD D8, superseded). Additive to the contract:
   * a producer that does not send it gets a one-off, exactly as before, and
   * one still naming the old fixed set ("annual") gets the interval that
   * always was.
   */
  recurrence: z
    .union([
      z.string(),
      z.null(),
      z.object({
        every: z.number().int().min(1),
        unit: z.enum(RECURRENCE_UNITS as [string, ...string[]]),
      }),
    ])
    .optional()
    .transform((value, ctx) => {
      if (value == null) return null
      if (typeof value === 'string' && (value === '' || value === 'none')) return null
      const parsed =
        typeof value === 'string' ? recurrenceOf(1, value) : recurrenceOf(value.every, value.unit)
      if (!parsed) {
        // Refused, never guessed: a producer that means "every fortnight" and
        // gets a one-off has been quietly misunderstood, and the weekly number
        // would be wrong for the rest of the series.
        ctx.addIssue({
          code: 'custom',
          message:
            typeof value === 'string'
              ? `Not a recurrence: "${value}". Send { every, unit } with unit one of day, week, month, year.`
              : `Not a recurrence: every ${value.every} ${value.unit}.`,
        })
        return z.NEVER
      }
      return parsed
    }),
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
  recurrence: Recurrence | null
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
  /**
   * Who is submitting. Needed because an individual-scoped account may only be
   * funded by its owner (PRD §2). Null means no signed-in actor, which can
   * still target household accounts.
   */
  actorUserId?: Id | null
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
      // A recurring item entered with a past date means "the last one was
      // then": roll it to the next occurrence rather than refusing it. A
      // one-off still has to be ahead of us -- a package plans for what is
      // still to come.
      dueDate = rollToFuture(item.due_date, item.recurrence, context.today)
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
    } else if (!canWriteAccount(account, context.actorUserId ?? null)) {
      // Rejected at intake rather than at commit: discovering you cannot fund a
      // plan only after building it is the worst moment to find out.
      problems.push({
        path: at('reserve_account'),
        message: `"${account.name}" belongs to someone else in the household. Ask them to add this, or choose a shared account.`,
      })
    }

    if (dueDate && account && unitAmountCents > 0 && canWriteAccount(account, context.actorUserId ?? null)) {
      lineItems.push({
        label: item.label,
        unitAmountCents,
        quantity: item.quantity,
        dueDate,
        reserveAccountId: account.id,
        recurrence: item.recurrence,
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
