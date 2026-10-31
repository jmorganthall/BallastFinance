/**
 * The family's trip shape (PRD D55): park days with a travel day each side,
 * and when a drive is split. Each rule at the top of trip-shape.ts has a
 * case here, on a 7.5-hour drive with two drivers (an easy stretch of 4
 * hours) unless the case needs otherwise.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRIP_SHAPE,
  easyStretchMinutes,
  parseParkDays,
  shapeSchoolDaysMissed,
  shapeWindow,
  shapeWords,
  validateTripShape,
  type ShapedWindow,
} from '../trip-shape'
import { TripPlanError } from '../trip-plan'

// 2026-11-06 is a Friday.
const weekdaySchool = (d: string) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay()
  return wd !== 0 && wd !== 6
}
const noSchool = () => false
const canGo = () => false

function shape(over: Partial<Parameters<typeof shapeWindow>[0]> = {}): ShapedWindow {
  return shapeWindow({
    firstParkDate: '2026-11-07',
    parkDays: 2,
    driveMinutes: 450,
    stretchMinutes: 240,
    splitWhenFree: true,
    isSchoolDay: weekdaySchool,
    isCantGo: canGo,
    ...over,
  })
}

const roles = (w: ShapedWindow) => w.days.map((d) => `${d.date.slice(5)} ${d.role}`)

describe('the easy stretch and the settings', () => {
  it('is two hours a driver unless typed', () => {
    expect(easyStretchMinutes(DEFAULT_TRIP_SHAPE)).toBe(240)
    expect(easyStretchMinutes({ adultDrivers: 1, easyStretchMinutes: null })).toBe(120)
    expect(easyStretchMinutes({ adultDrivers: 2, easyStretchMinutes: 210 })).toBe(210)
  })

  it('reads park days from the address, and nothing from anything else', () => {
    expect(parseParkDays('3-4')).toEqual({ min: 3, max: 4 })
    expect(parseParkDays('5')).toEqual({ min: 5, max: 5 })
    expect(parseParkDays('4-2')).toBeNull()
    expect(parseParkDays('0')).toBeNull()
    expect(parseParkDays('lots')).toBeNull()
    expect(parseParkDays(undefined)).toBeNull()
  })

  it('refuses a shape that cannot be laid out, in plain words', () => {
    expect(() => validateTripShape(DEFAULT_TRIP_SHAPE)).not.toThrow()
    expect(() => validateTripShape({ ...DEFAULT_TRIP_SHAPE, parkDaysMin: 5, parkDaysMax: 3 })).toThrow(TripPlanError)
    expect(() => validateTripShape({ ...DEFAULT_TRIP_SHAPE, adultDrivers: 0 })).toThrow(/drivers/)
    expect(() => validateTripShape({ ...DEFAULT_TRIP_SHAPE, easyStretchMinutes: 30 })).toThrow(/1 to 12 hours/)
    expect(() => validateTripShape({ ...DEFAULT_TRIP_SHAPE, stay: { kind: 'resort', name: ' ' } })).toThrow(/resort/)
  })
})

describe('the way down', () => {
  it('splits when the travel day would cost school and the morning leg is easy: the arrival day is a quick park day', () => {
    const w = shape()
    expect(w.down).toBe('split_quick')
    expect(w.downReason).toBe('needed')
    expect(roles(w)).toEqual(['11-06 leave_evening', '11-07 quick_park', '11-08 park', '11-09 travel'])
    expect(w.parkDays).toBe(2)
    expect(w.resortNights).toEqual(['2026-11-07', '2026-11-08'])
    expect(w.roadNights).toBe(1)
    // Leaving Friday after school costs nothing; driving home on Monday costs a day.
    expect(shapeSchoolDaysMissed(w, weekdaySchool)).toBe(1)
    expect(shapeWords(w)).toBe('leave Fri evening → quick park day Sat · 2 park days (first quick) · home Mon')
  })

  it('splits by preference when it is free: leave the evening before the travel day, arrive on it', () => {
    const w = shape({ isSchoolDay: noSchool })
    expect(w.down).toBe('split')
    expect(w.downReason).toBe('preferred')
    expect(roles(w)).toEqual(['11-05 leave_evening', '11-06 travel', '11-07 park', '11-08 park', '11-09 travel'])
    expect(w.resortNights).toEqual(['2026-11-06', '2026-11-07', '2026-11-08'])
    expect(w.roadNights).toBe(1)
  })

  it('does a full travel day when the family does not split by preference, or the evening is a day we cannot go', () => {
    expect(shape({ isSchoolDay: noSchool, splitWhenFree: false }).down).toBe('full')
    expect(shape({ isSchoolDay: noSchool, isCantGo: (d) => d === '2026-11-05' }).down).toBe('full')
    expect(roles(shape({ isSchoolDay: noSchool, splitWhenFree: false }))).toEqual(['11-06 travel', '11-07 park', '11-08 park', '11-09 travel'])
  })

  it('always splits a drive longer than two easy stretches, but no quick day when the morning leg is long too', () => {
    const w = shape({ driveMinutes: 540, splitWhenFree: false })
    expect(w.down).toBe('split')
    expect(w.downReason).toBe('ceiling')
    expect(w.home).toBe('split')
    // The Friday travel day still costs school; nothing could save it.
    expect(shapeSchoolDaysMissed(w, weekdaySchool)).toBe(2)
  })

  it('drives a short trip the evening before, after school, and sleeps at the resort', () => {
    const w = shape({ driveMinutes: 200 })
    expect(w.down).toBe('evening')
    expect(w.roadNights).toBe(0)
    expect(w.resortNights[0]).toBe('2026-11-06')
    expect(shapeSchoolDaysMissed(w, weekdaySchool)).toBe(1)
  })

  it('is a full travel day each way, and says so, with no drive looked up', () => {
    const w = shape({ driveMinutes: null })
    expect(w.driveKnown).toBe(false)
    expect([w.down, w.home]).toEqual(['full', 'full'])
  })
})

describe('the way home', () => {
  it('splits by preference only on a long trip: the last park day is quick and home the next morning', () => {
    expect(shape({ parkDays: 4, isSchoolDay: noSchool }).home).toBe('full')
    const w = shape({ parkDays: 5, isSchoolDay: noSchool })
    expect(w.home).toBe('split')
    expect(w.days.at(-2)).toEqual({ date: '2026-11-11', role: 'quick_park' })
    expect(w.resortNights.at(-1)).toBe('2026-11-10')
    expect(w.roadNights).toBe(2)
    expect(shapeWords(w)).toBe('leave Thu evening, arrive Fri · 5 park days (last quick) · leave Wed evening, home Thu')
  })

  it('is never split for need: the morning drive still uses the day', () => {
    expect(shape({ parkDays: 2, isSchoolDay: () => true }).home).toBe('full')
  })
})
