/**
 * Line diffs for the Changes review (pure; main and renderer). Myers' O(ND)
 * algorithm on lines, with common prefix and suffix trimmed first, and a
 * plain "all removed, all added" answer when the edit distance would be too
 * large to compute quickly (huge rewrites). Hunks carry 3 lines of context.
 */

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string; a?: number; b?: number }

export interface DiffHunk {
  /** 1-based first line in the old and new file. */
  aStart: number
  bStart: number
  lines: DiffOp[]
}

export interface LineDiff {
  added: number
  removed: number
  hunks: DiffHunk[]
  /** True when the diff was too big to compute line by line. */
  coarse: boolean
}

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  // A trailing newline is not an extra empty line.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Edit script between two line arrays. */
export function diffOps(a: string[], b: string[], maxD = 4000): { ops: DiffOp[]; coarse: boolean } {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const head: DiffOp[] = a.slice(0, start).map((text, i) => ({ type: 'same', text, a: i + 1, b: i + 1 }))
  const tail: DiffOp[] = a.slice(endA).map((text, i) => ({ type: 'same', text, a: endA + i + 1, b: endB + i + 1 }))
  const A = a.slice(start, endA), B = b.slice(start, endB)
  const mid = myers(A, B, maxD)
  if (!mid) {
    const coarse: DiffOp[] = [
      ...A.map((text, i) => ({ type: 'del' as const, text, a: start + i + 1 })),
      ...B.map((text, i) => ({ type: 'add' as const, text, b: start + i + 1 })),
    ]
    return { ops: [...head, ...coarse, ...tail], coarse: true }
  }
  let ia = start, ib = start
  const middle = mid.map(op => {
    if (op.type === 'same') { ia++; ib++; return { ...op, a: ia, b: ib } }
    if (op.type === 'del') { ia++; return { ...op, a: ia } }
    ib++; return { ...op, b: ib }
  })
  return { ops: [...head, ...middle, ...tail], coarse: false }
}

function myers(a: string[], b: string[], maxD: number): DiffOp[] | null {
  const n = a.length, m = b.length
  if (n === 0) return b.map(text => ({ type: 'add', text }))
  if (m === 0) return a.map(text => ({ type: 'del', text }))
  const max = Math.min(n + m, maxD)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, dEnd: number): DiffOp[] {
  const out: DiffOp[] = []
  let x = a.length, y = b.length
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1
    const prevX = v[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { x--; y--; out.push({ type: 'same', text: a[x] }) }
    if (x === prevX) { y--; out.push({ type: 'add', text: b[y] }) } else { x--; out.push({ type: 'del', text: a[x] }) }
  }
  while (x > 0 && y > 0) { x--; y--; out.push({ type: 'same', text: a[x] }) }
  return out.reverse()
}

/** Counts and hunks (with `context` lines around each change). */
export function lineDiff(before: string, after: string, context = 3): LineDiff {
  const { ops, coarse } = diffOps(splitLines(before), splitLines(after))
  let added = 0, removed = 0
  for (const op of ops) { if (op.type === 'add') added++; else if (op.type === 'del') removed++ }
  // Changes closer than 2 × context lines share a hunk.
  const changed: number[] = []
  ops.forEach((op, i) => { if (op.type !== 'same') changed.push(i) })
  const hunks: DiffHunk[] = []
  let g = 0
  while (g < changed.length) {
    let last = g
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= context * 2 + 1) last++
    const from = Math.max(0, changed[g] - context)
    const to = Math.min(ops.length - 1, changed[last] + context)
    hunks.push({ aStart: 0, bStart: 0, lines: ops.slice(from, to + 1) })
    g = last + 1
  }
  for (const h of hunks) {
    const firstA = h.lines.find(l => l.a != null)
    const firstB = h.lines.find(l => l.b != null)
    h.aStart = firstA?.a ?? 1
    h.bStart = firstB?.b ?? 1
  }
  return { added, removed, hunks, coarse }
}

/**
 * Just the +/- counts, for every file at the end of a turn (main process).
 * A lower edit-distance cap keeps a huge rewrite quick there; past it the
 * counts are the plain "all removed, all added" ones.
 */
export function diffCounts(before: string, after: string, maxD = 1500): { added: number; removed: number } {
  const { ops } = diffOps(splitLines(before), splitLines(after), maxD)
  let added = 0, removed = 0
  for (const op of ops) { if (op.type === 'add') added++; else if (op.type === 'del') removed++ }
  return { added, removed }
}
