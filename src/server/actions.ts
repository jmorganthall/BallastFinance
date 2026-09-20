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

export async function createDebtAction(formData: FormData): Promise<void> {
  const { engine } = await requireEngine()
  const { parseAmountOrNull } = await import('@/domain')

  const fail = (message: string): never => redirect(`/debts?error=${encodeURIComponent(message)}`)

  const name = String(formData.get('name') ?? '').trim()
  if (!name) fail('Give the debt a name.')

  const balanceCents = parseAmountOrNull(formData.get('balance') as string)
  if (balanceCents === null) fail('Enter the balance owed, like 5000 or 5,000.00.')
  if (balanceCents! < 0) fail('A balance cannot be negative.')

  const aprRaw = Number(formData.get('apr'))
  if (!Number.isFinite(aprRaw) || aprRaw < 0) fail('Enter the interest rate as a number, like 24.99.')
  // APR arrives as a percentage a human typed; basis points keep it exact.
  const aprBasisPoints = Math.round(aprRaw * 100)

  const minType = String(formData.get('min_type') ?? 'fixed')
  const percentRaw = Number(formData.get('min_percent'))

  let minPaymentRule
  if (minType === 'percent' || minType === 'percent_with_floor') {
    if (!Number.isFinite(percentRaw) || percentRaw <= 0) {
      fail('Enter the minimum payment percentage, like 2.')
    }
    const basisPoints = Math.round(percentRaw * 100)
    if (minType === 'percent') {
      minPaymentRule = { type: 'percent' as const, basisPoints }
    } else {
      const floorCents = parseAmountOrNull(formData.get('min_floor') as string)
      if (floorCents === null) fail('Enter the amount the minimum never drops below, like 25.')
      minPaymentRule = { type: 'percent_with_floor' as const, basisPoints, floorCents: floorCents! }
    }
  } else {
    const amountCents = parseAmountOrNull(formData.get('min_amount') as string)
    // This is the one that crashed: the field is optional in the markup, so a
    // blank box reached a parser that throws.
    if (amountCents === null) fail('Enter the minimum payment each month, like 150.')
    if (amountCents! <= 0) fail('The minimum payment must be more than zero.')
    minPaymentRule = { type: 'fixed' as const, amountCents: amountCents! }
  }

  const promoUntil = String(formData.get('promo_until') ?? '').trim()
  const promoRules = promoUntil
    ? [
        {
          rateBasisPoints: Math.round(Number(formData.get('promo_rate') ?? 0) * 100),
          appliesTo: 'full' as const,
          untilDate: promoUntil,
        },
      ]
    : []

  const limitRaw = String(formData.get('credit_limit') ?? '').trim()
  const creditLimitCents = limitRaw === '' ? null : parseAmountOrNull(limitRaw)
  if (limitRaw !== '' && creditLimitCents === null) {
    fail('That credit limit did not look like an amount. Leave it blank if there is none.')
  }

  try {
    await engine.createDebt({
      name,
      category: (String(formData.get('category') ?? 'consumer') as 'consumer' | 'auto' | 'mortgage'),
      balanceCents: balanceCents!,
      aprBasisPoints,
      minPaymentRule,
      promoRules,
      creditLimitCents,
      fixedPayment: formData.get('fixed_payment') === 'on',
    })
  } catch (error) {
    // A rejected debt comes back as a readable message on the page rather than
    // a crash; the rate guard exists to be seen, not to break the form.
    const { DebtDataError } = await import('@/domain')
    if (error instanceof DebtDataError) {
      redirect(`/debts?error=${encodeURIComponent(error.message)}`)
    }
    throw error
  }

  revalidatePath('/debts')
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
