/**
 * Memory across chats: short facts and notes the user wants MLX Harness to
 * keep ("I write TypeScript with 2-space indents", "my team's repo is …").
 *
 * Kept in the app's own database, searchable with SQLite FTS5. The agent adds
 * and removes entries only through visible tool calls (remember / forget),
 * and Preferences → Memory shows, edits and deletes every entry. Nothing here
 * leaves the Mac except as part of a prompt the user sends.
 */

import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'

export interface MemoryEntry {
  id: string
  text: string
  createdAt: number
  updatedAt: number
  /** The chat it was saved from, when saved by the agent. */
  sourceChatId?: string
}

export const MEMORY_MAX_CHARS = 500
export const MEMORY_MAX_ENTRIES = 500

export function ensureMemorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source_chat_id TEXT
    );
    CREATE INDEX IF NOT EXISTS memories_updated ON memories (updated_at DESC);
  `)
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');`)
  } catch {
    /* FTS5 missing: search falls back to LIKE */
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Words for an FTS query, each quoted (no operators from user text). */
export function ftsQuery(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 12)
  return words.length ? words.map(w => `"${w.replace(/"/g, '')}"`).join(' OR ') : null
}

export class MemoryStore {
  private fts = true
  constructor(private readonly db: Database.Database) {
    ensureMemorySchema(db)
    try { db.prepare('SELECT count(*) FROM memories_fts').get() } catch { this.fts = false }
  }

  private row(r: any): MemoryEntry {
    return { id: r.id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.source_chat_id ? { sourceChatId: r.source_chat_id } : {}) }
  }

  list(): MemoryEntry[] {
    return (this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as any[]).map(r => this.row(r))
  }

  get(id: string): MemoryEntry | null {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    return r ? this.row(r) : null
  }

  /** Add a fact; an identical one (ignoring case and spacing) is refreshed instead. */
  add(text: string, sourceChatId?: string): { entry: MemoryEntry; duplicate: boolean } {
    const clean = text.trim().slice(0, MEMORY_MAX_CHARS)
    if (!clean) throw new Error('Nothing to remember.')
    const now = Date.now()
    const same = this.list().find(e => norm(e.text) === norm(clean))
    if (same) {
      this.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(now, same.id)
      return { entry: { ...same, updatedAt: now }, duplicate: true }
    }
    const count = (this.db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n
    if (count >= MEMORY_MAX_ENTRIES) throw new Error(`Memory is full (${MEMORY_MAX_ENTRIES} entries). Remove some in Preferences → Memory.`)
    const id = `m${randomBytes(4).toString('hex')}`
    this.db.prepare('INSERT INTO memories (id, text, created_at, updated_at, source_chat_id) VALUES (?, ?, ?, ?, ?)').run(id, clean, now, now, sourceChatId ?? null)
    if (this.fts) this.db.prepare('INSERT INTO memories_fts (id, text) VALUES (?, ?)').run(id, clean)
    return { entry: { id, text: clean, createdAt: now, updatedAt: now, ...(sourceChatId ? { sourceChatId } : {}) }, duplicate: false }
  }

  update(id: string, text: string): MemoryEntry | null {
    const clean = text.trim().slice(0, MEMORY_MAX_CHARS)
    if (!clean) return null
    const now = Date.now()
    const info = this.db.prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?').run(clean, now, id)
    if (info.changes === 0) return null
    if (this.fts) {
      this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id)
      this.db.prepare('INSERT INTO memories_fts (id, text) VALUES (?, ?)').run(id, clean)
    }
    return this.get(id)
  }

  delete(id: string): boolean {
    const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    if (this.fts) this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id)
    return info.changes > 0
  }

  clear(): void {
    this.db.prepare('DELETE FROM memories').run()
    if (this.fts) this.db.prepare('DELETE FROM memories_fts').run()
  }

  search(query: string, limit = 8): MemoryEntry[] {
    const q = ftsQuery(query)
    if (!q) return this.list().slice(0, limit)
    if (this.fts) {
      try {
        const ids = (this.db.prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?').all(q, limit) as Array<{ id: string }>).map(r => r.id)
        return ids.map(id => this.get(id)).filter((e): e is MemoryEntry => !!e)
      } catch { /* fall through */ }
    }
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
    return this.list()
      .map(e => ({ e, score: words.filter(w => e.text.toLowerCase().includes(w)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.e)
  }
}

/**
 * The block at the end of the system prompt: the newest entries, as short
 * lines with their ids, within a character budget. Stable while memory is
 * unchanged, so the cached prompt prefix stays valid.
 */
export function renderMemoryBlock(entries: MemoryEntry[], budget = 2000): string | null {
  if (entries.length === 0) return null
  const lines: string[] = []
  let used = 0
  for (const e of entries) {
    const line = `- [${e.id}] ${e.text.replace(/\s+/g, ' ')}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length + 1
  }
  const more = entries.length - lines.length
  return [
    '# Memory',
    'Things the user asked you to remember or told you about themselves in earlier chats. Use them when they help; do not recite them. ' +
      'When the user states a lasting preference or fact, or asks you to remember something, save it with remember (one short fact per call). ' +
      'If an entry is wrong or the user asks you to forget it, use forget with its id. Never save passwords, keys, card numbers or health details.',
    ...lines,
    ...(more > 0 ? [`(${more} older entries: use recall to search them.)`] : []),
  ].join('\n')
}

/** Text that must never be stored (secrets, card numbers). */
export function looksSecret(text: string): boolean {
  return (
    /\b(sk|pk|rk|ak|ghp|gho|xox[bpas])[-_][A-Za-z0-9_-]{12,}/.test(text) ||
    /\b(?:\d[ -]?){13,19}\b/.test(text) ||
    /\b(password|passwd|passcode|api[_ -]?key|secret key|private key|seed phrase|recovery phrase)\b\s*[:=]/i.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
  )
}
