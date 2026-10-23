import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnChanges } from '../src/main/agent/turnChanges'
import { lineDiff, diffOps, splitLines } from '../src/shared/lineDiff'
import { changeTotals } from '../src/shared/changes'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tc-root-'))
  const work = mkdtempSync(join(tmpdir(), 'tc-work-'))
  return { tc: new TurnChanges(() => root), work, root }
}

describe('line diff', () => {
  it('finds the edit and counts lines', () => {
    const d = lineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    expect(d.coarse).toBe(false)
    const ops = d.hunks.flatMap(h => h.lines).map(o => `${o.type[0]}${o.text}`)
    expect(ops).toEqual(['sa', 'db', 'aB', 'sc', 'sd', 'ae'])
  })
  it('keeps far-apart changes in separate hunks with 3 lines of context', () => {
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`)
    const b = [...a]; b[2] = 'X'; b[30] = 'Y'
    const d = lineDiff(a.join('\n'), b.join('\n'))
    expect(d.hunks).toHaveLength(2)
    expect(d.hunks[0].lines.filter(l => l.type === 'same')).toHaveLength(5) // 2 before (file start) + 3 after
    expect(d.hunks[1].aStart).toBe(28)
  })
  it('handles empty sides and trailing newlines', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('x\n')).toEqual(['x'])
    expect(lineDiff('', 'one\ntwo\n')).toMatchObject({ added: 2, removed: 0 })
    expect(lineDiff('one\ntwo\n', '')).toMatchObject({ added: 0, removed: 2 })
    expect(lineDiff('same\n', 'same\n').hunks).toHaveLength(0)
  })
  it('falls back to a coarse diff when the edit distance is too large', () => {
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`), b = Array.from({ length: 300 }, (_, i) => `b${i}`)
    const r = diffOps(a, b, 50)
    expect(r.coarse).toBe(true)
    expect(r.ops.filter(o => o.type === 'del')).toHaveLength(300)
  })
})

describe('turn changes', () => {
  it('records the files a turn changed, with counts, and nothing else', () => {
    const { tc, work } = setup()
    const edited = join(work, 'a.txt'), created = join(work, 'sub', 'new.txt'), untouched = join(work, 'same.txt')
    writeFileSync(edited, 'one\ntwo\n'); writeFileSync(untouched, 'x')
    tc.begin('chat1', 'msg1', work)
    tc.noteBefore('chat1', edited); writeFileSync(edited, 'one\n2\nthree\n')
    tc.noteBefore('chat1', created); mkdirSync(join(work, 'sub'), { recursive: true }); writeFileSync(created, 'hi\n')
    tc.noteBefore('chat1', untouched) // touched but written back the same
    const set = tc.finish('chat1', 'msg1')!
    expect(set.files.map(f => [f.shown, f.kind, f.added, f.removed])).toEqual([
      ['a.txt', 'modified', 2, 1],
      ['sub/new.txt', 'added', 1, 0],
    ])
    expect(changeTotals(set)).toMatchObject({ files: 2, added: 3, removed: 1 })
    expect(tc.list('chat1')).toHaveLength(1)
    expect(tc.fileTexts('chat1', 'msg1', edited)).toMatchObject({ before: 'one\ntwo\n', after: 'one\n2\nthree\n', changedSince: false })
  })

  it('keeps the first version when a file is touched twice, and ignores other turns', () => {
    const { tc, work } = setup()
    const f = join(work, 'f.txt'); writeFileSync(f, 'v1')
    tc.begin('c', 'm1', work)
    tc.noteBefore('c', f); writeFileSync(f, 'v2')
    tc.noteBefore('c', f); writeFileSync(f, 'v3')
    expect(tc.finish('c', 'other')).toBeNull() // not the open turn
    const set = tc.finish('c', 'm1')!
    expect(tc.fileTexts('c', 'm1', f)?.before).toBe('v1')
    expect(set.files[0].kind).toBe('modified')
  })

  it('reverts files, refusing ones changed since unless forced', () => {
    const { tc, work } = setup()
    const a = join(work, 'a.txt'), b = join(work, 'b.txt'), made = join(work, 'made.txt')
    writeFileSync(a, 'A0'); writeFileSync(b, 'B0')
    tc.begin('c', 'm', work)
    for (const p of [a, b, made]) tc.noteBefore('c', p)
    writeFileSync(a, 'A1'); writeFileSync(b, 'B1'); writeFileSync(made, 'new')
    tc.finish('c', 'm')
    writeFileSync(b, 'B2-user-edit')
    const r = tc.revert('c', 'm')
    expect(r.reverted.sort()).toEqual([a, made].sort())
    expect(r.conflicts).toEqual([b])
    expect(readFileSync(a, 'utf8')).toBe('A0')
    expect(existsSync(made)).toBe(false)
    expect(readFileSync(b, 'utf8')).toBe('B2-user-edit')
    const forced = tc.revert('c', 'm', [b], true)
    expect(forced.reverted).toEqual([b])
    expect(readFileSync(b, 'utf8')).toBe('B0')
    expect(tc.list('c')[0].files.every(f => f.reverted)).toBe(true)
  })

  it('restores a deleted file', () => {
    const { tc, work } = setup()
    const f = join(work, 'gone.txt'); writeFileSync(f, 'keep me')
    tc.begin('c', 'm', work)
    tc.noteBefore('c', f)
    require('node:fs').unlinkSync(f)
    const set = tc.finish('c', 'm')!
    expect(set.files[0]).toMatchObject({ kind: 'deleted', removed: 1, revertible: true })
    expect(tc.revert('c', 'm').reverted).toEqual([f])
    expect(readFileSync(f, 'utf8')).toBe('keep me')
  })

  it('keeps the newest 30 turns and forgets a deleted chat', () => {
    const { tc, work, root } = setup()
    const f = join(work, 'n.txt')
    for (let i = 0; i < 33; i++) {
      tc.begin('c', `m${i}`, work)
      tc.noteBefore('c', f)
      writeFileSync(f, `v${i}`)
      tc.finish('c', `m${i}`)
    }
    const ids = tc.list('c').map(s => s.messageId)
    expect(ids).toHaveLength(30)
    expect(ids[0]).toBe('m3')
    expect(existsSync(join(root, 'c', 'm0'))).toBe(false)
    tc.forget('c')
    expect(tc.list('c')).toEqual([])
  })

  it('refuses unsafe ids', () => {
    const { tc, work } = setup()
    tc.begin('../x', 'm', work)
    tc.noteBefore('../x', join(work, 'a'))
    expect(tc.finish('../x')).toBeNull()
    expect(tc.list('../../etc')).toEqual([])
  })
})

describe('wired into the agent', () => {
  const exec = readFileSync('src/main/tools/executor.ts', 'utf8')
  const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
  it('every file tool reports before it changes a file', () => {
    expect(exec).toContain('changeHook.run(options.beforeChange ?? null')
    for (const fn of ['function backup(', 'function writeFile(', 'function moveFile(', 'function copyFile(']) {
      const at = exec.indexOf(fn)
      expect(exec.slice(at, at + 1400)).toContain('noteChange(')
    }
  })
  it('the chat loop opens and closes a checkpoint per turn', () => {
    expect(chat).toContain('turnChanges.begin(chatId, assistantMessageId, overrides.workingDirectory)')
    expect(chat).toContain('beforeChange: (fullPath) => turnChanges.noteBefore(chatId, fullPath)')
    expect(chat).toContain('turnChanges.finish(chatId, turnChangeMessageId)')
  })
})
