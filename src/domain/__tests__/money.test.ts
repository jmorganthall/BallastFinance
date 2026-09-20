import { describe, expect, it } from 'vitest'
import {
  ceilDiv,
  ceilToWholeDollars,
  formatCents,
  parseAmountOrNull,
  parseAmountToCents,
  parsePercentOrNull,
  proratedCeil,
  roundUpToStep,
} from '../money'

describe('ceiling division', () => {
  it('rounds up, never down -- the household rule', () => {
    expect(ceilDiv(60000, 7)).toBe(8572) // $600 / 7wk = $85.7142... -> $85.72
    expect(ceilDiv(7, 2)).toBe(4)
    expect(ceilDiv(6, 2)).toBe(3) // exact stays exact
  })

  it('is a true mathematical ceiling for negatives', () => {
    expect(ceilDiv(-7, 2)).toBe(-3)
    expect(ceilDiv(-6, 2)).toBe(-3)
  })

  it('rejects non-integers and division by zero', () => {
    expect(() => ceilDiv(1.5, 2)).toThrow()
    expect(() => ceilDiv(1, 0)).toThrow()
  })

  it('a rounded-up weekly rate always funds the target', () => {
    for (const total of [60000, 123457, 1, 99999]) {
      for (const weeks of [1, 3, 7, 13, 52]) {
        expect(ceilDiv(total, weeks) * weeks).toBeGreaterThanOrEqual(total)
      }
    }
  })
})

describe('prorating', () => {
  it('is exact at both endpoints', () => {
    expect(proratedCeil(60000, 0, 7)).toBe(0)
    expect(proratedCeil(60000, 7, 7)).toBe(60000)
    expect(proratedCeil(60000, 99, 7)).toBe(60000) // past the end stays at the total
  })

  it('rounds partial progress up', () => {
    expect(proratedCeil(60000, 1, 7)).toBe(8572)
    expect(proratedCeil(100, 1, 3)).toBe(34)
  })

  it('handles reductions without flipping sign', () => {
    expect(proratedCeil(-60000, 7, 7)).toBe(-60000)
    expect(proratedCeil(-100, 1, 3)).toBe(-33) // ceiling: toward zero
  })
})

describe('parsing and formatting', () => {
  it('round-trips ordinary amounts', () => {
    expect(parseAmountToCents('600')).toBe(60000)
    expect(parseAmountToCents('$1,234.56')).toBe(123456)
    expect(parseAmountToCents('600.5')).toBe(60050)
    expect(parseAmountToCents('-42.10')).toBe(-4210)
  })

  it('rejects junk rather than guessing', () => {
    expect(() => parseAmountToCents('six hundred')).toThrow()
    expect(() => parseAmountToCents('1.234')).toThrow()
    expect(() => parseAmountToCents('')).toThrow()
  })

  it('formats for display', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(8572)).toBe('$85.72')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(-19000)).toBe('-$190.00')
  })

  it('rounds an instruction up to whole dollars', () => {
    expect(ceilToWholeDollars(8572)).toBe(8600)
    expect(ceilToWholeDollars(8600)).toBe(8600)
  })
})

describe('parsing a form field that a person may leave blank', () => {
  it('returns null instead of throwing — a blank box is ordinary input', () => {
    // Regression: a blank minimum-payment box reached parseAmountToCents, which
    // throws, and the server action had no catch. The page 500'd.
    expect(parseAmountOrNull('')).toBeNull()
    expect(parseAmountOrNull('   ')).toBeNull()
    expect(parseAmountOrNull(null)).toBeNull()
    expect(parseAmountOrNull(undefined)).toBeNull()
  })

  it('returns null for junk rather than throwing', () => {
    expect(parseAmountOrNull('abc')).toBeNull()
    expect(parseAmountOrNull('150.000')).toBeNull()
    expect(parseAmountOrNull('-')).toBeNull()
  })

  it('still parses anything real', () => {
    expect(parseAmountOrNull('150')).toBe(15000)
    expect(parseAmountOrNull('$1,234.56')).toBe(123456)
    expect(parseAmountOrNull('0')).toBe(0)
  })
})

describe('parsing a percentage a person typed', () => {
  it('takes the ways people write a rate', () => {
    // Regression: "20.49%" with the sign a card statement prints went through
    // Number(), came back NaN, and the whole form was thrown away over it.
    expect(parsePercentOrNull('20.49')).toBe(2049)
    expect(parsePercentOrNull('20.49%')).toBe(2049)
    expect(parsePercentOrNull(' 20.49 % ')).toBe(2049)
    expect(parsePercentOrNull('2')).toBe(200)
    expect(parsePercentOrNull('0')).toBe(0)
    expect(parsePercentOrNull('.5')).toBeNull() // no leading digit: not a number people type
  })

  it('is exact where floating point is not', () => {
    // 20.49 * 100 is 2048.9999999999998 in IEEE doubles.
    expect(parsePercentOrNull('20.49')).toBe(2049)
    expect(parsePercentOrNull('0.0625')).toBe(6) // rounds to the nearest basis point
    expect(parsePercentOrNull('0.0649')).toBe(6)
    expect(parsePercentOrNull('0.0650')).toBe(7)
  })

  it('returns null for blanks and junk rather than throwing', () => {
    expect(parsePercentOrNull('')).toBeNull()
    expect(parsePercentOrNull('   ')).toBeNull()
    expect(parsePercentOrNull(null)).toBeNull()
    expect(parsePercentOrNull(undefined)).toBeNull()
    expect(parsePercentOrNull('twenty')).toBeNull()
    expect(parsePercentOrNull('20.49.1')).toBeNull()
    expect(parsePercentOrNull('1.23456')).toBeNull()
  })

  it('keeps the sign so the caller can refuse a negative rate with its own words', () => {
    expect(parsePercentOrNull('-5')).toBe(-500)
  })
})

describe('rounding the bank figure up to a step', () => {
  it('rounds up to the nearest step, and leaves an exact multiple alone', () => {
    expect(roundUpToStep(29126, 1000)).toBe(30000)
    expect(roundUpToStep(29126, 500)).toBe(29500)
    expect(roundUpToStep(30000, 1000)).toBe(30000)
    expect(roundUpToStep(1, 1000)).toBe(1000)
  })

  it('is exact with no step, and never rounds nothing or a cut', () => {
    expect(roundUpToStep(29126, 0)).toBe(29126)
    expect(roundUpToStep(0, 1000)).toBe(0)
    expect(roundUpToStep(-2500, 1000)).toBe(-2500)
  })

  it('refuses fractions of a cent', () => {
    expect(() => roundUpToStep(291.26, 1000)).toThrow()
  })
})
