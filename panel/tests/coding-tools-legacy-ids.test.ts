/**
 * Entries written into other tools' configs up to 0.2.x carry the legacy ids
 * ('_mlxstudio' tag, 'mlxstudio' provider keys and API-key placeholder,
 * 'MLXSTUDIO_*' Codex providers). New entries use '_mlxharness' /
 * 'mlxharness' / 'MLXHARNESS_*'. Both must be found, a legacy entry must be
 * taken over on the next add (keeping the user's parked values and models),
 * and remove must clean up both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
      electronMock.handlers.set(channel, handler)
    }),
  },
}))

describe('coding tools: legacy ids from 0.2.x and earlier', () => {
  let home: string
  const oldHome = process.env.HOME
  const oldPath = process.env.PATH
  const oldFetch = global.fetch
  const BASE = 'http://127.0.0.1:8080'

  beforeEach(async () => {
    home = join(tmpdir(), `vmlx-ct-legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    process.env.HOME = home
    process.env.PATH = `${join(home, '.local', 'bin')}:${oldPath || ''}`
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as any
    for (const cmd of ['claude', 'codex', 'opencode', 'openclaw', 'hermes']) {
      writeFileSync(join(home, '.local', 'bin', cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    electronMock.handlers.clear()
    vi.resetModules()
    const mod = await import('../src/main/ipc/coding-tools')
    mod.registerCodingToolHandlers()
  })

  afterEach(() => {
    process.env.HOME = oldHome
    process.env.PATH = oldPath
    global.fetch = oldFetch
    rmSync(home, { recursive: true, force: true })
  })

  const add = () => electronMock.handlers.get('tools:addCodingToolConfig')!
  const remove = () => electronMock.handlers.get('tools:removeCodingToolConfig')!
  const status = () => electronMock.handlers.get('tools:getCodingToolStatus')!
  const write = (rel: string, text: string) => {
    const path = join(home, rel)
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    writeFileSync(path, text)
    return path
  }
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

  it('Claude Code: lists a legacy entry, keeps its parked values on add, restores them on remove', async () => {
    const path = write('.claude/settings.json', JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: BASE,
        ANTHROPIC_MODEL: 'old-model',
        ANTHROPIC_API_KEY: 'mlxstudio',
        _mlxstudio: 'true',
        _mlxstudio_prev: { ANTHROPIC_BASE_URL: null, ANTHROPIC_MODEL: null, ANTHROPIC_API_KEY: 'sk-ant-REAL' },
      },
    }))
    expect((await status()({}))['claude-code'].entries).toEqual([{ label: 'old-model', baseUrl: BASE }])

    expect((await add()({}, 'claude-code', BASE, 'new-model', 8080))?.success).toBe(true)
    let cfg = json(path)
    expect(cfg.env._mlxharness).toBe('true')
    expect(cfg.env.ANTHROPIC_API_KEY).toBe('mlxharness')
    expect(cfg.env._mlxharness_prev.ANTHROPIC_API_KEY).toBe('sk-ant-REAL')
    expect(JSON.stringify(cfg)).not.toMatch(/studio/i)

    expect((await remove()({}, 'claude-code', 'new-model'))?.success).toBe(true)
    cfg = json(path)
    expect(cfg.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-REAL' })
  })

  it('Claude Code: removing a legacy entry restores the user values without an add', async () => {
    const path = write('.claude/settings.json', JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: BASE,
        ANTHROPIC_MODEL: 'old-model',
        ANTHROPIC_API_KEY: 'mlxstudio',
        _mlxstudio: 'true',
        _mlxstudio_prev: { ANTHROPIC_BASE_URL: null, ANTHROPIC_MODEL: 'claude-opus-4', ANTHROPIC_API_KEY: null },
      },
    }))
    expect((await remove()({}, 'claude-code', 'old-model'))?.success).toBe(true)
    expect(json(path).env).toEqual({ ANTHROPIC_MODEL: 'claude-opus-4' })
  })

  it('Codex: lists MLXSTUDIO_* providers and removes them', async () => {
    const path = write('.codex/config.toml',
      '[model_providers.MLXSTUDIO_OLD]\nname = "x"\nbase_url = "http://127.0.0.1:8080/v1"\nwire_api = "responses"\n')
    expect((await status()({})).codex.entries).toEqual([{ label: 'MLXSTUDIO_OLD', baseUrl: 'http://127.0.0.1:8080/v1' }])
    expect((await remove()({}, 'codex', 'MLXSTUDIO_OLD'))?.success).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('MLXSTUDIO_OLD')
  })

  it('OpenCode: replaces the same model\'s legacy entry and leaves unrelated providers alone', async () => {
    const path = write('.config/opencode/opencode.json', JSON.stringify({
      provider: {
        'mlxstudio-m': { name: 'old', options: { baseURL: `${BASE}/v1` }, _mlxstudio: true },
        'mlxstudio-other': { name: 'old other', options: { baseURL: `${BASE}/v1` }, _mlxstudio: true },
        mine: { name: 'theirs' },
      },
    }))
    expect((await status()({})).opencode.entries.map((e: any) => e.label).sort()).toEqual(['mlxstudio-m', 'mlxstudio-other'])
    expect((await add()({}, 'opencode', BASE, 'm', 8080))?.success).toBe(true)
    const cfg = json(path)
    expect(Object.keys(cfg.provider).sort()).toEqual(['mine', 'mlxharness-m', 'mlxstudio-other'])
    expect(cfg.provider['mlxharness-m']._mlxharness).toBe(true)
    expect((await status()({})).opencode.entries.map((e: any) => e.label).sort()).toEqual(['mlxharness-m', 'mlxstudio-other'])
  })

  it('OpenClaw: moves the legacy provider and its allowlist into mlxharness; remove cleans both', async () => {
    const path = write('.openclaw/openclaw.json', JSON.stringify({
      models: { mode: 'merge', providers: { mlxstudio: { baseUrl: `${BASE}/v1`, apiKey: 'mlxstudio', models: [{ id: 'model-a' }], _mlxstudio: true } } },
      agents: { defaults: { models: { 'mlxstudio/model-a': { alias: 'model-a' }, 'other/x': {} } } },
    }))
    expect((await add()({}, 'openclaw', BASE, 'model-b', 8080))?.success).toBe(true)
    let cfg = json(path)
    expect(cfg.models.providers.mlxstudio).toBeUndefined()
    expect(cfg.models.providers.mlxharness.models.map((m: any) => m.id).sort()).toEqual(['model-a', 'model-b'])
    expect(cfg.models.providers.mlxharness.apiKey).toBe('mlxharness')
    expect(cfg.models.providers.mlxharness._mlxharness).toBe(true)
    expect(cfg.models.providers.mlxharness._mlxstudio).toBeUndefined()
    expect(Object.keys(cfg.agents.defaults.models).sort()).toEqual(['mlxharness/model-a', 'mlxharness/model-b', 'other/x'])

    expect((await remove()({}, 'openclaw', 'mlxharness'))?.success).toBe(true)
    cfg = json(path)
    expect(cfg.models.providers).toEqual({})
    expect(Object.keys(cfg.agents.defaults.models)).toEqual(['other/x'])
  })

  it('Hermes: merges the legacy provider into mlxharness, and removes models from either', async () => {
    const { load } = await import('js-yaml')
    const path = write('.hermes/config.yaml',
      'providers:\n  mlxstudio:\n    base_url: http://127.0.0.1:8080/v1\n    api_key: mlxstudio\n    models:\n      model-a: {}\n    _mlxstudio: true\n')
    expect((await status()({})).hermes.entries).toEqual([{ label: 'model-a', baseUrl: 'http://127.0.0.1:8080/v1' }])

    expect((await add()({}, 'hermes', BASE, 'model-b', 8080))?.success).toBe(true)
    let doc = load(readFileSync(path, 'utf8')) as any
    expect(doc.providers.mlxstudio).toBeUndefined()
    expect(Object.keys(doc.providers.mlxharness.models).sort()).toEqual(['model-a', 'model-b'])
    expect(doc.providers.mlxharness._mlxharness).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toMatch(/studio/i)

    // A legacy provider left alone is still removable model by model.
    write('.hermes/config.yaml',
      'providers:\n  mlxstudio:\n    models:\n      model-a: {}\n    _mlxstudio: true\n  theirs:\n    base_url: https://x/v1\n')
    expect((await remove()({}, 'hermes', 'model-a'))?.success).toBe(true)
    doc = load(readFileSync(path, 'utf8')) as any
    expect(Object.keys(doc.providers)).toEqual(['theirs'])
  })

  it('Hermes: an untagged provider that happens to be called mlxstudio is not ours', async () => {
    const path = write('.hermes/config.yaml', 'providers:\n  mlxstudio:\n    models:\n      model-a: {}\n')
    expect((await status()({})).hermes.entries).toEqual([])
    expect((await remove()({}, 'hermes', 'model-a'))?.success).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('model-a')
  })
})
