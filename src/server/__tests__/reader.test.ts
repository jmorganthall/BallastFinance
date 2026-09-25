/**
 * The reader (PRD §16 D27), with no network: off until the environment
 * names a key and a model, a reply that fits its shape is accepted, one
 * that does not is refused, and a page or a PDF becomes words before it is
 * sent. Nothing here reaches a model; the fetch is a fake.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_READER_BASE_URL, readerConfig, readerEnabled, readerRequestBody, readerSourceName, readStructured, replyContent, sourceText } from '../reader'

const env = { READER_API_KEY: 'k-test', READER_MODEL: 'test/model-1' }

const reply = (content: unknown, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status })

describe('the reader', () => {
  it('is off unless the key and the model are set, and takes OpenRouter as the default base', () => {
    expect(readerEnabled({})).toBe(false)
    expect(readerEnabled({ READER_API_KEY: 'k' })).toBe(false)
    expect(readerEnabled({ READER_MODEL: 'm' })).toBe(false)
    expect(readerEnabled(env)).toBe(true)
    expect(readerConfig(env)).toEqual({ apiKey: 'k-test', baseUrl: DEFAULT_READER_BASE_URL, model: 'test/model-1' })
    expect(readerConfig({ ...env, READER_BASE_URL: 'https://llm.local/v1/' })?.baseUrl).toBe('https://llm.local/v1')
    expect(readerSourceName('test/model-1')).toBe('read:test/model-1')
  })

  it('refuses without touching the network when it is off', async () => {
    let called = 0
    const fake = (async () => {
      called += 1
      return reply({})
    }) as unknown as typeof fetch
    const got = await readStructured({ source: { text: 'anything' }, shape: 'school_calendar' }, { fetchImpl: fake, env: {} })
    expect(got).toEqual({ ok: false, reason: 'The reader is off: add a reader key in the environment to read PDFs and pages.', sourceUrl: null })
    expect(called).toBe(0)
  })

  it('sends a strict JSON schema to the chat completions endpoint with the key, and accepts a reply that fits', async () => {
    const asked: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      asked.push({ url, init })
      return reply({ schoolYear: '2026-27', daysOff: [{ date: '2027-01-18', label: 'MLK Day' }] })
    }) as unknown as typeof fetch
    const got = await readStructured({ source: { text: 'Jan 18 2027 MLK Day no school' }, shape: 'school_calendar' }, { fetchImpl: fake, env })
    expect(got).toEqual({ ok: true, value: { schoolYear: '2026-27', daysOff: [{ date: '2027-01-18', label: 'MLK Day' }] }, model: 'test/model-1', sourceUrl: null, chars: 29 })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((asked[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k-test')
    const body = JSON.parse(String(asked[0]!.init.body)) as { model: string; response_format: { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }; messages: { content: string }[] }
    expect(body.model).toBe('test/model-1')
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema).toMatchObject({ name: 'school_calendar', strict: true })
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false)
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined()
    expect(body.messages[1]!.content).toContain('Jan 18 2027 MLK Day no school')
  })

  it('refuses a reply that does not fit the shape, one that is not JSON, an error status, and a declined request', async () => {
    const bad = await readStructured({ source: { text: 'x' }, shape: 'school_calendar' }, { fetchImpl: (async () => reply({ schoolYear: '2026-27', daysOff: [{ date: 'Jan 18', label: 'x' }] })) as unknown as typeof fetch, env })
    expect(bad).toMatchObject({ ok: false, reason: expect.stringContaining("did not fit") })
    const prose = await readStructured({ source: { text: 'x' }, shape: 'dvc_listings' }, { fetchImpl: (async () => reply('Sure! Here are the rooms...')) as unknown as typeof fetch, env })
    expect(prose).toMatchObject({ ok: false, reason: 'The reader did not answer with JSON.' })
    const down = await readStructured({ source: { text: 'x' }, shape: 'dvc_listings' }, { fetchImpl: (async () => reply({}, 503)) as unknown as typeof fetch, env })
    expect(down).toMatchObject({ ok: false, reason: 'The reader answered 503.' })
    const declined = await readStructured(
      { source: { text: 'x' }, shape: 'dvc_listings' },
      { fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { refusal: 'I cannot help with that.' } }] }))) as unknown as typeof fetch, env },
    )
    expect(declined).toMatchObject({ ok: false, reason: 'The reader declined: I cannot help with that.' })
    const empty = await readStructured({ source: { text: '   ' }, shape: 'dvc_listings' }, { fetchImpl: (async () => reply({})) as unknown as typeof fetch, env })
    expect(empty).toMatchObject({ ok: false, reason: 'The source had no words to read.' })
  })

  it('fetches a URL as words: a page without its markup, a PDF through the text extractor', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
    const fake = (async (url: string) =>
      url.endsWith('.pdf')
        ? new Response(pdfBytes, { headers: { 'content-type': 'application/octet-stream' } })
        : new Response('<html><head><style>p{}</style><script>x()</script></head><body><h1>Calendar</h1><p>Jan 18: no school</p></body></html>', {
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof fetch
    const pdfToText = async (bytes: Uint8Array) => `pdf words (${bytes.length} bytes)`
    expect(await sourceText({ url: 'https://district.example/cal.pdf' }, { fetchImpl: fake, pdfToText })).toEqual({ text: 'pdf words (8 bytes)', sourceUrl: 'https://district.example/cal.pdf' })
    expect(await sourceText({ url: 'https://district.example/cal' }, { fetchImpl: fake, pdfToText })).toEqual({ text: 'Calendar\nJan 18: no school', sourceUrl: 'https://district.example/cal' })
    expect(await sourceText({ pdfBytes }, { pdfToText })).toEqual({ text: 'pdf words (8 bytes)', sourceUrl: null })
    const failing = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    expect(await readStructured({ source: { url: 'https://district.example/cal.pdf' }, shape: 'school_calendar' }, { fetchImpl: failing, env })).toEqual({
      ok: false,
      reason: 'Could not fetch the source: The source answered 404',
      sourceUrl: 'https://district.example/cal.pdf',
    })
  })

  it('reads the JSON out of a reply, fenced or not, and nothing from anything else', () => {
    expect(replyContent({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] })).toEqual({ a: 1 })
    expect(replyContent({ choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '2}' }] } }] })).toEqual({ a: 2 })
    expect(replyContent({ choices: [] })).toBeUndefined()
    expect(replyContent('nope')).toBeUndefined()
    const body = readerRequestBody({ apiKey: 'k', baseUrl: 'b', model: 'm' }, 'dvc_listings', 'words', 'only June', 500)
    expect(body).toMatchObject({ model: 'm', max_tokens: 500, temperature: 0 })
  })
})
