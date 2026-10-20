/*
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License.
 * (packages/compaction/compaction-tool-result-pruner, packages/spill/spill-policy)
 */

/**
 * Tool results are what fills a coding agent's context. A flat cut at 50,000
 * characters (about 12k tokens — a third of a 32k window per call) used to keep
 * the head and silently drop the tail, which is exactly where a failing test
 * or a compiler prints its error.
 *
 * Now a result over 8,192 characters keeps its first 4,096 and last 1,024
 * characters with a marker that says how much was cut. A very large result is
 * also written in full to a file under the app's data folder, and the marker
 * gives the model that path to page through with read_file / search_files.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

export const PRUNE_THRESHOLD_CHARS = 8_192
export const PRUNE_HEAD_CHARS = 4_096
export const PRUNE_TAIL_CHARS = 1_024
/** Results larger than this are spilled to a file in full. */
export const SPILL_THRESHOLD_CHARS = 16_384
/** Hard cap on what is ever kept in memory or spilled for one result. */
export const MAX_RAW_TOOL_RESULT_CHARS = 2_000_000

/** Tools whose full output already lives on disk (spilling would duplicate it). */
const SOURCE_BACKED_TOOLS = new Set(['read_file'])

export interface PruneBudget {
  thresholdChars: number
  headChars: number
  tailChars: number
}

/**
 * The per-chat "Tool Result Limit" setting keeps working: an explicit value is
 * the threshold, with the head/tail split in the same 4:1 proportion.
 */
export function resolvePruneBudget(userMaxChars?: number): PruneBudget {
  if (typeof userMaxChars === 'number' && Number.isFinite(userMaxChars) && userMaxChars > 0) {
    const thresholdChars = Math.max(200, Math.floor(userMaxChars))
    return {
      thresholdChars,
      headChars: Math.floor(thresholdChars / 2),
      tailChars: Math.floor(thresholdChars / 8),
    }
  }
  return { thresholdChars: PRUNE_THRESHOLD_CHARS, headChars: PRUNE_HEAD_CHARS, tailChars: PRUNE_TAIL_CHARS }
}

/** Never cut through a surrogate pair. */
function safeHeadEnd(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) return end - 1
  }
  return end
}

function safeTailStart(text: string, start: number): number {
  if (start > 0 && start < text.length) {
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) return start + 1
  }
  return start
}

export interface PruneResult {
  text: string
  pruned: boolean
  omittedChars: number
  spillPath?: string
}

export interface PruneOptions {
  toolName: string
  budget?: PruneBudget
  /** Writes the full text somewhere the model can read; returns the path, or undefined on failure. */
  spill?: (fullText: string) => string | undefined
  spillThresholdChars?: number
}

function marker(omitted: number, total: number, toolName: string, spillPath?: string): string {
  const head = `[... ${omitted.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters cut from the middle of this result ...`
  if (spillPath) {
    return `\n\n${head} The full result is saved at: ${spillPath} — read it with read_file (use offset/limit) or search it with search_files instead of re-running the tool.]\n\n`
  }
  if (SOURCE_BACKED_TOOLS.has(toolName)) {
    return `\n\n${head} Use read_file with offset/limit to read the omitted lines.]\n\n`
  }
  return `\n\n${head} Narrow the request (filters, line ranges, head/tail) to see the omitted part.]\n\n`
}

export function pruneToolResult(text: string, options: PruneOptions): PruneResult {
  const budget = options.budget ?? resolvePruneBudget()
  const value = String(text ?? '')
  if (value.length <= budget.thresholdChars) return { text: value, pruned: false, omittedChars: 0 }

  const bounded = value.length > MAX_RAW_TOOL_RESULT_CHARS ? value.slice(0, MAX_RAW_TOOL_RESULT_CHARS) : value
  let spillPath: string | undefined
  const spillThreshold = options.spillThresholdChars ?? Math.max(SPILL_THRESHOLD_CHARS, budget.thresholdChars * 2)
  if (options.spill && !SOURCE_BACKED_TOOLS.has(options.toolName) && value.length > spillThreshold) {
    try {
      spillPath = options.spill(bounded)
    } catch {
      spillPath = undefined
    }
  }

  const headEnd = safeHeadEnd(value, budget.headChars)
  const tailStart = safeTailStart(value, Math.max(headEnd, value.length - budget.tailChars))
  const omitted = tailStart - headEnd
  return {
    text: value.slice(0, headEnd) + marker(omitted, value.length, options.toolName, spillPath) + value.slice(tailStart),
    pruned: true,
    omittedChars: omitted,
    ...(spillPath ? { spillPath } : {}),
  }
}

let spillSequence = 0

/**
 * Write one full tool result under `dir` (created 0700, file 0600) and return
 * its absolute path. The file name carries the tool name so the model can tell
 * results apart.
 */
export function writeSpillFile(dir: string, toolName: string, fullText: string, now = Date.now()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  spillSequence = (spillSequence + 1) % 1_000_000
  const safeTool = toolName.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'tool'
  const path = join(dir, `${now}-${String(spillSequence).padStart(6, '0')}-${safeTool}.txt`)
  writeFileSync(path, fullText, { encoding: 'utf-8', mode: 0o600 })
  return path
}

/** Spilled results older than this are removed at startup. */
export const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Remove spill files older than `maxAgeMs` (and chat folders left empty).
 * Best effort: errors are ignored. Returns the number of files removed.
 */
export function pruneOldSpillFiles(root: string, maxAgeMs = SPILL_MAX_AGE_MS, now = Date.now()): number {
  let removed = 0
  let chats: string[]
  try {
    chats = readdirSync(root)
  } catch {
    return 0
  }
  for (const chat of chats) {
    const dir = join(root, chat)
    try {
      if (!statSync(dir).isDirectory()) continue
      const files = readdirSync(dir)
      let left = files.length
      for (const file of files) {
        const path = join(dir, file)
        try {
          if (now - statSync(path).mtimeMs > maxAgeMs) {
            rmSync(path, { force: true })
            removed += 1
            left -= 1
          }
        } catch {}
      }
      if (left === 0) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  return removed
}
