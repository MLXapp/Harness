/**
 * A stand-in for the preload bridge (src/preload/index.ts) so the real renderer
 * runs in a plain browser. Every method of the preload surface is implemented
 * here against in-memory fixture state (preview/fixtures.ts); writes change that
 * state, so clicking around behaves plausibly until the page reloads.
 *
 * Adding a preload method? Add it here too (tests/preview-mock-api.test.ts
 * fails until you do). Methods that are still missing at runtime resolve to
 * `undefined`, `on*` listeners return an unsubscribe function, and each miss
 * is logged once as `[preview] window.api.x.y is not mocked`.
 */

import { PROVIDER_CATALOG } from '../src/shared/providers/catalog'
import type { ChatModelBinding, ProviderDraft, ProviderView } from '../src/shared/providers/types'
import type { KeyCheckRequest, KeyCheckResult } from '../src/shared/providers/keyCheck'
import type { UpdateState } from '../src/shared/appUpdate'
import type { NativeNavigationAction } from '../src/shared/nativeNavigation'
import { APP_VERSION, HARDWARE, HF_CACHE, MODELS_DIR, sampleOutput, type Fixtures, type FixtureMessage } from './fixtures'
import { estimateCost, mediaModel, MEDIA_PROVIDER_NAMES } from '../src/shared/media/catalog'

type Listener = (data: any) => void

/** Main → renderer event bus, keyed by the IPC channel names the preload listens on. */
export class PreviewEvents {
  private listeners = new Map<string, Set<Listener>>()
  on(channel: string, cb: Listener): () => void {
    let set = this.listeners.get(channel)
    if (!set) { set = new Set(); this.listeners.set(channel, set) }
    set.add(cb)
    return () => { set!.delete(cb) }
  }
  emit(channel: string, data?: unknown): void {
    for (const cb of [...(this.listeners.get(channel) ?? [])]) {
      try { cb(data) } catch (error) { console.error(`[preview] listener for ${channel} threw`, error) }
    }
  }
  channels(): string[] {
    return [...this.listeners.keys()].filter(k => (this.listeners.get(k)?.size ?? 0) > 0)
  }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
let seq = 0
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`

/** Extra surface that the preload exposes but src/env.d.ts does not declare. */
interface UndeclaredSurface {
  models: {
    getRecommendedModels: () => Promise<any[]>
  }
  chat: {
    getDefaultProfile: () => Promise<any>
  }
  app: {
    getTotalMemoryGB: () => Promise<number>
  }
  distributed: {
    discover: (sessionId?: string) => Promise<any>
    status: (sessionId?: string) => Promise<any>
    nodes: (sessionId?: string) => Promise<any>
    addNode: (address: string, port?: number, sessionId?: string) => Promise<any>
    removeNode: (nodeId: string, sessionId?: string) => Promise<any>
  }
  i18n: {
    setLocale: (locale: string) => Promise<any>
    getLocale: () => Promise<any>
    getCatalogContract: () => Promise<any>
  }
}

export type PreviewApi = Window['api'] & UndeclaredSurface

export function createMockApi(fx: Fixtures, events: PreviewEvents): PreviewApi {
  const on = (channel: string) => (cb: Listener) => events.on(channel, cb)
  const settings = new Map<string, string>(Object.entries(fx.settings))
  const overrides = new Map<string, any>()
  const planChats = new Set<string>()
  // ?code=sample makes the most recent chat a Code session on a sample project.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('code') === 'sample') {
    const latest = [...fx.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (latest) overrides.set(latest.id, { chatId: latest.id, builtinToolsEnabled: true, workingDirectory: '/Users/luca/Projects/harness-site', permissionPreset: 'workspace' })
  }
  const profiles: any[] = []
  let gateway = { running: true, port: 8080, host: '127.0.0.1', displayHost: '127.0.0.1', singleModelMode: false }
  let downloadDir = MODELS_DIR
  const directories = { user: [] as string[], builtin: [MODELS_DIR, HF_CACHE] }

  const findSession = (id: string) => fx.sessions.find(s => s.id === id) ?? null
  const chatSummary = (c: typeof fx.chats[number]) => ({
    id: c.id, title: c.title, modelId: c.modelId, modelPath: c.modelPath ?? c.modelId,
    createdAt: c.createdAt, updatedAt: c.updatedAt, folderId: c.folderId,
    messageCount: fx.messages.filter(m => m.chatId === c.id).length,
  })
  const byRecent = <T extends { updatedAt: number }>(list: T[]) => [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  const touchChat = (chatId: string) => {
    const chat = fx.chats.find(c => c.id === chatId)
    if (chat) chat.updatedAt = Date.now()
  }
  const providerList = () => ({ ok: true as const, providers: fx.providers, localServers: fx.localServers })
  const setSessionStatus = (id: string, status: typeof fx.sessions[number]['status']) => {
    const s = findSession(id)
    if (!s) return
    s.status = status
    s.updatedAt = Date.now()
    events.emit('session:updated', { sessionId: id, session: s })
  }
  const hfResults = [
    { id: 'mlx-community/Qwen3.5-9B-4bit', author: 'mlx-community', downloads: 48210, likes: 312, lastModified: '2026-10-14T09:12:00.000Z', createdAt: '2026-09-30T09:12:00.000Z', tags: ['mlx', 'text-generation', '4-bit'], pipelineTag: 'text-generation', size: '5.2 GB' },
    { id: 'mlx-community/Qwen3.5-27B-4bit', author: 'mlx-community', downloads: 21877, likes: 205, lastModified: '2026-10-13T16:40:00.000Z', createdAt: '2026-09-30T10:01:00.000Z', tags: ['mlx', 'text-generation', '4-bit'], pipelineTag: 'text-generation', size: '15.3 GB' },
    { id: 'mlx-community/gemma-3-12b-it-qat-4bit', author: 'mlx-community', downloads: 90233, likes: 641, lastModified: '2026-10-02T11:20:00.000Z', createdAt: '2026-04-18T11:20:00.000Z', tags: ['mlx', 'image-text-to-text', '4-bit'], pipelineTag: 'image-text-to-text', size: '8.1 GB' },
    { id: 'mlx-community/whisper-large-v3-turbo', author: 'mlx-community', downloads: 130500, likes: 980, lastModified: '2026-08-21T08:00:00.000Z', createdAt: '2025-10-01T08:00:00.000Z', tags: ['mlx', 'automatic-speech-recognition'], pipelineTag: 'automatic-speech-recognition', size: '1.6 GB' },
    { id: 'JANGQ-AI/GLM-4.6-Air-JANG_3M', author: 'JANGQ-AI', downloads: 6120, likes: 88, lastModified: '2026-10-11T18:05:00.000Z', createdAt: '2026-10-08T18:05:00.000Z', tags: ['mlx', 'jang', 'text-generation'], pipelineTag: 'text-generation', size: '47.9 GB' },
  ]
  const updateState: UpdateState = { phase: 'idle', currentVersion: APP_VERSION }

  const api: PreviewApi = {
    navigation: {
      onAction: (cb: (action: NativeNavigationAction) => void) => events.on('app:navigate', cb),
    },

    models: {
      scan: async (modelType?: string) => {
        const list = fx.models.filter(m => !modelType || (modelType === 'image' ? m.kind === 'image' : m.kind !== 'image'))
        return list.map(({ kind: _kind, ...m }) => m)
      },
      classifyDflash2: async () => false,
      dsparkDrafter: async () => null,
      dflash2Drafters: async () => [],
      info: async (modelPath: string) => {
        const m = fx.models.find(x => x.path === modelPath)
        return { id: m?.name ?? modelPath.split('/').pop(), name: m?.name ?? modelPath.split('/').pop(), path: modelPath, size: m?.size ?? '—' }
      },
      getDirectories: async () => ({ directories: [...directories.builtin, ...directories.user], userDirectories: [...directories.user], builtinDirectories: [...directories.builtin] }),
      addDirectory: async (dirPath: string) => { directories.user.push(dirPath); return { success: true } },
      removeDirectory: async (dirPath: string) => { directories.user = directories.user.filter(d => d !== dirPath); return { success: true } },
      browseDirectory: async () => ({ canceled: true }),
      detectConfig: async (modelPath: string) => {
        if (/qwen/i.test(modelPath)) {
          return { family: 'qwen3_5', toolParser: 'qwen3', reasoningParser: 'qwen3', supportsThinking: true, enableAutoToolChoice: true, cacheType: 'kv', quantizationLabel: '4-bit', maxContextLength: 262_144, description: 'Qwen3.5 9B' }
        }
        if (/gemma/i.test(modelPath)) {
          return { family: 'gemma3', isMultimodal: true, cacheType: 'kv', quantizationLabel: '4-bit', maxContextLength: 131_072 }
        }
        return null
      },
      detectTypes: async (paths: string[]) => Object.fromEntries(paths.map(p => {
        const m = fx.models.find(x => x.path === p)
        return [p, m?.kind === 'image' ? 'image' : m ? 'text' : 'unknown'] as const
      })),
      getGenerationDefaults: async (modelPath: string) => /qwen/i.test(modelPath)
        ? { temperature: 0.6, topP: 0.95, topK: 20, source: 'generation_config' as const }
        : null,
      searchHF: async (query: string, _sortBy?: string, _sortDir?: string, modelType?: string) => {
        const q = query.trim().toLowerCase()
        return hfResults.filter(r => (!q || r.id.toLowerCase().includes(q)) && (modelType !== 'image' || r.pipelineTag === 'text-to-image'))
      },
      fetchReadme: async (repoId: string) => `# ${repoId.split('/').pop()}\n\nSample model card shown by the MLX Harness preview.\n\n\`\`\`bash\nmlx_lm.generate --model ${repoId} --prompt "Hello"\n\`\`\``,
      getRecommendedModels: async () => hfResults,
      getRecentModels: async (author: string) => hfResults.filter(r => !author || r.author === author || author.includes(r.author)),
      getCollectionModels: async () => hfResults.slice(0, 3),
      downloadModel: async (repoId: string) => ({ status: 'queued', path: `${MODELS_DIR}/${repoId}` }),
      startDownload: async (repoId: string) => {
        const jobId = newId('dl')
        events.emit('models:downloadStarted', { jobId, repoId })
        return { status: 'started', path: `${MODELS_DIR}/${repoId}` }
      },
      cancelDownload: async () => ({ success: true }),
      getDownloadStatus: async () => ({ active: null, activeAll: [], queue: [], completed: [] }),
      getDownloadDir: async () => downloadDir,
      setDownloadDir: async (dir: string) => { downloadDir = dir; return { success: true } },
      deleteLocal: async (modelPath: string) => {
        fx.models = fx.models.filter(m => m.path !== modelPath)
        return { success: true, deletedPath: modelPath, freedBytes: 0 }
      },
      browseDownloadDir: async () => ({ canceled: true }),
      onDownloadProgress: on('models:downloadProgress'),
      onDownloadComplete: on('models:downloadComplete'),
      onDownloadError: on('models:downloadError'),
      onDownloadStarted: on('models:downloadStarted'),
      onDownloadQueued: on('models:downloadQueued'),
      checkImageModel: async () => ({ available: false, missing: ['transformer'] }),
      downloadImageModel: async () => ({ status: 'queued', queuePosition: 1 }),
      pauseDownload: async () => ({ success: true }),
      resumeDownload: async () => ({ success: true }),
      onDownloadPaused: on('models:downloadPaused'),
      openDownloadWindow: async () => undefined,
    },

    chat: {
      createFolder: async (name: string, parentId?: string) => {
        const folder = { id: newId('folder'), name, parentId, createdAt: Date.now() }
        fx.folders.push(folder)
        return folder
      },
      getFolders: async () => [...fx.folders],
      deleteFolder: async (id: string) => { fx.folders = fx.folders.filter(f => f.id !== id); return { success: true } },
      create: async (title: string, modelId: string, folderId?: string, modelPath?: string) => {
        const now = Date.now()
        const chat = { id: newId('chat'), title, modelId, folderId, modelPath: modelPath ?? modelId, createdAt: now, updatedAt: now }
        fx.chats.unshift(chat)
        return chat
      },
      ensureForModel: async (title: string, modelPath: string) => {
        const existing = byRecent(fx.chats).find(c => c.modelPath === modelPath)
        if (existing) return existing
        return api.chat.create(title, modelPath, undefined, modelPath)
      },
      getRecent: async (limit = 100) => byRecent(fx.chats).slice(0, limit).map(chatSummary).map((c: any) => {
        const o = overrides.get(c.id)
        return o?.builtinToolsEnabled && o?.workingDirectory ? { ...c, codeDirectory: o.workingDirectory } : c
      }),
      getByModel: async (modelPath: string) => byRecent(fx.chats).filter(c => c.modelPath === modelPath),
      getAll: async (folderId?: string) => byRecent(fx.chats).filter(c => folderId === undefined || c.folderId === folderId),
      get: async (id: string) => fx.chats.find(c => c.id === id) ?? null,
      update: async (id: string, updates: any) => {
        const chat = fx.chats.find(c => c.id === id)
        if (chat) Object.assign(chat, updates)
        return { success: true }
      },
      delete: async (id: string) => {
        fx.chats = fx.chats.filter(c => c.id !== id)
        fx.messages = fx.messages.filter(m => m.chatId !== id)
        return { success: true }
      },
      deleteMessage: async (messageId: string) => { fx.messages = fx.messages.filter(m => m.id !== messageId); return { success: true } },
      deleteMessagesFrom: async (chatId: string, fromTimestamp: number) => {
        fx.messages = fx.messages.filter(m => m.chatId !== chatId || m.timestamp < fromTimestamp)
        return { success: true }
      },
      deleteAll: async (scope?: { folderId?: string; modelPath?: string }) => {
        const doomed = fx.chats.filter(c => (!scope?.folderId || c.folderId === scope.folderId) && (!scope?.modelPath || c.modelPath === scope.modelPath))
        const ids = new Set(doomed.map(c => c.id))
        fx.chats = fx.chats.filter(c => !ids.has(c.id))
        fx.messages = fx.messages.filter(m => !ids.has(m.chatId))
        return { success: true, deleted: ids.size }
      },
      search: async (query: string) => {
        const q = query.toLowerCase()
        return byRecent(fx.chats).filter(c => c.title.toLowerCase().includes(q) || fx.messages.some(m => m.chatId === c.id && m.content.toLowerCase().includes(q)))
      },
      getMessages: async (chatId: string) => fx.messages.filter(m => m.chatId === chatId).sort((a, b) => a.timestamp - b.timestamp).map(m => ({ ...m })),
      addMessage: async (chatId: string, role: string, content: string) => {
        const message: FixtureMessage = { id: newId('msg'), chatId, role: role as FixtureMessage['role'], content, timestamp: Date.now() }
        fx.messages.push(message)
        touchChat(chatId)
        return message
      },
      sendMessage: async (chatId: string, content: string) => {
        // A short, smooth fake stream so composer/streaming states can be captured.
        fx.messages.push({ id: newId('msg'), chatId, role: 'user', content, timestamp: Date.now() })
        touchChat(chatId)
        const messageId = newId('msg')
        events.emit('chat:typing', { chatId, messageId })
        await wait(250)
        const reply = 'This is a sample reply from the MLX Harness preview. No model ran: the preview only replays the streaming events the app would receive.'
        const words = reply.split(' ')
        const started = Date.now()
        for (let i = 1; i <= words.length; i++) {
          const fullContent = words.slice(0, i).join(' ')
          const elapsed = (Date.now() - started) / 1000
          events.emit('chat:stream', { chatId, messageId, content: (i > 1 ? ' ' : '') + words[i - 1], fullContent, metrics: { tokenCount: i, tokensPerSecond: (i / Math.max(elapsed, 0.05)).toFixed(1), ttft: '0.25' } })
          await wait(40)
        }
        const metrics = { tokenCount: words.length, tokenCountKnown: true, tokensPerSecond: '61.8', ttft: '0.25', totalTime: '1.4' }
        const assistant: FixtureMessage = { id: messageId, chatId, role: 'assistant', content: reply, timestamp: Date.now(), tokens: words.length, metricsJson: JSON.stringify(metrics) }
        fx.messages.push(assistant)
        events.emit('chat:complete', { chatId, messageId, content: reply, metrics })
        return assistant
      },
      onStream: on('chat:stream'),
      onComplete: on('chat:complete'),
      onReasoningDone: on('chat:reasoningDone'),
      onAnswerPass: on('chat:answerPass'),
      onTyping: on('chat:typing'),
      onToolStatus: on('chat:toolStatus'),
      abort: async () => undefined,
      isStreaming: async () => false,
      clearAllLocks: async () => ({ cleared: 0 }),
      clearStaleLocks: async () => ({ cleared: 0, running: 0 }),
      onAskUser: on('chat:askUser'),
      answerUser: () => undefined,
      compact: async () => ({ success: true, compacted: false }),
      onCompaction: on('chat:compaction'),
      onApprovalRequest: on('chat:approvalRequest'),
      onApprovalSettled: on('chat:approvalSettled'),
      answerApproval: async () => ({ accepted: true }),
      // ?approval=sample: one command waiting for an OK in whichever chat asks.
      getPendingApprovals: async (chatId: string) => new URLSearchParams(window.location.search).get('approval') === 'sample' ? [{
        id: 'ap-1', chatId: chatId || 'chat-swift', toolName: 'run_command', kind: 'shell',
        subject: 'npm install --save-dev vitest', reason: 'Add the test runner the plan uses.',
        why: 'no-sandbox', allowAlways: true, expiresAt: Date.now() + 4 * 60_000,
      }] : [],
      asideCancel: async () => true,
      // Ask aside (⌘;): a short answer that is not added to the chat.
      aside: async (_chatId: string, question: string) => {
        await new Promise(r => setTimeout(r, 600))
        return { success: true, text: /test/i.test(question)
          ? 'It runs the tests with Vitest: `npm test` once, `npx vitest` to watch. The plan adds one test file per screen.'
          : 'The model is updating the header and the footer. Two files have changed so far; nothing has been committed.' }
      },
      onContext: on('chat:context'),
      sandboxStatus: async () => ({ available: true, network: false }),
      getTodos: async () => [],
      onOpenFromNotification: on('chat:openFromNotification'),
      onTodos: on('chat:todos'),
      pickImages: async () => [],
      // The preview "chooses" a project folder so the Code tab can be clicked through.
      openDirectory: async () => ({ canceled: false, filePaths: ['/Users/luca/Projects/harness-site'] }),
      setOverrides: async (chatId: string, value: any) => { overrides.set(chatId, value); return { success: true } },
      getOverrides: async (chatId: string) => overrides.get(chatId) ?? null,
      setPlanMode: async (chatId: string, on: boolean) => { if (on) planChats.add(chatId); else planChats.delete(chatId); return on },
      getPlanMode: async (chatId: string) => planChats.has(chatId),
      steer: async () => ({ accepted: true }),
      onBrowserFrame: on('browser:frame'),
      onSteered: on('chat:steered'),
      onSteerUnused: on('chat:steerUnused'),
      clearOverrides: async (chatId: string) => { overrides.delete(chatId); return { success: true } },
      saveProfile: async (name: string, value: any, isDefault?: boolean) => {
        const profile = { id: newId('profile'), name, overrides: value, isDefault: !!isDefault, createdAt: Date.now() }
        profiles.push(profile)
        return profile
      },
      updateProfile: async (id: string, name: string, value: any, isDefault?: boolean) => {
        const profile = profiles.find(p => p.id === id)
        if (profile) Object.assign(profile, { name, overrides: value, isDefault: !!isDefault })
        return profile ?? null
      },
      getProfiles: async () => [...profiles],
      getDefaultProfile: async () => profiles.find(p => p.isDefault) ?? null,
      deleteProfile: async (id: string) => { profiles.splice(profiles.findIndex(p => p.id === id) >>> 0, 1); return { success: true } },
      export: async () => ({ success: false }),
      import: async () => ({ success: false }),
    },

    engine: {
      checkInstallation: async () => fx.engineInstalled
        ? { installed: true, path: '/Applications/MLX Harness.app/Contents/Resources/bundled-python', version: '1.6.0', method: 'bundled', bundled: true }
        : { installed: false },
      detectInstallers: async () => [{ method: 'bundled', path: '/Applications/MLX Harness.app/Contents/Resources/bundled-python', available: true }],
      checkEngineVersion: async () => ({ current: '1.6.0', bundled: '1.6.0', needsUpdate: false }),
      installStreaming: async () => {
        for (const line of ['Preparing the bundled engine…', 'Verifying files…', 'Done.']) {
          events.emit('engine:install-log', { data: line + '\n' })
          await wait(200)
        }
        events.emit('engine:install-complete', { success: true })
        return { success: true }
      },
      cancelInstall: async () => undefined,
      onInstallLog: on('engine:install-log'),
      onInstallComplete: on('engine:install-complete'),
    },

    cache: {
      stats: async () => ({ prefix_cache: { entries: 12, hits: 48, misses: 9, tokens_cached: 18_432 }, memory: { used_mb: 612, limit_mb: 5_400 } }),
      entries: async () => ({ entries: [] }),
      warm: async () => ({ success: true, warmed: 0 }),
      clear: async () => ({ success: true }),
    },

    audio: {
      transcribe: async () => ({ text: 'Sample transcription from the preview.', language: 'en', duration: 2.4 }),
      speak: async () => '',
      voices: async () => ({ voices: ['af_heart', 'am_michael'] }),
    },

    benchmark: {
      run: async () => ({ success: false, error: 'Benchmarks do not run in the preview' }),
      history: async () => [],
      delete: async () => ({ success: true }),
      onProgress: on('benchmark:progress'),
    },

    embeddings: {
      embed: async (texts: string[]) => ({ data: texts.map((_, index) => ({ index, embedding: [0, 0, 0] })) }),
    },

    performance: {
      capabilities: async () => null,
      health: async () => ({ status: 'healthy', model_loaded: true }),
    },

    templates: {
      list: async () => [],
      save: async () => ({ success: true }),
      delete: async () => ({ success: true }),
    },

    developer: {
      info: async (modelPath: string) => ({ success: true, output: `Model: ${modelPath}\nFormat: MLX (4-bit)\n` }),
      doctor: async () => ({ success: true }),
      convert: async () => ({ success: false, error: 'Conversion does not run in the preview' }),
      cancelOp: async () => ({ success: true }),
      isRunning: async () => ({ running: false }),
      getBufferedLogs: async () => ({ lines: [], running: false, result: null, operation: null }),
      browseOutputDir: async () => null,
      onLog: on('developer:log'),
      onComplete: on('developer:complete'),
    },

    network: {
      getTotals: async () => ({ ok: true, data: { chain: 'mlx-1', at: Date.now(), totals: { macs: 1284, online: 912, working: 640, tps: 182_400, tokensToday: 9_840_000_000, countries: 41, freeNodes: 377 } } }),
      getMining: async () => ({ ok: true, data: { at: Date.now(), locked: '128400000', pending: '2150000', rate: 0.0003, active: true, macs: 1, state: 'mining' as const } }),
      getMlxAppStatus: async () => ({ installed: false, running: false, bundled: true, bundledVersion: '0.9.0' }),
      yieldEnabled: async () => true,
      setYieldEnabled: async (on: boolean) => on,
      openMlxApp: async () => false,
      installMlxNode: async () => ({ ok: true as const, path: '/Applications/MLX Node.app', installed: true }),
    },

    app: {
      getPowerMode: async () => ({ mode: 'automatic' as const, source: 'ac' as const }),
      getVersion: async () => APP_VERSION,
      getTotalMemoryGB: async () => HARDWARE.totalMemoryGB,
      getHardware: async () => {
        await wait(250)
        // ?mem=16 pretends to be a smaller Mac (media tabs grey out what it cannot run).
        const mem = typeof window === 'undefined' ? 0 : Number(new URLSearchParams(window.location.search).get('mem'))
        return { chip: HARDWARE.chip, modelName: HARDWARE.modelName, memoryGB: mem > 0 ? mem : HARDWARE.totalMemoryGB, freeDiskGB: HARDWARE.freeDiskGB }
      },
      getUpdateState: async () => ({ ...updateState }),
      onUpdateState: on('app:updateState'),
      installUpdate: async () => undefined,
      restartToUpdate: async () => undefined,
      dismissUpdate: async () => undefined,
      openUpdateDownload: async () => undefined,
      onMtpComponentUpdateAvailable: on('models:mtpComponentUpdateAvailable'),
      dismissMtpComponentUpdate: async () => ({ success: true }),
    },

    gateway: {
      getStatus: async () => ({ ...gateway }),
      setPort: async (port: number) => { gateway = { ...gateway, port }; return { ...gateway } },
      setHostAndPort: async (port: number, host: string) => { gateway = { ...gateway, port, host, displayHost: host }; return { ...gateway } },
      setSingleModelMode: async (enabled: boolean) => {
        gateway = { ...gateway, singleModelMode: enabled }
        events.emit('gateway:singleModelModeChanged', { singleModelMode: enabled })
        return { ...gateway }
      },
      onSingleModelModeChanged: on('gateway:singleModelModeChanged'),
    },

    providers: {
      catalog: async () => PROVIDER_CATALOG.map(({ id, displayName, api: wire, baseURL, note }) => ({ id, displayName, api: wire, baseURL, note })),
      list: async () => providerList(),
      probeLocal: async () => ({ ok: true as const, localServers: fx.localServers }),
      save: async (draft: ProviderDraft, apiKey?: string) => {
        const existing = fx.providers.find(p => p.id === draft.id)
        const view: ProviderView = {
          ...draft,
          createdAt: existing?.createdAt ?? Date.now(),
          headerNames: existing?.headerNames ?? [],
          configured: !!apiKey || !!existing?.configured,
          needsKey: true,
        }
        fx.providers = existing ? fx.providers.map(p => p.id === draft.id ? view : p) : [...fx.providers, view]
        events.emit('providers:changed')
        return { ok: true as const, provider: view }
      },
      delete: async (id: string) => {
        fx.providers = fx.providers.filter(p => p.id !== id)
        events.emit('providers:changed')
        return { ok: true as const }
      },
      setKey: async (id: string) => {
        const p = fx.providers.find(x => x.id === id)
        if (p) p.configured = true
        events.emit('providers:changed')
        return { ok: true as const, configured: true }
      },
      clearKey: async (id: string) => {
        const p = fx.providers.find(x => x.id === id)
        if (p) p.configured = false
        events.emit('providers:changed')
        return { ok: true as const, configured: false }
      },
      discover: async (request: { providerId?: string; baseURL: string }) => {
        const known = fx.providers.find(p => p.id === request.providerId || p.baseURL === request.baseURL)
        const models = known?.models.map(({ id, name, contextWindow, maxTokens, input }) => ({ id, name, contextWindow, maxTokens, input }))
          ?? [{ id: 'sample-model-large', name: 'Sample Model Large' }, { id: 'sample-model-small', name: 'Sample Model Small' }]
        await wait(300)
        return { ok: true as const, models }
      },
      /**
       * Live key check, simulated: a key containing "bad" is rejected, "nocredit"
       * has no credit, "offline" cannot reach the service; anything else works.
       * The listing is the provider's featured ids plus a few others.
       */
      checkKey: async (request: KeyCheckRequest): Promise<KeyCheckResult> => {
        await wait(700)
        const key = request.apiKey ?? ''
        if (request.providerId && !key.trim()) return { ok: false, reason: 'format', message: 'Paste a key' }
        if (/bad/i.test(key)) return { ok: false, reason: 'rejected', message: 'The key was not accepted' }
        if (/nocredit/i.test(key)) return { ok: false, reason: 'no-credit', message: 'The account has no credit left' }
        if (/offline/i.test(key)) return { ok: false, reason: 'network', message: 'Could not reach the service' }
        const listed: Record<string, string[]> = {
          deepseek: ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
          anthropic: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5', 'claude-opus-4-1'],
          openai: ['gpt-6-astra', 'gpt-6-mini', 'gpt-5.2', 'gpt-5-mini', 'o5', 'gpt-image-2', 'text-embedding-3-large'],
          google: ['gemini-4-argon', 'gemini-4-flash', 'gemini-3-pro', 'gemini-embedding-001'],
          wavespeed: ['anthropic/claude-opus-5.5', 'deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-astra', 'google/gemini-4-argon', 'qwen/qwen3.8-max', 'moonshotai/kimi-k3', 'z-ai/glm-5.1', 'x-ai/grok-5', 'meta-llama/llama-5-405b', 'mistralai/mistral-large-3', 'minimax/minimax-m3'],
        }
        const ids = request.providerId ? listed[request.providerId] ?? [] : ['qwen3-coder-next', 'qwen3.8-27b', 'gpt-oss-120b']
        return { ok: true, models: ids.length, discovered: ids.map(id => ({ id })) }
      },
      getChatModel: async (chatId: string) => fx.chatBindings.find(b => b.chatId === chatId) ?? null,
      setChatModel: async (binding: ChatModelBinding) => {
        fx.chatBindings = [...fx.chatBindings.filter(b => b.chatId !== binding.chatId), binding]
        return { ok: true as const }
      },
      clearChatModel: async (chatId: string) => {
        fx.chatBindings = fx.chatBindings.filter(b => b.chatId !== chatId)
        return { ok: true as const }
      },
      remoteSessionCandidates: async () => [],
      importRemoteSession: async () => ({ ok: false as const, error: 'No remote session to import in the preview' }),
      onChanged: (cb: () => void) => events.on('providers:changed', () => cb()),
    },

    clipboard: {
      readText: async () => 'sk-preview-0123456789abcdef',
    },

    tasks: (() => {
      const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
      let items: any[] = params.get('tasks') === 'sample' ? [
        { id: 't1', title: 'Morning brief', prompt: 'Summarize my unread mail and today\'s calendar.', chatId: 'chat-trip', schedule: { kind: 'daily', time: '08:00' }, enabled: true, nextRun: Date.now() + 9 * 3600000, lastRun: Date.now() - 15 * 3600000, lastStatus: 'ok', lastNote: 'Ran at 09:14 instead of 08:00: the Mac was asleep or MLX Harness was closed.', createdAt: Date.now() - 3 * 86400000, running: false },
        { id: 't2', title: 'Check the build', prompt: 'Run the tests and tell me what fails.', chatId: 'chat-swift', schedule: { kind: 'interval', minutes: 120 }, enabled: false, nextRun: null, createdAt: Date.now() - 86400000, running: false },
      ] : []
      return {
        list: async () => items,
        create: async (_c: string, input: any) => { items = [{ id: `t${Date.now()}`, ...input, chatId: 'chat-trip', enabled: true, nextRun: Date.now() + 3600000, createdAt: Date.now(), running: false }, ...items]; events.emit('tasks:changed'); return { ok: true } },
        setEnabled: async (id: string, on: boolean) => { items = items.map(i => (i.id === id ? { ...i, enabled: on } : i)); events.emit('tasks:changed'); return true },
        runNow: async () => true,
        delete: async (id: string) => { items = items.filter(i => i.id !== id); events.emit('tasks:changed'); return true },
        onChanged: (cb: () => void) => events.on('tasks:changed', cb as any),
      }
    })(),
    code: {
      openInApps: async () => [
        { id: 'finder', name: 'Finder', bundleId: 'com.apple.finder', kind: 'finder' },
        { id: 'terminal', name: 'Terminal', bundleId: 'com.apple.Terminal', kind: 'terminal' },
        { id: 'xcode', name: 'Xcode', bundleId: 'com.apple.dt.Xcode', kind: 'editor' },
        { id: 'vscode', name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', kind: 'editor' },
      ],
      openIn: async () => ({ ok: true }),
    },
    // ?code=sample: the second Swift reply changed two files (Changes review).
    changes: (() => {
      const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
      const dir = '/Users/luca/Projects/harness-site'
      const before = 'struct NoteRow: View {\n  let note: Note\n  var body: some View {\n    HStack {\n      Text(note.title)\n      Spacer()\n    }\n  }\n}\n'
      const after = 'struct NoteRow: View {\n  let note: Note\n  var body: some View {\n    HStack {\n      Text(note.title)\n        .font(.headline)\n      Spacer()\n    }\n    .contextMenu {\n      Button("Pin") { togglePin(note) }\n      Button("Delete", role: .destructive) { delete(note) }\n    }\n  }\n}\n'
      let set: any = params.get('code') === 'sample' ? {
        chatId: 'chat-swift', messageId: 'm4', at: Date.now() - 60000, workingDir: dir,
        files: [
          { path: `${dir}/Sources/NoteRow.swift`, shown: 'Sources/NoteRow.swift', kind: 'modified', added: 5, removed: 0, afterHash: 'x', revertible: true },
          { path: `${dir}/Sources/NoteActions.swift`, shown: 'Sources/NoteActions.swift', kind: 'added', added: 12, removed: 0, afterHash: 'y', revertible: true },
        ],
      } : null
      return {
        list: async (chatId: string) => (set && set.chatId === chatId ? [set] : []),
        file: async (_c: string, _m: string, path: string) => (path.endsWith('NoteRow.swift')
          ? { before, after, opaque: false, changedSince: false }
          : { before: '', after: 'import SwiftUI\n\nfunc togglePin(_ note: Note) {\n  note.pinned.toggle()\n}\n\nfunc delete(_ note: Note) {\n  withAnimation {\n    store.remove(note)\n  }\n}\n', opaque: false, changedSince: false }),
        revert: async (_c: string, _m: string, paths: string[]) => {
          const all = paths.length ? paths : set.files.map((f: any) => f.path)
          set = { ...set, files: set.files.map((f: any) => (all.includes(f.path) ? { ...f, reverted: true } : f)) }
          events.emit('changes:turn', set)
          return { reverted: all, conflicts: [], failed: [] }
        },
        reveal: async () => true,
        onTurn: (cb: (s: any) => void) => events.on('changes:turn', cb as any),
      }
    })(),
    memory: (() => {
      let on = true
      let items = [
        { id: 'm1a2b3c4d', text: 'Prefers TypeScript with 2-space indents and no semicolons', createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000 },
        { id: 'm5e6f7a8b', text: 'Works on harness.mlx.app; deploys go through Vercel', createdAt: Date.now() - 3600000, updatedAt: Date.now() - 3600000 },
      ]
      return {
        list: async () => items,
        enabled: async () => on,
        setEnabled: async (v: boolean) => { on = v; return v },
        add: async (text: string) => { items = [{ id: `m${Math.random().toString(16).slice(2, 10)}`, text, createdAt: Date.now(), updatedAt: Date.now() }, ...items]; events.emit('memory:changed'); return { ok: true } },
        update: async (id: string, text: string) => { items = items.map(i => (i.id === id ? { ...i, text, updatedAt: Date.now() } : i)); events.emit('memory:changed'); return { ok: true } },
        delete: async (id: string) => { items = items.filter(i => i.id !== id); events.emit('memory:changed'); return true },
        clear: async () => { items = []; events.emit('memory:changed'); return true },
        onChanged: (cb: () => void) => events.on('memory:changed', cb as any),
      }
    })(),
    skills: {
      list: async () => [
        { name: 'pdf', description: 'Read, fill and merge PDF files', scope: 'user' as const, dir: '~/.claude/skills/pdf' },
        { name: 'release-notes', description: 'Write release notes in the house style from the git log', scope: 'user' as const, dir: '~/.mlx-harness/skills/release-notes' },
      ],
      openFolder: async () => true,
    },
    // Apps (Composio): ?apps=connected starts signed in.
    apps: (() => {
      const featured = [['gmail', 'Gmail'], ['googlecalendar', 'Google Calendar'], ['googledrive', 'Google Drive'], ['slack', 'Slack'], ['notion', 'Notion'], ['github', 'GitHub'], ['linear', 'Linear'], ['outlook', 'Outlook'], ['googlesheets', 'Google Sheets'], ['hubspot', 'HubSpot'], ['jira', 'Jira'], ['todoist', 'Todoist']].map(([id, name]) => ({ id, name }))
      const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
      let status: any = params.get('apps') === 'connected' ? { state: 'connected', via: 'oauth', toolCount: 5 } : { state: 'off', via: null }
      let rules: Record<string, any> = { slack: 'always' }
      const chats = new Set<string>()
      const view = () => ({ ...status, featured })
      return {
        status: async () => view(),
        connect: async () => { status = { state: 'waiting-for-browser', via: 'oauth' }; events.emit('apps:status', view()); await new Promise(r => setTimeout(r, 900)); status = { state: 'connected', via: 'oauth', toolCount: 5 }; events.emit('apps:status', view()); return view() },
        connectKey: async () => { status = { state: 'connected', via: 'key', toolCount: 5 }; return view() },
        cancel: async () => view(),
        disconnect: async () => { status = { state: 'off', via: null }; return view() },
        connectApp: async () => ({ ok: true, opened: 1 }),
        checkApp: async () => ({ ok: true, connected: true }),
        rules: async () => rules,
        setRule: async (toolkit: string, rule: string) => { rules = { ...rules, [toolkit]: rule }; if (rule === 'ask') delete rules[toolkit]; return rules },
        chatEnabled: async (chatId: string) => status.state === 'connected' && chats.has(chatId),
        setChatEnabled: async (chatId: string, on: boolean) => { if (on) chats.add(chatId); else chats.delete(chatId); return on && status.state === 'connected' },
        onStatus: on('apps:status'),
      }
    })(),

    // Media tabs: jobs live in fx.mediaJobs; a submit "runs" for a few
    // seconds and finishes with a sample picture (or a short silent clip).
    media: {
      list: async (kind: string) => fx.mediaJobs.filter(j => j.kind === kind).sort((a, b) => b.createdAt - a.createdAt),
      submit: async (request: any) => {
        const model = mediaModel(request.modelId)
        if (!model) return { ok: false as const, error: 'Unknown model' }
        if (model.where === 'cloud' && !fx.providers.some(p => p.id === model.provider && p.configured)) {
          return { ok: false as const, error: `Connect ${MEDIA_PROVIDER_NAMES[model.provider]} first` }
        }
        const now = Date.now()
        const job: any = {
          id: newId('media'), kind: model.kind, modelId: model.id, modelName: model.name, where: model.where,
          ...(model.where === 'cloud' ? { provider: model.provider } : {}),
          prompt: String(request.prompt), ...(request.lyrics ? { lyrics: request.lyrics } : {}),
          values: { ...request.values }, status: 'running', phase: 'queued', outputs: [],
          estimateUsd: estimateCost(model, request.values ?? {}, request.prompt), createdAt: now, updatedAt: now,
        }
        fx.mediaJobs.push(job)
        events.emit('media:job', { ...job })
        setTimeout(() => { job.phase = 'generating'; job.updatedAt = Date.now(); events.emit('media:job', { ...job }) }, 1200)
        setTimeout(() => {
          job.status = 'done'; delete job.phase; job.finishedAt = Date.now(); job.updatedAt = job.finishedAt
          job.outputs = [sampleOutput(job.kind, job.prompt)]
          events.emit('media:job', { ...job })
        }, 4200)
        return { ok: true as const, job: { ...job } }
      },
      quote: async (request: any) => {
        const model = mediaModel(request.modelId)
        const usd = model ? estimateCost(model, request.values ?? {}, request.prompt) : undefined
        return usd === undefined ? { ok: false as const, error: 'No quote' } : { ok: true as const, usd }
      },
      cancel: async (id: string) => {
        const job = fx.mediaJobs.find(j => j.id === id)
        if (job && job.status === 'running') { job.status = 'cancelled'; delete job.phase; events.emit('media:job', { ...job }) }
        return { ok: true as const }
      },
      delete: async (id: string) => { fx.mediaJobs = fx.mediaJobs.filter(j => j.id !== id); return { ok: true as const } },
      reveal: async () => ({ ok: true }),
      save: async () => ({ ok: false, error: 'Saving is off in the preview' }),
      onJob: (cb: (job: any) => void) => events.on('media:job', cb),
    },

    // The preview pretends to be a Mac with window glass; ?glass=0 shows the
    // opaque fallback other platforms get. The wallpaper behind it is preview.css.
    chrome: {
      vibrancy: () => typeof window === 'undefined' || new URLSearchParams(window.location.search).get('glass') !== '0',
    },

    // The preview pretends to be a Mac: the mic offers Apple Dictation (a no-op here).
    dictation: {
      supported: () => true,
      start: async () => ({ ok: true as const }),
    },

    settings: {
      get: async (key: string) => settings.get(key) ?? null,
      has: async (key: string) => settings.has(key),
      set: async (key: string, value: string) => { settings.set(key, value); return { success: true, value } },
      delete: async (key: string) => { settings.delete(key); return { success: true } },
    },

    modelSettings: {
      get: async () => null,
      getAll: async () => [],
      save: async () => ({ success: true }),
      delete: async () => ({ success: true }),
    },

    image: {
      getRuntimeSettings: async () => ({}) as any,
      saveRuntimeSettings: async () => undefined,
      inspectLocalModel: async () => ({ kind: 'missing' }) as any,
      createSession: async (modelName: string, sessionType?: 'generate' | 'edit') => ({ success: true, session: { id: newId('img'), modelName, sessionType: sessionType ?? 'generate', createdAt: Date.now(), updatedAt: Date.now() } }),
      getSessions: async () => [],
      getSession: async () => null,
      deleteSession: async () => ({ success: true }),
      getGenerations: async () => [],
      deleteGeneration: async () => ({ success: true }),
      generate: async () => ({ success: false, error: 'Image generation does not run in the preview' }),
      edit: async () => ({ success: false, error: 'Image editing does not run in the preview' }),
      startServer: async () => ({ success: false, error: 'Image servers do not run in the preview', serverKept: true }),
      stopServer: async () => ({ success: true }),
      cancelGeneration: async () => ({ success: true }),
      isGenerating: async () => ({ generating: false, cancelling: false, startTime: null, sessionId: null, progress: null }),
      getRunningServer: async () => null,
      getRunningServers: async () => [],
      readFile: async () => null,
      saveFile: async () => ({ success: false }),
      getModelPaths: async () => [],
    },

    tools: {
      getCodingToolStatus: async () => ({
        claude: { installed: true, configured: false, configPath: '~/.claude/settings.json', entries: [] },
        codex: { installed: false, configured: false, configPath: '~/.codex/config.toml', entries: [] },
        opencode: { installed: false, configured: false, configPath: '~/.config/opencode/opencode.json', entries: [] },
      }),
      installCodingTool: async () => ({ success: true }),
      addCodingToolConfig: async () => ({ success: true }),
      removeCodingToolConfig: async () => ({ success: true }),
      getConfigSnippets: async () => ({}),
    },

    sessions: {
      list: async () => fx.sessions.map(({ config, ...s }) => ({ ...s, config })),
      availablePort: async () => 8000 + fx.sessions.length,
      get: async (id: string) => {
        const s = findSession(id)
        return s ? { ...s } : null
      },
      create: async (modelPath: string, config: any) => {
        const now = Date.now()
        const session = {
          id: newId('sess'), modelPath, modelName: modelPath.split('/').pop(), host: config?.host ?? '127.0.0.1', port: config?.port ?? 8000 + fx.sessions.length,
          status: 'stopped' as const, standbyDepth: null, config: JSON.stringify(config ?? {}), pendingConfig: null,
          createdAt: now, updatedAt: now, type: 'local' as const, modelPathMissing: false,
        }
        fx.sessions.push(session)
        events.emit('session:created', { sessionId: session.id })
        return session
      },
      createRemote: async (params: { remoteUrl: string; remoteModel: string }) => {
        const now = Date.now()
        const session = {
          id: newId('remote'), modelPath: `remote://${params.remoteModel}`, modelName: params.remoteModel, host: new URL(params.remoteUrl).hostname, port: 443,
          status: 'stopped' as const, standbyDepth: null, config: '{}', pendingConfig: null, createdAt: now, updatedAt: now,
          type: 'remote' as const, remoteUrl: params.remoteUrl, remoteModel: params.remoteModel, modelPathMissing: false,
        }
        fx.sessions.push(session)
        events.emit('session:created', { sessionId: session.id })
        return session
      },
      start: async (sessionId: string) => {
        setSessionStatus(sessionId, 'loading')
        events.emit('session:starting', { sessionId })
        for (const progress of [20, 55, 85]) {
          await wait(200)
          events.emit('session:loadProgress', { sessionId, label: 'Loading weights', labelKey: 'sessions.load.weights', progress })
        }
        await wait(200)
        setSessionStatus(sessionId, 'running')
        events.emit('session:ready', { sessionId })
        return { success: true }
      },
      stop: async (sessionId: string) => {
        setSessionStatus(sessionId, 'stopped')
        events.emit('session:stopped', { sessionId })
        return { success: true }
      },
      restart: async (sessionId: string) => api.sessions.start(sessionId),
      getLoadProgress: async () => ({}),
      delete: async (sessionId: string) => {
        fx.sessions = fx.sessions.filter(s => s.id !== sessionId)
        events.emit('session:deleted', { sessionId })
        return { success: true }
      },
      repointModelPath: async () => ({ success: false, canceled: true }),
      detect: async () => [],
      update: async (sessionId: string, config: any) => {
        const s = findSession(sessionId)
        if (s) s.config = JSON.stringify({ ...JSON.parse(s.config || '{}'), ...config })
        events.emit('session:updated', { sessionId })
        return { success: true, restartRequired: false, changedKeys: Object.keys(config ?? {}) }
      },
      getLogs: async (sessionId: string) => {
        const s = findSession(sessionId)
        if (!s || s.status !== 'running') return []
        return [
          `[engine] Loading ${s.modelName}`,
          '[engine] Prefix cache: on (paged KV, 64-token blocks)',
          `[engine] Uvicorn running on http://${s.host}:${s.port}`,
          '[engine] POST /v1/chat/completions 200 (61.4 tok/s)',
        ]
      },
      clearLogs: async () => ({ success: true }),
      browseMcpConfig: async () => ({ canceled: true }),
      importMcpConfig: async () => ({ success: false, canceled: true, servers: [] }),
      validateMcpConfig: async () => ({ success: true, serverCount: 0, servers: [] }),
      mcpStatus: async () => ({ success: true, tools: [], servers: [], count: 0 }),
      softSleep: async (sessionId: string) => { setSessionStatus(sessionId, 'standby'); return { success: true } },
      deepSleep: async (sessionId: string) => { setSessionStatus(sessionId, 'standby'); return { success: true } },
      wake: async (sessionId: string) => { setSessionStatus(sessionId, 'running'); return { success: true } },
      touch: async () => ({ success: true }),
      onStarting: on('session:starting'),
      onReady: on('session:ready'),
      onStopped: on('session:stopped'),
      onError: on('session:error'),
      onHealth: on('session:health'),
      memoryWarnings: async () => [],
      dismissMemoryWarning: async () => undefined,
      copyMemoryWarningCommand: async () => undefined,
      onMemoryWarnings: on('session:memoryWarnings'),
      onLog: on('session:log'),
      onCreated: on('session:created'),
      onDeleted: on('session:deleted'),
      onUpdated: on('session:updated'),
      onStandby: on('session:standby'),
      onLoadProgress: on('session:loadProgress'),
    },

    distributed: {
      discover: async () => ({ nodes: [] }),
      status: async () => ({ enabled: false, nodes: [] }),
      nodes: async () => [],
      addNode: async () => ({ success: false, error: 'Distributed compute does not run in the preview' }),
      removeNode: async () => ({ success: true }),
    },

    i18n: {
      setLocale: async () => ({ success: true }),
      getLocale: async () => 'en',
      getCatalogContract: async () => null,
    },
  }
  return api
}

const NOT_PROXIED = new Set<PropertyKey>(['then', 'toJSON', '$$typeof', 'constructor', 'prototype', 'asymmetricMatch'])

/**
 * Wrap the mock so a method the preload gains later (and this file does not
 * have yet) degrades instead of crashing the render: `on*` returns an
 * unsubscribe function, anything else resolves to undefined. Logged once each.
 */
export function withFallback<T extends object>(api: T): T {
  const warned = new Set<string>()
  const miss = (path: string) => {
    if (warned.has(path)) return
    warned.add(path)
    console.warn(`[preview] window.api.${path} is not mocked (preview/mockApi.ts); returning a default`)
  }
  const wrapNamespace = (ns: Record<string, unknown>, name: string): Record<string, unknown> =>
    new Proxy(ns, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || NOT_PROXIED.has(prop) || prop in target) return Reflect.get(target, prop, receiver)
        miss(`${name}.${prop}`)
        return /^on[A-Z]/.test(prop) ? () => () => {} : () => Promise.resolve(undefined)
      },
    })
  const cache = new Map<string, Record<string, unknown>>()
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || NOT_PROXIED.has(prop)) return Reflect.get(target, prop, receiver)
      if (!cache.has(prop)) {
        const ns = (prop in target ? Reflect.get(target, prop, receiver) : (miss(prop), {})) as Record<string, unknown>
        cache.set(prop, wrapNamespace(ns, prop))
      }
      return cache.get(prop)
    },
  })
}
