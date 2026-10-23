import { describe, expect, it } from 'vitest'
import { LOCAL_SERVERS, PROVIDER_CATALOG, catalogProvider, isReservedProviderId } from '../src/shared/providers/catalog'
import { apiKeyFieldError, checkApiKey } from '../src/shared/providers/apiKey'
import { PROVIDER_APIS, PROVIDER_ID_PATTERN, normalizeProviderBaseURL } from '../src/shared/providers/types'

describe('provider catalog', () => {
  it('lists the main cloud providers once each, with valid ids, protocols and https endpoints', () => {
    const ids = PROVIDER_CATALOG.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['anthropic', 'openai', 'deepseek', 'google', 'wavespeed', 'openrouter', 'groq', 'mistral', 'xai', 'together', 'fireworks', 'moonshot', 'zai', 'qwen', 'huggingface']) {
      expect(ids).toContain(id)
    }
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.id).toMatch(PROVIDER_ID_PATTERN)
      expect(isReservedProviderId(entry.id)).toBe(false)
      expect(PROVIDER_APIS).toContain(entry.api)
      expect(new URL(entry.baseURL).protocol).toBe('https:')
      expect(normalizeProviderBaseURL(entry.baseURL)).toBe(entry.baseURL)
      expect(entry.displayName.length).toBeGreaterThan(0)
      // Headers are attribution only; nothing that looks like a credential.
      for (const name of Object.keys(entry.headers ?? {})) expect(name.toLowerCase()).not.toMatch(/auth|key|token/)
      // Every deviation from the DeepSeek Harness endpoint is explained.
      if (entry.baseURL !== entry.dshBaseURL) expect(entry.note).toBeTruthy()
    }
  })

  it('pins the endpoints and protocols checked against DeepSeek Harness provider data', () => {
    const pinned = Object.fromEntries(PROVIDER_CATALOG.map(p => [p.id, `${p.api} ${p.baseURL}`]))
    expect(pinned).toEqual({
      anthropic: 'anthropic-messages https://api.anthropic.com',
      openai: 'openai-responses https://api.openai.com/v1',
      deepseek: 'openai-completions https://api.deepseek.com',
      google: 'openai-completions https://generativelanguage.googleapis.com/v1beta/openai',
      wavespeed: 'openai-completions https://llm.wavespeed.ai/v1',
      atlascloud: 'openai-completions https://api.atlascloud.ai/v1',
      openrouter: 'openai-completions https://openrouter.ai/api/v1',
      groq: 'openai-completions https://api.groq.com/openai/v1',
      mistral: 'openai-completions https://api.mistral.ai/v1',
      xai: 'openai-completions https://api.x.ai/v1',
      together: 'openai-completions https://api.together.ai/v1',
      fireworks: 'openai-completions https://api.fireworks.ai/inference/v1',
      moonshot: 'openai-completions https://api.moonshot.ai/v1',
      zai: 'openai-completions https://api.z.ai/api/paas/v4',
      'zai-coding': 'openai-completions https://api.z.ai/api/coding/paas/v4',
      qwen: 'openai-completions https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      huggingface: 'openai-completions https://router.huggingface.co/v1',
    })
    // Same values as DSH provider-data.generated.ts where DSH ships the route.
    expect(catalogProvider('anthropic')?.dshBaseURL).toBe('https://api.anthropic.com')
    expect(catalogProvider('deepseek')?.dshBaseURL).toBe('https://api.deepseek.com')
    expect(catalogProvider('huggingface')?.dshBaseURL).toBe('https://router.huggingface.co/v1')
  })

  it('probes local servers on loopback only', () => {
    expect(LOCAL_SERVERS.map(s => s.id)).toEqual(['ollama', 'lmstudio'])
    for (const server of LOCAL_SERVERS) {
      expect(new URL(server.baseURL).hostname).toBe('127.0.0.1')
      expect(isReservedProviderId(server.id)).toBe(true)
    }
    expect(LOCAL_SERVERS.find(s => s.id === 'ollama')?.baseURL).toBe('http://127.0.0.1:11434/v1')
    expect(LOCAL_SERVERS.find(s => s.id === 'lmstudio')?.baseURL).toBe('http://127.0.0.1:1234/v1')
  })
})

describe('API key validation', () => {
  it('accepts real key shapes and trims padding', () => {
    expect(checkApiKey('  sk-ant-api03-abc_DEF-123  ')).toEqual({ ok: true, value: 'sk-ant-api03-abc_DEF-123' })
    expect(checkApiKey('ABCD==')).toEqual({ ok: true, value: 'ABCD==' })
    expect(checkApiKey('hf_abcDEF123')).toEqual({ ok: true, value: 'hf_abcDEF123' })
    expect(checkApiKey('gsk_x=y')).toEqual({ ok: true, value: 'gsk_x=y' })
  })

  it('rejects blank, non-printable, NAME=value and quoted pastes', () => {
    expect(checkApiKey('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(checkApiKey('sk abc')).toEqual({ ok: false, reason: 'illegalCharacters' })
    expect(checkApiKey('sk-ключ')).toEqual({ ok: false, reason: 'illegalCharacters' })
    expect(checkApiKey('sk-abc\u0000')).toEqual({ ok: false, reason: 'illegalCharacters' })
    expect(checkApiKey('OPENAI_API_KEY=sk-abc')).toEqual({ ok: false, reason: 'envLine' })
    expect(checkApiKey('"sk-abc"')).toEqual({ ok: false, reason: 'quoted' })
    expect(checkApiKey("'sk-abc'")).toEqual({ ok: false, reason: 'quoted' })
    expect(checkApiKey('`sk-abc`')).toEqual({ ok: false, reason: 'quoted' })
  })

  it('treats an empty field as "keep the stored key"', () => {
    expect(apiKeyFieldError('')).toBeUndefined()
    expect(apiKeyFieldError(' ')).toBe('empty')
    expect(apiKeyFieldError('sk-ok')).toBeUndefined()
  })
})
