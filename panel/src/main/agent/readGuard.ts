/**
 * Read-before-edit guard.
 *
 * An edit tool on an EXISTING file is refused unless this chat session has
 * read that file with read_file and the file has not changed since (size,
 * mtime, and — when those moved — the content hash). Small models otherwise
 * "edit" from memory: search_text that no longer matches, or a write_file
 * that silently drops everything they never saw. New files are always fine.
 *
 * The refusal is a normal tool result addressed to the model, so it reads the
 * file and retries instead of the turn failing.
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'

/** Tools that modify an existing file named by `args.path`. */
export const READ_GUARDED_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'patch_file',
  'batch_edit',
  'insert_text',
  'replace_lines',
  'apply_regex',
])

interface FileSnapshot {
  size: number
  mtimeMs: number
  hash: string
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function snapshot(path: string): FileSnapshot | undefined {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return undefined
    return { size: stats.size, mtimeMs: stats.mtimeMs, hash: hashFile(path) }
  } catch {
    return undefined
  }
}

/**
 * Absolute real path of an existing file the tool would touch, or undefined
 * when the target does not exist yet (creating files needs no read) or is a
 * directory.
 */
export function existingFileTarget(workingDir: string, userPath: unknown): string | undefined {
  if (typeof userPath !== 'string' || !userPath.trim()) return undefined
  try {
    const base = workingDir ? realpathSync(workingDir) : process.cwd()
    const candidate = isAbsolute(userPath) ? resolve(userPath) : resolve(base, userPath)
    if (!existsSync(candidate)) return undefined
    const real = realpathSync(candidate)
    return statSync(real).isFile() ? real : undefined
  } catch {
    return undefined
  }
}

export class FileReadTracker {
  private readonly sessions = new Map<string, Map<string, FileSnapshot>>()

  private files(sessionId: string): Map<string, FileSnapshot> {
    let files = this.sessions.get(sessionId)
    if (!files) {
      files = new Map()
      this.sessions.set(sessionId, files)
    }
    return files
  }

  /** Remember the file's current state as seen by the model. */
  remember(sessionId: string, absPath: string): void {
    const snap = snapshot(absPath)
    if (snap) this.files(sessionId).set(absPath, snap)
    else this.files(sessionId).delete(absPath)
  }

  forget(sessionId: string, absPath: string): void {
    this.sessions.get(sessionId)?.delete(absPath)
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Model-directed refusal text, or null when the edit may proceed.
   * @param displayPath - the path as the model wrote it.
   */
  check(sessionId: string, toolName: string, absPath: string, displayPath: string): string | null {
    const known = this.sessions.get(sessionId)?.get(absPath)
    if (!known) {
      return (
        `Error: ${displayPath} already exists and has not been read in this session, so ${toolName} was not run. ` +
        `Call read_file on ${displayPath} first, then retry ${toolName} using its current content. ` +
        `(Creating a NEW file does not need a read.)`
      )
    }
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(absPath)
    } catch {
      return null // Disappeared since: the tool itself reports the missing file.
    }
    if (stats.size === known.size && stats.mtimeMs === known.mtimeMs) return null
    let hash: string
    try {
      hash = hashFile(absPath)
    } catch {
      return null
    }
    if (hash === known.hash) {
      // Touched but identical: keep the newer timestamps.
      this.files(sessionId).set(absPath, { size: stats.size, mtimeMs: stats.mtimeMs, hash })
      return null
    }
    return (
      `Error: ${displayPath} has changed on disk since you last read it, so ${toolName} was not run. ` +
      `Read it again with read_file, then retry ${toolName} against the current content.`
    )
  }

  /** Refusal text for a tool call, or null. Only guarded tools on existing files are checked. */
  checkTool(sessionId: string, toolName: string, args: Record<string, any>, workingDir: string): string | null {
    if (!READ_GUARDED_TOOLS.has(toolName)) return null
    const target = existingFileTarget(workingDir, args?.path)
    if (!target) return null
    return this.check(sessionId, toolName, target, String(args.path))
  }

  /** Record what the model has now seen after a successful tool call. */
  afterTool(
    sessionId: string,
    toolName: string,
    args: Record<string, any>,
    workingDir: string,
    succeeded: boolean,
  ): void {
    if (!succeeded) return
    // A successful write leaves the file exactly as the model intended, so a
    // follow-up edit does not need another read.
    if (toolName === 'read_file' || READ_GUARDED_TOOLS.has(toolName)) {
      const target = existingFileTarget(workingDir, args?.path)
      if (target) this.remember(sessionId, target)
    }
  }
}
