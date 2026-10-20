/**
 * Phase 3 adds provider tables to an existing chats.db. Remote sessions
 * created before it (remote_api_key on the session row) must keep working
 * untouched, and new secrets must never be written in plaintext.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userData: '', encryption: true }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: () => h.encryption,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (buf: Buffer) => buf.toString().replace(/^sealed:/, ''),
  },
}))

beforeAll(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'mlx-providers-migration-'))
})

afterAll(() => {
  vi.resetModules()
})

describe('provider migration safety', () => {
  it('opens a pre-phase-3 database without touching its remote sessions', async () => {
    // 1. A database as an older build left it: a remote session with an
    //    encrypted key and one with a legacy plaintext key, no provider tables.
    vi.resetModules()
    {
      const { db } = await import('../src/main/database')
      db.createSession({
        id: 'remote-enc', modelPath: 'remote://gpt-4o@api.openai.com', modelName: 'gpt-4o', host: 'api.openai.com',
        port: 50001, status: 'stopped', config: '{"timeout":300}', createdAt: 1, updatedAt: 1,
        type: 'remote', remoteUrl: 'https://api.openai.com/v1', remoteApiKey: 'sk-enc-key', remoteModel: 'gpt-4o',
      })
      db.createSession({
        id: 'remote-plain', modelPath: 'remote://llama@10.0.0.2:8080', modelName: 'llama', host: '10.0.0.2',
        port: 50002, status: 'stopped', config: '{"timeout":300}', createdAt: 2, updatedAt: 2,
        type: 'remote', remoteUrl: 'http://10.0.0.2:8080', remoteModel: 'llama',
      })
      db.close()
    }
    const raw = new Database(join(h.userData, 'chats.db'))
    raw.prepare("UPDATE sessions SET remote_api_key = 'legacy-plaintext' WHERE id = 'remote-plain'").run()
    raw.exec('DROP TABLE providers; DROP TABLE credentials; DROP TABLE chat_model_bindings;')
    const before = raw.prepare('SELECT * FROM sessions ORDER BY id').all()
    raw.close()

    // 2. Open it with this build.
    vi.resetModules()
    const { db } = await import('../src/main/database')
    expect(db.getSession('remote-enc')?.remoteApiKey).toBe('sk-enc-key')
    expect(db.getSession('remote-plain')?.remoteApiKey).toBe('legacy-plaintext')
    expect(db.providers.list()).toEqual([])
    db.close()

    const after = new Database(join(h.userData, 'chats.db'))
    expect(after.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(before)
    const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name)
    expect(tables).toEqual(expect.arrayContaining(['providers', 'credentials', 'chat_model_bindings', 'sessions', 'chats']))
    after.close()
  })

  it('stores provider keys in the Keychain-encrypted table and refuses when encryption is unavailable', async () => {
    vi.resetModules()
    const { db } = await import('../src/main/database')
    db.providers.save({ id: 'anthropic', kind: 'catalog', displayName: '', api: 'anthropic-messages', baseURL: '', models: [] })
    db.providers.setCredential('anthropic', 'sk-ant-secret')
    expect(db.providers.resolveCredential('anthropic')).toBe('sk-ant-secret')

    h.encryption = false
    try {
      expect(() => db.providers.setCredential('anthropic', 'sk-ant-other')).toThrow(/Keychain/)
      // New remote-session keys refuse too instead of falling back to plaintext.
      const { encryptValue } = await import('../src/main/secretStorage')
      expect(() => encryptValue('sk-new')).toThrow(/Keychain/)
    } finally {
      h.encryption = true
    }
    expect(db.providers.resolveCredential('anthropic')).toBe('sk-ant-secret')
    db.close()

    const raw = new Database(join(h.userData, 'chats.db'))
    const rows = raw.prepare('SELECT ciphertext FROM credentials').all() as Array<{ ciphertext: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].ciphertext.startsWith('enc:')).toBe(true)
    expect(rows[0].ciphertext).not.toContain('sk-ant-secret')
    raw.close()
  })
})
