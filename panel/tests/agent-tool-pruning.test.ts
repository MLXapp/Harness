import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PRUNE_HEAD_CHARS,
  PRUNE_TAIL_CHARS,
  PRUNE_THRESHOLD_CHARS,
  pruneToolResult,
  resolvePruneBudget,
  writeSpillFile,
} from '../src/main/agent/toolResultPruning'

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `mlx-agent-${name}-`))

describe('tool result pruning', () => {
  it('leaves results up to 8,192 chars untouched', () => {
    const text = 'a'.repeat(PRUNE_THRESHOLD_CHARS)
    expect(pruneToolResult(text, { toolName: 'run_command' })).toEqual({ text, pruned: false, omittedChars: 0 })
  })

  it('keeps the first 4,096 and last 1,024 chars with a marker saying how much was cut', () => {
    const text = 'H'.repeat(PRUNE_HEAD_CHARS) + 'M'.repeat(10_000) + 'T'.repeat(PRUNE_TAIL_CHARS)
    const result = pruneToolResult(text, { toolName: 'run_command' })
    expect(result.pruned).toBe(true)
    expect(result.omittedChars).toBe(10_000)
    expect(result.text.startsWith('H'.repeat(PRUNE_HEAD_CHARS) + '\n\n[...')).toBe(true)
    expect(result.text.endsWith(']\n\n' + 'T'.repeat(PRUNE_TAIL_CHARS))).toBe(true)
    expect(result.text).toContain('10,000 of 15,120 characters cut')
    expect(result.text).not.toContain('M')
  })

  it('spills very large results to a readable file and names its path', () => {
    const dir = tmp('spill')
    const text = 'start\n' + 'x'.repeat(40_000) + '\nERROR: the real failure is at the end'
    const result = pruneToolResult(text, {
      toolName: 'run_command',
      spill: full => writeSpillFile(dir, 'run_command', full, 1234),
    })
    expect(result.spillPath).toMatch(/1234-\d{6}-run_command\.txt$/)
    expect(readFileSync(result.spillPath!, 'utf8')).toBe(text)
    expect(result.text).toContain(`The full result is saved at: ${result.spillPath}`)
    expect(result.text).toContain('read_file')
    expect(result.text.endsWith('ERROR: the real failure is at the end')).toBe(true)
    expect(statSync(result.spillPath!).mode & 0o777).toBe(0o600)
  })

  it('does not spill read_file (the source is already on disk) but points to offset/limit', () => {
    const result = pruneToolResult('y'.repeat(50_000), { toolName: 'read_file', spill: () => { throw new Error('no') } })
    expect(result.spillPath).toBeUndefined()
    expect(result.text).toContain('offset/limit')
  })

  it('keeps pruning when the spill fails', () => {
    const result = pruneToolResult('z'.repeat(50_000), { toolName: 'fetch_url', spill: () => { throw new Error('disk full') } })
    expect(result.pruned).toBe(true)
    expect(result.spillPath).toBeUndefined()
  })

  it('never splits a surrogate pair', () => {
    const text = 'a'.repeat(PRUNE_HEAD_CHARS - 1) + '😀'.repeat(5000)
    const result = pruneToolResult(text, { toolName: 'x' })
    expect(result.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(result.text).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })

  it('honours an explicit per-chat limit', () => {
    expect(resolvePruneBudget()).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    expect(resolvePruneBudget(16000)).toEqual({ thresholdChars: 16000, headChars: 8000, tailChars: 2000 })
  })
})

describe('spill folder housekeeping', () => {
  it('removes spill files older than a week and empty chat folders', async () => {
    const { pruneOldSpillFiles } = await import('../src/main/agent/toolResultPruning')
    const root = tmp('spill-root')
    const old = writeSpillFile(join(root, 'chat-a'), 'run_command', 'old')
    const fresh = writeSpillFile(join(root, 'chat-b'), 'run_command', 'fresh')
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(old, weekAgo, weekAgo)
    expect(pruneOldSpillFiles(root)).toBe(1)
    expect(() => statSync(join(root, 'chat-a'))).toThrow()
    expect(readFileSync(fresh, 'utf8')).toBe('fresh')
    expect(pruneOldSpillFiles(join(root, 'missing'))).toBe(0)
  })
})
