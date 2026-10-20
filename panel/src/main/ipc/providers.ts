/**
 * IPC for Settings → Models and the chat model picker.
 *
 * Secrets flow one way: the renderer may send an API key (to store it, or to
 * probe an endpoint once); nothing here ever returns a key or ciphertext.
 * Provider views carry `configured: boolean` only.
 */

import { BrowserWindow, ipcMain, net } from 'electron'
import { db } from '../database'
import { discoverModels, probeLocalServers, type DiscoveryFetch, type LocalServerProbe } from '../providers/discovery'
import { checkProviderKey } from '../providers/keyCheck'
import type { KeyCheckRequest, KeyCheckResult } from '../../shared/providers/keyCheck'
import { PROVIDER_CATALOG, localServer } from '../../shared/providers/catalog'
import { remoteServerBaseUrl } from '../../shared/remoteApiUrl'
import {
  type ChatModelBinding,
  type DiscoveredModel,
  type ProviderApi,
  type ProviderDraft,
  type ProviderView,
  PROVIDER_ID_PATTERN,
  isProviderApi,
  isProviderReasoningLevel,
  normalizeProviderBaseURL,
} from '../../shared/providers/types'

type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

const fail = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
})

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** net.fetch for the internet (system proxy, certificates); Node fetch for loopback. */
const discoveryFetch: DiscoveryFetch = (url, init) =>
  isLoopbackUrl(url) ? globalThis.fetch(url, init) : net.fetch(url, init)

/** Local servers last seen by a probe, so the picker can list them without waiting. */
let lastProbe: LocalServerProbe[] = []

export function localServerViews(probe: LocalServerProbe[] = lastProbe): ProviderView[] {
  return probe.filter(p => p.reachable).map(p => ({
    id: p.id,
    kind: 'local-server',
    displayName: p.displayName,
    api: 'openai-completions',
    baseURL: p.baseURL,
    models: p.models.map(m => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      input: m.input ?? ['text'],
    })),
    createdAt: 0,
    headerNames: [],
    configured: true,
    needsKey: false,
    reachable: true,
  }))
}

function listViews(): ProviderView[] {
  const store = db.providers
  return store.list().map(record => store.view(record))
}

function slugFromHost(host: string): string {
  const slug = host.toLowerCase().replace(/^api\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return PROVIDER_ID_PATTERN.test(slug) ? slug : 'remote'
}

export function registerProviderHandlers(getWindow: () => BrowserWindow | null): void {
  const changed = () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('providers:changed')
  }

  ipcMain.handle('providers:catalog', () =>
    PROVIDER_CATALOG.map(({ id, displayName, api, baseURL, note }) => ({ id, displayName, api, baseURL, note })),
  )

  ipcMain.handle('providers:list', (): Result<{ providers: ProviderView[]; localServers: ProviderView[] }> => {
    try {
      return { ok: true, providers: listViews(), localServers: localServerViews() }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('providers:probeLocal', async (): Promise<Result<{ localServers: ProviderView[] }>> => {
    try {
      lastProbe = await probeLocalServers(discoveryFetch)
      return { ok: true, localServers: localServerViews(lastProbe) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('providers:save', (_, draft: ProviderDraft, apiKey?: string): Result<{ provider: ProviderView }> => {
    try {
      const store = db.providers
      const saved = store.save(draft)
      // Store the key after the row exists; a typed key is never echoed back.
      if (typeof apiKey === 'string' && apiKey.length > 0) store.setCredential(saved.id, apiKey)
      changed()
      return { ok: true, provider: store.view(store.get(saved.id)!) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('providers:delete', (_, id: string): Result<object> => {
    try {
      db.providers.delete(String(id))
      changed()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('providers:setKey', (_, id: string, apiKey: string): Result<{ configured: boolean }> => {
    try {
      db.providers.setCredential(String(id), String(apiKey ?? ''))
      changed()
      return { ok: true, configured: true }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('providers:clearKey', (_, id: string): Result<{ configured: boolean }> => {
    try {
      db.providers.clearCredential(String(id))
      changed()
      return { ok: true, configured: false }
    } catch (error) {
      return fail(error)
    }
  })

  /**
   * Fetch available models for a draft endpoint. A typed key wins and is used
   * once (not stored). The stored key is used only for the stored provider's
   * own endpoint, so an edited URL cannot receive the saved credential.
   */
  ipcMain.handle(
    'providers:discover',
    async (_, request: { providerId?: string; baseURL: string; api: ProviderApi; apiKey?: string }): Promise<Result<{ models: DiscoveredModel[] }>> => {
      try {
        if (!isProviderApi(request?.api)) throw new Error('Choose a protocol')
        const baseURL = normalizeProviderBaseURL(request.baseURL)
        let apiKey = typeof request.apiKey === 'string' && request.apiKey.length > 0 ? request.apiKey : undefined
        let headers: Record<string, string> | undefined
        if (request.providerId) {
          const server = localServer(request.providerId)
          if (server) {
            apiKey ??= server.placeholderKey
          } else {
            const stored = db.providers.get(request.providerId)
            if (stored && stored.baseURL === baseURL) {
              headers = stored.headers
              apiKey ??= db.providers.resolveCredential(stored.id)
            } else if (stored && apiKey === undefined && db.providers.hasCredential(stored.id)) {
              throw new Error('The endpoint changed: enter the API key again to use it with the new endpoint')
            }
          }
        }
        if (!headers && request.providerId) {
          headers = PROVIDER_CATALOG.find(p => p.id === request.providerId)?.headers
        }
        const models = await discoverModels({ baseURL, api: request.api, apiKey, headers, signal: AbortSignal.timeout(20_000) }, discoveryFetch)
        return { ok: true, models }
      } catch (error) {
        return fail(error)
      }
    },
  )

  /**
   * Live key check for the Connect sheet: one cheap authenticated request.
   * The key is used once and not stored; the reply never contains it.
   */
  ipcMain.handle('providers:checkKey', async (_, request: KeyCheckRequest): Promise<KeyCheckResult> => {
    try {
      return await checkProviderKey(request ?? {}, discoveryFetch, AbortSignal.timeout(15_000))
    } catch {
      return { ok: false, reason: 'network', message: 'Could not reach the service' }
    }
  })

  ipcMain.handle('providers:getChatModel', (_, chatId: string): ChatModelBinding | null => {
    try {
      return db.providers.getChatBinding(String(chatId)) ?? null
    } catch {
      return null
    }
  })

  ipcMain.handle('providers:setChatModel', (_, binding: ChatModelBinding): Result<object> => {
    try {
      const providerId = String(binding?.providerId ?? '')
      if (!localServer(providerId) && !db.providers.get(providerId)) throw new Error('Unknown provider')
      if (binding.reasoningEffort !== undefined && !isProviderReasoningLevel(binding.reasoningEffort)) {
        throw new Error('Unknown reasoning level')
      }
      db.providers.setChatBinding({
        chatId: String(binding.chatId),
        providerId,
        modelId: String(binding.modelId ?? ''),
        ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}),
      })
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('providers:clearChatModel', (_, chatId: string): Result<object> => {
    try {
      db.providers.clearChatBinding(String(chatId))
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  })

  /** Remote sessions that can be copied into a custom provider (no secrets in the reply). */
  ipcMain.handle('providers:remoteSessionCandidates', () => {
    try {
      return db.getSessions()
        .filter(s => s.type === 'remote' && s.remoteUrl && s.remoteModel)
        .map(s => ({ sessionId: s.id, remoteUrl: s.remoteUrl!, remoteModel: s.remoteModel! }))
    } catch {
      return []
    }
  })

  /**
   * Copy a remote session into a custom provider (OpenAI Chat Completions, the
   * protocol remote sessions use). The session itself is left untouched.
   */
  ipcMain.handle('providers:importRemoteSession', (_, sessionId: string): Result<{ provider: ProviderView }> => {
    try {
      const session = db.getSession(String(sessionId))
      if (!session || session.type !== 'remote' || !session.remoteUrl || !session.remoteModel) {
        throw new Error('Not a remote session')
      }
      const apiBase = `${remoteServerBaseUrl(session.remoteUrl)}/v1`
      const url = new URL(apiBase)
      const store = db.providers
      const existing = store.list().find(p => p.baseURL === apiBase && p.kind === 'custom')
      let id = existing?.id ?? slugFromHost(url.host)
      if (!existing) {
        for (let n = 2; store.get(id) || localServer(id); n++) id = `${slugFromHost(url.host)}-${n}`
      }
      const models = existing?.models ?? []
      const saved = store.save({
        id,
        kind: 'custom',
        displayName: existing?.displayName ?? url.host,
        api: existing?.api ?? 'openai-completions',
        baseURL: apiBase,
        models: models.some(m => m.id === session.remoteModel)
          ? models
          : [...models, { id: session.remoteModel, input: ['text'] }],
      })
      if (session.remoteApiKey && !store.hasCredential(saved.id)) store.setCredential(saved.id, session.remoteApiKey)
      changed()
      return { ok: true, provider: store.view(store.get(saved.id)!) }
    } catch (error) {
      return fail(error)
    }
  })
}
