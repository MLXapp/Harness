import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldAutoStreamExperts, streamsFromLoad } from '../src/main/flashMoeAuto'
import { launchSlotBank, raisePrefillStepForStreaming } from '../src/shared/flashMoeLaunch'

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

describe('architectures that stream from load', () => {
  it('lists Qwen3-MoE, Qwen3-Next and Mixtral, nested text configs too', () => {
    expect(streamsFromLoad({ model_type: 'qwen3_moe' })).toBe(true)
    expect(streamsFromLoad({ model_type: 'mixtral' })).toBe(true)
    expect(streamsFromLoad({ model_type: 'x', text_config: { model_type: 'qwen3_next' } })).toBe(true)
    for (const other of ['glm5_next', 'minimax_m3', 'deepseek_v4', 'gpt_oss', 'qwen2_moe', 'qwen3']) {
      expect(streamsFromLoad({ model_type: other, num_experts: 64 })).toBe(false)
    }
    expect(streamsFromLoad(null)).toBe(false)
  })
})

describe('automatic expert streaming', () => {
  const base = { requested: false, optedOut: false, excluded: false, totalBytes: 100 }

  it('turns on for a listed MoE model above 75% of memory', () => {
    const dir = bundle(MOE, 0)
    expect(shouldAutoStreamExperts({ ...base, modelPath: dir, modelFileBytes: 80 })).toBe(true)
    expect(shouldAutoStreamExperts({ ...base, modelPath: dir, modelFileBytes: 70 })).toBe(false)
  })

  it('stays off for other architectures, every JANG stamp, excluded paths and an opt-out', () => {
    expect(shouldAutoStreamExperts({ ...base, modelPath: bundle({ model_type: 'glm5_next', n_routed_experts: 256 }, 0), modelFileBytes: 90 })).toBe(false)
    for (const stamp of ['jang_config.json', 'jjqf_config.json', 'jang_cfg.json']) {
      expect(shouldAutoStreamExperts({ ...base, modelPath: bundle(MOE, 0, { [stamp]: '{}' }), modelFileBytes: 90 })).toBe(false)
    }
    expect(shouldAutoStreamExperts({ ...base, excluded: true, modelPath: bundle(MOE, 0), modelFileBytes: 90 })).toBe(false)
    expect(shouldAutoStreamExperts({ ...base, optedOut: true, modelPath: bundle(MOE, 0), modelFileBytes: 90 })).toBe(false)
  })
})

describe('slot count and prompt chunk', () => {
  it('passes no slot count for Auto or the old untouched 256, and keeps a chosen 256', () => {
    expect(launchSlotBank(0)).toBeNull()
    expect(launchSlotBank(256)).toBeNull()
    expect(launchSlotBank(256, true)).toBe(256)
    expect(launchSlotBank(undefined)).toBeNull()
    expect(launchSlotBank(512)).toBe(512)
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

  it('respects the opt-out', () => {
    expect(launch(bundle(MOE, 0.8), { flashMoeAuto: false })).not.toContain('--flash-moe')
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
