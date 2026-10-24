import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routedExpertCount, shouldAutoStreamExperts } from '../src/main/flashMoeAuto'
import { explicitSlotBank, raisePrefillStepForStreaming } from '../src/shared/flashMoeLaunch'

const { db } = vi.hoisted(() => ({
  db: {
    getSessions: () => [], getSession: () => undefined, getSessionByModelPath: () => undefined,
    getSetting: () => undefined, createSession: () => undefined, updateSession: () => undefined,
  },
}))
vi.mock('../src/main/database', () => ({ db }))
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/tmp', isPackaged: false },
  powerSaveBlocker: { isStarted: () => false, start: () => 1, stop: () => undefined },
}))
import { SessionManager } from '../src/main/sessions'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A bundle whose weights file reports `share` × this machine's memory (sparse, no disk used). */
function bundle(config: object, share: number, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'mlx-fmoe-auto-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  const weights = join(dir, 'model.safetensors')
  writeFileSync(weights, '')
  truncateSync(weights, Math.ceil(totalmem() * share))
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text)
  return dir
}

const MOE = { model_type: 'qwen3_moe', num_experts: 128, num_experts_per_tok: 8 }
const flag = (args: string[], name: string) => {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}

describe('routed expert count', () => {
  it('reads the usual config keys, nested text configs too', () => {
    expect(routedExpertCount({ num_experts: 64 })).toBe(64)
    expect(routedExpertCount({ n_routed_experts: 256 })).toBe(256)
    expect(routedExpertCount({ text_config: { num_local_experts: 8 } })).toBe(8)
    expect(routedExpertCount({ model_type: 'qwen3', num_experts: 1 })).toBe(0)
    expect(routedExpertCount(null)).toBe(0)
  })
})

describe('automatic expert streaming', () => {
  const base = { requested: false, excluded: false, totalBytes: 100 }

  it('turns on for a MoE model above 75% of memory', () => {
    const dir = bundle(MOE, 0)
    expect(shouldAutoStreamExperts({ ...base, modelPath: dir, modelFileBytes: 80 })).toBe(true)
    expect(shouldAutoStreamExperts({ ...base, modelPath: dir, modelFileBytes: 70 })).toBe(false)
  })

  it('stays off for dense models, JANG bundles and excluded paths', () => {
    expect(shouldAutoStreamExperts({ ...base, modelPath: bundle({ model_type: 'qwen3' }, 0), modelFileBytes: 90 })).toBe(false)
    expect(shouldAutoStreamExperts({ ...base, modelPath: bundle(MOE, 0, { 'jang_config.json': '{}' }), modelFileBytes: 90 })).toBe(false)
    expect(shouldAutoStreamExperts({ ...base, excluded: true, modelPath: bundle(MOE, 0), modelFileBytes: 90 })).toBe(false)
  })
})

describe('slot count and prompt chunk', () => {
  it('passes no slot count for Auto or the old 256 default', () => {
    expect(explicitSlotBank(0)).toBeNull()
    expect(explicitSlotBank(256)).toBeNull()
    expect(explicitSlotBank(undefined)).toBeNull()
    expect(explicitSlotBank(512)).toBe(512)
  })

  it('raises only the default prompt chunk', () => {
    const a = ['--prefill-step-size', '2048']
    raisePrefillStepForStreaming(a)
    expect(a).toEqual(['--prefill-step-size', '4096'])
    const b = ['--prefill-step-size', '768']
    raisePrefillStepForStreaming(b)
    expect(b).toEqual(['--prefill-step-size', '768'])
  })
})

describe('launch command', () => {
  const launch = (modelPath: string, extra: object = {}) =>
    (new SessionManager() as any).buildArgs({
      modelPath, host: '127.0.0.1', port: 8123, prefillStepSize: 2048, flashMoeSlotBank: 256, ...extra,
    }) as string[]

  it('streams a MoE model that does not fit, with an automatic cache and bigger chunks', () => {
    const args = launch(bundle(MOE, 0.8))
    expect(args).toContain('--flash-moe')
    expect(args).not.toContain('--flash-moe-slot-bank')
    expect(flag(args, '--prefill-step-size')).toBe('4096')
  })

  it('leaves a MoE model that fits as it was', () => {
    const args = launch(bundle(MOE, 0.3))
    expect(args).not.toContain('--flash-moe')
    expect(flag(args, '--prefill-step-size')).toBe('2048')
  })

  it('keeps a slot count and chunk size the user chose', () => {
    const args = launch(bundle(MOE, 0.3), { flashMoe: true, flashMoeSlotBank: 512, prefillStepSize: 1024 })
    expect(flag(args, '--flash-moe-slot-bank')).toBe('512')
    expect(flag(args, '--prefill-step-size')).toBe('1024')
  })
})
