'use client'

/**
 * "Check for updates" in the footer: asks the registry now instead of
 * waiting for the hourly check. The footer is drawn again when the answer
 * is in, so "Up to date" or the update notice is what the registry just
 * said. While it waits the button says so, and cannot be pressed twice.
 */

import { useFormStatus } from 'react-dom'
import { checkForUpdatesAction } from '@/server/actions'

function Button() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className="underline underline-offset-2 disabled:no-underline disabled:opacity-70">
      {pending ? 'Checking…' : 'Check for updates'}
    </button>
  )
}

export function CheckForUpdates() {
  return (
    <form action={checkForUpdatesAction} className="inline">
      <Button />
    </form>
  )
}
