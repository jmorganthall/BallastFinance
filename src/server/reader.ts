/**
 * The reader: AI as the last resort (PRD §16, D27).
 *
 * For a source that is unstructured or changes shape -- a district's
 * school-calendar PDF, a broker's listing page -- the app may hand the
 * fetched text to a language model and ask for a fixed shape back. This is
 * the one module in the app that knows a model exists. The rules, each
 * enforced here or in the engine, not by convention:
 *
 *   1. Off unless READER_API_KEY, READER_BASE_URL and READER_MODEL are set
 *      in the environment. Never in the database, never on a screen.
 *   2. Structured first. The engine runs the reader only when no parser
 *      applies or a parser returned nothing (its `fallbackToReader` flag,
 *      set by the action after the parser path came back empty).
 *   3. The request carries a JSON schema from the domain's shapes, and the
 *      reply is validated against the zod shape there or refused.
 *   4. What it read is held in a setting and shown to a person before
 *      anything is stored; a fact it read carries source "read:<model>",
 *      the URL and the date.
 *   5. Never used for money math, never on a schedule. Nothing else imports
 *      the model client; there is no client, only one fetch to an
 *      OpenAI-compatible chat completions endpoint.
 *
 * A PDF becomes text through unpdf before it is sent. Every failure is a
 * refusal with a reason for the screen, never a thrown surprise past the
 * action, and nothing here is reachable from the build sandbox: the tests
 * use a fake fetch.
 */

import { READER_INSTRUCTIONS, readerJsonSchema, validateReaderReply, type DvcListingsRead, type ReaderShapeKey, type SchoolCalendarRead } from '@/domain'
import { userAgent } from '@/server/trip-fetch'

export const DEFAULT_READER_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_READER_MAX_TOKENS = 4_000
/** More than this is not a calendar or a listing; it is a whole site. */
export const READER_MAX_SOURCE_CHARS = 120_000

/** The environment as the reader reads it: a plain map, so a test can hand it any set of variables. */
export type ReaderEnv = Record<string, string | undefined>

export interface ReaderConfig {
  apiKey: string
  baseUrl: string
  model: string
}

/** The reader as the environment configures it, or null when any part is missing. */
export function readerConfig(env: ReaderEnv = process.env): ReaderConfig | null {
  const apiKey = env.READER_API_KEY?.trim()
  const model = env.READER_MODEL?.trim()
  if (!apiKey || !model) return null
  const baseUrl = (env.READER_BASE_URL?.trim() || DEFAULT_READER_BASE_URL).replace(/\/+$/, '')
  return { apiKey, baseUrl, model }
}

export function readerEnabled(env: ReaderEnv = process.env): boolean {
  return readerConfig(env) !== null
}

/** "read:<model>": the source a fact the reader read is stored with. */
export function readerSourceName(model: string): `read:${string}` {
  return `read:${model}`
}

export type ReaderInput = { url: string } | { text: string } | { pdfBytes: Uint8Array }

export interface ReadRequest {
  source: ReaderInput
  shape: ReaderShapeKey
  /** Extra words for this source, after the shape's own instruction. */
  instruction?: string
  maxTokens?: number
}

export type ReadResult<T> =
  | { ok: true; value: T; model: string; sourceUrl: string | null; chars: number }
  | { ok: false; reason: string; sourceUrl: string | null }

export interface ReaderDeps {
  fetchImpl?: typeof fetch
  env?: ReaderEnv
  /** PDF bytes to text; unpdf by default. */
  pdfToText?: (bytes: Uint8Array) => Promise<string>
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
}

async function unpdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return typeof text === 'string' ? text : (text as string[]).join('\n')
}

const stripTags = (html: string) =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()

/**
 * The words of a source: a URL fetched (a PDF by its bytes, a page by its
 * text with the markup taken out), a PDF's bytes through unpdf, or text as
 * given. Cut to a size a calendar never exceeds.
 */
export async function sourceText(source: ReaderInput, deps: ReaderDeps = {}): Promise<{ text: string; sourceUrl: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pdfToText = deps.pdfToText ?? unpdfText
  if ('text' in source) return { text: source.text.slice(0, READER_MAX_SOURCE_CHARS), sourceUrl: null }
  if ('pdfBytes' in source) return { text: (await pdfToText(source.pdfBytes)).slice(0, READER_MAX_SOURCE_CHARS), sourceUrl: null }
  const response = await fetchImpl(source.url, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/pdf, text/calendar, text/html, text/plain', 'user-agent': userAgent() },
  })
  if (!response.ok) throw new Error(`The source answered ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  if (type.includes('application/pdf') || looksLikePdf(bytes)) {
    return { text: (await pdfToText(bytes)).slice(0, READER_MAX_SOURCE_CHARS), sourceUrl: source.url }
  }
  const raw = new TextDecoder().decode(bytes)
  const text = type.includes('html') || /<html|<body|<div/i.test(raw) ? stripTags(raw) : raw
  return { text: text.slice(0, READER_MAX_SOURCE_CHARS), sourceUrl: source.url }
}

/** The one shape of request this module sends: OpenAI-compatible chat completions with a strict JSON schema. */
export function readerRequestBody(config: ReaderConfig, shape: ReaderShapeKey, text: string, instruction: string | undefined, maxTokens: number): Record<string, unknown> {
  const schema = { ...readerJsonSchema(shape) }
  delete schema.$schema
  return {
    model: config.model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You read a document and answer with JSON that fits the schema exactly. Never invent a date or a figure that is not in the document. Dates are YYYY-MM-DD.',
      },
      { role: 'user', content: `${READER_INSTRUCTIONS[shape]}${instruction ? `\n\n${instruction}` : ''}\n\nDocument:\n\n${text}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: shape, strict: true, schema },
    },
  }
}

/** The JSON a chat completions reply carries, or nothing readable. */
export function replyContent(body: unknown): unknown {
  const choices = (body as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: { content?: unknown; refusal?: unknown } })?.message
  if (!message) return undefined
  if (typeof message.refusal === 'string' && message.refusal.trim()) return { refusal: message.refusal }
  const content = message.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? '').join('') : ''
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Read a source into a shape. Disabled, unreachable, unreadable, or a reply
 * that does not fit: a refusal with a reason. Never throws past here.
 */
export async function readStructured(request: ReadRequest, deps: ReaderDeps = {}): Promise<ReadResult<SchoolCalendarRead | DvcListingsRead>> {
  const config = readerConfig(deps.env ?? process.env)
  const sourceUrl = 'url' in request.source ? request.source.url : null
  if (!config) return { ok: false, reason: 'The reader is off: add a reader key in the environment to read PDFs and pages.', sourceUrl }
  const fetchImpl = deps.fetchImpl ?? fetch
  let text: string
  try {
    ;({ text } = await sourceText(request.source, deps))
  } catch (error) {
    return { ok: false, reason: `Could not fetch the source: ${(error as Error).message}`, sourceUrl }
  }
  if (!text.trim()) return { ok: false, reason: 'The source had no words to read.', sourceUrl }

  let response: Response
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        'user-agent': userAgent(),
      },
      body: JSON.stringify(readerRequestBody(config, request.shape, text, request.instruction, request.maxTokens ?? DEFAULT_READER_MAX_TOKENS)),
    })
  } catch (error) {
    return { ok: false, reason: `Could not reach the reader: ${(error as Error).message}`, sourceUrl }
  }
  if (!response.ok) return { ok: false, reason: `The reader answered ${response.status}.`, sourceUrl }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'The reader did not answer with JSON.', sourceUrl }
  }
  const content = replyContent(body)
  if (content === undefined) return { ok: false, reason: 'The reader did not answer with JSON.', sourceUrl }
  if (content && typeof content === 'object' && 'refusal' in content && Object.keys(content).length === 1) {
    return { ok: false, reason: `The reader declined: ${String((content as { refusal: unknown }).refusal)}`, sourceUrl }
  }
  const checked = validateReaderReply(request.shape, content)
  if (!checked.ok) return { ok: false, reason: `The reader's answer did not fit: ${checked.problems.slice(0, 3).join('; ')}.`, sourceUrl }
  return { ok: true, value: checked.value, model: config.model, sourceUrl, chars: text.length }
}
