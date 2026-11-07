/**
 * The reader's shapes (PRD §16 D27): a reply is either exactly the shape
 * asked for or refused, and the JSON schema sent with the request is the
 * strict kind a provider's structured-output mode takes.
 */

import { describe, expect, it } from 'vitest'
import { CrowdCalendarShape, DvcListingsShape, READER_INSTRUCTIONS, readerJsonSchema, SchoolCalendarShape, validateReaderReply } from '../reader-shapes'

describe('reader shapes', () => {
  it('accepts a school calendar and refuses a bad date, a missing field, or an extra one', () => {
    const good = { schoolYear: '2026-27', firstDayOfSchool: null, lastDayOfSchool: null, daysOff: [{ date: '2027-01-18', label: 'MLK Day' }] }
    expect(validateReaderReply('school_calendar', good)).toEqual({ ok: true, value: good })
    expect(validateReaderReply('school_calendar', { schoolYear: '2026-27', firstDayOfSchool: null, lastDayOfSchool: null, daysOff: [{ date: '2027-02-30', label: 'x' }] })).toMatchObject({ ok: false })
    expect(validateReaderReply('school_calendar', { schoolYear: '2026-27', firstDayOfSchool: null, lastDayOfSchool: null, daysOff: [{ date: 'Jan 18', label: 'x' }] })).toMatchObject({ ok: false })
    expect(validateReaderReply('school_calendar', { daysOff: [] })).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining('schoolYear')]) })
    expect(SchoolCalendarShape.safeParse({ schoolYear: '2026-27', firstDayOfSchool: null, lastDayOfSchool: null, daysOff: [], extra: 1 }).success).toBe(false)
    expect(validateReaderReply('school_calendar', 'not even an object')).toMatchObject({ ok: false })
  })

  it('takes the first and last day of school as dates or null (D59)', () => {
    const both = { schoolYear: '2026-27', firstDayOfSchool: '2026-08-12', lastDayOfSchool: '2027-05-27', daysOff: [] }
    expect(validateReaderReply('school_calendar', both)).toEqual({ ok: true, value: both })
    expect(validateReaderReply('school_calendar', { ...both, firstDayOfSchool: 'Aug 12' })).toMatchObject({ ok: false })
    expect(validateReaderReply('school_calendar', { schoolYear: '2026-27', daysOff: [] })).toMatchObject({ ok: false })
  })

  it('accepts DVC listings and refuses fractional nights or negative cents', () => {
    const good = { listings: [{ resort: 'Bay Lake Tower', room: 'Studio', checkIn: '2027-06-12', nights: 5, points: 118, priceCents: 224200 }] }
    expect(validateReaderReply('dvc_listings', good)).toEqual({ ok: true, value: good })
    expect(DvcListingsShape.safeParse({ listings: [{ ...good.listings[0], nights: 2.5 }] }).success).toBe(false)
    expect(DvcListingsShape.safeParse({ listings: [{ ...good.listings[0], priceCents: -1 }] }).success).toBe(false)
    expect(DvcListingsShape.safeParse({ listings: [{ ...good.listings[0], points: null, priceCents: null }] }).success).toBe(true)
  })

  it('accepts a crowd calendar of the four theme parks, 1 to 10, and refuses anything else', () => {
    const good = { levels: [{ date: '2026-12-14', park: 'epcot', level: 3 }] }
    expect(validateReaderReply('crowd_calendar', good)).toEqual({ ok: true, value: good })
    expect(CrowdCalendarShape.safeParse({ levels: [{ ...good.levels[0], level: 11 }] }).success).toBe(false)
    expect(CrowdCalendarShape.safeParse({ levels: [{ ...good.levels[0], level: 2.5 }] }).success).toBe(false)
    expect(CrowdCalendarShape.safeParse({ levels: [{ ...good.levels[0], park: 'water_park' }] }).success).toBe(false)
    expect(CrowdCalendarShape.safeParse({ levels: [{ ...good.levels[0], date: '2026-12-32' }] }).success).toBe(false)
    const schema = readerJsonSchema('crowd_calendar') as { required: string[]; additionalProperties: boolean }
    expect(schema).toMatchObject({ required: ['levels'], additionalProperties: false })
  })

  it('emits a strict JSON schema: every property required, no extras', () => {
    const schema = readerJsonSchema('school_calendar') as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> }
    expect(schema.required).toEqual(['schoolYear', 'firstDayOfSchool', 'lastDayOfSchool', 'daysOff'])
    expect(schema.additionalProperties).toBe(false)
    const items = (schema.properties.daysOff as { items: { required: string[]; additionalProperties: boolean } }).items
    expect(items.required).toEqual(['date', 'label'])
    expect(items.additionalProperties).toBe(false)
    expect(READER_INSTRUCTIONS.dvc_listings).toContain('cents')
  })
})
