/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (packages/llm/llm-pi-ai/src/discovery.ts).
 *
 * MIT License
 *
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * "Which models can this endpoint serve?" for Settings → Models → Fetch
 * available models, and the probe that finds Ollama / LM Studio on this Mac.
 *
 * OpenAI protocols list at `GET {baseURL}/models` with a bearer key; Anthropic
 * Messages lists at `GET {root}/v1/models?limit=1000` with `x-api-key` and
 * `anthropic-version`, where the root is the base URL with or without one
 * trailing `/v1`. The reply is candidate metadata only; nothing is stored
 * until the user adopts models.
 */

import type { DiscoveredModel, ProviderApi } from '../../shared/providers/types'
import { checkApiKey } from '../../shared/providers/apiKey'
import { LOCAL_SERVERS } from '../../shared/providers/catalog'

/** Stable API version required by Anthropic's endpoints. */
export const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page Anthropic accepts; one page is read. */
const ANTHROPIC_MODEL_LIMIT = 1000

/** Replies larger than this are refused (the URL is whatever the user typed). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type DiscoveryFetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

export class DiscoveryError extends Error {
  constructor(message: string, readonly code: 'DISCOVERY_FAILED' | 'INVALID_CREDENTIAL' | 'ABORTED' | 'UNAUTHORIZED') {
    super(message)
    this.name = 'DiscoveryError'
  }
}

interface ListingEntry {
  id?: unknown
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  limit?: { context?: unknown; output?: unknown } | null
  top_provider?: { max_completion_tokens?: unknown; context_length?: unknown } | null
  architecture?: { input_modalities?: unknown; modality?: unknown } | null
  capabilities?: unknown
}

function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Image input when the listing discloses it (OpenRouter architecture, Ollama-style capabilities). */
function disclosedImageInput(entry: ListingEntry | null): boolean | undefined {
  const modalities = entry?.architecture?.input_modalities
  if (Array.isArray(modalities)) return modalities.includes('image')
  const modality = entry?.architecture?.modality
  if (typeof modality === 'string' && modality.includes('->')) return modality.split('->')[0].includes('image')
  if (Array.isArray(entry?.capabilities)) return (entry!.capabilities as unknown[]).includes('vision')
  return undefined
}

/**
 * The listing URL for a protocol. The base is a prefix, not a URL to resolve
 * against, so deployment paths (`/openai/v1`) keep their segments.
 */
export function listingUrl(baseURL: string, api: ProviderApi): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${ANTHROPIC_MODEL_LIMIT}`
}

/**
 * Read one model-listing reply: the standard `data` array, or an enriched
 * `models` map (key = endpoint-facing id). Rows without an id are skipped.
 */
export function readListing(body: unknown): DiscoveredModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  let listed: Array<{ key?: string; raw: unknown }>
  if (Array.isArray(listing?.data)) {
    listed = (listing!.data as unknown[]).map(raw => ({ raw }))
  } else if (Array.isArray(listing?.models)) {
    // Ollama's native /api/tags shape ({models:[{name}]}) when a user points
    // a custom endpoint at the server root.
    listed = (listing!.models as unknown[]).map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new DiscoveryError(
        'The endpoint\'s model list has neither a "data" array nor a "models" object; add the models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const out: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id, typeof entry?.name === 'string' && !entry?.id ? entry.name : undefined)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = label(entry?.name, entry?.display_name, entry?.displayName)
    const contextWindow = capacity(
      entry?.contextWindow, entry?.context_window, entry?.context_length,
      entry?.max_input_tokens, entry?.limit?.context, entry?.top_provider?.context_length,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens,
      entry?.limit?.output, entry?.top_provider?.max_completion_tokens,
    )
    const image = disclosedImageInput(entry)
    out.push({
      id,
      ...(name && name !== id ? { name } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(image === undefined ? {} : { input: image ? ['text', 'image'] : ['text'] }),
    })
  }
  return out
}

export async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = () => new DiscoveryError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw oversized()
  }
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))))
}

export interface DiscoveryRequest {
  baseURL: string
  api: ProviderApi
  /** Typed key (wins) or the stored key; never logged or returned. */
  apiKey?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** Ask an endpoint which models it serves. */
export async function discoverModels(request: DiscoveryRequest, fetchImpl: DiscoveryFetch): Promise<DiscoveredModel[]> {
  const url = listingUrl(request.baseURL, request.api)
  let apiKey: string | undefined
  if (request.apiKey !== undefined) {
    const checked = checkApiKey(request.apiKey)
    if (!checked.ok) {
      throw new DiscoveryError(
        checked.reason === 'empty'
          ? 'The API key is blank'
          : 'That API key contains characters no HTTP header can carry; paste the key itself',
        'INVALID_CREDENTIAL',
      )
    }
    apiKey = checked.value
  }
  const headers: Record<string, string> = { ...(request.headers ?? {}), accept: 'application/json' }
  if (request.api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (apiKey !== undefined) headers['x-api-key'] = apiKey
  } else if (apiKey !== undefined) {
    headers.authorization = `Bearer ${apiKey}`
  }
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', headers, ...(request.signal ? { signal: request.signal } : {}) })
  } catch {
    if (request.signal?.aborted) throw new DiscoveryError('Model discovery was cancelled', 'ABORTED')
    throw new DiscoveryError(`Could not reach ${url}`, 'DISCOVERY_FAILED')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      throw new DiscoveryError(`${url} answered ${response.status}: check the API key`, 'UNAUTHORIZED')
    }
    throw new DiscoveryError(`${url} answered ${response.status}`, 'DISCOVERY_FAILED')
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error) {
    if (request.signal?.aborted) throw new DiscoveryError('Model discovery was cancelled', 'ABORTED')
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new DiscoveryError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED')
  }
  return readListing(body)
}

export interface LocalServerProbe {
  id: string
  displayName: string
  baseURL: string
  reachable: boolean
  models: DiscoveredModel[]
}

/**
 * Probe Ollama (127.0.0.1:11434) and LM Studio (127.0.0.1:1234) through their
 * OpenAI-compatible `/v1/models`, with their placeholder keys. Short timeout:
 * a server that is not running refuses the connection immediately.
 */
export async function probeLocalServers(fetchImpl: DiscoveryFetch, timeoutMs = 1500): Promise<LocalServerProbe[]> {
  return Promise.all(LOCAL_SERVERS.map(async (server) => {
    try {
      const models = await discoverModels(
        { baseURL: server.baseURL, api: 'openai-completions', apiKey: server.placeholderKey, signal: AbortSignal.timeout(timeoutMs) },
        fetchImpl,
      )
      return { id: server.id, displayName: server.displayName, baseURL: server.baseURL, reachable: true, models }
    } catch {
      return { id: server.id, displayName: server.displayName, baseURL: server.baseURL, reachable: false, models: [] }
    }
  }))
}
