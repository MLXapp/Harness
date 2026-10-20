/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (endpoint data from packages/llm/llm-pi-ai/src/provider-data.generated.ts).
 *
 * The built-in list of cloud providers offered by Settings → Models →
 * Add model provider → Catalog, and the local model servers MLX Harness probes.
 *
 * `dshBaseURL` records the endpoint DeepSeek Harness ships for the same
 * provider (`null` where it ships none). Where `baseURL` differs it is
 * because DSH talks to that provider through a native protocol MLX Harness does
 * not implement (Google, Mistral) or ships only a plan-specific endpoint (Z.ai
 * coding plan, Qwen token plan); MLX Harness then uses the provider's
 * documented OpenAI-compatible endpoint, and `note` says so. Tests pin every
 * entry, so a change here is deliberate.
 *
 * No model list is bundled: models come from the provider's own listing
 * ("Fetch available models") or are typed by hand, so nothing here goes stale
 * when a provider ships a new model.
 */

import type { ProviderApi } from './types'

export interface CatalogProvider {
  id: string
  displayName: string
  api: ProviderApi
  baseURL: string
  dshBaseURL: string | null
  /** Non-secret headers sent with every request (attribution). */
  headers?: Record<string, string>
  note?: string
}

export const PROVIDER_CATALOG: readonly CatalogProvider[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
    dshBaseURL: 'https://api.anthropic.com',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    api: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    dshBaseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com',
    dshBaseURL: 'https://api.deepseek.com',
  },
  {
    id: 'google',
    displayName: 'Google Gemini',
    api: 'openai-completions',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    dshBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    note: "Gemini's OpenAI-compatible endpoint (DSH uses the native Gemini API at /v1beta).",
  },
  {
    id: 'wavespeed',
    displayName: 'WaveSpeed AI',
    api: 'openai-completions',
    baseURL: 'https://llm.wavespeed.ai/v1',
    dshBaseURL: null,
    note: "WaveSpeed AI's LLM gateway (one key for Claude, GPT, Gemini, DeepSeek and more); DSH ships no WaveSpeed entry.",
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1',
    dshBaseURL: 'https://openrouter.ai/api/v1',
    headers: { 'HTTP-Referer': 'https://harness.mlx.app', 'X-Title': 'MLX Harness' },
  },
  {
    id: 'groq',
    displayName: 'Groq',
    api: 'openai-completions',
    baseURL: 'https://api.groq.com/openai/v1',
    dshBaseURL: 'https://api.groq.com/openai/v1',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    api: 'openai-completions',
    baseURL: 'https://api.mistral.ai/v1',
    dshBaseURL: 'https://api.mistral.ai',
    note: "Mistral's OpenAI-compatible /v1 API (DSH uses Mistral's native API at the root).",
  },
  {
    id: 'xai',
    displayName: 'xAI',
    api: 'openai-completions',
    baseURL: 'https://api.x.ai/v1',
    dshBaseURL: 'https://api.x.ai/v1',
  },
  {
    id: 'together',
    displayName: 'Together AI',
    api: 'openai-completions',
    baseURL: 'https://api.together.ai/v1',
    dshBaseURL: 'https://api.together.ai/v1',
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    api: 'openai-completions',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    dshBaseURL: 'https://api.fireworks.ai/inference',
    note: 'OpenAI-compatible path /inference/v1 under the DSH root.',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI (Kimi)',
    api: 'openai-completions',
    baseURL: 'https://api.moonshot.ai/v1',
    dshBaseURL: 'https://api.moonshot.ai/v1',
  },
  {
    id: 'zai',
    displayName: 'Z.ai',
    api: 'openai-completions',
    baseURL: 'https://api.z.ai/api/paas/v4',
    dshBaseURL: null,
    note: "Z.ai's general API; DSH ships only the coding-plan endpoint (see zai-coding).",
  },
  {
    id: 'zai-coding',
    displayName: 'Z.ai Coding Plan',
    api: 'openai-completions',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    dshBaseURL: 'https://api.z.ai/api/coding/paas/v4',
  },
  {
    id: 'qwen',
    displayName: 'Qwen (DashScope)',
    api: 'openai-completions',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    dshBaseURL: null,
    note: "DashScope international compatible-mode; DSH ships only Qwen token-plan endpoints of the same /compatible-mode/v1 shape.",
  },
  {
    id: 'huggingface',
    displayName: 'Hugging Face',
    api: 'openai-completions',
    baseURL: 'https://router.huggingface.co/v1',
    dshBaseURL: 'https://router.huggingface.co/v1',
  },
]

export function catalogProvider(id: string): CatalogProvider | undefined {
  return PROVIDER_CATALOG.find(entry => entry.id === id)
}

/** A model server on this Mac that speaks the OpenAI API. */
export interface LocalServerDefinition {
  id: string
  displayName: string
  baseURL: string
  /** Sent as the bearer token; these servers ignore it but some clients require one. */
  placeholderKey: string
}

export const LOCAL_SERVERS: readonly LocalServerDefinition[] = [
  { id: 'ollama', displayName: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', placeholderKey: 'ollama' },
  { id: 'lmstudio', displayName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', placeholderKey: 'lm-studio' },
]

export function localServer(id: string): LocalServerDefinition | undefined {
  return LOCAL_SERVERS.find(entry => entry.id === id)
}

/** Ids a user-defined provider may not take. */
export function isReservedProviderId(id: string): boolean {
  return LOCAL_SERVERS.some(entry => entry.id === id)
}
