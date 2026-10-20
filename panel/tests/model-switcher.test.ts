import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, Menu: { sendActionToFirstResponder: vi.fn() } }))

import {
  buildSwitcherGroups,
  describeSelection,
  featuredProviderModel,
  selectableRows,
  subsequenceMatch,
} from '../src/shared/providers/switcherGroups'
import { FEATURED_CLOUD_MODELS } from '../src/shared/curated'
import type { ProviderView } from '../src/shared/providers/types'
import { startDictation } from '../src/main/dictation'
import { resolveVoiceInput } from '../src/renderer/src/components/chat/voiceInput'

const view = (over: Partial<ProviderView>): ProviderView => ({
  id: 'p', kind: 'catalog', displayName: 'P', api: 'openai-completions', baseURL: 'https://p.example/v1',
  models: [], createdAt: 0, headerNames: [], configured: true, needsKey: true, ...over,
})

const sessions = [
  { id: 'qwen', modelPath: '/hf/models--mlx-community--Qwen3.5-9B-4bit', modelName: 'Qwen3.5-9B-4bit', status: 'running', type: 'local' as const },
  { id: 'whisper', modelPath: '/hf/models--mlx-community--whisper-large-v3-turbo', status: 'stopped', type: 'local' as const },
  { id: 'kokoro', modelPath: '/hf/models--prince-canuma--Kokoro-82M', status: 'stopped', type: 'local' as const },
  { id: 'gemma', modelPath: '/hf/models--mlx-community--gemma-4-12B-it-4bit', status: 'stopped', type: 'local' as const },
  { id: 'old-remote', modelPath: 'remote://gpt@api.example', modelName: 'gpt', status: 'running', type: 'remote' as const },
]

const ollama = view({
  id: 'ollama', kind: 'local-server', needsKey: false, configured: false, reachable: true, displayName: 'Ollama',
  models: [{ id: 'llama3.2', input: ['text'] }, { id: 'nomic-embed-text', input: ['text'] }],
})

describe('model switcher grouping', () => {
  it('with no account: a connect row, five account chips, and chat models on this Mac only', () => {
    const g = buildSwitcherGroups({ sessions, localServers: [ollama], providers: [view({ id: 'anthropic', configured: false })] })
    expect(g.featured).toEqual([])
    expect(g.showConnect).toBe(true)
    expect(g.connectable.map(a => a.id)).toEqual(['deepseek', 'anthropic', 'openai', 'google', 'wavespeed'])
    // whisper / kokoro and the embedding model never show in a chat list.
    expect(g.onThisMac.map(r => r.key)).toEqual(['session:qwen', 'session:gemma', 'ollama/llama3.2'])
    expect(g.more).toEqual([])
    expect(g.remoteSessions.map(r => r.session.id)).toEqual(['old-remote'])
  })

  it('with DeepSeek and Claude: their top models first, the rest of each account under More', () => {
    const providers = [
      view({ id: 'deepseek', displayName: 'DeepSeek', models: [{ id: 'deepseek-flash', input: ['text'] }, { id: 'deepseek-chat', input: ['text'] }] }),
      view({ id: 'anthropic', displayName: 'Anthropic', api: 'anthropic-messages', models: [
        { id: 'claude-haiku-5', name: 'Claude Haiku 5', input: ['text'] },
        { id: 'claude-old', input: ['text'], hidden: true } as never,
      ] }),
      view({ id: 'openai', displayName: 'OpenAI', configured: false, models: [{ id: 'whisper-1', input: ['text'] }] }),
      view({ id: 'groq', displayName: 'Groq', models: [{ id: 'whisper-large-v3', input: ['text'] }, { id: 'llama-4', input: ['text'] }] }),
    ]
    const g = buildSwitcherGroups({ sessions, localServers: [], providers })
    expect(g.showConnect).toBe(false)
    expect(g.featured.map(r => r.model.key)).toEqual(['claude-opus-5-5', 'deepseek-v4-pro-max', 'deepseek-flash'])
    expect(g.featured.map(r => r.present)).toEqual([false, false, true])
    expect(g.connectable.map(a => a.id)).toEqual(['openai', 'google', 'wavespeed'])
    // Featured ids are not repeated; hidden and non-chat models are left out; unconfigured accounts are absent.
    expect(g.more.map(m => [m.label, m.rows.map(r => r.model.id)])).toEqual([
      ['DeepSeek', ['deepseek-chat']],
      ['Claude', ['claude-haiku-5']],
      ['Groq', ['llama-4']],
    ])
    // Keyboard order: closed groups are skipped unless searching.
    expect(selectableRows(g, new Set(), false).length).toBe(3 + 2 + 1)
    expect(selectableRows(g, new Set(['anthropic']), false).length).toBe(3 + 2 + 1 + 1)
    expect(selectableRows(g, new Set(), true).length).toBe(3 + 2 + 3 + 1)
  })

  it('reaches every featured model through WaveSpeed alone', () => {
    const g = buildSwitcherGroups({ sessions: [], localServers: [], providers: [view({ id: 'wavespeed' })] })
    expect(g.featured.map(r => [r.providerId, r.via])).toEqual(FEATURED_CLOUD_MODELS.map(() => ['wavespeed', 'wavespeed']))
  })

  it('filters every group by subsequence', () => {
    expect(subsequenceMatch('cop', 'Claude Opus 5.5')).toBe(true)
    expect(subsequenceMatch('op cl', 'Claude Opus')).toBe(false)
    expect(subsequenceMatch('  ', 'anything')).toBe(true)
    const providers = [view({ id: 'anthropic', models: [] }), view({ id: 'deepseek', models: [] })]
    const g = buildSwitcherGroups({ sessions, localServers: [ollama], providers, query: 'opus' })
    expect(g.featured.map(r => r.model.key)).toEqual(['claude-opus-5-5'])
    expect(g.onThisMac).toEqual([])
    const local = buildSwitcherGroups({ sessions, localServers: [ollama], providers, query: 'gem' })
    expect(local.onThisMac.map(r => r.key)).toEqual(['session:gemma'])
    expect(local.showConnect).toBe(false)
    // Fields are matched one by one: a query never threads through a path and a name.
    expect(buildSwitcherGroups({ sessions, localServers: [], providers, query: 'son' }).onThisMac).toEqual([])
  })

  it('adds a featured model to its account with the levels it offers, and describes the selection', () => {
    const opus = FEATURED_CLOUD_MODELS.find(m => m.key === 'claude-opus-5-5')!
    const entry = featuredProviderModel(opus, 'claude-opus-5-5')
    expect(entry).toMatchObject({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' })
    expect(entry.reasoningEfforts).toContain('high')
    const flash = FEATURED_CLOUD_MODELS.find(m => m.key === 'deepseek-flash')!
    expect(featuredProviderModel(flash, 'deepseek-flash').reasoningEfforts).toBeUndefined()

    const anthropic = view({ id: 'anthropic', models: [entry] })
    const sel = describeSelection({ binding: { chatId: 'c', providerId: 'anthropic', modelId: 'claude-opus-5-5' }, session: undefined, localServers: [], providers: [anthropic] })
    expect(sel).toMatchObject({ none: false, name: 'Claude Opus 5.5', local: false, providerId: 'anthropic', effort: 'high', defaultEffort: 'high' })
    const max = describeSelection({ binding: { chatId: 'c', providerId: 'deepseek', modelId: 'deepseek-v4-pro', reasoningEffort: 'max' }, session: undefined, localServers: [], providers: [] })
    expect(max).toMatchObject({ name: 'DeepSeek V4 Pro Max', effort: 'max', levels: ['high', 'max'] })
    expect(describeSelection({ binding: null, session: sessions[0], localServers: [], providers: [] })).toMatchObject({ name: 'Qwen3.5-9B-4bit', local: true })
    expect(describeSelection({ binding: null, session: undefined, localServers: [], providers: [] }).none).toBe(true)
  })
})

describe('Apple Dictation', () => {
  it('sends startDictation: on macOS only', () => {
    const send = vi.fn()
    expect(startDictation('darwin', send)).toEqual({ ok: true })
    expect(send).toHaveBeenCalledExactlyOnceWith('startDictation:')
    const other = vi.fn()
    expect(startDictation('linux', other)).toEqual({ ok: false, reason: 'unsupported' })
    expect(startDictation('win32', other)).toEqual({ ok: false, reason: 'unsupported' })
    expect(other).not.toHaveBeenCalled()
  })

  it('is wired main → preload → mic, with Whisper as the fallback', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain('registerDictationIpc()')
    const preload = readFileSync('src/preload/index.ts', 'utf8')
    expect(preload).toContain("supported: (): boolean => process.platform === 'darwin'")
    expect(preload).toContain("ipcRenderer.invoke('dictation:start')")
    const input = readFileSync('src/renderer/src/components/chat/InputBox.tsx', 'utf8')
    expect(input).toContain('await window.api.dictation?.start()')
    expect(input.indexOf('el.focus()')).toBeLessThan(input.indexOf('await window.api.dictation?.start()'))
    const voice = readFileSync('src/renderer/src/components/chat/VoiceChat.tsx', 'utf8')
    expect(voice).toContain("t('chat.voice.dictateTitle')")
    expect(resolveVoiceInput(null, true)).toBe('apple')
    expect(resolveVoiceInput('whisper', true)).toBe('whisper')
    expect(resolveVoiceInput('apple', false)).toBe('whisper')
  })
})

describe('composer and chat chrome', () => {
  it('has no text under 11px anywhere in the renderer', () => {
    const bad: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(tsx?|css)$/.test(path) && /text-\[(?:[0-9]|10)px\]/.test(readFileSync(path, 'utf8'))) bad.push(path)
      }
    }
    walk('src/renderer')
    expect(bad).toEqual([])
  })

  it('puts the model pill, mic and round Send in the composer; Send waits for a model', () => {
    const input = readFileSync('src/renderer/src/components/chat/InputBox.tsx', 'utf8')
    const row = input.slice(input.indexOf('<ModelSwitcher'))
    expect(row.indexOf('<ModelSwitcher')).toBeLessThan(row.indexOf('<VoiceChat'))
    expect(row.indexOf('<VoiceChat')).toBeLessThan(row.indexOf('data-vmlx-control="chat-send"'))
    expect(input).toContain("const sendTitle = noModel ? t('chat.switcher.chooseFirst') : t('chat.input.sendTitle')")
    expect(input).toContain('min-h-[44px]')
    expect(input).toContain('text-[14px]')
    expect(input).toContain('rounded-full bg-[color:var(--acc)] text-white')
  })

  it('switcher strings exist in all five locales', () => {
    const src = readFileSync('src/renderer/src/components/chat/ModelSwitcher.tsx', 'utf8')
      + readFileSync('src/renderer/src/components/chat/VoiceInputSetting.tsx', 'utf8')
    const keys = new Set([...src.matchAll(/t\('((?:chat\.(?:switcher|voiceInput))\.[A-Za-z.]+)'/g)].map(m => m[1]))
    for (const key of Object.values({ a: 'chat.switcher.badge.best', b: 'chat.switcher.badge.bestValue', c: 'chat.switcher.badge.fast' })) keys.add(key)
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) keys.add(`chat.switcher.levels.${level}`)
    expect(keys.size).toBeGreaterThan(20)
    for (const code of ['en', 'zh', 'ko', 'ja', 'es']) {
      const catalog = JSON.parse(readFileSync(`src/renderer/src/i18n/locales/${code}.json`, 'utf8'))
      const missing = [...keys].filter(key => typeof key.split('.').reduce((n: any, k) => n?.[k], catalog) !== 'string')
      expect(missing, code).toEqual([])
    }
  })

  it('opens with ⌘⇧M, which no menu item or other shortcut uses', async () => {
    const { isSwitcherShortcut } = await import('../src/renderer/src/components/chat/ModelSwitcher')
    expect(isSwitcherShortcut({ key: 'M', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(true)
    expect(isSwitcherShortcut({ key: 'm', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false)
    expect(readFileSync('src/main/application-menu.ts', 'utf8')).not.toMatch(/Shift\+M/i)
  })
})
