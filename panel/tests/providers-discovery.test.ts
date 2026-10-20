import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DiscoveryError, discoverModels, listingUrl, probeLocalServers, readListing, type DiscoveryFetch } from '../src/main/providers/discovery'

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures/providers', name), 'utf8'))

/** Records requests and answers from a table; no network. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown } | 'refuse'>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fn: DiscoveryFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const route = routes[url]
    if (!route || route === 'refuse') throw new TypeError('fetch failed: ECONNREFUSED')
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fn, calls }
}

describe('listing URLs', () => {
  it('appends /models to OpenAI bases and normalizes the Anthropic root', () => {
    expect(listingUrl('https://api.openai.com/v1', 'openai-responses')).toBe('https://api.openai.com/v1/models')
    expect(listingUrl('https://gateway.example/openai/v1/', 'openai-completions')).toBe('https://gateway.example/openai/v1/models')
    expect(listingUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'openai-completions')).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
    expect(listingUrl('https://api.anthropic.com', 'anthropic-messages')).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(listingUrl('https://api.anthropic.com/v1/', 'anthropic-messages')).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(listingUrl('https://proxy.example/anthropic', 'anthropic-messages')).toBe('https://proxy.example/anthropic/v1/models?limit=1000')
  })
})

describe('listing parser', () => {
  it('reads OpenAI listings, skipping rows without an id and duplicates', () => {
    expect(readListing(fixture('openai-models.json'))).toEqual([{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }])
  })

  it('reads Anthropic display names', () => {
    expect(readListing(fixture('anthropic-models.json'))).toEqual([
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ])
  })

  it('reads OpenRouter capacities and image input', () => {
    expect(readListing(fixture('openrouter-models.json'))).toEqual([
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek: DeepSeek V3', contextWindow: 163840, maxTokens: 8192, input: ['text'] },
      { id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 65535, input: ['text', 'image'] },
    ])
  })

  it('reads enriched gateway maps keyed by the endpoint-facing id', () => {
    expect(readListing(fixture('gateway-models-map.json'))).toEqual([
      { id: 'fast', name: 'Fast', contextWindow: 131072, maxTokens: 16384 },
      { id: 'smart', name: 'Smart', contextWindow: 200000, maxTokens: 32000 },
      { id: 'fallback-id' },
    ])
  })

  it('refuses a reply that is not a listing', () => {
    expect(() => readListing({ object: 'error' })).toThrow(DiscoveryError)
    expect(() => readListing(null)).toThrow(/by hand/)
  })
})

describe('discoverModels', () => {
  it('uses a bearer key for OpenAI protocols', async () => {
    const { fn, calls } = fakeFetch({ 'https://api.openai.com/v1/models': { body: fixture('openai-models.json') } })
    const models = await discoverModels({ baseURL: 'https://api.openai.com/v1', api: 'openai-responses', apiKey: ' sk-abc ' }, fn)
    expect(models.map(m => m.id)).toEqual(['gpt-4.1', 'gpt-4.1-mini'])
    expect(calls[0].headers.authorization).toBe('Bearer sk-abc')
    expect(calls[0].headers['x-api-key']).toBeUndefined()
  })

  it('uses x-api-key and anthropic-version for Anthropic', async () => {
    const { fn, calls } = fakeFetch({ 'https://api.anthropic.com/v1/models?limit=1000': { body: fixture('anthropic-models.json') } })
    const models = await discoverModels({ baseURL: 'https://api.anthropic.com/v1', api: 'anthropic-messages', apiKey: 'sk-ant-1' }, fn)
    expect(models).toHaveLength(2)
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-1')
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it('maps 401/403 to a key problem and refuses malformed keys before any request', async () => {
    const { fn, calls } = fakeFetch({ 'https://api.groq.com/openai/v1/models': { status: 401, body: { error: { message: 'Invalid API Key' } } } })
    await expect(discoverModels({ baseURL: 'https://api.groq.com/openai/v1', api: 'openai-completions', apiKey: 'gsk_bad' }, fn))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED', message: expect.stringContaining('check the API key') })
    await expect(discoverModels({ baseURL: 'https://api.groq.com/openai/v1', api: 'openai-completions', apiKey: 'GROQ_API_KEY=gsk' }, fn))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(calls).toHaveLength(1)
  })

  it('reports an unreachable endpoint and a non-JSON reply', async () => {
    await expect(discoverModels({ baseURL: 'https://down.example/v1', api: 'openai-completions' }, fakeFetch({}).fn))
      .rejects.toThrow(/Could not reach https:\/\/down.example\/v1\/models/)
    const html: DiscoveryFetch = async () => new Response('<html>', { status: 200 })
    await expect(discoverModels({ baseURL: 'https://x.example/v1', api: 'openai-completions' }, html)).rejects.toThrow(/JSON/)
  })
})

describe('local server probe', () => {
  it('lists reachable servers with their models and placeholder keys', async () => {
    const { fn, calls } = fakeFetch({
      'http://127.0.0.1:11434/v1/models': 'refuse',
      'http://127.0.0.1:1234/v1/models': { body: fixture('lmstudio-models.json') },
    })
    const probes = await probeLocalServers(fn)
    expect(probes).toEqual([
      { id: 'ollama', displayName: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', reachable: false, models: [] },
      { id: 'lmstudio', displayName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', reachable: true, models: [{ id: 'qwen2.5-7b-instruct-mlx' }] },
    ])
    expect(calls.map(c => c.headers.authorization)).toEqual(['Bearer ollama', 'Bearer lm-studio'])
  })
})
