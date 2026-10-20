/**
 * One cheap authenticated call that tells the Connect sheet whether a pasted
 * key works, before anything is saved.
 *
 *  - OpenAI, DeepSeek, Gemini (OpenAI-compatible) and custom endpoints:
 *    GET {base}/models with a bearer key.
 *  - Anthropic: GET /v1/models with x-api-key.
 *  - DeepSeek additionally: GET /user/balance (documented; is_available says
 *    whether the account can pay for requests).
 *  - WaveSpeed AI: its LLM gateway lists models without a key, so the key is
 *    proved with GET https://api.wavespeed.ai/api/v3/balance (answers 401
 *    "Missing API key" / invalid key, checked 20 Oct 2026); the model count
 *    comes from the public list.
 *
 * The key is never logged and never part of a returned message.
 */

import { cleanPastedKey, checkApiKey } from '../../shared/providers/apiKey'
import { catalogProvider, localServer } from '../../shared/providers/catalog'
import { classifyKeyStatus, type KeyCheckReason, type KeyCheckRequest, type KeyCheckResult } from '../../shared/providers/keyCheck'
import { isProviderApi, normalizeProviderBaseURL, type DiscoveredModel, type ProviderApi } from '../../shared/providers/types'
import { ANTHROPIC_VERSION, listingUrl, readBounded, readListing, type DiscoveryFetch } from './discovery'
import { providerErrorDetail } from './errors'

export const WAVESPEED_BALANCE_URL = 'https://api.wavespeed.ai/api/v3/balance'

const MESSAGES: Record<KeyCheckReason, string> = {
  rejected: 'The key was not accepted',
  'no-credit': 'The account has no credit left',
  network: 'Could not reach the service',
  format: 'That does not look like an API key',
}

const fail = (reason: KeyCheckReason, message = MESSAGES[reason]): KeyCheckResult => ({ ok: false, reason, message })

interface Target {
  providerId?: string
  baseURL: string
  api: ProviderApi
  headers: Record<string, string>
  /** Custom endpoints and local servers may need no key. */
  keyOptional: boolean
}

function resolveTarget(request: KeyCheckRequest): Target {
  const catalog = request.providerId ? catalogProvider(request.providerId) : undefined
  if (catalog) {
    return { providerId: catalog.id, baseURL: catalog.baseURL, api: catalog.api, headers: catalog.headers ?? {}, keyOptional: false }
  }
  const server = request.providerId ? localServer(request.providerId) : undefined
  if (server) return { providerId: server.id, baseURL: server.baseURL, api: 'openai-completions', headers: {}, keyOptional: true }
  if (!isProviderApi(request.api)) throw new Error('Choose a protocol')
  return { baseURL: normalizeProviderBaseURL(request.baseURL), api: request.api, headers: {}, keyOptional: true }
}

function authHeaders(api: ProviderApi, key: string | undefined, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra, accept: 'application/json' }
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (key) headers['x-api-key'] = key
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }
  return headers
}

type Answer = { status: number; text: string } | { status: 0; text: '' }

async function get(fetchImpl: DiscoveryFetch, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Answer> {
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', headers, ...(signal ? { signal } : {}) })
  } catch {
    return { status: 0, text: '' }
  }
  try {
    return { status: response.status, text: await readBounded(response, url) }
  } catch {
    return { status: response.status, text: '' }
  }
}

function verdict(answer: Answer): KeyCheckResult | null {
  if (answer.status === 0) return fail('network')
  const detail = providerErrorDetail(answer.text)
  const reason = classifyKeyStatus(answer.status, detail)
  if (reason === null) return null
  if (reason === 'network' && answer.status === 404) return fail('network', 'No model list at that address')
  if (reason === 'network' && answer.status === 429) return fail('network', 'The service is busy; try again in a moment')
  return fail(reason, reason === 'network' ? `The service answered ${answer.status}` : MESSAGES[reason])
}

function parseModels(text: string): DiscoveredModel[] | undefined {
  try {
    return readListing(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Check a key (or, for an open endpoint, no key) against its service. */
export async function checkProviderKey(
  request: KeyCheckRequest,
  fetchImpl: DiscoveryFetch,
  signal?: AbortSignal,
): Promise<KeyCheckResult> {
  let target: Target
  try {
    target = resolveTarget(request)
  } catch (error) {
    return fail('format', error instanceof Error ? error.message : String(error))
  }
  const cleaned = cleanPastedKey(request.apiKey ?? '')
  let key: string | undefined
  if (cleaned) {
    const judged = checkApiKey(cleaned)
    if (!judged.ok) return fail('format')
    key = judged.value
  } else if (!target.keyOptional) {
    return fail('format', 'Paste a key')
  }

  if (target.providerId === 'wavespeed') {
    const balance = await get(fetchImpl, WAVESPEED_BALANCE_URL, authHeaders('openai-completions', key, {}), signal)
    const bad = verdict(balance)
    if (bad) return bad
    try {
      const body = JSON.parse(balance.text)
      const amount = body?.data?.balance ?? body?.balance
      if (typeof amount === 'number' && amount <= 0) return fail('no-credit')
    } catch {
      // A 2xx without JSON still proves the key.
    }
    const listing = await get(fetchImpl, listingUrl(target.baseURL, target.api), { accept: 'application/json' }, signal)
    const discovered = listing.status >= 200 && listing.status < 300 ? parseModels(listing.text) ?? [] : []
    return { ok: true, models: discovered.length, discovered }
  }

  const url = listingUrl(target.baseURL, target.api)
  const answer = await get(fetchImpl, url, authHeaders(target.api, key, target.headers), signal)
  const bad = verdict(answer)
  if (bad) return bad
  const discovered = parseModels(answer.text)
  if (!discovered) return fail('network', 'The answer was not a model list')

  if (target.providerId === 'deepseek') {
    const balance = await get(fetchImpl, `${target.baseURL}/user/balance`, authHeaders(target.api, key, {}), signal)
    if (balance.status >= 200 && balance.status < 300) {
      try {
        if (JSON.parse(balance.text)?.is_available === false) return fail('no-credit')
      } catch {
        // Unknown shape: the listing already proved the key.
      }
    }
  }
  return { ok: true, models: discovered.length, discovered }
}
