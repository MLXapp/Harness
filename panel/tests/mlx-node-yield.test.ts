import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
vi.mock('electron', () => ({}))
vi.mock('../src/main/database', () => ({ db: { getSetting: vi.fn(() => undefined), getSessions: vi.fn(() => []) } }))
vi.mock('../src/main/mlx-node', () => ({ mlxNodeStatus: vi.fn() }))
import { RENEW_MS, versionAtLeast, yieldStep } from '../src/main/mlxNodeYield'

describe('MLX Node yields to Harness', () => {
  it('compares versions', () => {
    expect(versionAtLeast('0.9.5', '0.9.5')).toBe(true)
    expect(versionAtLeast('0.10.0', '0.9.5')).toBe(true)
    expect(versionAtLeast('0.9.4', '0.9.5')).toBe(false)
    expect(versionAtLeast(undefined, '0.9.5')).toBe(false)
  })
  it('yields while a local model is loaded, renews, and resumes after', () => {
    const base = { enabled: true, busy: true, yielding: false, lastSentAt: 0, now: 1_000_000 }
    expect(yieldStep(base)).toEqual({ send: 'yield', yielding: true })
    expect(yieldStep({ ...base, yielding: true, lastSentAt: base.now - 1000 })).toEqual({ send: null, yielding: true })
    expect(yieldStep({ ...base, yielding: true, lastSentAt: base.now - RENEW_MS })).toEqual({ send: 'yield', yielding: true })
    expect(yieldStep({ ...base, busy: false, yielding: true })).toEqual({ send: 'resume', yielding: false })
    expect(yieldStep({ ...base, enabled: false, yielding: true })).toEqual({ send: 'resume', yielding: false })
    expect(yieldStep({ ...base, busy: false })).toEqual({ send: null, yielding: false })
  })
  it('sends the links in the background to the running copy only', () => {
    const src = readFileSync('src/main/mlxNodeYield.ts', 'utf8')
    expect(src).toContain("execFile('/usr/bin/open', ['-g', '-a', node.path!, url]")
    expect(src).toContain('!node.running')
    expect(src).toContain('mlx://yield?by=harness&minutes=')
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain('processManager.killAll(), releaseMlxNodeYield()])')
  })
})
