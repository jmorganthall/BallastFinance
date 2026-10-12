/**
 * What the reader may answer with (PRD §16, D27).
 *
 * The reader (src/server/reader.ts) hands a page or a PDF to a language
 * model and asks for one of these shapes back. The request carries the JSON
 * schema derived here, and the reply is validated here before anything else
 * sees it: a reply that does not fit is refused, whatever the model meant.
 * Nothing that validates is stored on its own -- it is shown to a person
 * first, and kept only when they say so.
 *
 * These shapes carry dates and names, never money the engine would set
 * aside. A listing's price is a fact to look at beside the lodging line,
 * not a figure any math uses.
 */

import { z } from 'zod'

const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date written like 2027-01-18')
  .refine((d) => {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number]
    return y >= 2000 && y <= 2100 && new Date(Date.UTC(y, m - 1, day)).toISOString().slice(0, 10) === d
  }, 'a real calendar date')

/** A school calendar as read from a district's PDF or page: the year and its days off. */
export const SchoolCalendarShape = z.strictObject({
  schoolYear: z.string().min(1).max(20),
  daysOff: z
    .array(
      z.strictObject({
        date: civilDate,
        label: z.string().min(1).max(120),
      }),
    )
    .max(400),
})

export type SchoolCalendarRead = z.infer<typeof SchoolCalendarShape>

/** DVC rooms a broker listed, as read from a page the parser could not. */
export const DvcListingsShape = z.strictObject({
  listings: z
    .array(
      z.strictObject({
        resort: z.string().min(1).max(120),
        room: z.string().min(1).max(120),
        checkIn: civilDate,
        nights: z.number().int().min(1).max(60),
        points: z.number().int().min(0).nullable(),
        priceCents: z.number().int().min(0).nullable(),
      }),
    )
    .max(400),
})

export type DvcListingsRead = z.infer<typeof DvcListingsShape>

/** How busy each theme park is said to be on each day, as read from a crowd calendar page the parsers could not (D23). */
export const CrowdCalendarShape = z.strictObject({
  levels: z
    .array(
      z.strictObject({
        date: civilDate,
        park: z.enum(['magic_kingdom', 'epcot', 'hollywood_studios', 'animal_kingdom']),
        level: z.number().int().min(1).max(10),
      }),
    )
    .max(400),
})

export type CrowdCalendarRead = z.infer<typeof CrowdCalendarShape>

export type ReaderShapeKey = 'school_calendar' | 'dvc_listings' | 'crowd_calendar'

export type ReaderRead = SchoolCalendarRead | DvcListingsRead | CrowdCalendarRead

export const READER_SHAPES = {
  school_calendar: SchoolCalendarShape,
  dvc_listings: DvcListingsShape,
  crowd_calendar: CrowdCalendarShape,
} as const

/** The instruction sent with each shape, in plain words the model follows. */
export const READER_INSTRUCTIONS: Record<ReaderShapeKey, string> = {
  school_calendar:
    'This is a school district calendar. List every day students do not attend school (holidays, breaks, teacher work days, early-release days are NOT days off). Give each day as a separate entry with its date as YYYY-MM-DD and a short label. Expand a multi-day break into one entry per weekday. Give the school year as the calendar names it, like "2026-27". If no days off can be found, return an empty list.',
  dvc_listings:
    'This is a page of Disney Vacation Club rooms a broker has available or confirmed. List each room: resort name, room type, check-in date as YYYY-MM-DD, number of nights, points if shown (else null), and the total price in whole US cents if shown (else null). If no rooms can be found, return an empty list.',
  crowd_calendar:
    'This is a Walt Disney World crowd calendar. For each day it shows, give how busy each of the four theme parks is predicted to be (magic_kingdom, epcot, hollywood_studios, animal_kingdom) on a scale of 1 (quiet) to 10 (packed), with the date as YYYY-MM-DD. If the page uses another scale, convert it to 1-10 proportionally (a 1-5 scale: multiply by 2). If the page gives one level for the whole resort, give that level for each of the four parks. Leave out any day or park the page does not rate. If no levels can be found, return an empty list.',
}

/**
 * The JSON schema a provider's structured-output mode takes. zod v4 emits
 * one; the provider's strict mode also wants every property required and
 * no extras, which the shapes above already satisfy.
 */
export function readerJsonSchema(key: ReaderShapeKey): Record<string, unknown> {
  return z.toJSONSchema(READER_SHAPES[key], { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' }) as Record<string, unknown>
}

/** A reply against its shape: the parsed value, or the problems in words. */
export function validateReaderReply(key: ReaderShapeKey, reply: unknown): { ok: true; value: ReaderRead } | { ok: false; problems: string[] } {
  const result = READER_SHAPES[key].safeParse(reply)
  if (result.success) return { ok: true, value: result.data }
  return { ok: false, problems: result.error.issues.map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`) }
}
