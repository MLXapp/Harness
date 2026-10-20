/**
 * Tool presets and prefix-cache discipline for the tool catalog.
 *
 * "Full" (default) offers every enabled built-in tool. "Lean" gives small
 * models only a minimal, well-known set — a long catalog costs thousands of
 * prompt tokens on every request and makes small models pick the wrong tool.
 *
 * PREFIX-CACHE DISCIPLINE (see also the comment block in ipc/chat.ts):
 * the engine reuses its KV cache only for an identical token prefix, and the
 * tool schemas are rendered near the very start of the prompt. So:
 *  - the catalog for a chat is a pure function of its settings — never of the
 *    current message's wording or of what happened earlier in the turn;
 *  - tools are always emitted in one canonical order (registry order, then
 *    any other tools by name), whatever order filters produced;
 *  - per-turn notices (repeat-call notes, todo results, recovery prompts) are
 *    appended at the END of the message list; earlier messages and the system
 *    prompt are never rewritten mid-session. The one deliberate exception is
 *    compaction, which replaces a span once and is then stable again.
 */

export type ToolPreset = 'full' | 'lean'

/** The Lean set: shell, read, write/edit, list/search, ask the user. */
export const LEAN_TOOL_NAMES: readonly string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'search_files',
  'run_command',
  'ask_user',
]

export function normalizeToolPreset(value: unknown): ToolPreset {
  return value === 'lean' ? 'lean' : 'full'
}

interface NamedTool {
  function: { name: string }
}

export function applyToolPreset<T extends NamedTool>(tools: readonly T[], preset: unknown): T[] {
  if (normalizeToolPreset(preset) !== 'lean') return [...tools]
  const lean = new Set(LEAN_TOOL_NAMES)
  return tools.filter(tool => lean.has(tool.function.name))
}

/**
 * One canonical order: names listed in `canonicalOrder` first in that order,
 * then every other tool sorted by name. Stable for any input permutation.
 */
export function orderToolsForPrefixCache<T extends NamedTool>(
  tools: readonly T[],
  canonicalOrder: readonly string[],
): T[] {
  const rank = new Map(canonicalOrder.map((name, index) => [name, index]))
  return [...tools].sort((a, b) => {
    const ra = rank.get(a.function.name)
    const rb = rank.get(b.function.name)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0
  })
}

/** Short system prompt matching the Lean tool set (the full one names ~30 tools). */
export const LEAN_AGENTIC_SYSTEM_PROMPT = `You are an expert software engineer working in the user's project folder.

Tools: read_file, write_file, edit_file, list_directory, search_files, run_command (shell) and ask_user.

Rules:
- Read a file with read_file before you edit it; edit_file needs the exact current text.
- Prefer edit_file for small changes; write_file only for new files or full rewrites.
- Use search_files and list_directory to find things instead of guessing paths.
- Run tests or builds with run_command after changes.
- Ask the user when you need a decision; do not guess.
- After using tools, give a short final answer saying what you found or changed.`
