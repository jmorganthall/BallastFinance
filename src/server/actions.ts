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
