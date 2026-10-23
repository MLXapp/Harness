import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  accountDraft,
  chooseStartModel,
  connectedAccountIds,
  featuredModelsFor,
  formatPrice,
  nextStep,
  pathMatchesRepo,
  previousStep,
  providerIdFromName,
  shouldShowOnboarding,
  sortModelsForChooser,
  withShownModels,
  ONBOARDING_STEPS,
} from '../src/shared/accountSetup'
import { FEATURED_ACCOUNTS, FEATURED_CLOUD_MODELS, LOCAL_PICKS, featuredAccount } from '../src/shared/curated'
import { featuredProviderModel } from '../src/shared/providers/switcherGroups'
import { freeGBFromStatfs, modelNameFromIdentifier, parseChip, parseSystemProfiler, readHardware } from '../src/main/hardware'
import { hardwareParts } from '../src/shared/hardware'
import { groupPickerEntries } from '../src/shared/providers/pickerGroups'
import { normalizeProviderModels, type ProviderView } from '../src/shared/providers/types'
import { imageQuantizeFor } from '../src/renderer/src/components/setup/usePickDownloads'
import { AccountRowsLarge } from '../src/renderer/src/components/accounts/AccountList'
import { RemoteAccountsCard } from '../src/renderer/src/components/accounts/RemoteAccountsCard'

const view = (over: Partial<ProviderView>): ProviderView => ({
  id: 'x', kind: 'catalog', displayName: 'X', api: 'openai-completions', baseURL: 'https://x.example/v1',
  models: [], createdAt: 0, headerNames: [], configured: true, needsKey: true, ...over,
})

describe('hardware', () => {
  it('reads the chip, the Mac model and memory', () => {
    expect(parseChip('Apple M3 Pro\n')).toBe('Apple M3 Pro')
    expect(parseChip('')).toBeUndefined()
    const profiler = JSON.stringify({ SPHardwareDataType: [{ machine_name: 'MacBook Pro', chip_type: 'Apple M3 Pro', physical_memory: '36 GB' }] })
    expect(parseSystemProfiler(profiler)).toEqual({ modelName: 'MacBook Pro', chip: 'Apple M3 Pro', memoryGB: 36 })
    expect(parseSystemProfiler('not json')).toEqual({})
    expect(modelNameFromIdentifier('MacBookPro18,3')).toBe('MacBook Pro')
    expect(modelNameFromIdentifier('Macmini9,1')).toBe('Mac mini')
    expect(modelNameFromIdentifier('Mac15,8')).toBeUndefined()
    expect(freeGBFromStatfs({ bavail: 100_000_000, bsize: 4096 })).toBe(381)
    expect(freeGBFromStatfs(undefined)).toBeUndefined()
  })

  it('assembles a summary on a Mac and falls back elsewhere', async () => {
    const answers: Record<string, string> = {
      'machdep.cpu.brand_string': 'Apple M3 Pro',
      SPHardwareDataType: JSON.stringify({ SPHardwareDataType: [{ machine_name: 'MacBook Pro', physical_memory: '36 GB' }] }),
      'hw.model': 'Mac15,8',
    }
    const mac = await readHardware({
      platform: 'darwin',
      run: async (_cmd, args) => answers[args.find(a => a in answers) ?? ''],
      statfs: async () => ({ bavail: 108_000_000, bsize: 4096 }),
      totalMemBytes: 36 * 1024 ** 3,
      paths: ['/models'],
    })
    expect(mac).toEqual({ chip: 'Apple M3 Pro', modelName: 'MacBook Pro', memoryGB: 36, freeDiskGB: 411 })
    const t = (key: string, p?: Record<string, string | number>) => `${key}:${p?.gb}`
    expect(hardwareParts(mac, t)).toEqual(['MacBook Pro', 'Apple M3 Pro', 'onboarding.mac.memory:36', 'onboarding.mac.free:411'])

    const linux = await readHardware({
      platform: 'linux',
      run: async () => { throw new Error('never called') },
      statfs: async () => { throw new Error('no fs') },
      totalMemBytes: 16 * 1024 ** 3,
      paths: ['/a'],
    })
    expect(linux).toEqual({ chip: 'Apple silicon', memoryGB: 16 })
  })

  it('is wired as app:hardware and window.api.app.getHardware', () => {
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain("ipcMain.handle('app:hardware'")
    expect(readFileSync('src/preload/index.ts', 'utf8')).toContain("getHardware: (): Promise<import('../shared/hardware').HardwareInfo> => ipcRenderer.invoke('app:hardware')")
  })
})

describe('connecting an account', () => {
  it('adds the featured models exactly as the model switcher does, with 1M context', () => {
    expect(featuredModelsFor('deepseek')).toEqual([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro Max', contextWindow: 1_000_000, input: ['text', 'image'], reasoningEfforts: ['high', 'max'] },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1_000_000, input: ['text', 'image'] },
    ])
    expect(featuredModelsFor('anthropic')[0]).toMatchObject({ id: 'claude-opus-5-5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(featuredModelsFor('openai')[0].reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(featuredModelsFor('google')[0].reasoningEfforts).toBeUndefined()
    const ws = featuredModelsFor('wavespeed')
    expect(ws.map(m => m.id)).toEqual([
      'anthropic/claude-opus-5.5', 'deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-astra', 'google/gemini-4-argon',
    ])
    expect(ws.every(m => m.contextWindow === 1_000_000)).toBe(true)
    // One definition: the switcher's featuredProviderModel.
    for (const m of FEATURED_CLOUD_MODELS) {
      const { contextWindow: _c, ...rest } = featuredModelsFor(m.account).find(x => x.id === m.modelId)!
      expect(rest).toEqual(featuredProviderModel(m, m.modelId))
    }
  })

  it('shows featured models, stores the rest hidden, keeps earlier choices', () => {
    const deepseek = featuredAccount('deepseek')!
    const draft = accountDraft(deepseek, [{ id: 'deepseek-flash' }, { id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner' }])
    expect(draft).toMatchObject({ id: 'deepseek', kind: 'catalog', displayName: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.deepseek.com' })
    expect(draft.models.map(m => [m.id, !!m.hidden])).toEqual([
      ['deepseek-v4-pro', false], ['deepseek-flash', false], ['deepseek-chat', true], ['deepseek-reasoner', true],
    ])
    const again = accountDraft(deepseek, [{ id: 'deepseek-new' }], {
      models: [{ id: 'deepseek-flash', input: ['text'], hidden: true }, { id: 'deepseek-chat', input: ['text'] }],
    })
    expect(again.models.map(m => [m.id, !!m.hidden])).toEqual([
      ['deepseek-v4-pro', false], ['deepseek-flash', true], ['deepseek-chat', false], ['deepseek-new', true],
    ])
  })

  it('hidden survives normalization and stays out of the chat picker', () => {
    const models = normalizeProviderModels([{ id: 'a', input: ['text'] }, { id: 'b', input: ['text'], hidden: true }])
    expect(models).toEqual([{ id: 'a', input: ['text'] }, { id: 'b', input: ['text'], hidden: true }])
    const groups = groupPickerEntries([], [], [view({ id: 'deepseek', models })])
    expect(groups.cloud[0].models.map(m => m.id)).toEqual(['a'])
    const allHidden = groupPickerEntries([], [], [view({ id: 'deepseek', models: [{ id: 'b', input: ['text'], hidden: true }] })])
    expect(allHidden.cloud).toEqual([])
  })

  it('Choose models: featured first, then by name; show exactly the checked ones', () => {
    const sorted = sortModelsForChooser([
      { id: 'zeta', input: ['text'] }, { id: 'deepseek-flash', input: ['text'] }, { id: 'alpha', input: ['text'] }, { id: 'deepseek-v4-pro', input: ['text'] },
    ])
    expect(sorted.map(m => m.id)).toEqual(['deepseek-v4-pro', 'deepseek-flash', 'alpha', 'zeta'])
    expect(withShownModels(sorted, new Set(['alpha'])).map(m => [m.id, !!m.hidden])).toEqual([
      ['deepseek-v4-pro', true], ['deepseek-flash', true], ['alpha', false], ['zeta', true],
    ])
  })

  it('counts an account as connected only with a key', () => {
    expect([...connectedAccountIds([view({ id: 'deepseek' }), view({ id: 'openai', configured: false }), view({ id: 'groq' })])]).toEqual(['deepseek'])
  })

  it('custom endpoint ids come from the name and never clash', () => {
    expect(providerIdFromName('My Server', new Set())).toBe('my-server')
    expect(providerIdFromName('My Server', new Set(['my-server']))).toBe('my-server-2')
    expect(providerIdFromName('OpenAI', new Set())).toBe('openai-2')
    expect(providerIdFromName('Ollama', new Set())).toBe('ollama-2')
    expect(providerIdFromName('!!!', new Set())).toBe('endpoint')
  })

  it('formats published prices', () => {
    expect(formatPrice({ input: 0.15, output: 0.6 })).toEqual({ input: '$0.15', output: '$0.60' })
    expect(formatPrice({ input: 4, output: 20 })).toEqual({ input: '$4', output: '$20' })
    expect(formatPrice({ input: 0.66, output: 1.98 })).toEqual({ input: '$0.66', output: '$1.98' })
  })
})

describe('first-run setup', () => {
  it('walks four steps and shows once', () => {
    expect(ONBOARDING_STEPS).toEqual(['welcome', 'accounts', 'mac', 'done'])
    expect(nextStep('welcome')).toBe('accounts')
    expect(nextStep('done')).toBe('done')
    expect(previousStep('mac')).toBe('accounts')
    expect(previousStep('welcome')).toBe('welcome')
    expect(shouldShowOnboarding(true, null)).toBe(true)
    expect(shouldShowOnboarding(true, '1729440000000')).toBe(false)
    expect(shouldShowOnboarding(false, null)).toBe(false)
  })

  it('Start a chat: Opus 5.5, else DeepSeek V4 Pro Max, else a downloaded local model', () => {
    const claude = view({ id: 'anthropic', models: featuredModelsFor('anthropic') })
    const deepseek = view({ id: 'deepseek', models: featuredModelsFor('deepseek') })
    const wavespeed = view({ id: 'wavespeed', models: featuredModelsFor('wavespeed') })
    expect(chooseStartModel([deepseek, claude], [])).toEqual({ kind: 'cloud', providerId: 'anthropic', modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', effort: 'high' })
    expect(chooseStartModel([wavespeed], [])).toMatchObject({ kind: 'cloud', providerId: 'wavespeed', modelId: 'anthropic/claude-opus-5.5' })
    expect(chooseStartModel([wavespeed], [])).not.toHaveProperty('effort')
    expect(chooseStartModel([deepseek], [])).toMatchObject({ providerId: 'deepseek', modelId: 'deepseek-v4-pro', effort: 'max' })
    const pick = LOCAL_PICKS.find(p => p.repo === 'mlx-community/Qwen3.5-9B-4bit')!
    expect(chooseStartModel([view({ id: 'openai', configured: false, models: featuredModelsFor('openai') })], [{ pick, path: '/m/x' }]))
      .toEqual({ kind: 'local', modelPath: '/m/x', name: 'Qwen 3.5 9B' })
    expect(chooseStartModel([], [])).toEqual({ kind: 'none' })
  })

  it('recognises downloaded repos in the download dir and the HF cache', () => {
    expect(pathMatchesRepo('/Users/a/.cache/huggingface/hub/mlx-community/Qwen3.5-9B-4bit', 'mlx-community/Qwen3.5-9B-4bit')).toBe(true)
    expect(pathMatchesRepo('/Users/a/.cache/huggingface/hub/models--mlx-community--Qwen3.5-9B-4bit/snapshots/abc', 'mlx-community/Qwen3.5-9B-4bit')).toBe(true)
    expect(pathMatchesRepo('/Users/a/models/Qwen3.5-4B-4bit', 'mlx-community/Qwen3.5-9B-4bit')).toBe(false)
  })

  it('downloads image picks at the quantization whose repo is the pick', () => {
    const bySize = Object.fromEntries(LOCAL_PICKS.filter(p => p.purpose === 'image').map(p => [p.imageModelId, imageQuantizeFor(p)]))
    expect(bySize).toEqual({ 'qwen-image-2.1': 0, 'klein-9b': 0, 'z-image-turbo': 4, 'klein-4b': 4 })
  })

  it('renders the five accounts as large rows, Connect or Connected', () => {
    const html = renderToStaticMarkup(React.createElement(AccountRowsLarge, { connected: new Set(['deepseek']), onConnect: () => undefined }))
    for (const a of FEATURED_ACCOUNTS) expect(html).toContain(`data-account="${a.id}"`)
    expect(html).toContain('h-16')
    expect(html.match(/data-active="true"/g)?.length).toBe(5)
    expect(html).toContain('Connected')
    const card = renderToStaticMarkup(React.createElement(RemoteAccountsCard))
    expect(card).toContain('Connect an account or any OpenAI-compatible server')
    expect(card).toContain('Custom endpoint…')
  })

  it('App opens setup once, from events, and mounts the account sheets', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(app).toContain('window.api.settings.get(ONBOARDING_DONE_KEY)')
    expect(app).toContain("detail?.mode === 'onboarding'")
    expect(app).toContain('window.addEventListener(ONBOARDING_EVENT, open)')
    expect(app).toContain('<AccountSheetsHost />')
    expect(readFileSync('src/renderer/src/components/preferences/PreferencesSheet.tsx', 'utf8')).toContain('<AccountsPreference embedded />')
    expect(readFileSync('src/renderer/src/components/accounts/events.ts', 'utf8')).toContain("CONNECT_ACCOUNT_EVENT = 'vmlx:connect-account'")
  })
})

// ── Copy and type sizes ────────────────────────────────────────────────────

const LOCALES = ['en', 'zh', 'ko', 'ja', 'es']
const locale = (code: string) => JSON.parse(readFileSync(join(__dirname, '../src/renderer/src/i18n/locales', `${code}.json`), 'utf8'))
const lookup = (catalog: any, key: string) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), catalog)
const NEW_UI = [
  ...readdirSync(join(__dirname, '../src/renderer/src/components/accounts')).map(f => `src/renderer/src/components/accounts/${f}`),
  'src/renderer/src/components/setup/Onboarding.tsx',
  'src/renderer/src/components/setup/usePickDownloads.ts',
  'src/shared/hardware.ts',
]

describe('accounts and setup copy', () => {
  it('every accounts.* / onboarding.* key (and its "One" form) exists in all five locales', () => {
    const used = new Set<string>()
    for (const file of NEW_UI) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
      for (const match of src.matchAll(/['`]((?:accounts|onboarding|providers|common)\.[A-Za-z.]+)['`]/g)) used.add(match[1])
      for (const match of src.matchAll(/countKey\('([A-Za-z.]+)'/g)) used.add(`${match[1]}One`)
    }
    expect(used.size).toBeGreaterThan(100)
    for (const code of LOCALES) {
      const catalog = locale(code)
      const missing = [...used].filter(key => typeof lookup(catalog, key) !== 'string')
      expect(missing, `${code} is missing`).toEqual([])
    }
  })

  it('keeps every placeholder in every translation', () => {
    const en = locale('en')
    const walk = (node: any, prefix: string, out: Record<string, string>) => {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') out[`${prefix}${k}`] = v
        else walk(v, `${prefix}${k}.`, out)
      }
      return out
    }
    const base = walk({ accounts: en.accounts, onboarding: en.onboarding }, '', {})
    for (const code of LOCALES.slice(1)) {
      const catalog = locale(code)
      for (const [key, text] of Object.entries(base)) {
        const want = [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
        const got = [...String(lookup(catalog, key)).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
        expect(got, `${code} ${key}`).toEqual(want)
      }
    }
  })

  it('no new UI text below 11px, and 11px only on badges', () => {
    for (const file of NEW_UI) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
      expect(src, file).not.toMatch(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]/)
      expect(src, file).not.toMatch(/\btext-\[?(?:xxs|2xs)\b/)
      const elevens = [...src.matchAll(/text-\[11px\]/g)]
      if (elevens.length) expect(file).toMatch(/accounts\/ui\.tsx$/)
    }
  })
})
