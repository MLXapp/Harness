/**
 * Turn a chat's model binding into what the chat pipeline needs to talk to
 * that provider: a remote-style session for the existing remote path, the
 * wire API, the model's capabilities, and a fetch that rewrites the
 * pipeline's `/v1/<route>` URL onto the provider's endpoint, adds the
 * credential (only here, in the main process) and, for Anthropic Messages,
 * translates the protocol.
 *
 * Subscription sign-in (OAuth for consumer plans) is intentionally not
 * implemented: it needs a terms review. A future `credentialKind: 'oauth'`
 * would resolve its bearer token here, in `authHeadersFor`, and nowhere else.
 */

import type { Session } from '../database'
import type { ChatModelBinding, ProviderApi, ProviderModel, ProviderRecord, ProviderReasoningLevel } from '../../shared/providers/types'
import { localServer } from '../../shared/providers/catalog'
import { checkApiKey } from '../../shared/providers/apiKey'
import { createAnthropicFetch, type PipelineFetch, type PipelineResponse } from './anthropic'

export interface ProviderRoute {
  providerId: string
  providerName: string
  kind: ProviderRecord['kind']
  api: ProviderApi
  modelId: string
  model?: ProviderModel
  reasoningEffort?: ProviderReasoningLevel
  wireApi: 'completions' | 'responses'
  isLocalServer: boolean
  /** A remote-type session object for the pipeline's remote code path (not stored). */
  session: Session
  /** Fetch for every inference request of this chat turn. */
  fetch: PipelineFetch
}

export interface ProviderResolveDeps {
  getProvider(id: string): ProviderRecord | undefined
  resolveCredential(id: string): string | undefined
  /** Node http(s) streaming fetch (loopback servers). */
  nodeFetch: PipelineFetch
  /** Electron net.fetch (internet: proxies, certificates). */
  netFetch: PipelineFetch
}

export class ProviderRouteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderRouteError'
  }
}

/** The pipeline route after `/v1/`, e.g. `chat/completions` or `responses`. */
export function pipelineRoute(url: string): string {
  const match = /\/v1\/(chat\/completions|responses)(\/[^?#]*)?(?:[?#].*)?$/.exec(url)
  if (!match) throw new ProviderRouteError(`Unsupported provider request path: ${url}`)
  return match[1] + (match[2] ?? '')
}

function isLoopback(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** The record for a local server (not stored; models come from its live listing). */
export function localServerRecord(id: string): ProviderRecord | undefined {
  const server = localServer(id)
  if (!server) return undefined
  return {
    id: server.id,
    kind: 'local-server',
    displayName: server.displayName,
    api: 'openai-completions',
    baseURL: server.baseURL,
    headers: {},
    models: [],
    createdAt: 0,
  }
}

/** Credential headers for one request. Main process only. */
function authHeadersFor(provider: ProviderRecord, apiKey: string | undefined): Record<string, string> {
  if (provider.api === 'anthropic-messages') return {} // x-api-key is added by the Anthropic client
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

export function resolveProviderRoute(binding: ChatModelBinding, deps: ProviderResolveDeps): ProviderRoute {
  const local = localServer(binding.providerId)
  const provider = local ? localServerRecord(binding.providerId)! : deps.getProvider(binding.providerId)
  if (!provider) {
    throw new ProviderRouteError('The model provider for this chat was removed. Pick another model from the model menu.')
  }
  let apiKey: string | undefined
  if (local) {
    apiKey = local.placeholderKey
  } else {
    apiKey = deps.resolveCredential(provider.id)
    if (apiKey === undefined && provider.kind === 'catalog') {
      throw new ProviderRouteError(`${provider.displayName} has no API key (or it can no longer be read from the Keychain). Add it in Preferences → Models.`)
    }
    if (apiKey !== undefined) {
      const checked = checkApiKey(apiKey)
      if (!checked.ok) throw new ProviderRouteError(`The stored ${provider.displayName} API key is not usable. Enter it again in Preferences → Models.`)
      apiKey = checked.value
    }
  }

  const model = provider.models.find(m => m.id === binding.modelId)
  const loopback = isLoopback(provider.baseURL)
  const upstream = loopback ? deps.nodeFetch : deps.netFetch
  const base = provider.baseURL.replace(/\/+$/, '')

  let fetch: PipelineFetch
  if (provider.api === 'anthropic-messages') {
    fetch = createAnthropicFetch({
      baseURL: base,
      apiKey,
      headers: provider.headers,
      model: binding.modelId,
      maxTokens: model?.maxTokens,
      upstream,
    })
  } else {
    fetch = async (url, init): Promise<PipelineResponse> => {
      const route = pipelineRoute(url)
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        // The pipeline's own auth slot is empty for providers; never let a
        // stray Authorization header override the provider credential.
        if (name.toLowerCase() === 'authorization') continue
        headers[name] = value
      }
      Object.assign(headers, provider.headers, authHeadersFor(provider, apiKey))
      let body = init.body
      // Pin the provider's model id even if the pipeline picked a display name.
      try {
        const parsed = JSON.parse(init.body)
        if (parsed && typeof parsed === 'object' && parsed.model !== binding.modelId) {
          parsed.model = binding.modelId
          body = JSON.stringify(parsed)
        }
      } catch {
        // not JSON; send as is
      }
      return upstream(`${base}/${route}`, { ...init, headers, body })
    }
  }

  let host = '127.0.0.1'
  let port = 0
  try {
    const url = new URL(base)
    host = url.hostname
    port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  } catch {
    // validated on save
  }
  const session: Session = {
    id: `provider:${provider.id}`,
    modelPath: `provider://${provider.id}/${binding.modelId}`,
    modelName: model?.name || binding.modelId,
    host,
    port,
    status: 'running',
    config: JSON.stringify({ timeout: 600 }),
    createdAt: 0,
    updatedAt: 0,
    type: 'remote',
    remoteUrl: base,
    remoteModel: binding.modelId,
  }

  return {
    providerId: provider.id,
    providerName: provider.displayName,
    kind: provider.kind,
    api: provider.api,
    modelId: binding.modelId,
    model,
    reasoningEffort: binding.reasoningEffort,
    wireApi: provider.api === 'openai-responses' ? 'responses' : 'completions',
    isLocalServer: !!local,
    session,
    fetch,
  }
}
