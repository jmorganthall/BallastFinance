'use server'

/**
 * Server actions: the only route from the browser into a mutation, and each one
 * goes through the engine (PRD §10 -- no handler touches tables).
 */

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireEngine } from '@/server/session'
import {
  INTAKE_CONTRACT_VERSION,
  assertCivilDate,
  describeRecurrence,
  recurrenceOf,
  type Recurrence,
} from '@/domain'

export interface FormState {
  problems: { path: string; message: string }[]
}

export async function createPackageAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const { engine } = await requireEngine()

  const labels = formData.getAll('label').map(String)
  const amounts = formData.getAll('unit_amount').map(String)
  const quantities = formData.getAll('quantity').map(String)
  const dueDates = formData.getAll('due_date').map(String)
  const accounts = formData.getAll('reserve_account').map(String)
  const units = formData.getAll('recurrence_unit').map(String)
  const everys = formData.getAll('recurrence_every').map(String)

  const lineItems = labels
    .map((label, i) => ({
      label,
      unit_amount: amounts[i] ?? '',
      quantity: Number(quantities[i] ?? '1') || 1,
      due_date: dueDates[i] ?? '',
      reserve_account: accounts[i] ?? '',
      recurrence: recurrenceOf(everys[i] ?? 1, units[i] ?? 'none'),
    }))
    // An untouched blank row is not an error, it is just not a line item.
    .filter((item) => item.label.trim() !== '' || item.unit_amount.trim() !== '')

  const result = await engine.createPackageFromIntake({
    contract_version: INTAKE_CONTRACT_VERSION,
    package: { name: String(formData.get('name') ?? ''), module: 'manual' },
    line_items: lineItems,
  })

  if (!result.ok) return { problems: result.problems }

  revalidatePath('/packages')
  revalidatePath('/')
  redirect(`/packages/${result.packageId}`)
}

/** Commit, with the one optional number: how much is already set aside (PRD §5). */
export async function commitPackageAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull } = await import('@/domain')
  const packageId = String(formData.get('package_id'))

  // Taking the offer recomputes it here rather than believing the form: the
  // figure decides a weekly number, so it comes from the same place the screen
  // got it, not from whatever was posted back.
  if (formData.get('use_suggested')) {
    const suggested = await engine.suggestedOpenings(packageId)
    await engine.commitPackage(packageId, {
      openingByLineItem: Object.fromEntries(suggested.map((s) => [s.lineItemId, s.cents])),
    })
    revalidatePath('/')
    revalidatePath('/packages')
    revalidatePath(`/packages/${packageId}`)
    return
  }

  const raw = String(formData.get('opening') ?? '').trim()
  const openingCents = raw === '' ? 0 : parseAmountOrNull(raw)
  if (openingCents === null || openingCents < 0) {
    redirect(
      `/packages/${packageId}?error=${encodeURIComponent('Enter what is already set aside as an amount, like 250, or leave it blank.')}`,
    )
  }
  await engine.commitPackage(packageId, { openingCents: openingCents! })
  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath(`/packages/${packageId}`)
}

/**
 * How often, as a form sends it: a unit ("none" for a one-off) and a count.
 * An unusable pair is a one-off rather than an error -- the same reading the
 * domain gives it, so a screen and the engine can never disagree.
 */
function readRecurrence(formData: FormData): Recurrence | null {
  return recurrenceOf(formData.get('recurrence_every') ?? 1, formData.get('recurrence_unit'))
}

/** Every field of a part, in one save. */
export async function updateLineItemAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull } = await import('@/domain')
  const { EngineError } = await import('@/server/engine')
  const lineItemId = String(formData.get('line_item_id'))
  const packageId = String(formData.get('package_id'))
  const fail = (message: string): never =>
    redirect(`/packages/${packageId}?error=${encodeURIComponent(message)}`)

  const label = String(formData.get('label') ?? '').trim()
  if (!label) fail('Every part needs a name.')
  const unitAmountCents = parseAmountOrNull(formData.get('unit_amount') as string)
  if (unitAmountCents === null || unitAmountCents <= 0) fail('Enter the cost of one as an amount, like 600.')
  const quantity = Number(formData.get('quantity'))
  if (!Number.isInteger(quantity) || quantity < 1) fail('How many must be a whole number, at least one.')
  const dueDate = String(formData.get('due_date') ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) fail('Pick the date it is needed by.')
  const reserveAccountId = String(formData.get('reserve_account') ?? '')
  if (!reserveAccountId) fail('Pick the account it is saved in.')

  try {
    await engine.updateLineItem(lineItemId, {
      label,
      unitAmountCents: unitAmountCents!,
      quantity,
      dueDate,
      reserveAccountId,
      recurrence: readRecurrence(formData),
    })
  } catch (error) {
    if (error instanceof EngineError) fail(error.message)
    throw error
  }

  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath(`/packages/${packageId}`)
  redirect(`/packages/${packageId}?saved=1`)
}

export async function addLineItemAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull } = await import('@/domain')
  const { EngineError } = await import('@/server/engine')
  const packageId = String(formData.get('package_id'))
  const fail = (message: string): never =>
    redirect(`/packages/${packageId}?error=${encodeURIComponent(message)}`)

  const label = String(formData.get('label') ?? '').trim()
  if (!label) fail('Every part needs a name.')
  const unitAmountCents = parseAmountOrNull(formData.get('unit_amount') as string)
  if (unitAmountCents === null || unitAmountCents <= 0) fail('Enter the cost of one as an amount, like 600.')
  const quantity = Number(formData.get('quantity') || '1')
  if (!Number.isInteger(quantity) || quantity < 1) fail('How many must be a whole number, at least one.')
  const dueDate = String(formData.get('due_date') ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) fail('Pick the date it is needed by.')
  const reserveAccountId = String(formData.get('reserve_account') ?? '')
  if (!reserveAccountId) fail('Pick the account it is saved in.')

  try {
    await engine.addLineItem(packageId, {
      label,
      unitAmountCents: unitAmountCents!,
      quantity,
      dueDate,
      reserveAccountId,
      recurrence: readRecurrence(formData),
    })
  } catch (error) {
    if (error instanceof EngineError) fail(error.message)
    throw error
  }

  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath(`/packages/${packageId}`)
  redirect(`/packages/${packageId}?saved=1`)
}

export async function retireLineItemAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const lineItemId = String(formData.get('line_item_id'))
  const packageId = String(formData.get('package_id'))
  await engine.retireLineItem(lineItemId)
  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath(`/packages/${packageId}`)
}

export async function renamePackageAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { EngineError } = await import('@/server/engine')
  const packageId = String(formData.get('package_id'))
  try {
    await engine.renamePackage(packageId, String(formData.get('name') ?? ''))
  } catch (error) {
    if (error instanceof EngineError) {
      redirect(`/packages/${packageId}?error=${encodeURIComponent(error.message)}`)
    }
    throw error
  }
  revalidatePath('/packages')
  revalidatePath(`/packages/${packageId}`)
  redirect(`/packages/${packageId}?saved=1`)
}

export async function retirePackageAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const packageId = String(formData.get('package_id'))
  await engine.retirePackage(packageId)
  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath(`/packages/${packageId}`)
  redirect('/packages')
}

/**
 * Delete a finished plan for good. The plan's name comes back with the form
 * and the engine refuses unless it matches, so a stray tap cannot do this.
 */
export async function deletePackageAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { EngineError } = await import('@/server/engine')
  const packageId = String(formData.get('package_id'))
  try {
    await engine.deletePackage(packageId, String(formData.get('confirm_name') ?? ''))
  } catch (error) {
    if (error instanceof EngineError) {
      redirect(`/packages/${packageId}?error=${encodeURIComponent(error.message)}`)
    }
    throw error
  }
  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath('/check-in')
  redirect('/packages')
}

/**
 * A check-in found more in an account than its plans had accrued, and the
 * person chose to count it toward those plans. The amounts arrive as one
 * hidden field per part, exactly as previewed.
 */
export async function acceptOpeningsAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const items: { lineItemId: string; openingCents: number }[] = []
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('opening_')) continue
    const openingCents = Number(value)
    if (!Number.isInteger(openingCents) || openingCents < 0) continue
    items.push({ lineItemId: key.slice('opening_'.length), openingCents })
  }
  if (items.length > 0) await engine.recordOpeningBalances(items)
  revalidatePath('/')
  revalidatePath('/check-in')
  revalidatePath('/packages')
  redirect('/check-in?counted=1')
}

/**
 * Re-spread what an account's plans count as held across its parts (PRD §6).
 * Only the account is posted: the engine works the spread out again as it
 * records it, so what lands is today's answer, never a stale preview.
 */
export async function reshuffleAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const accountId = String(formData.get('reserve_account_id') ?? '')
  await engine.reshuffleAccount(accountId)
  revalidatePath('/')
  revalidatePath('/check-in')
  revalidatePath('/packages')
  redirect('/check-in?reshuffled=1')
}

export async function createReserveAccountAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const name = String(formData.get('name') ?? '').trim()
  const institutionLabel = String(formData.get('institution_label') ?? '').trim()
  const scope = formData.get('scope') === 'individual' ? 'individual' : 'household'

  if (name) {
    try {
      await engine.createReserveAccount({
        name,
        institutionLabel: institutionLabel || name,
        scope,
      })
    } catch (error) {
      redirect(`/settings?error=${encodeURIComponent((error as Error).message)}`)
    }
  }
  revalidatePath('/packages/new')
  revalidatePath('/settings')
  revalidatePath('/')
}

// ---------------------------------------------------------------- Phase B

/**
 * A check-in (PRD §5, capability 3). The user confirms what each account
 * actually holds; drift is the difference from what the plan says should be
 * there. Accepting a catch-up issues an instruction, and only confirming that
 * instruction changes the weekly number.
 */
export async function confirmBalancesAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const accounts = await engine.listReserveAccounts()

  for (const account of accounts) {
    const raw = String(formData.get(`balance_${account.id}`) ?? '').trim()
    if (raw === '') continue
    try {
      const { parseAmountToCents } = await import('@/domain')
      await engine.confirmBalance({
        reserveAccountId: account.id,
        amountCents: parseAmountToCents(raw),
      })
    } catch {
      // A field the user left as junk is skipped rather than failing the whole
      // check-in; the others still record.
    }
  }

  revalidatePath('/')
  revalidatePath('/check-in')
  redirect('/check-in?done=1')
}

/**
 * Accept one of the check-in's offers: the two ways back on track when an
 * account is behind, or the two when it is ahead. Each becomes an instruction,
 * and nothing changes until a human confirms it was done.
 */
const DRIFT_OPTION_TYPES = {
  one_time: 'one_time_move',
  rate_bump: 'rate_bump',
  one_time_out: 'one_time_move_out',
  rate_cut: 'rate_cut',
} as const

export async function acceptCatchUpAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const accountId = String(formData.get('reserve_account_id'))
  const accountName = String(formData.get('account_name'))
  const amountCents = Number(formData.get('amount_cents'))
  const kind = String(formData.get('kind')) as keyof typeof DRIFT_OPTION_TYPES
  const endsOn = String(formData.get('ends_on') ?? '')

  const type = DRIFT_OPTION_TYPES[kind]
  if (!type) return
  if (!Number.isFinite(amountCents) || amountCents <= 0) return

  const dated = type === 'rate_bump' || type === 'rate_cut'
  if (dated && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return

  await engine.issueInstruction({
    type,
    amountCents,
    targetId: accountId,
    targetLabel: accountName,
    ...(dated ? { endsOn } : {}),
  })

  revalidatePath('/')
  revalidatePath('/check-in')
  redirect('/')
}

export async function confirmInstructionAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  await engine.confirmInstruction({ instructionId: String(formData.get('instruction_id')) })
  revalidatePath('/')
  revalidatePath('/check-in')
}

/**
 * "Not doing this" on a to-do, or "stop this" on a running bump or cut (PRD
 * D18). One event; the numbers it changes change now, because changing the
 * transfer back is something the person has already done in the bank.
 */
export async function endInstructionAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  await engine.endInstruction({ instructionId: String(formData.get('instruction_id')) })
  revalidatePath('/')
  revalidatePath('/check-in')
}

export async function confirmSpendAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const lineItemId = String(formData.get('line_item_id'))
  const raw = String(formData.get('actual_amount') ?? '').trim()
  const planned = Number(formData.get('planned_cents'))

  let actualAmountCents = planned
  if (raw !== '') {
    try {
      const { parseAmountToCents } = await import('@/domain')
      actualAmountCents = parseAmountToCents(raw)
    } catch {
      actualAmountCents = planned
    }
  }

  await engine.confirmSpend({ lineItemId, actualAmountCents })
  revalidatePath('/')
  revalidatePath('/packages')
}

/**
 * Record an allocation run (PRD §6). Produces a set of instructions, each of
 * which stays outstanding until a human confirms it happened.
 */
export async function runAllocationAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const raw = String(formData.get('floor') ?? '').trim()
  if (raw === '') return

  const { parseAmountToCents } = await import('@/domain')
  let floorCents: number
  try {
    floorCents = parseAmountToCents(raw)
  } catch {
    redirect('/allocate?error=amount')
  }

  // When this is the extra a check-in found in a reserve account, the run
  // also asks for it to be moved out of there.
  const from = String(formData.get('from') ?? '').trim()
  // The first step: which shortfalls to cover. The form names them; the
  // amounts are worked out again here from what is actually short.
  const cover = await engine.chosenShortfalls(formData.getAll('fill').map(String))
  await engine.runAllocation({
    floorCents,
    cover,
    ...(from ? { sourceAccountId: from } : {}),
  })
  revalidatePath('/')
  revalidatePath('/allocate')
  revalidatePath('/check-in')
  redirect('/')
}

// ---------------------------------------------------------------- Phase D

/**
 * What the add-a-debt form gets back. A problem names the box it belongs to,
 * so the form can show it in place and keep everything the person typed. A
 * redirect on error was what used to wipe the form.
 */
export interface DebtFormState {
  problems: { field: string; message: string }[]
  /** Bumped on every successful add, so the form knows to clear itself. */
  saved: number
}

export async function createDebtAction(
  previous: DebtFormState,
  formData: FormData,
): Promise<DebtFormState> {
  const { engine } = await requireEngine()
  const { debtFormValuesFrom, parseDebtForm, DebtDataError } = await import('@/domain')

  // The browser already ran this same validator; running it again here is what
  // makes the browser's check a convenience rather than the only guard.
  const parsed = parseDebtForm(debtFormValuesFrom((name) => formData.get(name)))
  if (!parsed.ok) return { problems: parsed.problems, saved: previous.saved }

  try {
    await engine.createDebt(parsed.input)
  } catch (error) {
    // A rejected debt comes back as a readable message on the page rather than
    // a crash; the rate guard exists to be seen, not to break the form.
    if (error instanceof DebtDataError) {
      return { problems: [{ field: 'form', message: error.message }], saved: previous.saved }
    }
    throw error
  }

  revalidatePath('/debts')
  revalidatePath('/allocate')
  return { problems: [], saved: previous.saved + 1 }
}

/**
 * Correct a debt from the same form that added it. The terms go through
 * updateDebt; a changed balance is a statement balance, recorded on its own
 * dated path, so the two never get mixed up in the log.
 */
export async function updateDebtAction(
  previous: DebtFormState,
  formData: FormData,
): Promise<DebtFormState> {
  const { engine } = await requireEngine()
  const { debtFormValuesFrom, parseDebtForm, DebtDataError } = await import('@/domain')
  const { EngineError } = await import('@/server/engine')
  const debtId = String(formData.get('debt_id') ?? '')

  const parsed = parseDebtForm(debtFormValuesFrom((name) => formData.get(name)))
  if (!parsed.ok) return { problems: parsed.problems, saved: previous.saved }

  try {
    const current = (await engine.listDebts()).find((d) => d.id === debtId)
    if (!current) return { problems: [{ field: 'form', message: 'That debt is no longer here.' }], saved: previous.saved }
    const { balanceCents, ...terms } = parsed.input
    await engine.updateDebt(debtId, terms)
    if (balanceCents !== current.balanceCents) {
      await engine.updateDebtBalance({ debtId, balanceCents })
    }
  } catch (error) {
    if (error instanceof DebtDataError || error instanceof EngineError) {
      return { problems: [{ field: 'form', message: error.message }], saved: previous.saved }
    }
    throw error
  }

  revalidatePath('/debts')
  revalidatePath('/allocate')
  revalidatePath('/')
  return { problems: [], saved: previous.saved + 1 }
}

export async function removeDebtAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  await engine.removeDebt(String(formData.get('debt_id')))
  revalidatePath('/debts')
  revalidatePath('/allocate')
  revalidatePath('/')
}

export async function confirmDebtPaymentAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull } = await import('@/domain')
  const debtId = String(formData.get('debt_id'))

  const amountCents = parseAmountOrNull(formData.get('amount') as string)
  if (amountCents === null || amountCents <= 0) {
    redirect(`/debts?error=${encodeURIComponent('Enter the amount you paid, like 150.')}`)
  }

  await engine.confirmDebtPayment({ debtId, amountCents: amountCents! })
  revalidatePath('/debts')
  revalidatePath('/')
}

/**
 * A balance read off a statement, as opposed to a payment made. This is how a
 * balance that has gone stale gets refreshed, and it stamps today as the date
 * it was last known to be right.
 */
export async function updateDebtBalanceAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull } = await import('@/domain')
  const debtId = String(formData.get('debt_id'))

  const balanceCents = parseAmountOrNull(formData.get('balance') as string)
  if (balanceCents === null || balanceCents < 0) {
    redirect(`/debts?error=${encodeURIComponent('Enter the balance from the statement, like 4,321.00.')}`)
  }

  await engine.updateDebtBalance({ debtId, balanceCents: balanceCents! })
  revalidatePath('/debts')
  revalidatePath('/')
}

export async function setPriorityWeightAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const weight = Number(formData.get('weight'))
  if (Number.isFinite(weight) && weight >= 0 && weight <= 1) {
    await engine.putSetting('priority_weights', weight)
  }
  revalidatePath('/debts')
}

// ---------------------------------------------------------------- settings

export async function saveAllocationRulesAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { DEFAULT_ALLOCATION_RULES, validateRules, parseAmountToCents } = await import('@/domain')

  const rules = DEFAULT_ALLOCATION_RULES.map((rule) => ({
    ...rule,
    percent: Number(formData.get(`percent_${rule.destination}`) ?? rule.percent),
  }))

  try {
    validateRules(rules)
  } catch (error) {
    redirect(`/settings?error=${encodeURIComponent((error as Error).message)}`)
  }

  await engine.putSetting('allocation_split', rules)

  const buffer = String(formData.get('buffer') ?? '').trim()
  if (buffer) {
    try {
      await engine.putSetting('buffer_amount', parseAmountToCents(buffer))
    } catch {
      redirect('/settings?error=' + encodeURIComponent('That buffer did not look like an amount.'))
    }
  }

  revalidatePath('/settings')
  revalidatePath('/allocate')
  redirect('/settings?saved=1')
}

// ---------------------------------------------------------------- spreadsheet import (temporary)

export type SheetImportState =
  | { phase: 'idle'; error?: string }
  | {
      phase: 'preview'
      text: string
      expenses: {
        row: number
        label: string
        account: string
        amountCents: number
        dueDate: string
        /** Already in plain words: "Every 3 weeks". */
        recurrence: string
        repeats: boolean
        openingCents: number
        notes: string[]
      }[]
      debts: {
        row: number
        name: string
        category: string
        balanceCents: number
        balanceAsOf: string | null
        aprBasisPoints: number
        minimum: string
        creditLimitCents: number | null
        notes: string[]
      }[]
      problems: { row: number; message: string }[]
      ignoredColumns: string[]
      accountsToCreate: string[]
    }
  | {
      phase: 'done'
      accountsCreated: string[]
      plansCreated: string[]
      debtsCreated: string[]
      problems: { row: number; message: string }[]
    }

/**
 * Two steps, one action: "check it" parses the paste and shows what would be
 * made and what is thrown away; "import" makes it. The text rides along in
 * the form between the two, so what is imported is exactly what was shown.
 */
export async function sheetImportAction(
  _previous: SheetImportState,
  formData: FormData,
): Promise<SheetImportState> {
  const { engine } = await requireEngine()
  const { parseSheet, formatCents } = await import('@/domain')
  const text = String(formData.get('sheet') ?? '')
  if (text.trim() === '') return { phase: 'idle', error: 'Paste the rows first, header line included.' }

  const existingAccounts = (await engine.listReserveAccounts()).map((a) => a.name)
  const parsed = parseSheet(text, { today: engine.today(), existingAccounts })

  if (formData.get('mode') !== 'import') {
    const minimumOf = (rule: (typeof parsed.debts)[number]['minPaymentRule']) =>
      rule.type === 'fixed'
        ? `${formatCents(rule.amountCents)} a month`
        : rule.type === 'percent'
          ? `${(rule.basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}% of the balance`
          : `${(rule.basisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}% of the balance, never below ${formatCents(rule.floorCents)}`
    return {
      phase: 'preview',
      text,
      expenses: parsed.expenses.map((e) => ({
        ...e,
        recurrence: describeRecurrence(e.recurrence),
        repeats: e.recurrence !== null,
      })),
      debts: parsed.debts.map((d) => ({
        row: d.row,
        name: d.name,
        category: d.category,
        balanceCents: d.balanceCents,
        balanceAsOf: d.balanceAsOf,
        aprBasisPoints: d.aprBasisPoints,
        minimum: minimumOf(d.minPaymentRule),
        creditLimitCents: d.creditLimitCents,
        notes: d.notes,
      })),
      problems: parsed.problems,
      ignoredColumns: parsed.ignoredColumns,
      accountsToCreate: parsed.accountsToCreate,
    }
  }

  const result = await engine.importSheet(parsed)
  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath('/debts')
  revalidatePath('/check-in')
  revalidatePath('/settings')
  return { phase: 'done', ...result }
}

export async function signOutAction(): Promise<void> {
  const { signOut } = await import('@/auth')
  await signOut({ redirectTo: '/sign-in' })
}

export async function saveNotificationPrefsAction(formData: FormData): Promise<void> {
  const { engine, viewer } = await requireEngine()
  const prefs = await engine.getSetting<Record<string, boolean>>('notification_prefs', {})
  // Muting is per person, keyed by user id: both spouses get everything by
  // default (PRD §8), and one muting themselves must not mute the other.
  await engine.putSetting('notification_prefs', {
    ...prefs,
    [viewer.userId]: formData.get('muted') !== 'on',
  })
  revalidatePath('/settings')
  redirect('/settings?saved=1')
}

export async function saveTransferRoundingAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull } = await import('@/domain')
  const raw = String(formData.get('round_up') ?? '').trim()
  const cents = raw === '' ? 0 : parseAmountOrNull(raw)
  if (cents === null || cents < 0 || cents > 100_000) {
    redirect(`/settings?error=${encodeURIComponent('Enter the step as an amount, like 10, or 0 for the exact figure.')}`)
  }
  await engine.putSetting('transfer_round_up_cents', cents)
  revalidatePath('/')
  revalidatePath('/settings')
  redirect('/settings?saved=1')
}

export async function saveNudgeSettingsAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const weeks = Number(formData.get('check_in_nudge_weeks'))
  if (Number.isInteger(weeks) && weeks >= 1 && weeks <= 12) {
    await engine.putSetting('check_in_nudge_weeks', weeks)
  }
  const lead = Number(formData.get('promo_lead_weeks'))
  if (Number.isInteger(lead) && lead >= 1 && lead <= 52) {
    await engine.putSetting('promo_lead_weeks', lead)
  }
  revalidatePath('/settings')
  redirect('/settings?saved=1')
}

// ---------------------------------------------------------------- equity (PRD §15)

const EQUITY_PATH = '/debts/equity'

/** Back to the equity screen, with a message when something was refused. */
function backToEquity(message: string | null): never {
  revalidatePath(EQUITY_PATH)
  redirect(message ? `${EQUITY_PATH}?error=${encodeURIComponent(message)}` : `${EQUITY_PATH}?saved=1`)
}

/** An engine or domain refusal becomes a message on the page; anything else is a real fault. */
async function refusalOf(run: () => Promise<void>): Promise<string | null> {
  const { AssetDataError } = await import('@/domain')
  const { EngineError } = await import('@/server/engine')
  try {
    await run()
    return null
  } catch (error) {
    if (error instanceof AssetDataError || error instanceof EngineError) return error.message
    throw error
  }
}

export async function createAssetAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull, parsePercentOrNull } = await import('@/domain')
  const kind = formData.get('kind') === 'vehicle' ? 'vehicle' : 'home'
  const valueCents = parseAmountOrNull(formData.get('value') as string)
  if (valueCents === null) backToEquity('Enter what it would sell for, like 425,000.')
  const sellingRaw = String(formData.get('selling_cost') ?? '').trim()
  const sellingCostBasisPoints = sellingRaw === '' ? undefined : parsePercentOrNull(sellingRaw)
  if (sellingCostBasisPoints === null) backToEquity('Enter the cost of selling as a percent, like 7.')

  backToEquity(
    await refusalOf(async () => {
      await engine.createAsset({
        name: String(formData.get('name') ?? ''),
        kind,
        valueCents: valueCents!,
        sellingCostBasisPoints: sellingCostBasisPoints ?? undefined,
      })
    }),
  )
}

export async function updateAssetAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull, parsePercentOrNull } = await import('@/domain')
  const valueCents = parseAmountOrNull(formData.get('value') as string)
  const sellingCostBasisPoints = parsePercentOrNull(formData.get('selling_cost') as string)
  if (valueCents === null) backToEquity('Enter what it would sell for, like 425,000.')
  if (sellingCostBasisPoints === null) backToEquity('Enter the cost of selling as a percent, like 7.')

  backToEquity(
    await refusalOf(() =>
      engine.updateAsset(String(formData.get('asset_id')), {
        name: String(formData.get('name') ?? ''),
        valueCents: valueCents!,
        sellingCostBasisPoints: sellingCostBasisPoints!,
        state: formData.get('sold') ? 'sold' : 'owned',
      }),
    ),
  )
}

export async function removeAssetAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  backToEquity(await refusalOf(() => engine.removeAsset(String(formData.get('asset_id')))))
}

export async function linkDebtToAssetAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const assetId = String(formData.get('asset_id') ?? '')
  backToEquity(
    await refusalOf(() => engine.linkDebtToAsset(String(formData.get('debt_id')), assetId === '' ? null : assetId)),
  )
}

export async function saveHomeBuyingAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseHomeBuyingForm, parsePercentOrNull } = await import('@/domain')
  const field = (name: string) => String(formData.get(name) ?? '')

  const parsed = parseHomeBuyingForm({
    currentHousingPayment: field('current_payment'),
    propertyTaxPercent: field('property_tax'),
    insurancePerYear: field('insurance'),
    mortgageInsurancePercent: field('mortgage_insurance'),
    hoaPerMonth: field('hoa'),
    buyingCostPercent: field('buying_cost'),
    termYears: field('term_years'),
  })
  if (!parsed.ok) backToEquity(parsed.message)

  const typed = field('typed_rate').trim()
  const typedBasisPoints = typed === '' ? null : parsePercentOrNull(typed)
  if (typed !== '' && typedBasisPoints === null) backToEquity('Enter the rate as a percent, like 6.25, or leave it blank.')

  backToEquity(
    await refusalOf(async () => {
      await engine.setHomeBuyingAssumptions(parsed.assumptions)
      await engine.setTypedMortgageRate(typedBasisPoints)
    }),
  )
}

// ---------------------------------------------------------------- trips (PRD §16)

/** Back to a trip, with a message when something was refused. */
function backToTrip(tripId: string, message: string | null, query: string = 'saved=1'): never {
  revalidatePath('/trips')
  revalidatePath(`/trips/${tripId}`)
  redirect(message ? `/trips/${tripId}?error=${encodeURIComponent(message)}` : `/trips/${tripId}?${query}`)
}

/** An engine or domain refusal becomes a message on the page; anything else is a real fault. */
async function tripRefusalOf<T>(run: () => Promise<T>): Promise<{ value: T; message: null } | { value: null; message: string }> {
  const { TripDataError, MoneyError, DateError } = await import('@/domain')
  const { EngineError } = await import('@/server/engine')
  try {
    return { value: await run(), message: null }
  } catch (error) {
    if (error instanceof TripDataError || error instanceof EngineError || error instanceof MoneyError || error instanceof DateError) {
      return { value: null, message: error.message }
    }
    throw error
  }
}

function tripFacts(formData: FormData) {
  const field = (name: string) => String(formData.get(name) ?? '').trim()
  const names = formData.getAll('traveler_name').map(String)
  const bands = formData.getAll('traveler_band').map(String)
  const travelers = names
    .map((name, i) => ({ name: name.trim(), band: (bands[i] ?? 'adult') as 'adult' | 'child' | 'infant' }))
    .filter((t) => t.name !== '')
  const mpg = field('car_mpg')
  const seats = field('car_seats')
  const car = mpg === '' && seats === '' ? null : { mpg: Number(mpg), seats: Number(seats || '5') }
  return { name: field('name'), startDate: field('start_date'), endDate: field('end_date'), travelers, car }
}

export async function createTripAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const facts = tripFacts(formData)
  const made = await tripRefusalOf(async () => {
    assertCivilDate(facts.startDate)
    assertCivilDate(facts.endDate)
    return engine.createTrip(facts)
  })
  if (made.message !== null) {
    revalidatePath('/trips')
    redirect(`/trips?error=${encodeURIComponent(made.message)}`)
  }
  revalidatePath('/trips')
  redirect(`/trips/${made.value.id}`)
}

export async function updateTripAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const facts = tripFacts(formData)
  const done = await tripRefusalOf(async () => {
    assertCivilDate(facts.startDate)
    assertCivilDate(facts.endDate)
    await engine.updateTrip(tripId, facts)
  })
  backToTrip(tripId, done.message)
}

export async function retireTripAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const done = await tripRefusalOf(() => engine.retireTrip(tripId))
  if (done.message !== null) backToTrip(tripId, done.message)
  revalidatePath('/trips')
  redirect('/trips')
}

function variantChoices(formData: FormData) {
  const field = (name: string) => String(formData.get(name) ?? '').trim()
  const promoName = field('promo_name')
  return {
    name: field('name'),
    choices: {
      travel: field('travel') === 'fly' ? ('fly' as const) : ('drive' as const),
      lodging: (['disney_resort', 'dvc_rental', 'rental'].includes(field('lodging')) ? field('lodging') : 'disney_resort') as
        | 'disney_resort'
        | 'dvc_rental'
        | 'rental',
      lightningLane: (['none', 'multi_pass', 'premier'].includes(field('lightning_lane')) ? field('lightning_lane') : 'none') as
        | 'none'
        | 'multi_pass'
        | 'premier',
      dining: field('dining') === 'plan' ? ('plan' as const) : ('out_of_pocket' as const),
      parkDays: Number(field('park_days') || '0'),
      promo:
        promoName === ''
          ? null
          : { name: promoName, percent: field('promo_percent'), amount: field('promo_amount'), category: field('promo_category'), bookBy: field('promo_book_by') },
    },
  }
}

async function choicesWithPromotion(raw: ReturnType<typeof variantChoices>['choices']) {
  const { parseAmountOrNull, parsePercentOrNull, TripDataError, TRIP_LINE_CATEGORIES } = await import('@/domain')
  const { promo, ...choices } = raw
  if (!promo) return choices
  const percent = promo.percent === '' ? null : parsePercentOrNull(promo.percent)
  const amount = promo.amount === '' ? null : parseAmountOrNull(promo.amount)
  if (promo.percent !== '' && percent === null) throw new TripDataError('Enter the deal as a percent, like 25.')
  if (promo.amount !== '' && amount === null) throw new TripDataError('Enter the deal as an amount, like 500.')
  const category = promo.category as (typeof TRIP_LINE_CATEGORIES)[number]
  if (!TRIP_LINE_CATEGORIES.includes(category)) throw new TripDataError('Say what the deal applies to.')
  assertCivilDate(promo.bookBy)
  return {
    ...choices,
    promotion: {
      name: promo.name,
      ...(percent !== null ? { percentOffBasisPoints: percent } : {}),
      ...(amount !== null ? { amountOffCents: amount } : {}),
      appliesToCategory: category,
      bookBy: promo.bookBy,
    },
  }
}

export async function addVariantAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const input = variantChoices(formData)
  const done = await tripRefusalOf(async () => {
    await engine.addVariant(tripId, { name: input.name, choices: await choicesWithPromotion(input.choices) })
  })
  backToTrip(tripId, done.message)
}

export async function updateVariantAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const variantId = String(formData.get('variant_id'))
  const input = variantChoices(formData)
  const done = await tripRefusalOf(async () => {
    await engine.updateVariant(tripId, variantId, { name: input.name, choices: await choicesWithPromotion(input.choices) })
  })
  backToTrip(tripId, done.message)
}

export async function removeVariantAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const done = await tripRefusalOf(() => engine.removeVariant(tripId, String(formData.get('variant_id'))))
  backToTrip(tripId, done.message)
}

export async function updateTripLineAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull, TripDataError } = await import('@/domain')
  const tripId = String(formData.get('trip_id'))
  const field = (name: string) => String(formData.get(name) ?? '').trim()
  const done = await tripRefusalOf(async () => {
    const amount = parseAmountOrNull(field('unit_amount'))
    if (amount === null) throw new TripDataError('Enter the figure as an amount, like 185.')
    const quantity = Number(field('quantity') || '1')
    const dueDate = field('due_date')
    assertCivilDate(dueDate)
    const account = field('reserve_account')
    await engine.updateTripLine(tripId, String(formData.get('line_id')), {
      unitAmountCents: field('category') === 'promotion' ? -Math.abs(amount) || 0 : amount,
      quantity: Number.isInteger(quantity) ? quantity : -1,
      dueDate,
      reserveAccountId: account === '' ? null : account,
      note: field('note'),
    })
  })
  backToTrip(tripId, done.message)
}

export async function addTripLineAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull, TripDataError, TRIP_LINE_CATEGORIES } = await import('@/domain')
  const tripId = String(formData.get('trip_id'))
  const field = (name: string) => String(formData.get(name) ?? '').trim()
  const done = await tripRefusalOf(async () => {
    const amount = parseAmountOrNull(field('unit_amount'))
    if (amount === null) throw new TripDataError('Enter the figure as an amount, like 185.')
    const dueDate = field('due_date')
    assertCivilDate(dueDate)
    const category = field('category') as (typeof TRIP_LINE_CATEGORIES)[number]
    if (!TRIP_LINE_CATEGORIES.includes(category)) throw new TripDataError('Pick which part of the trip this is.')
    const quantity = Number(field('quantity') || '1')
    await engine.addTripLine(tripId, String(formData.get('variant_id')), {
      category,
      label: field('label'),
      quantity: Number.isInteger(quantity) ? quantity : -1,
      unitAmountCents: category === 'promotion' ? -Math.abs(amount) || 0 : amount,
      dueDate,
      reserveAccountId: field('reserve_account') === '' ? null : field('reserve_account'),
      note: field('note'),
    })
  })
  backToTrip(tripId, done.message)
}

export async function removeTripLineAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const done = await tripRefusalOf(() => engine.removeTripLine(tripId, String(formData.get('line_id'))))
  backToTrip(tripId, done.message)
}

/**
 * Look the drive up and show it before anything is stored. The figure comes
 * back in the URL for the person to accept; a failure is a message, never
 * a crash (PRD §16).
 */
export async function checkDriveAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { fetchDrive, tripFetchEnabled } = await import('@/server/trip-fetch')
  const tripId = String(formData.get('trip_id'))
  if (!tripFetchEnabled()) {
    backToTrip(tripId, 'Looking things up is switched off on this machine (TRIP_FETCH=off). Type the miles and hours instead.')
  }
  const trip = (await engine.listTrips()).find((t) => t.id === tripId)
  if (!trip) backToTrip(tripId, 'No such trip.')
  if (!trip.home) backToTrip(tripId, 'Set where home is first, under Trips.')
  let drive: Awaited<ReturnType<typeof fetchDrive>> = null
  try {
    drive = await fetchDrive(trip.home, trip.destination, engine.today())
  } catch (error) {
    backToTrip(tripId, `Could not look up the drive: ${(error as Error).message}`)
  }
  if (!drive) backToTrip(tripId, 'The route service did not answer with a drive. Try again later, or type the miles and hours.')
  backToTrip(tripId, null, `drive=${drive.miles}:${drive.minutes}`)
}

export async function useDriveAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const miles = Number(formData.get('miles'))
  const minutes = Number(formData.get('minutes'))
  const done = await tripRefusalOf(() => engine.recordDriveEstimate(tripId, { miles, minutes, fetchedOn: engine.today() }))
  backToTrip(tripId, done.message)
}

export async function checkGasPriceAction(formData: FormData): Promise<void> {
  await requireEngine()
  const { fetchGasPrice, tripFetchEnabled } = await import('@/server/trip-fetch')
  const tripId = String(formData.get('trip_id'))
  if (!tripFetchEnabled()) {
    backToTrip(tripId, 'Looking things up is switched off on this machine (TRIP_FETCH=off). Type a gas price instead.')
  }
  let gas: Awaited<ReturnType<typeof fetchGasPrice>> = null
  try {
    gas = await fetchGasPrice()
  } catch (error) {
    backToTrip(tripId, `Could not look up the gas price: ${(error as Error).message}`)
  }
  if (!gas) backToTrip(tripId, 'FRED did not answer with a gas price. Try again later, or type one.')
  backToTrip(tripId, null, `gas=${gas.centsPerGallon}:${gas.observationDate}`)
}

export async function useGasPriceAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull, TripDataError } = await import('@/domain')
  const tripId = String(formData.get('trip_id'))
  const done = await tripRefusalOf(async () => {
    const cents = parseAmountOrNull(String(formData.get('dollars_per_gallon') ?? ''))
    if (cents === null) throw new TripDataError('Enter the gas price in dollars a gallon, like 3.05.')
    const observationDate = String(formData.get('observation_date') || engine.today())
    assertCivilDate(observationDate)
    await engine.recordGasPrice({ centsPerGallon: cents, observationDate })
  })
  backToTrip(tripId, done.message)
}

/** Add to Plans: the one-way handoff (PRD §16). */
export async function sendToPlansAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const tripId = String(formData.get('trip_id'))
  const variantId = String(formData.get('variant_id'))
  const account = String(formData.get('reserve_account') ?? '')
  if (account === '') backToTrip(tripId, 'Pick the account the trip saves into.')
  const sent = await tripRefusalOf(() => engine.sendVariantToPlans(tripId, variantId, { defaultAccountId: account }))
  if (sent.message !== null) backToTrip(tripId, sent.message)
  if (!sent.value.ok) backToTrip(tripId, sent.value.problems.map((p) => p.message).join(' '))
  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath('/trips')
  revalidatePath(`/trips/${tripId}`)
  redirect(`/packages/${sent.value.packageId}`)
}

export async function saveReferencePricesAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull, parsePercentOrNull, TripDataError } = await import('@/domain')
  const field = (name: string) => String(formData.get(name) ?? '').trim()
  const done = await tripRefusalOf(async () => {
    const current = await engine.referencePrices()
    const next = current.map((price) => {
      const raw = field(`amount_${price.key}`)
      const amount = price.unit === 'percent' ? parsePercentOrNull(raw) : parseAmountOrNull(raw)
      if (amount === null) throw new TripDataError(`"${price.label}" needs a number.`)
      const typedDate = field(`as_of_${price.key}`)
      // A changed figure was checked today unless a date was typed with it.
      const asOf = typedDate !== '' ? typedDate : amount !== price.amountCents ? engine.today() : price.asOf
      assertCivilDate(asOf)
      return { ...price, amountCents: amount, asOf, sourceUrl: field(`source_${price.key}`) || null }
    })
    await engine.setReferencePrices(next)
  })
  revalidatePath('/trips')
  redirect(done.message ? `/trips?error=${encodeURIComponent(done.message)}` : '/trips?saved=1')
}

export async function saveHomeLocationAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const field = (name: string) => String(formData.get(name) ?? '').trim()
  const done = await tripRefusalOf(() =>
    engine.setHomeLocation({ label: field('label'), latitude: Number(field('latitude')), longitude: Number(field('longitude')) }),
  )
  revalidatePath('/trips')
  redirect(done.message ? `/trips?error=${encodeURIComponent(done.message)}` : '/trips?saved=1')
}
