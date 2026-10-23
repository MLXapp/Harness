import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ clipboard: {} }))
vi.mock('../src/main/database', () => ({ db: { getSetting: vi.fn(() => undefined) } }))
import { findLoose, nearestFragment, spliceLines } from '../src/main/agent/editMatch'
import { FileBackups } from '../src/main/agent/fileBackups'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function dir(prefix = 'mlx-edit-') { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d }

const FILE = [
  'function add(a, b) {',
  '    return a + b',
  '}',
  '',
  'function sub(a, b) {',
  '    return a - b',
  '}',
].join('\n')

describe('findLoose', () => {
  it('matches lines that differ only in trailing whitespace', () => {
    const m = findLoose(FILE, 'function add(a, b) {   \n    return a + b  ')
    expect(m).toMatchObject({ kind: 'unique', start: 0, end: 2, level: 'trailing' })
  })

  it('matches across a different indent and re-indents the replacement', () => {
    const m = findLoose(FILE, 'return a - b\n}')
    expect(m.kind).toBe('unique')
    if (m.kind !== 'unique') return
    expect(m.level).toBe('indent')
    expect(m.reindent('return b - a\n}')).toBe('    return b - a\n    }')
  })

  it('ignores blank lines inside the search when the file has none', () => {
    const m = findLoose(FILE, '}\n\n\nfunction sub(a, b) {')
    expect(m).toMatchObject({ kind: 'unique', start: 2, end: 5 })
  })

  it('reports an ambiguous loose match instead of guessing', () => {
    expect(findLoose(FILE, '}  ')).toMatchObject({ kind: 'ambiguous', count: 2 })
  })

  it('returns none for text that is not there', () => {
    expect(findLoose(FILE, 'return a * b')).toEqual({ kind: 'none' })
  })

  it('splices whole lines and keeps CRLF files CRLF', () => {
    const crlf = 'a\r\nb\r\nc'
    expect(spliceLines(crlf, 1, 2, 'B\n')).toBe('a\r\nB\r\nc')
  })
})

describe('nearestFragment', () => {
  it('points at the closest lines, numbered', () => {
    const near = nearestFragment(FILE, 'function sub(x, y) {\n  return x - y')
    expect(near).not.toBeNull()
    expect(near!.text).toContain('    5 | function sub(a, b) {')
    expect(near!.from).toBeLessThanOrEqual(5)
  })

  it('returns null when nothing looks alike', () => {
    expect(nearestFragment(FILE, 'zzzz qqqq')).toBeNull()
  })
})

describe('edit_file second chance', () => {
  it('applies a unique near miss and says so', async () => {
    process.env.MLX_HARNESS_BACKUP_DIR = dir('mlx-bak-')
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = dir()
    writeFileSync(join(work, 'm.js'), FILE)
    const r = await executeBuiltinTool('edit_file', { path: 'm.js', search_text: 'return a + b   ', replacement_text: 'return b + a' }, work)
    expect(r.is_error).toBe(false)
    expect(r.content).toContain('matched ignoring')
    expect(readFileSync(join(work, 'm.js'), 'utf8')).toContain('    return b + a\n}')
  })

  it('answers a miss with the nearest fragment, not the whole file', async () => {
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = dir()
    writeFileSync(join(work, 'm.js'), FILE)
    const r = await executeBuiltinTool('edit_file', { path: 'm.js', search_text: 'function sub(x, y) {\n  return x - y', replacement_text: 'x' }, work)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('closest part of the file')
    expect(r.content).toContain('function sub(a, b)')
  })

  it('keeps $ patterns in the replacement literal', async () => {
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = dir()
    writeFileSync(join(work, 'p.txt'), 'price: X')
    await executeBuiltinTool('edit_file', { path: 'p.txt', search_text: 'X', replacement_text: "$& costs $'" }, work)
    expect(readFileSync(join(work, 'p.txt'), 'utf8')).toBe("price: $& costs $'")
  })
})

describe('undo safety', () => {
  it('copies a file aside before an edit and restore_file puts it back', async () => {
    process.env.MLX_HARNESS_BACKUP_DIR = dir('mlx-bak-')
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = dir()
    writeFileSync(join(work, 'a.txt'), 'original')
    await executeBuiltinTool('write_file', { path: 'a.txt', content: 'changed' }, work)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('changed')
    const listed = await executeBuiltinTool('restore_file', {}, work)
    expect(listed.content).toContain('a.txt')
    const restored = await executeBuiltinTool('restore_file', { path: 'a.txt' }, work)
    expect(restored.is_error).toBe(false)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('original')
  })

  it('makes no copy of a file the agent created itself', async () => {
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = dir()
    await executeBuiltinTool('write_file', { path: 'new.txt', content: 'one' }, work)
    await executeBuiltinTool('write_file', { path: 'new.txt', content: 'two' }, work)
    const r = await executeBuiltinTool('restore_file', { path: 'new.txt' }, work)
    expect(r.is_error).toBe(true)
  })

  it('delete without a Trash keeps a copy that can be restored', async () => {
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = dir()
    writeFileSync(join(work, 'gone.txt'), 'keep me')
    const del = await executeBuiltinTool('delete_file', { path: 'gone.txt' }, work)
    expect(del.is_error).toBe(false)
    expect(existsSync(join(work, 'gone.txt'))).toBe(false)
    await executeBuiltinTool('restore_file', { path: 'gone.txt' }, work)
    expect(readFileSync(join(work, 'gone.txt'), 'utf8')).toBe('keep me')
  })

  it('moves never overwrite', async () => {
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = dir()
    writeFileSync(join(work, 'a'), 'A')
    writeFileSync(join(work, 'b'), 'B')
    const r = await executeBuiltinTool('move_file', { source: 'a', destination: 'b' }, work)
    expect(r.is_error).toBe(true)
    expect(readFileSync(join(work, 'b'), 'utf8')).toBe('B')
  })

  it('keeps only the newest copies and skips big files', () => {
    const root = dir('mlx-bak-')
    const work = dir()
    const b = new FileBackups(() => root, 3, 10)
    const f = join(work, 'f.txt')
    for (let i = 0; i < 5; i++) { writeFileSync(f, `v${i}`); b.save(f, work, 'edit_file') }
    const list = b.list(work)
    expect(list).toHaveLength(3)
    writeFileSync(f, 'x'.repeat(11))
    expect(b.save(f, work, 'edit_file')).toEqual({ skipped: 'too-big' })
    const r = b.restore(work, { fullPath: f })
    expect(r.ok).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('v4')
  })
})
