import Link from 'next/link'
import { requireEngine } from '@/server/session'
import { PageHeader, Empty } from '@/components/ui'
import { PackageBuilder } from './builder'
import { createReserveAccountAction } from '@/server/actions'

export const dynamic = 'force-dynamic'

export default async function NewPackagePage() {
  const { engine } = await requireEngine()
  const accounts = await engine.listReserveAccounts()

  if (accounts.length === 0) {
    return (
      <>
        <PageHeader
          title="First, where does the money go?"
          subtitle="Name a savings account you already have at Capital One 360."
        />
        <Empty title="No savings accounts set up yet.">
          <form action={createReserveAccountAction} className="mt-4 space-y-3 text-left">
            <label className="block text-sm font-medium">
              Account name
              <input
                name="name"
                required
                placeholder="Annual Expenses"
                className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-ink)]"
              />
            </label>
            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
            >
              Add it
            </button>
          </form>
        </Empty>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Start a plan"
        subtitle="List what it costs and when you need each part. Ballast works out the weekly amount."
      />
      <PackageBuilder accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
      <p className="mt-6 text-center text-sm">
        <Link href="/packages" className="text-[var(--color-accent)] underline">
          Back to plans
        </Link>
      </p>
    </>
  )
}
