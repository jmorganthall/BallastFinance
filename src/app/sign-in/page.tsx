import { signIn } from '@/auth'
import { currentViewer } from '@/server/session'
import { redirect } from 'next/navigation'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  if (await currentViewer()) redirect('/')
  const { error } = await searchParams

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <h1 className="text-3xl font-semibold tracking-tight">Ballast</h1>
      <p className="mt-2 text-[var(--color-ink-soft)]">
        What to move into each savings account this week, and whether you are on track.
      </p>

      {error ? (
        <p className="mt-6 rounded-xl bg-[var(--color-behind-soft)] p-3 text-sm text-[var(--color-behind)]">
          That account is not set up for this household. Ask Josh to add your email.
        </p>
      ) : null}

      <form
        className="mt-8"
        action={async () => {
          'use server'
          await signIn('google', { redirectTo: '/' })
        }}
      >
        <button
          type="submit"
          className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-medium text-white"
        >
          Continue with Google
        </button>
      </form>

      <p className="mt-6 text-xs text-[var(--color-ink-soft)]">
        Ballast never connects to your bank and never moves money. It works out the numbers; you
        make the transfers.
      </p>
    </main>
  )
}
