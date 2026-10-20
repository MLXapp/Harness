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

/** Hardware the preview pretends to run on. No IPC exposes the chip yet; read it from `window.__PREVIEW__.hardware`. */
export const HARDWARE = {
  chip: 'Apple M3 Pro',
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
  }
  if (scenario === 'fresh') return base

  const { chats, messages } = localChats(now)
  base.models = localModels()
  base.sessions = [runningSession(now), stoppedSession(now)]
  base.chats = chats
  base.messages = messages

  if (scenario === 'connected') {
    base.providers = [ANTHROPIC, DEEPSEEK]
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
