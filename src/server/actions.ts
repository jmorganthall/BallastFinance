'use server'

/**
 * Server actions: the only route from the browser into a mutation, and each one
 * goes through the engine (PRD §10 -- no handler touches tables).
 */

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireEngine } from '@/server/session'
import { INTAKE_CONTRACT_VERSION } from '@/domain'

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

  const lineItems = labels
    .map((label, i) => ({
      label,
      unit_amount: amounts[i] ?? '',
      quantity: Number(quantities[i] ?? '1') || 1,
      due_date: dueDates[i] ?? '',
      reserve_account: accounts[i] ?? '',
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

export async function commitPackageAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const packageId = String(formData.get('package_id'))
  await engine.commitPackage(packageId)
  revalidatePath('/')
  revalidatePath('/packages')
  revalidatePath(`/packages/${packageId}`)
}

export async function updateQuantityAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const lineItemId = String(formData.get('line_item_id'))
  const packageId = String(formData.get('package_id'))
  const quantity = Number(formData.get('quantity'))

  if (Number.isInteger(quantity) && quantity >= 0) {
    await engine.updateLineItem(lineItemId, { quantity })
  }

  revalidatePath('/')
  revalidatePath(`/packages/${packageId}`)
}

export async function updateDueDateAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const lineItemId = String(formData.get('line_item_id'))
  const packageId = String(formData.get('package_id'))
  const dueDate = String(formData.get('due_date'))

  if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    await engine.updateLineItem(lineItemId, { dueDate })
  }

  revalidatePath('/')
  revalidatePath(`/packages/${packageId}`)
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

export async function acceptCatchUpAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const accountId = String(formData.get('reserve_account_id'))
  const accountName = String(formData.get('account_name'))
  const amountCents = Number(formData.get('amount_cents'))
  const kind = String(formData.get('kind'))
  const endsOn = String(formData.get('ends_on') ?? '')

  if (!Number.isFinite(amountCents) || amountCents <= 0) return

  await engine.issueInstruction({
    type: kind === 'rate_bump' ? 'rate_bump' : 'one_time_move',
    amountCents,
    targetId: accountId,
    targetLabel: accountName,
    ...(kind === 'rate_bump' && endsOn ? { endsOn } : {}),
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

  await engine.runAllocation({ floorCents })
  revalidatePath('/')
  revalidatePath('/allocate')
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
