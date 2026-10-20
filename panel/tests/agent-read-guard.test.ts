import { describe, expect, it } from 'vitest'
import { mkdtempSync, utimesSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileReadTracker, READ_GUARDED_TOOLS } from '../src/main/agent/readGuard'

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `mlx-agent-${name}-`))

describe('read-before-edit guard', () => {
  it('guards the file-modifying tools', () => {
    for (const tool of ['write_file', 'edit_file', 'patch_file', 'batch_edit', 'insert_text', 'replace_lines']) {
      expect(READ_GUARDED_TOOLS.has(tool)).toBe(true)
    }
    expect(READ_GUARDED_TOOLS.has('read_file')).toBe(false)
  })

  it('allows new files, refuses unread existing files, allows after a read', () => {
    const dir = tmp('guard')
    writeFileSync(join(dir, 'a.ts'), 'const a = 1\n')
    const guard = new FileReadTracker()
    expect(guard.checkTool('chat', 'write_file', { path: 'new.ts', content: 'x' }, dir)).toBeNull()

    const refusal = guard.checkTool('chat', 'edit_file', { path: 'a.ts' }, dir)
    expect(refusal).toContain('has not been read in this session')
    expect(refusal).toContain('read_file')

    guard.afterTool('chat', 'read_file', { path: 'a.ts' }, dir, true)
    expect(guard.checkTool('chat', 'edit_file', { path: 'a.ts' }, dir)).toBeNull()
    // Other chats are separate sessions.
    expect(guard.checkTool('other', 'edit_file', { path: 'a.ts' }, dir)).not.toBeNull()
    // A failed read does not count.
    guard.afterTool('other', 'read_file', { path: 'a.ts' }, dir, false)
    expect(guard.checkTool('other', 'edit_file', { path: 'a.ts' }, dir)).not.toBeNull()
  })

  it('refuses after an outside change, accepts a touch with identical content', () => {
    const dir = tmp('guard-change')
    const file = join(dir, 'b.txt')
    writeFileSync(file, 'one\n')
    const guard = new FileReadTracker()
    guard.afterTool('s', 'read_file', { path: 'b.txt' }, dir, true)

    const future = new Date(Date.now() + 60_000)
    utimesSync(file, future, future)
    expect(guard.checkTool('s', 'edit_file', { path: 'b.txt' }, dir)).toBeNull()

    writeFileSync(file, 'two, changed elsewhere\n')
    expect(guard.checkTool('s', 'edit_file', { path: 'b.txt' }, dir)).toContain('has changed on disk')

    guard.afterTool('s', 'read_file', { path: 'b.txt' }, dir, true)
    expect(guard.checkTool('s', 'replace_lines', { path: 'b.txt' }, dir)).toBeNull()
  })

  it('a successful write counts as seen, so consecutive edits need no re-read', () => {
    const dir = tmp('guard-write')
    writeFileSync(join(dir, 'c.txt'), 'v1')
    const guard = new FileReadTracker()
    guard.afterTool('s', 'read_file', { path: 'c.txt' }, dir, true)
    writeFileSync(join(dir, 'c.txt'), 'v2 written by the tool')
    guard.afterTool('s', 'write_file', { path: 'c.txt' }, dir, true)
    expect(guard.checkTool('s', 'edit_file', { path: 'c.txt' }, dir)).toBeNull()
    guard.clear('s')
    expect(guard.checkTool('s', 'edit_file', { path: 'c.txt' }, dir)).not.toBeNull()
  })

  it('resolves symlinks to the same file', () => {
    const dir = tmp('guard-link')
    writeFileSync(join(dir, 'real.txt'), 'x')
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'))
    const guard = new FileReadTracker()
    guard.afterTool('s', 'read_file', { path: 'link.txt' }, dir, true)
    expect(guard.checkTool('s', 'edit_file', { path: 'real.txt' }, dir)).toBeNull()
  })
})

describe('read guard wiring in the chat tool loop', () => {
  it('checks before executing a built-in tool and records what the model saw after', async () => {
    const { readFileSync } = await import('node:fs')
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    const check = chat.indexOf('const readGuardRefusal = fileReadTracker.checkTool(')
    const exec = chat.indexOf('const result = await executeBuiltinTool(', check)
    const after = chat.indexOf('fileReadTracker.afterTool(', exec)
    expect(check).toBeGreaterThan(-1)
    expect(exec).toBeGreaterThan(check)
    expect(after).toBeGreaterThan(exec)
    // A refusal is a normal model-facing tool result, not a thrown error.
    expect(chat.slice(check, exec)).toContain('resultText = readGuardRefusal;')
    expect(chat).toContain('fileReadTracker.clear(chatId);')
  })
})
