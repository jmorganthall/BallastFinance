/**
 * Money. Integer cents everywhere (PRD §10: "Money is stored as integer cents").
 *
 * Rounding policy, set by the household: every derived figure errs HIGH.
 * "Would rather have a few cents more than not enough in all expense scenarios."
 * So division rounds up (mathematical ceiling, correct for negatives too), and a
 * weekly instruction is never a cent short of what the plan needs.
 */

/** A whole number of cents. Negative values are legal (reductions, refunds). */
export type Cents = number

export class MoneyError extends Error {}

/**
 * Mathematical ceiling division on integers: the smallest integer >= a / b.
 *
 * Done with integer arithmetic rather than Math.ceil(a / b) so there is no
 * floating-point step to introduce an off-by-one-cent at large magnitudes.
 * Correct for negative `a` as well: ceilDiv(-7, 2) === -3.
 */
export function ceilDiv(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new MoneyError(`ceilDiv needs integers, got ${a} / ${b}`)
  }
  if (b === 0) throw new MoneyError('ceilDiv by zero')
  if (b < 0) return ceilDiv(-a, -b)
  return Math.floor((a + b - 1) / b)
}

/**
 * The share of `totalCents` delivered after `part` of `whole` periods, rounded up.
 *
 * Exact at the endpoints, which is what keeps the accrual invariant honest:
 * proratedCeil(t, 0, w) === 0 and proratedCeil(t, w, w) === t for every t and w.
 */
export function proratedCeil(totalCents: Cents, part: number, whole: number): Cents {
  if (whole <= 0) throw new MoneyError(`prorate needs a positive period count, got ${whole}`)
  if (part <= 0) return 0
  if (part >= whole) return totalCents
  return ceilDiv(totalCents * part, whole)
}

/** Parse a user-entered amount ("1,234.56", "$600", "600.5") into cents. */
export function parseAmountToCents(input: string): Cents {
  const cleaned = input.trim().replace(/[$,\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new MoneyError(`Not an amount: "${input}"`)
  }
  const negative = cleaned.startsWith('-')
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return negative ? -cents : cents
}

/**
 * Parse, or null if it is not an amount.
 *
 * Anything reading a form field should use this rather than parseAmountToCents:
 * a person leaving a box empty, or typing three decimal places, is ordinary
 * input and must produce a message on the page, never a server exception.
 */
export function parseAmountOrNull(input: string | null | undefined): Cents | null {
  if (input === null || input === undefined) return null
  if (input.trim() === '') return null
  try {
    return parseAmountToCents(input)
  } catch {
    return null
  }
}

/**
 * Parse a percentage a person typed ("24.99", "24.99%", " 2 ") into basis
 * points, or null if it is not a percentage. Rates are basis points everywhere
 * else (PRD §10), so this is the only place a rate touches a decimal string.
 *
 * Up to four decimal places are accepted (0.0625% is a real APR), and the
 * result is rounded to the nearest basis point without a floating-point
 * multiply: "20.49" becomes 2049 by string arithmetic, never 2048.9999.
 */
export function parsePercentOrNull(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null
  const cleaned = input.trim().replace(/[%\s,]/g, '')
  if (!/^-?\d+(\.\d{1,4})?$/.test(cleaned)) return null
  const negative = cleaned.startsWith('-')
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.')
  // Basis points are the first two decimals; the rest decide the rounding.
  const bp = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, '0'))
  const rest = frac.slice(2).padEnd(2, '0')
  const rounded = bp + (Number(rest) >= 50 ? 1 : 0)
  return negative ? -rounded : rounded
}

/** "$1,234.56" — the canonical display form. */
export function formatCents(cents: Cents): string {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  const frac = String(abs % 100).padStart(2, '0')
  return `${negative ? '-' : ''}$${whole}.${frac}`
}

/** Round a figure up to the next whole dollar. For instructions a human types into a bank. */
export function ceilToWholeDollars(cents: Cents): Cents {
  return ceilDiv(cents, 100) * 100
}

/**
 * Round a transfer up to the nearest step: $291.26 to the nearest $10 is
 * $300. A household rule for the Capital One figure, so a plan that moves by
 * a few cents does not mean editing the bank every week; the little extra it
 * leaves behind is on purpose ("rather a few cents more than not enough").
 * A step of zero means exact. Nothing at or below zero is rounded: a cut is
 * still a cut.
 */
export function roundUpToStep(cents: Cents, stepCents: Cents): Cents {
  if (!Number.isInteger(cents) || !Number.isInteger(stepCents)) {
    throw new MoneyError(`roundUpToStep needs integers, got ${cents} to ${stepCents}`)
  }
  if (stepCents <= 0 || cents <= 0) return cents
  return ceilDiv(cents, stepCents) * stepCents
}

/** Nearest $10: the household's opening position on how steady the bank figure should be. */
export const DEFAULT_TRANSFER_ROUND_UP_CENTS: Cents = 1000
