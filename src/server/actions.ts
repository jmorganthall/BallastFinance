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
