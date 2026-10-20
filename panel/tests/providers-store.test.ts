import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { ensureProviderSchema, ProviderStore, type SecretBox } from '../src/main/providers/store'

const KEY = 'sk-test-0123456789abcdef'

/** Reversible fake of safeStorage: never stores the plaintext as-is. */
function fakeBox(available = true): SecretBox & { encrypted: string[] } {
  const encrypted: string[] = []
  return {
    encrypted,
    encrypt(plain: string) {
      if (!available) throw new Error('Secure storage (Keychain) is unavailable, so the API key was not saved')
      const cipher = 'enc:' + Buffer.from(plain.split('').reverse().join('')).toString('base64')
      encrypted.push(cipher)
      return cipher
    },
    decrypt(cipher: string) {
      if (!cipher.startsWith('enc:')) return ''
      return Buffer.from(cipher.slice(4), 'base64').toString().split('').reverse().join('')
    },
  }
}

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, folder_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_id TEXT NOT NULL, model_path TEXT)`)
  ensureProviderSchema(db)
  return db
}

describe('provider store', () => {
  let db: Database.Database
  let box: ReturnType<typeof fakeBox>
  let store: ProviderStore

  beforeEach(() => {
    db = freshDb()
    box = fakeBox()
    store = new ProviderStore(db, box)
  })

  it('creates catalog and custom providers with validated fields', () => {
    const anthropic = store.save({ id: 'anthropic', kind: 'catalog', displayName: '', api: 'anthropic-messages', baseURL: '', models: [] })
    expect(anthropic.baseURL).toBe('https://api.anthropic.com')
    expect(anthropic.displayName).toBe('Anthropic')

    const custom = store.save({
      id: 'my-gateway', kind: 'custom', displayName: 'Gateway', api: 'openai-completions',
      baseURL: 'http://10.0.0.5:8080/v1/', models: [{ id: 'm1', input: ['text', 'image'], contextWindow: 32768, reasoningEfforts: ['low', 'high'] }],
    })
    expect(custom.baseURL).toBe('http://10.0.0.5:8080/v1')
    expect(custom.models[0]).toEqual({ id: 'm1', input: ['text', 'image'], contextWindow: 32768, reasoningEfforts: ['low', 'high'] })
    expect(store.list().map(p => p.id)).toEqual(['anthropic', 'my-gateway'])

    expect(() => store.save({ id: 'Bad Id', kind: 'custom', displayName: '', api: 'openai-completions', baseURL: 'https://x.test', models: [] })).toThrow(/Provider id/)
    expect(() => store.save({ id: 'ollama', kind: 'custom', displayName: '', api: 'openai-completions', baseURL: 'https://x.test', models: [] })).toThrow(/reserved/)
    expect(() => store.save({ id: 'nope', kind: 'catalog', displayName: '', api: 'openai-completions', baseURL: '', models: [] })).toThrow(/catalog/)
    expect(() => store.save({ id: 'x', kind: 'custom', displayName: '', api: 'openai-completions', baseURL: 'ftp://x', models: [] })).toThrow(/http/)
    expect(() => store.save({ id: 'x', kind: 'custom', displayName: '', api: 'openai-completions', baseURL: 'https://user:pw@x.test', models: [] })).toThrow(/key field/)
    expect(() => store.save({ id: 'x', kind: 'custom', displayName: '', api: 'openai-completions', baseURL: 'https://x.test', models: [{ id: 'a', input: ['text'] }, { id: 'a', input: ['text'] }] })).toThrow(/twice/)
    expect(() => store.save({ id: 'x', kind: 'custom', displayName: '', api: 'grpc' as any, baseURL: 'https://x.test', models: [] })).toThrow(/protocol/)
  })

  it('stores keys only as Keychain ciphertext and never puts them in a view', () => {
    store.save({ id: 'openai', kind: 'catalog', displayName: '', api: 'openai-responses', baseURL: '', models: [] })
    expect(store.view(store.get('openai')!).configured).toBe(false)

    store.setCredential('openai', `  ${KEY}  `)
    const rows = db.prepare('SELECT ref, ciphertext FROM credentials').all() as Array<{ ref: string; ciphertext: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].ref).toBe('provider/openai')
    expect(rows[0].ciphertext.startsWith('enc:')).toBe(true)
    expect(rows[0].ciphertext).not.toContain(KEY)

    const view = store.view(store.get('openai')!)
    expect(view.configured).toBe(true)
    expect(JSON.stringify(view)).not.toContain(KEY)
    expect(JSON.stringify(view)).not.toContain(rows[0].ciphertext)
    expect(store.resolveCredential('openai')).toBe(KEY)

    store.clearCredential('openai')
    expect(store.hasCredential('openai')).toBe(false)
    expect(store.resolveCredential('openai')).toBeUndefined()
  })

  it('refuses to store a key when encryption is unavailable (no plaintext fallback)', () => {
    const locked = new ProviderStore(db, fakeBox(false))
    locked.save({ id: 'groq', kind: 'catalog', displayName: '', api: 'openai-completions', baseURL: '', models: [] })
    expect(() => locked.setCredential('groq', KEY)).toThrow(/Keychain/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM credentials').get()).toEqual({ n: 0 })

    // A SecretBox that "encrypts" to plaintext is refused too, and so is a
    // direct plaintext row (table CHECK).
    const leaky = new ProviderStore(db, { encrypt: p => p, decrypt: c => c })
    expect(() => leaky.setCredential('groq', KEY)).toThrow(/not saved/)
    expect(() => db.prepare("INSERT INTO credentials (ref, ciphertext, updated_at) VALUES ('provider/groq', ?, 0)").run(KEY)).toThrow()
  })

  it('validates the key before storing it', () => {
    store.save({ id: 'xai', kind: 'catalog', displayName: '', api: 'openai-completions', baseURL: '', models: [] })
    expect(() => store.setCredential('xai', '   ')).toThrow(/blank/)
    expect(() => store.setCredential('xai', 'XAI_API_KEY=xai-123')).toThrow(/API key/)
    expect(() => store.setCredential('xai', '"xai-123"')).toThrow(/API key/)
    expect(() => store.setCredential('xai', 'xai 123')).toThrow(/API key/)
    expect(() => store.setCredential('missing', KEY)).toThrow(/Unknown provider/)
    expect(box.encrypted).toHaveLength(0)
  })

  it('binds chats to provider models and cleans up on chat or provider delete', () => {
    store.save({ id: 'deepseek', kind: 'catalog', displayName: '', api: 'openai-completions', baseURL: '', models: [{ id: 'deepseek-chat', input: ['text'] }] })
    store.setCredential('deepseek', KEY)
    db.prepare("INSERT INTO chats (id, title, created_at, updated_at, model_id) VALUES ('c1', 't', 0, 0, 'm'), ('c2', 't', 0, 0, 'm')").run()

    store.setChatBinding({ chatId: 'c1', providerId: 'deepseek', modelId: 'deepseek-chat', reasoningEffort: 'high' })
    store.setChatBinding({ chatId: 'c2', providerId: 'deepseek', modelId: 'deepseek-chat' })
    expect(store.getChatBinding('c1')).toEqual({ chatId: 'c1', providerId: 'deepseek', modelId: 'deepseek-chat', reasoningEffort: 'high' })
    expect(store.getChatBinding('c2')).toEqual({ chatId: 'c2', providerId: 'deepseek', modelId: 'deepseek-chat' })
    expect(() => store.setChatBinding({ chatId: 'nope', providerId: 'deepseek', modelId: 'x' })).toThrow(/Chat not found/)
    expect(() => store.setChatBinding({ chatId: 'c1', providerId: 'deepseek', modelId: 'x', reasoningEffort: 'turbo' as any })).toThrow(/reasoning/)

    db.prepare("DELETE FROM chats WHERE id = 'c1'").run()
    expect(store.getChatBinding('c1')).toBeUndefined()

    store.delete('deepseek')
    expect(store.getChatBinding('c2')).toBeUndefined()
    expect(store.hasCredential('deepseek')).toBe(false)
    expect(store.get('deepseek')).toBeUndefined()
  })

  it('schema creation is idempotent and leaves other tables alone', () => {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT, remote_url TEXT, remote_api_key TEXT)`)
    db.prepare("INSERT INTO sessions VALUES ('s1', 'remote', 'https://api.example.com/v1', 'enc:abc')").run()
    store.save({ id: 'together', kind: 'catalog', displayName: '', api: 'openai-completions', baseURL: '', models: [] })
    ensureProviderSchema(db)
    ensureProviderSchema(db)
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual([{ id: 's1', type: 'remote', remote_url: 'https://api.example.com/v1', remote_api_key: 'enc:abc' }])
    expect(store.get('together')?.baseURL).toBe('https://api.together.ai/v1')
  })
})
