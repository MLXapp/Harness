/**
 * Changes: what the agent's file tools changed in each turn, and the way back.
 *
 * Before a file tool first touches a file in a turn, the file's content (or
 * "it did not exist") is kept in MLX Harness's own folder. When the turn ends,
 * each touched file is compared with what is on disk now: unchanged files are
 * dropped, the rest become the turn's change list ("3 files changed +42 −7").
 * Reverting puts the kept content back (or removes a file the turn created),
 * but only while the file is still as the turn left it: if it changed since,
 * the revert is refused for that file unless the user confirms (`force`).
 *
 * Shell commands are not tracked (like every other harness, the agent's own
 * file tools are what is checkpointed). Per chat the newest 30 turns are kept;
 * files over 5 MB or that look binary are listed but not diffed or reverted.
 */

import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, relative, isAbsolute } from 'path'
import { diffCounts } from '../../shared/lineDiff'

export const TURNS_KEPT = 30
export const MAX_FILE_BYTES = 5 * 1024 * 1024

import type { ChangeKind, FileChange, FileTexts, RevertResult, TurnChangeSet } from '../../shared/changes'
export type { ChangeKind, FileChange, FileTexts, RevertResult, TurnChangeSet }

interface Before {
  path: string
  existed: boolean
  /** File holding the original bytes (inside the turn folder). */
  blob?: string
  opaque?: boolean
}

interface OpenTurn {
  chatId: string
  messageId: string
  workingDir: string
  dir: string
  before: Map<string, Before>
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex')
const looksBinary = (b: Buffer) => b.subarray(0, 8000).includes(0)
const safeId = (s: string) => /^[A-Za-z0-9_-]{1,80}$/.test(s)

export function shownPath(fullPath: string, workingDir: string): string {
  if (!workingDir) return fullPath
  const rel = relative(workingDir, fullPath)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : fullPath
}

export class TurnChanges {
  private open = new Map<string, OpenTurn>()

  constructor(private readonly root: () => string) {}

  private chatDir(chatId: string): string {
    return join(this.root(), chatId)
  }

  private indexPath(chatId: string): string {
    return join(this.chatDir(chatId), 'index.json')
  }

  list(chatId: string): TurnChangeSet[] {
    if (!safeId(chatId)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath(chatId), 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter(t => t && typeof t.messageId === 'string' && Array.isArray(t.files)) : []
    } catch {
      return []
    }
  }

  private writeIndex(chatId: string, sets: TurnChangeSet[]): void {
    mkdirSync(this.chatDir(chatId), { recursive: true })
    writeFileSync(this.indexPath(chatId), JSON.stringify(sets, null, 1), 'utf-8')
  }

  /** A turn starts: file tools in it report to `noteBefore`. */
  begin(chatId: string, messageId: string, workingDir: string): void {
    if (!safeId(chatId) || !safeId(messageId)) return
    // A turn that never finished (stopped, then a new message): keep what it did.
    const previous = this.open.get(chatId)
    if (previous) this.finish(chatId, previous.messageId)
    this.open.set(chatId, {
      chatId, messageId, workingDir,
      dir: join(this.chatDir(chatId), messageId),
      before: new Map(),
    })
  }

  /** Call before a tool changes, creates, moves or deletes `fullPath`. Never throws. */
  noteBefore(chatId: string, fullPath: string): void {
    const turn = this.open.get(chatId)
    if (!turn || turn.before.has(fullPath)) return
    try {
      if (!existsSync(fullPath)) { turn.before.set(fullPath, { path: fullPath, existed: false }); return }
      const st = statSync(fullPath)
      if (!st.isFile()) return
      if (st.size > MAX_FILE_BYTES) { turn.before.set(fullPath, { path: fullPath, existed: true, opaque: true }); return }
      const bytes = readFileSync(fullPath)
      mkdirSync(turn.dir, { recursive: true })
      const blob = join(turn.dir, `${turn.before.size}-${randomBytes(3).toString('hex')}`)
      writeFileSync(blob, bytes)
      turn.before.set(fullPath, { path: fullPath, existed: true, blob, opaque: looksBinary(bytes) })
    } catch {
      /* a missing checkpoint only means no revert for this file */
    }
  }

  /** The turn ended: work out what actually changed and keep it. */
  finish(chatId: string, messageId?: string): TurnChangeSet | null {
    const turn = this.open.get(chatId)
    // Only the turn that is ending (a newer one may have started meanwhile).
    if (!turn || (messageId && turn.messageId !== messageId)) return null
    this.open.delete(chatId)
    if (turn.before.size === 0) return null
    const files: FileChange[] = []
    for (const b of turn.before.values()) {
      let now: Buffer | null = null
      let nowOpaque = false
      try {
        if (existsSync(b.path) && statSync(b.path).isFile()) {
          if (statSync(b.path).size > MAX_FILE_BYTES) nowOpaque = true
          else now = readFileSync(b.path)
        }
      } catch { /* unreadable: treat as gone */ }
      const existsNow = now !== null || nowOpaque
      if (!b.existed && !existsNow) continue
      const beforeBytes = b.blob ? safeRead(b.blob) : null
      if (b.existed && existsNow && beforeBytes && now && beforeBytes.equals(now)) continue
      const kind: ChangeKind = !b.existed ? 'added' : !existsNow ? 'deleted' : 'modified'
      const opaque = !!b.opaque || nowOpaque || (now ? looksBinary(now) : false) || (b.existed && !beforeBytes)
      const counts = opaque
        ? { added: 0, removed: 0 }
        : diffCounts(beforeBytes ? beforeBytes.toString('utf-8') : '', now ? now.toString('utf-8') : '')
      files.push({
        path: b.path,
        shown: shownPath(b.path, turn.workingDir),
        kind,
        ...counts,
        ...(opaque ? { opaque: true } : {}),
        afterHash: now ? sha1(now) : null,
      })
    }
    if (files.length === 0) {
      try { rmSync(turn.dir, { recursive: true, force: true }) } catch { /* fine */ }
      return null
    }
    files.sort((x, y) => x.shown.localeCompare(y.shown))
    // Keep only the originals of files that changed.
    const blobs: Record<string, string> = {}
    for (const b of turn.before.values()) if (b.blob && files.some(f => f.path === b.path)) blobs[b.path] = b.blob
    for (const b of turn.before.values()) if (b.blob && !blobs[b.path]) { try { unlinkSync(b.blob) } catch { /* fine */ } }
    let blobsSaved = true
    try { mkdirSync(turn.dir, { recursive: true }); writeFileSync(join(turn.dir, 'blobs.json'), JSON.stringify(blobs), 'utf-8') } catch { blobsSaved = false }
    for (const f of files) f.revertible = f.kind === 'added' || (blobsSaved && !!blobs[f.path])
    const set: TurnChangeSet = { chatId, messageId: turn.messageId, at: Date.now(), workingDir: turn.workingDir, files }
    const all = [...this.list(chatId).filter(s => s.messageId !== set.messageId), set]
    const kept = all.slice(-TURNS_KEPT)
    for (const old of all.slice(0, all.length - kept.length)) {
      if (safeId(old.messageId)) { try { rmSync(join(this.chatDir(chatId), old.messageId), { recursive: true, force: true }) } catch { /* fine */ } }
    }
    try { this.writeIndex(chatId, kept) } catch { /* listed this run only */ }
    return set
  }

  private blobsOf(chatId: string, messageId: string): Record<string, string> {
    if (!safeId(chatId) || !safeId(messageId)) return {}
    try { return JSON.parse(readFileSync(join(this.chatDir(chatId), messageId, 'blobs.json'), 'utf-8')) } catch { return {} }
  }

  /** Before and after text of one file in one turn (for the diff view). */
  fileTexts(chatId: string, messageId: string, path: string): { before: string; after: string; opaque: boolean; changedSince: boolean } | null {
    const set = this.list(chatId).find(s => s.messageId === messageId)
    const file = set?.files.find(f => f.path === path)
    if (!set || !file) return null
    const changedSince = !file.reverted && this.current(file) === 'changed'
    if (file.opaque) return { before: '', after: '', opaque: true, changedSince }
    const blob = this.blobsOf(chatId, messageId)[path]
    const before = blob ? safeRead(blob)?.toString('utf-8') ?? '' : ''
    // "After" is the file on disk now (the turn's result unless it changed since).
    let after = ''
    try { if (existsSync(path)) after = readFileSync(path).toString('utf-8') } catch { /* gone */ }
    if (file.reverted) after = before
    return { before, after, opaque: false, changedSince }
  }

  /** Is each file still as the turn left it? */
  private current(file: FileChange): 'same' | 'changed' {
    try {
      if (file.afterHash === null) return existsSync(file.path) ? 'changed' : 'same'
      if (!existsSync(file.path)) return 'changed'
      return sha1(readFileSync(file.path)) === file.afterHash ? 'same' : 'changed'
    } catch {
      return 'changed'
    }
  }

  /**
   * Put files back as they were before the turn. `paths` empty = every file.
   * A file changed since the turn is skipped (reported as `conflict`) unless
   * `force`.
   */
  revert(chatId: string, messageId: string, paths: string[] = [], force = false):
    { reverted: string[]; conflicts: string[]; failed: string[] } {
    const out = { reverted: [] as string[], conflicts: [] as string[], failed: [] as string[] }
    const sets = this.list(chatId)
    const set = sets.find(s => s.messageId === messageId)
    if (!set) return out
    const blobs = this.blobsOf(chatId, messageId)
    for (const file of set.files) {
      if (paths.length && !paths.includes(file.path)) continue
      if (file.reverted) continue
      // Revertible: a file the turn made, or one whose original was kept.
      if (file.kind !== 'added' && !blobs[file.path]) { out.failed.push(file.path); continue }
      if (!force && this.current(file) === 'changed') { out.conflicts.push(file.path); continue }
      try {
        if (file.kind === 'added') {
          if (existsSync(file.path)) unlinkSync(file.path)
        } else {
          const bytes = blobs[file.path] ? safeRead(blobs[file.path]) : null
          if (!bytes) { out.failed.push(file.path); continue }
          mkdirSync(dirname(file.path), { recursive: true })
          writeFileSync(file.path, bytes)
        }
        file.reverted = true
        out.reverted.push(file.path)
      } catch {
        out.failed.push(file.path)
      }
    }
    try { this.writeIndex(chatId, sets) } catch { /* state shown until restart */ }
    return out
  }

  /** The chat was deleted: its checkpoints go too. */
  forget(chatId: string): void {
    this.open.delete(chatId)
    if (!safeId(chatId)) return
    try { rmSync(this.chatDir(chatId), { recursive: true, force: true }) } catch { /* fine */ }
  }

  /** Housekeeping: chats whose folders exist but are not in `known`. */
  prune(known: Set<string>): void {
    try {
      for (const name of readdirSync(this.root())) if (!known.has(name)) this.forget(name)
    } catch { /* no folder yet */ }
  }
}

function safeRead(path: string): Buffer | null {
  try { return readFileSync(path) } catch { return null }
}
