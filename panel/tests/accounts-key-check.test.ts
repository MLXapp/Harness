import { describe, expect, it } from 'vitest'
import { checkProviderKey, WAVESPEED_BALANCE_URL } from '../src/main/providers/keyCheck'
import type { DiscoveryFetch } from '../src/main/providers/discovery'
import { classifyKeyStatus } from '../src/shared/providers/keyCheck'
import { cleanPastedKey } from '../src/shared/providers/apiKey'

type Route = { status?: number; body?: unknown } | 'refuse'

/** Records requests and answers from a table; no network. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fn: DiscoveryFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const route = routes[url]
    if (!route || route === 'refuse') throw new TypeError('fetch failed: ECONNREFUSED')
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {})
    return new Response(body, { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fn, calls }
}

const KEY = 'sk-test-0123456789abcdef'
const listing = (...ids: string[]) => ({ data: ids.map(id => ({ id })) })

describe('pasted keys are tidied before they are checked', () => {
  it.each([
    ['  sk-abc  ', 'sk-abc'],
    ['DEEPSEEK_API_KEY=sk-abc', 'sk-abc'],
    ['export OPENAI_API_KEY="sk-abc"', 'sk-abc'],
    ["'sk-abc'", 'sk-abc'],
    ['Bearer sk-abc', 'sk-abc'],
    ['ANTHROPIC_API_KEY: sk-ant-x', 'sk-ant-x'],
    ['sk-abc;', 'sk-abc'],
    ['ABCD==', 'ABCD=='],
  ])('%j → %j', (raw, clean) => {
    expect(cleanPastedKey(raw)).toBe(clean)
  })
})

describe('key check verdicts', () => {
  it('classifies HTTP answers', () => {
    expect(classifyKeyStatus(200, '')).toBeNull()
    expect(classifyKeyStatus(401, '')).toBe('rejected')
    expect(classifyKeyStatus(403, '')).toBe('rejected')
    expect(classifyKeyStatus(400, 'API key not valid. Please pass a valid API key.')).toBe('rejected')
    expect(classifyKeyStatus(402, '')).toBe('no-credit')
    expect(classifyKeyStatus(429, 'You exceeded your current quota')).toBe('no-credit')
    expect(classifyKeyStatus(429, 'Rate limit')).toBe('network')
    expect(classifyKeyStatus(500, '')).toBe('network')
  })

  it('DeepSeek: lists models with a bearer key, then reads the balance', async () => {
    const { fn, calls } = fakeFetch({
      'https://api.deepseek.com/models': { body: listing('deepseek-v4-pro', 'deepseek-flash', 'deepseek-chat') },
      'https://api.deepseek.com/user/balance': { body: { is_available: true, balance_infos: [] } },
    })
    const result = await checkProviderKey({ providerId: 'deepseek', apiKey: `DEEPSEEK_API_KEY=${KEY}` }, fn)
    expect(result).toMatchObject({ ok: true, models: 3 })
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(calls.map(c => c.url)).toEqual(['https://api.deepseek.com/models', 'https://api.deepseek.com/user/balance'])
  })

  it('DeepSeek: a working key on an account that cannot pay is "no credit"', async () => {
    const { fn } = fakeFetch({
      'https://api.deepseek.com/models': { body: listing('deepseek-flash') },
      'https://api.deepseek.com/user/balance': { body: { is_available: false } },
    })
    expect(await checkProviderKey({ providerId: 'deepseek', apiKey: KEY }, fn)).toMatchObject({ ok: false, reason: 'no-credit' })
  })

  it('Anthropic: x-api-key and anthropic-version on /v1/models', async () => {
    const { fn, calls } = fakeFetch({
      'https://api.anthropic.com/v1/models?limit=1000': { body: listing('claude-opus-5-5') },
    })
    expect(await checkProviderKey({ providerId: 'anthropic', apiKey: KEY }, fn)).toMatchObject({ ok: true, models: 1 })
    expect(calls[0].headers['x-api-key']).toBe(KEY)
    expect(calls[0].headers['anthropic-version']).toBeTruthy()
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it('rejected, no credit and unreachable keys', async () => {
    const openai = 'https://api.openai.com/v1/models'
    const reject = fakeFetch({ [openai]: { status: 401, body: { error: { message: 'Incorrect API key provided' } } } })
    const rejected = await checkProviderKey({ providerId: 'openai', apiKey: KEY }, reject.fn)
    expect(rejected).toMatchObject({ ok: false, reason: 'rejected' })
    expect(JSON.stringify(rejected)).not.toContain(KEY)

    const gemini = 'https://generativelanguage.googleapis.com/v1beta/openai/models'
    const bad = fakeFetch({ [gemini]: { status: 400, body: [{ error: { message: 'API key not valid' } }] } })
    expect(await checkProviderKey({ providerId: 'google', apiKey: 'AIza0123456789' }, bad.fn)).toMatchObject({ ok: false, reason: 'rejected' })

    const broke = fakeFetch({ [openai]: { status: 402, body: { error: { message: 'Payment required' } } } })
    expect(await checkProviderKey({ providerId: 'openai', apiKey: KEY }, broke.fn)).toMatchObject({ ok: false, reason: 'no-credit' })

    const down = fakeFetch({ [openai]: 'refuse' })
    expect(await checkProviderKey({ providerId: 'openai', apiKey: KEY }, down.fn)).toMatchObject({ ok: false, reason: 'network' })
  })

  it('refuses a blank or malformed key without a request', async () => {
    const { fn, calls } = fakeFetch({})
    expect(await checkProviderKey({ providerId: 'openai', apiKey: '   ' }, fn)).toMatchObject({ ok: false, reason: 'format' })
    expect(await checkProviderKey({ providerId: 'openai', apiKey: 'sk-ab cd ef' }, fn)).toMatchObject({ ok: false, reason: 'format' })
    expect(calls).toEqual([])
  })

  it('WaveSpeed AI: proves the key on the balance endpoint, counts the public LLM list', async () => {
    const { fn, calls } = fakeFetch({
      [WAVESPEED_BALANCE_URL]: { body: { code: 200, message: 'success', data: { balance: 12.5 } } },
      'https://llm.wavespeed.ai/v1/models': { body: listing('anthropic/claude-opus-5.5', 'deepseek/deepseek-v4.1-flash-1017') },
    })
    expect(await checkProviderKey({ providerId: 'wavespeed', apiKey: KEY }, fn)).toMatchObject({ ok: true, models: 2 })
    expect(calls[0]).toMatchObject({ url: WAVESPEED_BALANCE_URL })
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    // The public list is read without the key.
    expect(calls[1].headers.authorization).toBeUndefined()
  })

  it('WaveSpeed AI: 401 is rejected, an empty balance is "no credit"', async () => {
    const rejected = fakeFetch({ [WAVESPEED_BALANCE_URL]: { status: 401, body: { code: 401, message: 'Invalid API key' } } })
    expect(await checkProviderKey({ providerId: 'wavespeed', apiKey: KEY }, rejected.fn)).toMatchObject({ ok: false, reason: 'rejected' })
    const empty = fakeFetch({ [WAVESPEED_BALANCE_URL]: { body: { code: 200, data: { balance: 0 } } } })
    expect(await checkProviderKey({ providerId: 'wavespeed', apiKey: KEY }, empty.fn)).toMatchObject({ ok: false, reason: 'no-credit' })
  })

  it('custom endpoints: key optional, 404 explained', async () => {
    const { fn, calls } = fakeFetch({
      'http://192.168.1.20:8000/v1/models': { body: listing('qwen3-coder') },
      'https://nope.example/v1/models': { status: 404, body: 'not found' },
    })
    expect(await checkProviderKey({ baseURL: 'http://192.168.1.20:8000/v1/', api: 'openai-completions' }, fn)).toMatchObject({ ok: true, models: 1 })
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(await checkProviderKey({ baseURL: 'https://nope.example/v1', api: 'openai-completions' }, fn)).toMatchObject({ ok: false, reason: 'network', message: 'No model list at that address' })
    expect(await checkProviderKey({ baseURL: 'ftp://x', api: 'openai-completions' }, fn)).toMatchObject({ ok: false, reason: 'format' })
  })
})

describe('providers:checkKey IPC', () => {
  it('is registered, bounded by a timeout, and exposed in preload and typings', async () => {
    const { readFileSync } = await import('node:fs')
    const ipc = readFileSync('src/main/ipc/providers.ts', 'utf8')
    expect(ipc).toContain("ipcMain.handle('providers:checkKey'")
    expect(ipc).toContain('AbortSignal.timeout(15_000)')
    expect(readFileSync('src/preload/index.ts', 'utf8')).toContain("ipcRenderer.invoke('providers:checkKey', request)")
    expect(readFileSync('src/env.d.ts', 'utf8')).toContain('checkKey: (request')
  })
})
