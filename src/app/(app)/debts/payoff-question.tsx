'use client'

/**
 * The one question asked before a car loan or mortgage is paid off (D37).
 *
 * Paid off, a loan is done: it leaves the Debts screen and there is no way
 * back on screen. A typo in "I paid" would otherwise make a real debt vanish,
 * so whichever box would clear it -- "I paid", "The statement says it is" or
 * the balance on "Change its terms" -- stops and asks this once. "Yes"
 * submits again with confirm_payoff=yes, which the engine needs to record it.
 */

import { useRef, useState, type FormEvent, type ReactNode } from 'react'

export function PayoffQuestion({
  name,
  onYes,
  onNo,
}: {
  name: string
  onYes: () => void
  onNo: () => void
}) {
  return (
    <div role="alertdialog" aria-label={`Pay off ${name}?`} className="rounded-xl bg-[var(--color-accent-soft)] p-3 text-sm">
      <p className="font-medium">That pays off {name}, and it will leave this screen. Right?</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onYes}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white"
        >
          Yes, it&rsquo;s paid off
        </button>
        <button
          type="button"
          onClick={onNo}
          className="min-h-11 rounded-lg border border-[var(--color-line)] px-3 text-sm font-medium"
        >
          Not yet
        </button>
      </div>
    </div>
  )
}

/**
 * The hidden answer and the question, for a form that may pay a loan off.
 * `check(event)` stops the submit and asks when `wouldPayOff` says the form as
 * typed clears the loan and nobody has said yes yet.
 */
export function usePayoffQuestion(name: string) {
  const [asking, setAsking] = useState(false)
  const answer = useRef<HTMLInputElement>(null)
  const form = useRef<HTMLFormElement | null>(null)

  function check(event: FormEvent<HTMLFormElement>, wouldPayOff: boolean): boolean {
    form.current = event.currentTarget
    if (answer.current?.value === 'yes' || !wouldPayOff) return true
    event.preventDefault()
    setAsking(true)
    return false
  }

  function yes() {
    setAsking(false)
    if (!answer.current || !form.current) return
    answer.current.value = 'yes'
    form.current.requestSubmit()
    // The submit has read the form by now; the next one asks again.
    setTimeout(() => {
      if (answer.current) answer.current.value = ''
    }, 0)
  }

  const hidden: ReactNode = <input ref={answer} type="hidden" name="confirm_payoff" defaultValue="" />
  const question: ReactNode = asking ? (
    <PayoffQuestion name={name} onYes={yes} onNo={() => setAsking(false)} />
  ) : null

  return { check, hidden, question }
}
