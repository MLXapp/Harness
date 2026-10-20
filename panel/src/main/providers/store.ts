/**
 * Model provider rows, their Keychain-encrypted credentials and per-chat model
 * bindings, in the app's SQLite database.
 *
 * Credentials: a provider's API key is encrypted with Electron safeStorage
 * (whose key lives in the macOS Keychain) and stored under the reference
 * `provider/<id>`. Writing refuses when encryption is unavailable instead of
 * falling back to plaintext. Reading a key is a main-process-only operation
 * (`resolveCredential`); everything handed to the renderer goes through
 * `view()`, which reports only whether a key is configured.
 */

import type Database from 'better-sqlite3'
import {
  type ChatModelBinding,
  type ProviderDraft,
  type ProviderModel,
  type ProviderRecord,
  type ProviderView,
  PROVIDER_ID_PATTERN,
  isProviderApi,
  isProviderKind,
  isProviderReasoningLevel,
  normalizeProviderBaseURL,
  normalizeProviderModels,
  providerCredentialRef,
} from '../../shared/providers/types'
import { checkApiKey } from '../../shared/providers/apiKey'
import { catalogProvider, isReservedProviderId } from '../../shared/providers/catalog'

/** Encryption seam: safeStorage in the app, a fake in tests. */
export interface SecretBox {
  /** Throws when encryption is unavailable; never returns plaintext. */
  encrypt(plain: string): string
  /** Returns '' when the ciphertext cannot be decrypted. */
  decrypt(cipher: string): string
}

/** Tables owned by this module. Called from DatabaseManager.initialize(). */
export function ensureProviderSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('local-server','catalog','custom')),
      display_name TEXT NOT NULL,
      api TEXT NOT NULL CHECK(api IN ('openai-completions','openai-responses','anthropic-messages')),
      base_url TEXT NOT NULL,
      headers_json TEXT NOT NULL DEFAULT '{}',
      models_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    -- Keychain-encrypted secrets (safeStorage ciphertext, "enc:" prefix only),
    -- keyed by reference, e.g. provider/<id>.
    CREATE TABLE IF NOT EXISTS credentials (
      ref TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL CHECK(ciphertext LIKE 'enc:%'),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_model_bindings (
      chat_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      reasoning_effort TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
  `)
}

interface ProviderRow {
  id: string
  kind: string
  display_name: string
  api: string
  base_url: string
  headers_json: string
  models_json: string
  created_at: number
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}

function rowToRecord(row: ProviderRow): ProviderRecord | undefined {
  if (!isProviderKind(row.kind) || !isProviderApi(row.api)) return undefined
  let models: ProviderModel[] = []
  try {
    models = normalizeProviderModels(parseJson(row.models_json, []))
  } catch {
    models = []
  }
  const headers = parseJson<Record<string, unknown>>(row.headers_json, {})
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    api: row.api,
    baseURL: row.base_url,
    headers: Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    models,
    createdAt: row.created_at,
  }
}

export class ProviderStore {
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: SecretBox,
  ) {}

  list(): ProviderRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM providers ORDER BY created_at ASC, id ASC')
      .all() as ProviderRow[]
    return rows.map(rowToRecord).filter((r): r is ProviderRecord => !!r)
  }

  get(id: string): ProviderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  /** Create or update a provider. Validates everything; never touches the credential. */
  save(draft: ProviderDraft): ProviderRecord {
    const id = typeof draft.id === 'string' ? draft.id.trim() : ''
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new Error('Provider id: lower-case letters, digits, ".", "_" or "-" (up to 64)')
    }
    if (!isProviderKind(draft.kind) || draft.kind === 'local-server') {
      throw new Error('Unknown provider kind')
    }
    if (isReservedProviderId(id)) throw new Error(`"${id}" is reserved for a local server`)
    if (!isProviderApi(draft.api)) throw new Error('Choose a protocol')
    const catalog = draft.kind === 'catalog' ? catalogProvider(id) : undefined
    if (draft.kind === 'catalog' && !catalog) throw new Error(`"${id}" is not in the catalog`)
    const displayName = (typeof draft.displayName === 'string' ? draft.displayName.trim() : '') || catalog?.displayName || id
    const baseURL = normalizeProviderBaseURL(draft.baseURL || catalog?.baseURL)
    const models = normalizeProviderModels(draft.models)
    const existing = this.get(id)
    if (existing && existing.kind !== draft.kind) {
      throw new Error(`A provider with id "${id}" already exists`)
    }
    const headers = existing?.headers ?? catalog?.headers ?? {}
    const createdAt = existing?.createdAt ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO providers (id, kind, display_name, api, base_url, headers_json, models_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name, api = excluded.api, base_url = excluded.base_url,
           headers_json = excluded.headers_json, models_json = excluded.models_json`,
      )
      .run(id, draft.kind, displayName, draft.api, baseURL, JSON.stringify(headers), JSON.stringify(models), createdAt)
    return this.get(id)!
  }

  /** Remove a provider, its credential and every chat binding that pointed at it. */
  delete(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM credentials WHERE ref = ?').run(providerCredentialRef(id))
      this.db.prepare('DELETE FROM chat_model_bindings WHERE provider_id = ?').run(id)
    })
    tx()
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  /** Store a provider's API key, encrypted. Throws on a malformed key or when encryption is unavailable. */
  setCredential(providerId: string, rawKey: string): void {
    if (!this.get(providerId)) throw new Error('Unknown provider')
    const check = checkApiKey(rawKey)
    if (!check.ok) {
      throw new Error(
        check.reason === 'empty'
          ? 'The API key is blank'
          : 'That does not look like an API key. Paste the key itself (printable characters, no quotes, no NAME=).',
      )
    }
    const cipher = this.secrets.encrypt(check.value)
    if (typeof cipher !== 'string' || !cipher.startsWith('enc:')) {
      // Defence in depth: a SecretBox that returns anything but Keychain
      // ciphertext must not reach the table (which also refuses it).
      throw new Error('Secure storage did not encrypt the key; it was not saved')
    }
    this.db
      .prepare(
        `INSERT INTO credentials (ref, ciphertext, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      )
      .run(providerCredentialRef(providerId), cipher, Date.now())
  }

  clearCredential(providerId: string): void {
    this.db.prepare('DELETE FROM credentials WHERE ref = ?').run(providerCredentialRef(providerId))
  }

  /** Redacted: whether a key is stored. Does not decrypt. */
  hasCredential(providerId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM credentials WHERE ref = ?').get(providerCredentialRef(providerId))
  }

  /** MAIN PROCESS ONLY. The decrypted key, or undefined when none or unreadable. */
  resolveCredential(providerId: string): string | undefined {
    const row = this.db
      .prepare('SELECT ciphertext FROM credentials WHERE ref = ?')
      .get(providerCredentialRef(providerId)) as { ciphertext: string } | undefined
    if (!row) return undefined
    const plain = this.secrets.decrypt(row.ciphertext)
    return plain ? plain : undefined
  }

  /** The renderer-safe description of a stored provider. */
  view(record: ProviderRecord): ProviderView {
    const { headers, ...rest } = record
    return {
      ...rest,
      headerNames: Object.keys(headers),
      configured: this.hasCredential(record.id),
      needsKey: true,
    }
  }

  // ── Chat bindings ────────────────────────────────────────────────────────

  getChatBinding(chatId: string): ChatModelBinding | undefined {
    const row = this.db
      .prepare('SELECT chat_id, provider_id, model_id, reasoning_effort FROM chat_model_bindings WHERE chat_id = ?')
      .get(chatId) as { chat_id: string; provider_id: string; model_id: string; reasoning_effort: string | null } | undefined
    if (!row) return undefined
    return {
      chatId: row.chat_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      ...(isProviderReasoningLevel(row.reasoning_effort) ? { reasoningEffort: row.reasoning_effort } : {}),
    }
  }

  setChatBinding(binding: ChatModelBinding): void {
    const reasoning = binding.reasoningEffort === undefined ? null : binding.reasoningEffort
    if (reasoning !== null && !isProviderReasoningLevel(reasoning)) throw new Error('Unknown reasoning level')
    if (!binding.providerId || !binding.modelId) throw new Error('Choose a provider and a model')
    if (!this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(binding.chatId)) throw new Error('Chat not found')
    this.db
      .prepare(
        `INSERT INTO chat_model_bindings (chat_id, provider_id, model_id, reasoning_effort, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET provider_id = excluded.provider_id, model_id = excluded.model_id,
           reasoning_effort = excluded.reasoning_effort, updated_at = excluded.updated_at`,
      )
      .run(binding.chatId, binding.providerId, binding.modelId, reasoning, Date.now())
  }

  clearChatBinding(chatId: string): void {
    this.db.prepare('DELETE FROM chat_model_bindings WHERE chat_id = ?').run(chatId)
  }
}
