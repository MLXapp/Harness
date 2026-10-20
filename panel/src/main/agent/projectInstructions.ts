/**
 * Project instructions for the coding agent: AGENTS.md and CLAUDE.md (plus
 * their *.local.md overlays) from the chat's working directory up to the
 * workspace root (the nearest folder above it with a .git entry; without one,
 * only the working directory itself is read).
 *
 * The rendered block is appended to the system prompt within a 65,536-byte
 * budget. When the files do not fit, the broader (higher-up) files are
 * dropped first; only then is the most specific file truncated.
 *
 * Output is deterministic for unchanged files, so the system prompt — and the
 * engine's prefix cache — stays stable from turn to turn.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

export const PROJECT_INSTRUCTION_BUDGET_BYTES = 65_536
export const MAX_INSTRUCTION_SOURCE_BYTES = 1_048_576
export const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const
export const LOCAL_INSTRUCTION_FILE_NAMES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
export const WORKSPACE_ROOT_MARKERS = ['.git'] as const

export interface InstructionFile {
  path: string
  /** Path relative to the workspace root, '/' separated. */
  displayPath: string
  content: string
}

export interface RenderedProjectInstructions {
  text: string
  included: string[]
  omitted: string[]
  truncated: string[]
  bytes: number
}

const INTRO =
  'Project instructions from the working directory and its parent folders up to the workspace root. ' +
  'Follow them when they apply. Deeper (more specific) files take precedence over broader ones. ' +
  "They do not override the user's direct requests."

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** Nearest directory at or above `cwd` that holds a workspace marker; `cwd` itself when none does. */
export function findWorkspaceRoot(cwd: string, markers: readonly string[] = WORKSPACE_ROOT_MARKERS): string {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    if (markers.some(marker => existsSync(join(dir, marker)))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** Directories from the workspace root down to `cwd`, broadest first. */
export function instructionDirectories(cwd: string, root: string): string[] {
  const target = resolve(cwd)
  const top = resolve(root)
  const rel = relative(top, target)
  if (rel.startsWith('..') || resolve(top, rel) !== target) return [target]
  const dirs = [top]
  let current = top
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    dirs.push(current)
  }
  return dirs
}

function readInstructionFile(path: string): string | undefined {
  try {
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > MAX_INSTRUCTION_SOURCE_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Existing instruction files, broadest first; within one folder AGENTS.md,
 * CLAUDE.md, then the *.local.md overlays. A file whose trimmed content
 * duplicates an earlier one in the same folder (a symlinked CLAUDE.md →
 * AGENTS.md, say) is loaded once.
 */
export function discoverInstructionFiles(cwd: string, root = findWorkspaceRoot(cwd)): InstructionFile[] {
  const files: InstructionFile[] = []
  for (const dir of instructionDirectories(cwd, root)) {
    const seen = new Set<string>()
    for (const name of [...INSTRUCTION_FILE_NAMES, ...LOCAL_INSTRUCTION_FILE_NAMES]) {
      const path = join(dir, name)
      const content = readInstructionFile(path)
      if (content === undefined) continue
      const key = content.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      const rel = relative(resolve(root), path).split(sep).join('/')
      files.push({ path, displayPath: rel || name, content: content.trim() })
    }
  }
  return files
}

function section(file: InstructionFile): string {
  return `## ${file.displayPath}\n\n${file.content}`
}

function assemble(sections: string[], notes: string[]): string {
  return ['# Project instructions', INTRO, ...notes, ...sections].join('\n\n')
}

export function renderProjectInstructions(
  files: readonly InstructionFile[],
  budgetBytes = PROJECT_INSTRUCTION_BUDGET_BYTES,
): RenderedProjectInstructions | null {
  if (files.length === 0 || budgetBytes <= 0) return null
  let kept = [...files]
  const omitted: string[] = []
  const notesFor = () =>
    omitted.length > 0 ? [`(Omitted to fit the size budget: ${omitted.join(', ')})`] : []

  // Drop broader files until what is left fits (or one file remains).
  while (kept.length > 1 && byteLength(assemble(kept.map(section), notesFor())) > budgetBytes) {
    omitted.push(kept.shift()!.displayPath)
  }

  let text = assemble(kept.map(section), notesFor())
  const truncated: string[] = []
  if (byteLength(text) > budgetBytes) {
    const only = kept[0]
    const marker = `\n\n[... truncated to fit the ${budgetBytes.toLocaleString('en-US')}-byte budget ...]`
    const frame = assemble([`## ${only.displayPath}\n\n`], notesFor())
    const room = budgetBytes - byteLength(frame) - byteLength(marker)
    if (room <= 0) return null
    text = assemble([`## ${only.displayPath}\n\n${truncateUtf8(only.content, room)}${marker}`], notesFor())
    truncated.push(only.displayPath)
  }
  return {
    text,
    included: kept.map(file => file.displayPath),
    omitted,
    truncated,
    bytes: byteLength(text),
  }
}

/** Discover and render in one step; null when there is nothing to add. */
export function loadProjectInstructions(
  workingDirectory: string | undefined,
  budgetBytes = PROJECT_INSTRUCTION_BUDGET_BYTES,
): RenderedProjectInstructions | null {
  if (!workingDirectory || !workingDirectory.trim()) return null
  try {
    if (!statSync(workingDirectory).isDirectory()) return null
  } catch {
    return null
  }
  return renderProjectInstructions(discoverInstructionFiles(workingDirectory), budgetBytes)
}
