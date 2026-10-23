/**
 * Fixture data for the browser preview (see preview/bootstrap.ts).
 *
 * Everything here is sample data for design review only: nothing is read from
 * a real Mac, a real engine or a real provider. Scenarios pick what exists:
 *
 *   default    engine installed, local models, one running session, 3 chats
 *   fresh      engine installed, nothing else (no models, sessions, chats, accounts)
 *   connected  default + DeepSeek and Anthropic (Claude) accounts with models,
 *              plus a chat bound to Claude
 */

import type { ProviderView, ChatModelBinding } from '../src/shared/providers/types'

export type ScenarioName = 'default' | 'fresh' | 'connected'

export const SCENARIOS: readonly ScenarioName[] = ['default', 'fresh', 'connected']

/** Hardware the preview pretends to run on (window.api.app.getHardware and `window.__PREVIEW__.hardware`). */
export const HARDWARE = {
  chip: 'Apple M3 Pro',
  modelName: 'MacBook Pro',
  freeDiskGB: 412,
  totalMemoryGB: 36,
  cpuCores: 12,
  gpuCores: 18,
  macOS: '15.6',
}

export const APP_VERSION = '0.2.0'

const HOME = '/Users/alex'
export const MODELS_DIR = `${HOME}/.mlxstudio/models`
export const HF_CACHE = `${HOME}/.cache/huggingface/hub`

export interface FixtureModel {
  id: string
  name: string
  path: string
  size?: string
  format?: 'mlx' | 'gguf' | 'unknown'
  quantization?: string
  hasChatTemplate?: boolean
  /** Not part of the IPC shape: lets scan(modelType) filter. */
  kind: 'text' | 'image' | 'audio'
}

export interface FixtureSession {
  id: string
  modelPath: string
  modelName?: string
  host: string
  port: number
  pid?: number
  status: 'running' | 'stopped' | 'error' | 'loading' | 'standby'
  standbyDepth?: 'soft' | 'deep' | null
  config: string
  pendingConfig?: string | null
  createdAt: number
  updatedAt: number
  lastStartedAt?: number
  lastStoppedAt?: number
  lastRequestAt?: number
  type: 'local' | 'remote'
  remoteUrl?: string
  remoteModel?: string
  modelPathMissing: boolean
}

export interface FixtureChat {
  id: string
  title: string
  folderId?: string
  createdAt: number
  updatedAt: number
  modelId: string
  modelPath?: string
}

export interface FixtureMessage {
  id: string
  chatId: string
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp: number
  tokens?: number
  metricsJson?: string
  reasoningContent?: string
}

export interface Fixtures {
  scenario: ScenarioName
  engineInstalled: boolean
  models: FixtureModel[]
  sessions: FixtureSession[]
  chats: FixtureChat[]
  messages: FixtureMessage[]
  folders: Array<{ id: string; name: string; parentId?: string; createdAt: number }>
  providers: ProviderView[]
  localServers: ProviderView[]
  chatBindings: ChatModelBinding[]
  settings: Record<string, string>
  /** Media tab generations (preview mock of main/media). */
  mediaJobs: any[]
}

const MIN = 60_000
const HOUR = 60 * MIN

function metrics(tokenCount: number, tps: number, ttft: number, pp?: number): string {
  return JSON.stringify({
    tokenCount,
    tokenCountKnown: true,
    tokensPerSecond: tps.toFixed(1),
    ttft: ttft.toFixed(2),
    ...(pp ? { ppSpeed: pp.toFixed(0) } : {}),
    promptTokens: Math.round(tokenCount * 1.6),
    totalTime: (ttft + tokenCount / tps).toFixed(1),
  })
}

const QWEN = {
  id: 'mlx-community/Qwen3.5-9B-4bit',
  path: `${MODELS_DIR}/mlx-community/Qwen3.5-9B-4bit`,
}

function localModels(): FixtureModel[] {
  return [
    {
      id: QWEN.id,
      name: 'Qwen3.5-9B-4bit',
      path: QWEN.path,
      size: '5.2 GB',
      format: 'mlx',
      quantization: '4-bit',
      hasChatTemplate: true,
      kind: 'text',
    },
    {
      id: 'mlx-community/gemma-3-12b-it-qat-4bit',
      name: 'gemma-3-12b-it-qat-4bit',
      path: `${MODELS_DIR}/mlx-community/gemma-3-12b-it-qat-4bit`,
      size: '8.1 GB',
      format: 'mlx',
      quantization: '4-bit',
      hasChatTemplate: true,
      kind: 'text',
    },
    {
      id: 'mlx-community/whisper-large-v3-turbo',
      name: 'whisper-large-v3-turbo',
      path: `${HF_CACHE}/models--mlx-community--whisper-large-v3-turbo/snapshots/main`,
      size: '1.6 GB',
      format: 'mlx',
      kind: 'audio',
    },
  ]
}

function runningSession(now: number): FixtureSession {
  return {
    id: 'sess-qwen',
    modelPath: QWEN.path,
    modelName: 'Qwen3.5-9B-4bit',
    host: '127.0.0.1',
    port: 8000,
    pid: 48211,
    status: 'running',
    standbyDepth: null,
    config: JSON.stringify({ host: '127.0.0.1', port: 8000, modelType: 'text', continuousBatching: true, enablePrefixCache: true }),
    pendingConfig: null,
    createdAt: now - 3 * 24 * HOUR,
    updatedAt: now - 20 * MIN,
    lastStartedAt: now - 2 * HOUR,
    lastRequestAt: now - 4 * MIN,
    type: 'local',
    modelPathMissing: false,
  }
}

function stoppedSession(now: number): FixtureSession {
  const path = `${MODELS_DIR}/mlx-community/gemma-3-12b-it-qat-4bit`
  return {
    id: 'sess-gemma',
    modelPath: path,
    modelName: 'gemma-3-12b-it-qat-4bit',
    host: '127.0.0.1',
    port: 8001,
    status: 'stopped',
    standbyDepth: null,
    config: JSON.stringify({ host: '127.0.0.1', port: 8001, modelType: 'text' }),
    pendingConfig: null,
    createdAt: now - 6 * 24 * HOUR,
    updatedAt: now - 26 * HOUR,
    lastStoppedAt: now - 26 * HOUR,
    type: 'local',
    modelPathMissing: false,
  }
}

function localChats(now: number): { chats: FixtureChat[]; messages: FixtureMessage[] } {
  const chats: FixtureChat[] = [
    { id: 'chat-swift', title: 'SwiftUI list with swipe actions', createdAt: now - 3 * HOUR, updatedAt: now - 12 * MIN, modelId: QWEN.path, modelPath: QWEN.path },
    { id: 'chat-trip', title: 'Weekend in Busan', createdAt: now - 26 * HOUR, updatedAt: now - 25 * HOUR, modelId: QWEN.path, modelPath: QWEN.path },
    { id: 'chat-memory', title: 'Unified memory explained', createdAt: now - 4 * 24 * HOUR, updatedAt: now - 4 * 24 * HOUR, modelId: QWEN.path, modelPath: QWEN.path },
  ]
  const t0 = now - 14 * MIN
  const messages: FixtureMessage[] = [
    {
      id: 'm1', chatId: 'chat-swift', role: 'user', timestamp: t0,
      content: 'How do I add swipe-to-delete and a pin action to a SwiftUI List?',
    },
    {
      id: 'm2', chatId: 'chat-swift', role: 'assistant', timestamp: t0 + 9_000, tokens: 312,
      reasoningContent: 'The user wants two swipe actions on a List row: a destructive delete and a non-destructive pin. `.swipeActions` (iOS 15+) handles both; `onDelete` only covers delete. Show one example with both edges.',
      metricsJson: metrics(312, 61.4, 0.38, 812),
      content: [
        'Use `.swipeActions` on each row. It gives you both edges and full control over tint:',
        '',
        '```swift',
        'List {',
        '    ForEach(notes) { note in',
        '        NoteRow(note: note)',
        '            .swipeActions(edge: .trailing, allowsFullSwipe: true) {',
        '                Button(role: .destructive) { delete(note) } label: {',
        '                    Label("Delete", systemImage: "trash")',
        '                }',
        '            }',
        '            .swipeActions(edge: .leading) {',
        '                Button { togglePin(note) } label: {',
        '                    Label(note.pinned ? "Unpin" : "Pin", systemImage: "pin")',
        '                }',
        '                .tint(.orange)',
        '            }',
        '    }',
        '}',
        '```',
        '',
        '- **`allowsFullSwipe: true`** lets a long swipe trigger the first button (delete).',
        '- `role: .destructive` gives the red tint and animates the row out.',
        '- Keep `onDelete` only if you also need Edit mode on macOS.',
      ].join('\n'),
    },
    {
      id: 'm3', chatId: 'chat-swift', role: 'user', timestamp: t0 + 60_000,
      content: 'Does this work on macOS too?',
    },
    {
      id: 'm4', chatId: 'chat-swift', role: 'assistant', timestamp: t0 + 66_000, tokens: 118,
      metricsJson: metrics(118, 63.0, 0.21, 1490),
      content: 'Yes. On macOS 12+ the same modifier shows the actions on a trackpad swipe. Mouse users get nothing, so add a **context menu** with the same two actions:\n\n```swift\n.contextMenu {\n    Button("Pin") { togglePin(note) }\n    Button("Delete", role: .destructive) { delete(note) }\n}\n```',
    },
    {
      id: 'm5', chatId: 'chat-trip', role: 'user', timestamp: now - 25 * HOUR - 5 * MIN,
      content: 'Plan a relaxed Saturday in Busan, arriving by KTX at 10am.',
    },
    {
      id: 'm6', chatId: 'chat-trip', role: 'assistant', timestamp: now - 25 * HOUR, tokens: 240,
      metricsJson: metrics(240, 58.2, 0.44, 760),
      content: '1. **Busan Station → Huinnyeoul Culture Village** (taxi, 25 min). Walk the cliff path.\n2. **Lunch at Jagalchi Market**: pick seafood downstairs, eat upstairs.\n3. **Gamcheon Culture Village** in the afternoon light.\n4. **Sunset at Gwangalli Beach**, then the bridge lights at 8pm.',
    },
    {
      id: 'm7', chatId: 'chat-memory', role: 'user', timestamp: now - 4 * 24 * HOUR,
      content: 'Why can a 36 GB Mac run models a 24 GB GPU cannot?',
    },
    {
      id: 'm8', chatId: 'chat-memory', role: 'assistant', timestamp: now - 4 * 24 * HOUR + 7_000, tokens: 160,
      metricsJson: metrics(160, 60.1, 0.31, 900),
      content: 'Apple Silicon shares one pool of memory between CPU and GPU. Most of the 36 GB can hold model weights, while a discrete GPU is limited to its own VRAM.',
    },
  ]
  return { chats, messages }
}

const ANTHROPIC: ProviderView = {
  id: 'anthropic',
  kind: 'catalog',
  displayName: 'Anthropic',
  api: 'anthropic-messages',
  baseURL: 'https://api.anthropic.com',
  models: [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'], reasoningEfforts: ['off', 'low', 'medium', 'high'] },
    { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', contextWindow: 200_000, maxTokens: 32_000, input: ['text', 'image'], reasoningEfforts: ['off', 'low', 'medium', 'high'] },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'] },
  ],
  createdAt: Date.now() - 2 * 24 * HOUR,
  headerNames: [],
  configured: true,
  needsKey: true,
}

const DEEPSEEK: ProviderView = {
  id: 'deepseek',
  kind: 'catalog',
  displayName: 'DeepSeek',
  api: 'openai-completions',
  baseURL: 'https://api.deepseek.com',
  models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000, maxTokens: 8_192, input: ['text'] },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 128_000, maxTokens: 64_000, input: ['text'], reasoningEfforts: ['low', 'medium', 'high'] },
  ],
  createdAt: Date.now() - 3 * 24 * HOUR,
  headerNames: [],
  configured: true,
  needsKey: true,
}

export function buildFixtures(scenario: ScenarioName, opts: { engineInstalled: boolean }): Fixtures {
  const now = Date.now()
  const base: Fixtures = {
    scenario,
    engineInstalled: opts.engineInstalled,
    models: [],
    sessions: [],
    chats: [],
    messages: [],
    folders: [],
    providers: [],
    localServers: [],
    chatBindings: [],
    settings: {},
    mediaJobs: [],
  }
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  // ?accounts=wavespeed,atlascloud connects those media accounts (any scenario).
  for (const id of (params.get('accounts') ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    base.providers.push(mediaAccount(id, now))
  }
  // ?media=samples fills the media tabs with finished examples.
  if (params.get('media') === 'samples') base.mediaJobs = sampleMediaJobs(now)
  if (scenario === 'fresh') return base

  const { chats, messages } = localChats(now)
  base.models = localModels()
  base.sessions = [runningSession(now), stoppedSession(now)]
  base.chats = chats
  base.messages = messages

  if (scenario === 'connected') {
    base.providers = [ANTHROPIC, DEEPSEEK, ...base.providers]
    const t = now - 6 * MIN
    base.chats.unshift({ id: 'chat-claude', title: 'Review my launch email', createdAt: t, updatedAt: t + 40_000, modelId: 'claude-sonnet-4-5', modelPath: 'provider://anthropic/claude-sonnet-4-5' })
    base.messages.push(
      { id: 'c1', chatId: 'chat-claude', role: 'user', timestamp: t, content: 'Tighten this subject line: "We are excited to announce our new app is now available"' },
      { id: 'c2', chatId: 'chat-claude', role: 'assistant', timestamp: t + 4_000, tokens: 64, metricsJson: JSON.stringify({ tokenCount: 64, tokensPerSecond: '74.0', ttft: '0.82', remoteRequestSeconds: 1.7 }), content: 'Three options, shortest first:\n\n- **It\'s here.**\n- **Our new app is live**\n- **Meet the app we\'ve been building**\n\nDrop "excited to announce": readers skip it.' },
    )
    base.chatBindings = [{ chatId: 'chat-claude', providerId: 'anthropic', modelId: 'claude-sonnet-4-5' }]
  }
  return base
}

// ── Media tabs ──────────────────────────────────────────────────────────────

function mediaAccount(id: string, now: number): ProviderView {
  const name = id === 'atlascloud' ? 'Atlas Cloud' : id === 'wavespeed' ? 'WaveSpeed AI' : id
  return {
    id, kind: 'catalog', displayName: name, api: 'openai-completions',
    baseURL: id === 'atlascloud' ? 'https://api.atlascloud.ai/v1' : 'https://llm.wavespeed.ai/v1',
    models: [], createdAt: now - 2 * HOUR, headerNames: [], configured: true, needsKey: true,
  } as ProviderView
}

const PALETTES = [['#ff9f0a', '#ff5a2e', '#3a1c71'], ['#0ea5e9', '#6366f1', '#0f172a'], ['#34c759', '#0ea5e9', '#052e16'], ['#f472b6', '#a855f7', '#1e1b4b']]

/** A sample picture (labelled) so cards have something to show in screenshots. */
function samplePicture(seed: number, label: string): string {
  const [a, b, c] = PALETTES[seed % PALETTES.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><radialGradient id="g" cx="30%" cy="30%" r="90%"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="930" cy="250" r="150" fill="#fff" fill-opacity=".14"/><text x="64" y="660" font-family="-apple-system,Inter,sans-serif" font-size="30" fill="#fff" fill-opacity=".85">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** One second of silence as a WAV data URL. */
/** A quiet sample: one second of silence, or (seed > 0) a few seconds of shaped tones so waveforms have a shape. */
function silentWav(seed = 0): string {
  const rate = 8000, n = seed > 0 ? rate * 6 : rate
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true)
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true)
  for (let i = 0; i < n; i++) {
    if (seed === 0) { v.setUint8(44 + i, 128); continue }
    const t = i / rate
    // Beats with a slow swell, like a song's verse and chorus.
    const beat = Math.exp(-((t * 2) % 1) * 5)
    const swell = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.9 + seed))
    const tone = Math.sin(2 * Math.PI * 220 * t) * 0.6 + Math.sin(2 * Math.PI * 330 * t + seed) * 0.4
    v.setUint8(44 + i, Math.round(128 + 110 * tone * (0.25 + 0.75 * beat) * swell * 0.9))
  }
  let bin = ''
  new Uint8Array(buf).forEach(x => { bin += String.fromCharCode(x) })
  return `data:audio/wav;base64,${btoa(bin)}`
}

let sampleSeed = 0
export function sampleOutput(kind: string, prompt: string) {
  if (kind === 'audio' || kind === 'music') return { kind: 'file' as const, url: silentWav(kind === 'music' ? 1 + (sampleSeed++ % 3) : 0), mime: 'audio/wav', name: 'sample.wav' }
  return { kind: 'file' as const, url: samplePicture(sampleSeed++, `Preview sample · ${prompt.slice(0, 48)}`), mime: 'image/svg+xml', name: 'sample.svg' }
}

function sampleMediaJobs(now: number): any[] {
  const job = (kind: string, modelId: string, modelName: string, provider: string | undefined, prompt: string, values: any, ago: number, status = 'done') => ({
    id: `sample-${kind}-${ago}`, kind, modelId, modelName, where: provider ? 'cloud' : 'local', ...(provider ? { provider } : {}),
    prompt, values, status, ...(status === 'running' ? { phase: 'generating' } : {}),
    outputs: status === 'done' ? [sampleOutput(kind, prompt)] : [],
    ...(status === 'failed' ? { error: 'Insufficient credits on this account' } : {}),
    createdAt: now - ago, updatedAt: now - ago, finishedAt: now - ago + 60_000,
  })
  return [
    job('video', 'ws:wan-3.0', 'Wan 3.0', 'wavespeed', 'Slow dolly shot through a rainy Tokyo alley at night, neon reflections', { duration: 5, aspect: '16:9', resolution: '720p', audio: true }, 40_000, 'running'),
    job('video', 'at:seedance-2.0', 'Seedance 2.0', 'atlascloud', 'A golden retriever runs along the beach at sunrise, waves crashing', { duration: 5, aspect: '16:9', audio: true }, 20 * MIN),
    job('video', 'ws:kling-3.0-std', 'Kling 3.0', 'wavespeed', 'Macro shot of coffee being poured, steam rising', { duration: 4, aspect: '1:1', audio: false }, 2 * HOUR),
    job('audio', 'local:kokoro-82m', 'Kokoro', undefined, 'Welcome to MLX Harness. Everything you see here runs on your Mac.', { voice: 'af_heart', speed: 1 }, 5 * MIN),
    job('audio', 'at:elevenlabs-v3', 'ElevenLabs v3', 'atlascloud', 'Once upon a time, a small computer learned to sing.', {}, 3 * HOUR),
    job('music', 'local:minimax-music-3-4bit', 'MiniMax Music 3 (4-bit)', undefined, 'Warm indie folk, fingerpicked guitar, soft male vocals, campfire', { instrumental: false, duration: 60 }, 4 * MIN),
    job('music', 'ws:ace-step-1.5', 'ACE-Step 1.5', 'wavespeed', 'Upbeat synth-pop, bright female vocals, 120 BPM, summer night drive', { duration: 60 }, 12 * MIN),
    job('music', 'at:minimax-music-3', 'MiniMax Music 3.0', 'atlascloud', 'Lo-fi hip hop, warm piano, vinyl crackle', { instrumental: true }, 26 * HOUR, 'failed'),
    job('image', 'ws:nano-banana-2', 'Nano Banana 2', 'wavespeed', 'A poster that says "Open late" in bold orange letters', { aspect: '16:9', resolution: '1k' }, 8 * MIN),
    job('image', 'ws:z-image-turbo', 'Z-Image Turbo', 'wavespeed', 'A ceramic coffee cup on a sunlit marble counter', { size: '1024*1024' }, 30 * MIN),
  ]
}
