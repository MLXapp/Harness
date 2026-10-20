/**
 * Model providers: cloud APIs, OpenAI/Anthropic-compatible endpoints and local
 * model servers (Ollama, LM Studio) that a chat can use instead of a model
 * running inside MLX Harness.
 *
 * These types are shared by the main process (store, discovery, transport)
 * and the renderer (Settings → Models, chat model picker). Nothing here ever
 * carries a credential value: the renderer only learns whether a provider has
 * a key configured.
 */

/** Wire protocols a provider can speak. */
export const PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type ProviderApi = typeof PROVIDER_APIS[number]

/** Where a provider row came from. */
export const PROVIDER_KINDS = ['local-server', 'catalog', 'custom'] as const
export type ProviderKind = typeof PROVIDER_KINDS[number]

/**
 * Reasoning levels a provider model may accept. The first five are the levels
 * the chat pipeline already sends (`reasoning_effort`); `off` turns thinking
 * off for a model that reasons by default.
 */
export const PROVIDER_REASONING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ProviderReasoningLevel = typeof PROVIDER_REASONING_LEVELS[number]

export type ProviderInputType = 'text' | 'image'

/** One model a provider serves, as the user configured it. */
export interface ProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input: ProviderInputType[]
  /** Absent: the model does not reason (no level is offered). */
  reasoningEfforts?: ProviderReasoningLevel[]
  /**
   * Kept but not offered in the chat model picker (Preferences → Accounts →
   * Choose models…). Absent = shown, so rows saved before this existed stay
   * visible.
   */
  hidden?: boolean
}

/** A stored provider row (no credential). */
export interface ProviderRecord {
  id: string
  kind: ProviderKind
  displayName: string
  api: ProviderApi
  baseURL: string
  /** Extra request headers (never credentials; those live in the Keychain). */
  headers: Record<string, string>
  models: ProviderModel[]
  createdAt: number
}

/** What the renderer sees for a provider: the record plus redacted credential state. */
export interface ProviderView extends Omit<ProviderRecord, 'headers'> {
  /** Header names only; values stay in the main process. */
  headerNames: string[]
  /** True when an API key is stored for this provider. Never the key itself. */
  configured: boolean
  /** Local servers authenticate with a placeholder key and need none. */
  needsKey: boolean
  /** Local servers only: whether the last probe reached it. */
  reachable?: boolean
}

/** A model the endpoint advertised, offered for adoption. */
export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ProviderInputType[]
}

/** Which model a chat uses when it is not bound to an MLX session. */
export interface ChatModelBinding {
  chatId: string
  providerId: string
  modelId: string
  /** undefined = provider default ("Auto"). */
  reasoningEffort?: ProviderReasoningLevel
}

/** Input to create or update a provider (credential handled separately). */
export interface ProviderDraft {
  id: string
  kind: ProviderKind
  displayName: string
  api: ProviderApi
  baseURL: string
  models: ProviderModel[]
}

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isProviderApi(value: unknown): value is ProviderApi {
  return typeof value === 'string' && (PROVIDER_APIS as readonly string[]).includes(value)
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)
}

export function isProviderReasoningLevel(value: unknown): value is ProviderReasoningLevel {
  return typeof value === 'string' && (PROVIDER_REASONING_LEVELS as readonly string[]).includes(value)
}

/** The credential reference a provider's key is stored under. */
export function providerCredentialRef(providerId: string): string {
  return `provider/${providerId}`
}

/** Positive integer or undefined. */
function capacity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Validate and normalize a model list. Throws with a readable message on an
 * empty or duplicate id; drops unusable capacities; at least `text` input.
 */
export function normalizeProviderModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const models: ProviderModel[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) throw new Error('Every model needs an id')
    if (seen.has(id)) throw new Error(`Model "${id}" is listed twice`)
    seen.add(id)
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
    const inputs = Array.isArray(entry.input) ? entry.input : []
    const input: ProviderInputType[] = ['text']
    if (inputs.includes('image')) input.push('image')
    const efforts = Array.isArray(entry.reasoningEfforts)
      ? PROVIDER_REASONING_LEVELS.filter(level => (entry.reasoningEfforts as unknown[]).includes(level))
      : undefined
    models.push({
      id,
      ...(name ? { name } : {}),
      ...(capacity(entry.contextWindow) ? { contextWindow: capacity(entry.contextWindow) } : {}),
      ...(capacity(entry.maxTokens) ? { maxTokens: capacity(entry.maxTokens) } : {}),
      input,
      // A switch that is on must name at least one level besides Off.
      ...(efforts && efforts.some(level => level !== 'off') ? { reasoningEfforts: efforts } : {}),
      ...(entry.hidden === true ? { hidden: true } : {}),
    })
  }
  return models
}

/**
 * Validate an endpoint URL: http(s) only, parseable, no credentials in it.
 * Returns the trimmed URL without trailing slashes.
 */
export function normalizeProviderBaseURL(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Enter an http:// or https:// endpoint URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Enter an http:// or https:// endpoint URL')
  }
  if (url.username || url.password) {
    throw new Error('Put the API key in the key field, not in the URL')
  }
  return raw.replace(/\/+$/, '')
}
