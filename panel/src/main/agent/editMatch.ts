/**
 * Forgiving search for edit_file (pattern from Atomic Agent, MIT; written
 * fresh here). Small local models often get an edit almost right: trailing
 * spaces, CRLF line ends, a different indent, or a stray blank line. The
 * exact match is always tried first by the caller; this module is the second
 * chance:
 *
 *  1. lines compared without trailing whitespace;
 *  2. lines compared without leading and trailing whitespace, blank lines in
 *     the search ignored; the replacement is re-indented by the same offset.
 *
 * A loose match is applied only when it is unique. Otherwise the model gets
 * the nearest fragment of the file, numbered, instead of a 300-line dump.
 */

export type LooseMatch =
  | { kind: 'unique'; start: number; end: number; level: 'trailing' | 'indent'; reindent: (text: string) => string }
  | { kind: 'ambiguous'; count: number; level: 'trailing' | 'indent' }
  | { kind: 'none' }

const splitLines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n')

function dropEdgeBlanks(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b)
}

const leading = (s: string) => /^[ \t]*/.exec(s)?.[0] ?? ''

/**
 * Find `search` in `content` line by line. `start`/`end` are line indexes
 * into content (end exclusive).
 */
export function findLoose(content: string, search: string): LooseMatch {
  const file = splitLines(content)
  const want = dropEdgeBlanks(splitLines(search))
  if (want.length === 0) return { kind: 'none' }

  // Level 1: trailing whitespace ignored, same line count.
  const t = want.map(l => l.trimEnd())
  const hits1: number[] = []
  for (let i = 0; i + t.length <= file.length; i++) {
    let ok = true
    for (let j = 0; j < t.length; j++) {
      if (file[i + j].trimEnd() !== t[j]) { ok = false; break }
    }
    if (ok) hits1.push(i)
  }
  if (hits1.length === 1) {
    return { kind: 'unique', start: hits1[0], end: hits1[0] + t.length, level: 'trailing', reindent: s => s }
  }
  if (hits1.length > 1) return { kind: 'ambiguous', count: hits1.length, level: 'trailing' }

  // Level 2: indentation and blank lines ignored.
  const core = want.filter(l => l.trim() !== '').map(l => l.trim())
  const hits2: Array<{ start: number; end: number }> = []
  for (let i = 0; i < file.length; i++) {
    if (file[i].trim() !== core[0]) continue
    let j = 0
    let k = i
    while (k < file.length && j < core.length) {
      const line = file[k].trim()
      if (line === '') { k++; continue }
      if (line !== core[j]) break
      j++
      k++
    }
    if (j === core.length) hits2.push({ start: i, end: k })
  }
  if (hits2.length > 1) return { kind: 'ambiguous', count: hits2.length, level: 'indent' }
  if (hits2.length === 0) return { kind: 'none' }

  const { start, end } = hits2[0]
  const fileIndent = leading(file[start])
  const searchIndent = leading(want[0])
  let reindent = (s: string) => s
  if (fileIndent.startsWith(searchIndent) && fileIndent !== searchIndent) {
    const add = fileIndent.slice(searchIndent.length)
    reindent = s => splitLines(s).map(l => (l.trim() === '' ? l : add + l)).join('\n')
  } else if (searchIndent.startsWith(fileIndent) && fileIndent !== searchIndent) {
    const cut = searchIndent.length - fileIndent.length
    reindent = s => splitLines(s).map(l => (leading(l).length >= cut ? l.slice(cut) : l.trimStart())).join('\n')
  }
  return { kind: 'unique', start, end, level: 'indent', reindent }
}

/** Replace lines [start, end) of content with `replacement`, keeping the file's line ends. */
export function spliceLines(content: string, start: number, end: number, replacement: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const file = splitLines(content)
  // Whole lines are replaced, so one trailing line break in the replacement is
  // the end of its last line, not an extra blank line.
  const trimmed = replacement.replace(/\r?\n$/, '')
  const repl = replacement === '' ? [] : splitLines(trimmed)
  return [...file.slice(0, start), ...repl, ...file.slice(end)].join(eol)
}

/**
 * The part of the file that looks most like `search`, numbered, with a few
 * lines of context, or null when nothing is similar.
 */
export function nearestFragment(content: string, search: string, context = 3, maxLines = 40): { from: number; to: number; text: string } | null {
  const file = splitLines(content)
  const want = dropEdgeBlanks(splitLines(search)).map(l => l.trim()).filter(Boolean)
  if (want.length === 0 || file.length === 0) return null
  const wanted = new Set(want)
  const span = Math.max(1, want.length)
  let best = -1
  let bestScore = 0
  for (let i = 0; i < file.length; i++) {
    let score = 0
    for (let j = 0; j < span && i + j < file.length; j++) {
      const line = file[i + j].trim()
      if (!line) continue
      if (line === want[j]) score += 3
      else if (wanted.has(line)) score += 2
      else if (similar(line, want[j] ?? '')) score += 1
    }
    if (score > bestScore) { bestScore = score; best = i }
  }
  if (best < 0) return null
  const from = Math.max(0, best - context)
  const to = Math.min(file.length, best + span + context, from + maxLines)
  const text = file.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(5)} | ${l}`).join('\n')
  return { from: from + 1, to, text }
}

/** Loose similarity: most of the shorter line's words appear in the other. */
function similar(a: string, b: string): boolean {
  if (!a || !b) return false
  const wa = a.split(/\W+/).filter(w => w.length > 2)
  const wb = new Set(b.split(/\W+/).filter(w => w.length > 2))
  if (wa.length === 0 || wb.size === 0) return false
  const shared = wa.filter(w => wb.has(w)).length
  return shared / Math.min(wa.length, wb.size) >= 0.6
}
