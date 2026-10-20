import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: { readText: () => '', writeText: () => {} } }))
vi.mock('../src/main/database', () => ({ db: {} }))

describe('spilled tool results are readable but not writable', () => {
  it('read_file and search_files may open the spill folder; writes stay in the working directory', async () => {
    const { executeBuiltinTool, registerReadOnlyRoot } = await import('../src/main/tools/executor')
    const work = mkdtempSync(join(tmpdir(), 'mlx-work-'))
    const spill = mkdtempSync(join(tmpdir(), 'mlx-spill-'))
    const spilled = join(spill, 'chat', '1-000001-run_command.txt')

    // Before registration the path escapes the working directory.
    const denied = await executeBuiltinTool('read_file', { path: join(spill, 'x.txt') }, work)
    expect(denied.is_error).toBe(true)
    expect(denied.content).toContain('escapes working directory')

    registerReadOnlyRoot(spill)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(spill, 'chat'), { recursive: true })
    writeFileSync(spilled, 'line one\nneedle here\n')

    const read = await executeBuiltinTool('read_file', { path: spilled, offset: 2, limit: 1 }, work)
    expect(read.is_error).toBe(false)
    expect(read.content).toContain('needle here')

    const write = await executeBuiltinTool('write_file', { path: spilled, content: 'overwrite' }, work)
    expect(write.is_error).toBe(true)
    expect(write.content).toContain('escapes working directory')

    // Relative paths never resolve into the spill folder.
    const relative = await executeBuiltinTool('read_file', { path: '../x' }, work)
    expect(relative.is_error).toBe(true)
  })

  it('keeps only a memory-safety cap in the executor (the model-facing prune happens in chat.ts)', async () => {
    const { executeBuiltinTool } = await import('../src/main/tools/executor')
    const work = mkdtempSync(join(tmpdir(), 'mlx-work-'))
    writeFileSync(join(work, 'big.txt'), 'a'.repeat(60_000))
    const result = await executeBuiltinTool('read_file', { path: 'big.txt' }, work)
    expect(result.content).not.toContain('[Truncated')
    expect(result.content.length).toBeGreaterThan(60_000)
  })
})
