/**
 * Undo safety for the agent's file tools (pattern from Atomic Agent, MIT;
 * written fresh here). Before a tool changes, overwrites or deletes a file the
 * agent did not create itself, a copy goes to MLX Harness's own folder (never
 * into the project). `restore_file` puts a copy back. Per working folder the
 * newest BACKUP_LIMIT copies are kept; files over BACKUP_MAX_BYTES are not
 * copied (the tool result says so).
 */

import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, isAbsolute } from 'path'

export const BACKUP_LIMIT = 50
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024

export interface BackupEntry {
  id: string
  /** Absolute path of the file that was copied. */
  path: string
  at: number
  size: number
  /** The tool that was about to change it. */
  reason: string
}

export type BackupOutcome = { saved: BackupEntry } | { skipped: 'created' | 'missing' | 'too-big' | 'not-a-file' | 'failed' }

export class FileBackups {
  /** Files the agent created in this run of the app: no copy needed. */
  private readonly created = new Set<string>()
  private counter = 0

  constructor(private readonly root: () => string, private readonly limit = BACKUP_LIMIT, private readonly maxBytes = BACKUP_MAX_BYTES) {}

  private folder(workingDir: string): string {
    const id = createHash('sha1').update(workingDir || '-').digest('hex').slice(0, 16)
    return join(this.root(), id)
  }

  private readIndex(folder: string): BackupEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter(e => e && typeof e.id === 'string' && typeof e.path === 'string') : []
    } catch {
      return []
    }
  }

  private writeIndex(folder: string, entries: BackupEntry[]): void {
    writeFileSync(join(folder, 'index.json'), JSON.stringify(entries, null, 1), 'utf-8')
  }

  /** Remember a file the agent just created (it gets no backup). */
  noteCreated(fullPath: string): void {
    this.created.add(fullPath)
  }

  /** Copy `fullPath` aside before a tool changes it. Never throws. */
  save(fullPath: string, workingDir: string, reason: string): BackupOutcome {
    if (this.created.has(fullPath)) return { skipped: 'created' }
    try {
      if (!existsSync(fullPath)) return { skipped: 'missing' }
      const stat = statSync(fullPath)
      if (!stat.isFile()) return { skipped: 'not-a-file' }
      if (stat.size > this.maxBytes) return { skipped: 'too-big' }
      const folder = this.folder(workingDir)
      mkdirSync(folder, { recursive: true })
      const id = `${Date.now().toString(36)}${(this.counter++ % 1296).toString(36).padStart(2, '0')}`
      copyFileSync(fullPath, join(folder, `${id}.bak`))
      const entry: BackupEntry = { id, path: fullPath, at: Date.now(), size: stat.size, reason }
      const entries = [...this.readIndex(folder), entry]
      const drop = entries.length > this.limit ? entries.splice(0, entries.length - this.limit) : []
      for (const old of drop) rmSync(join(folder, `${old.id}.bak`), { force: true })
      this.writeIndex(folder, entries)
      return { saved: entry }
    } catch {
      return { skipped: 'failed' }
    }
  }

  /** Newest first; only copies whose file is still there. */
  list(workingDir: string, fullPath?: string): BackupEntry[] {
    const folder = this.folder(workingDir)
    return this.readIndex(folder)
      .filter(e => (!fullPath || e.path === fullPath) && existsSync(join(folder, `${e.id}.bak`)))
      .reverse()
  }

  /**
   * Put a copy back: by id, else the newest copy of `fullPath`. The current
   * version is copied aside first, so a restore can itself be undone.
   */
  restore(workingDir: string, opts: { id?: string; fullPath?: string }): { ok: true; entry: BackupEntry; undo?: BackupEntry } | { ok: false; error: string } {
    const folder = this.folder(workingDir)
    const all = this.list(workingDir)
    const entry = opts.id ? all.find(e => e.id === opts.id) : all.find(e => e.path === opts.fullPath)
    if (!entry) return { ok: false, error: opts.id ? `No backup with id ${opts.id}.` : 'No backup of that file.' }
    if (opts.id && opts.fullPath && entry.path !== opts.fullPath) {
      return { ok: false, error: `Backup ${opts.id} belongs to ${entry.path}, not ${opts.fullPath}.` }
    }
    this.created.delete(entry.path)
    const before = this.save(entry.path, workingDir, 'restore_file')
    mkdirSync(dirname(entry.path), { recursive: true })
    copyFileSync(join(folder, `${entry.id}.bak`), entry.path)
    return { ok: true, entry, undo: 'saved' in before ? before.saved : undefined }
  }
}

/** "src/app.ts" when inside the working folder, else the absolute path. */
export function shownPath(fullPath: string, workingDir: string): string {
  if (!workingDir) return fullPath
  const rel = relative(workingDir, fullPath)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : fullPath
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
