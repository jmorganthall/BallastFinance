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
  if (name) {
    await engine.createReserveAccount({
      name,
      institutionLabel: institutionLabel || `Capital One 360 — ${name}`,
    })
  }
  revalidatePath('/packages/new')
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
