import { describe, expect, it } from 'vitest'
import { ProviderRouteError, pipelineRoute, resolveProviderRoute, type ProviderResolveDeps } from '../src/main/providers/transport'
import { classifyProviderError, providerErrorMessage } from '../src/main/providers/errors'
import type { PipelineFetch } from '../src/main/providers/anthropic'

const okFetch: PipelineFetch = async () => ({ ok: true, status: 200, statusText: 'OK', body: null, text: async () => '' })

function deps(overrides: Partial<ProviderResolveDeps> = {}): ProviderResolveDeps {
  return {
    getProvider: (id) => id === 'openrouter'
      ? { id, kind: 'catalog', displayName: 'OpenRouter', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', headers: {}, createdAt: 0, models: [{ id: 'x/y', input: ['text'], contextWindow: 1000 }] }
      : id === 'gw'
        ? { id, kind: 'custom', displayName: 'Gateway', api: 'openai-responses', baseURL: 'http://10.0.0.9:8000/v1', headers: {}, createdAt: 0, models: [] }
        : undefined,
    resolveCredential: (id) => (id === 'openrouter' ? 'sk-or-1' : undefined),
    nodeFetch: okFetch,
    netFetch: okFetch,
    ...overrides,
  }
}

describe('provider routes', () => {
  it('extracts the pipeline route after /v1/', () => {
    expect(pipelineRoute('https://openrouter.ai/api/v1/chat/completions')).toBe('chat/completions')
    expect(pipelineRoute('http://127.0.0.1:1/x/v1/responses')).toBe('responses')
    expect(pipelineRoute('http://h/v1/responses/resp_1/cancel')).toBe('responses/resp_1/cancel')
    expect(() => pipelineRoute('http://h/v1/embeddings')).toThrow(ProviderRouteError)
  })

  it('describes a provider as a remote session with its capabilities', () => {
    const route = resolveProviderRoute({ chatId: 'c', providerId: 'openrouter', modelId: 'x/y', reasoningEffort: 'high' }, deps())
    expect(route.session).toMatchObject({ id: 'provider:openrouter', type: 'remote', remoteUrl: 'https://openrouter.ai/api/v1', remoteModel: 'x/y', host: 'openrouter.ai', port: 443, status: 'running' })
    expect(route.session.remoteApiKey).toBeUndefined()
    expect(route.model?.contextWindow).toBe(1000)
    expect(route.wireApi).toBe('completions')
    expect(route.reasoningEffort).toBe('high')
  })

  it('sends to the provider endpoint through the right transport', async () => {
    const seen: Array<{ via: string; url: string; headers: Record<string, string> }> = []
    const spy = (via: string): PipelineFetch => async (url, init) => {
      seen.push({ via, url, headers: init.headers })
      return okFetch(url, init)
    }
    const route = resolveProviderRoute({ chatId: 'c', providerId: 'openrouter', modelId: 'x/y' }, deps({ netFetch: spy('net'), nodeFetch: spy('node') }))
    await route.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer leaked', 'Content-Type': 'application/json' }, body: '{"model":"wrong"}' })
    expect(seen).toEqual([{ via: 'net', url: 'https://openrouter.ai/api/v1/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-or-1' } }])

    // An open custom endpoint (no key) is allowed and sends no Authorization.
    const open = resolveProviderRoute({ chatId: 'c', providerId: 'gw', modelId: 'm' }, deps({ netFetch: spy('net') }))
    expect(open.wireApi).toBe('responses')
    await open.fetch('http://10.0.0.9:8000/v1/responses', { method: 'POST', headers: {}, body: '{}' })
    expect(seen[1]).toEqual({ via: 'net', url: 'http://10.0.0.9:8000/v1/responses', headers: {} })
  })

  it('explains a removed provider or a missing key', () => {
    expect(() => resolveProviderRoute({ chatId: 'c', providerId: 'gone', modelId: 'm' }, deps())).toThrow(/was removed/)
    expect(() => resolveProviderRoute({ chatId: 'c', providerId: 'openrouter', modelId: 'm' }, deps({ resolveCredential: () => undefined }))).toThrow(/has no API key/)
  })
})

describe('provider error messages', () => {
  it('classifies auth, quota, rate limit and overload', () => {
    expect(classifyProviderError(401, '')).toBe('auth')
    expect(classifyProviderError(403, 'forbidden')).toBe('auth')
    expect(classifyProviderError(402, '')).toBe('quota')
    expect(classifyProviderError(429, 'You exceeded your current quota, please check your plan and billing details.')).toBe('quota')
    expect(classifyProviderError(429, 'Rate limit reached for requests')).toBe('rate-limit')
    expect(classifyProviderError(529, 'Overloaded')).toBe('overloaded')
    expect(classifyProviderError(400, 'prompt is too long: 210000 tokens > 200000 maximum')).toBe('other')
  })

  it('keeps the API error prefix and the provider detail', () => {
    const text = providerErrorMessage(401, JSON.stringify({ error: { message: 'Incorrect API key provided' } }), 'OpenAI')
    expect(text).toBe('API error: 401 - OpenAI did not accept the API key: check the API key in Preferences → Models. (Incorrect API key provided)')
    expect(providerErrorMessage(400, '{"error":{"message":"prompt is too long"}}', 'X')).toBe('API error: 400 - prompt is too long')
  })
})
