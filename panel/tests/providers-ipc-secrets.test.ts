/**
 * The renderer may send an API key; it never gets one back. Every provider
 * IPC reply is checked for the key and its ciphertext, and the stored key is
 * only sent to the stored provider's own endpoint.
 */
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  fetches: [] as Array<{ url: string; headers: Record<string, string> }>,
  store: undefined as any,
  sessions: [] as any[],
  sent: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn) },
  BrowserWindow: class {},
  net: {
    fetch: async (url: string, init: any) => {
      h.fetches.push({ url, headers: init.headers })
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 })
    },
  },
}))

vi.mock('../src/main/database', () => ({
  db: {
    get providers() { return h.store },
    getSessions: () => h.sessions.map(({ remoteApiKey: _omit, ...rest }) => rest),
    getSession: (id: string) => h.sessions.find(s => s.id === id),
  },
}))

const KEY = 'sk-live-SECRET-0123456789'
const OTHER_KEY = 'sk-imported-SECRET-987'

const call = (channel: string, ...args: any[]) => h.handlers.get(channel)!({}, ...args)

function assertNoSecret(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain(KEY)
  expect(text).not.toContain(OTHER_KEY)
  expect(text).not.toMatch(/enc:/)
}

beforeAll(async () => {
  const { registerProviderHandlers } = await import('../src/main/ipc/providers')
  registerProviderHandlers(() => ({ isDestroyed: () => false, webContents: { send: (ch: string) => h.sent.push(ch) } }) as any)
})

beforeEach(async () => {
  const { ensureProviderSchema, ProviderStore } = await import('../src/main/providers/store')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY)')
  ensureProviderSchema(db)
  h.store = new ProviderStore(db, {
    encrypt: p => 'enc:' + Buffer.from(p).toString('hex'),
    decrypt: c => Buffer.from(c.slice(4), 'hex').toString(),
  })
  h.fetches = []
  h.sent = []
  h.sessions = []
})

describe('provider IPC never returns secrets', () => {
  it('save, list, setKey and discover reply with configured flags only', async () => {
    const saved = await call('providers:save', { id: 'openai', kind: 'catalog', displayName: '', api: 'openai-responses', baseURL: '', models: [] }, KEY)
    expect(saved.ok).toBe(true)
    expect(saved.provider.configured).toBe(true)
    assertNoSecret(saved)
    expect(h.sent).toContain('providers:changed')

    const list = await call('providers:list')
    expect(list.providers[0]).toMatchObject({ id: 'openai', configured: true, needsKey: true })
    assertNoSecret(list)

    assertNoSecret(await call('providers:setKey', 'openai', KEY))
    assertNoSecret(await call('providers:catalog'))

    // Discovery with the stored key: sent to the stored endpoint, not returned.
    const discovered = await call('providers:discover', { providerId: 'openai', baseURL: 'https://api.openai.com/v1', api: 'openai-responses' })
    expect(discovered).toEqual({ ok: true, models: [{ id: 'model-a' }] })
    expect(h.fetches[0]).toMatchObject({ url: 'https://api.openai.com/v1/models' })
    expect(h.fetches[0].headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('does not send the stored key to an edited endpoint', async () => {
    await call('providers:save', { id: 'openai', kind: 'catalog', displayName: '', api: 'openai-responses', baseURL: '', models: [] }, KEY)
    const result = await call('providers:discover', { providerId: 'openai', baseURL: 'https://attacker.example/v1', api: 'openai-responses' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/enter the API key again/)
    expect(h.fetches).toHaveLength(0)
  })

  it('refuses malformed keys with a readable error and stores nothing', async () => {
    const result = await call('providers:save', { id: 'groq', kind: 'catalog', displayName: '', api: 'openai-completions', baseURL: '', models: [] }, 'GROQ_API_KEY=gsk_x')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/API key/)
    expect(h.store.hasCredential('groq')).toBe(false)
  })

  it('imports a remote session as a custom provider without echoing its key', async () => {
    h.sessions = [{ id: 's1', type: 'remote', remoteUrl: 'https://llm.example.com/v1', remoteModel: 'big-model', remoteApiKey: OTHER_KEY }]
    const candidates = await call('providers:remoteSessionCandidates')
    expect(candidates).toEqual([{ sessionId: 's1', remoteUrl: 'https://llm.example.com/v1', remoteModel: 'big-model' }])
    const imported = await call('providers:importRemoteSession', 's1')
    expect(imported.ok).toBe(true)
    expect(imported.provider).toMatchObject({ id: 'llm-example-com', kind: 'custom', baseURL: 'https://llm.example.com/v1', configured: true })
    expect(imported.provider.models).toEqual([{ id: 'big-model', input: ['text'] }])
    assertNoSecret(imported)
    expect(h.store.resolveCredential('llm-example-com')).toBe(OTHER_KEY)
    // The session is untouched.
    expect(h.sessions[0].remoteApiKey).toBe(OTHER_KEY)
  })

  it('exposes no key-reading channel to the renderer', () => {
    const preload = readFileSync('src/preload/index.ts', 'utf8')
    const providersBlock = preload.slice(preload.indexOf('  providers: {'), preload.indexOf('\n  },', preload.indexOf('  providers: {')))
    expect(providersBlock).toContain("ipcRenderer.invoke('providers:setKey'")
    expect(providersBlock).not.toMatch(/getKey|resolveCredential|readKey/)
    expect([...h.handlers.keys()].filter(c => c.startsWith('providers:')).sort()).toEqual([
      'providers:catalog', 'providers:checkKey', 'providers:clearChatModel', 'providers:clearKey', 'providers:delete', 'providers:discover',
      'providers:getChatModel', 'providers:importRemoteSession', 'providers:list', 'providers:probeLocal',
      'providers:remoteSessionCandidates', 'providers:save', 'providers:setChatModel', 'providers:setKey',
    ])
  })
})
