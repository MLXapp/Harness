/**
 * "Does this key work?" — the answer the Connect sheet shows live while the
 * user pastes a key (main: src/main/providers/keyCheck.ts). Never carries
 * the key.
 */

import type { DiscoveredModel, ProviderApi } from './types'

export type KeyCheckReason = 'rejected' | 'no-credit' | 'network' | 'format'

export type KeyCheckResult =
  | {
      ok: true
      /** Models the account can use (its listing, or the gateway's public list). */
      models: number
      discovered: DiscoveredModel[]
    }
  | { ok: false; reason: KeyCheckReason; message: string }

/** What the renderer asks: a catalog account, or a custom endpoint. */
export interface KeyCheckRequest {
  /** Catalog id ('deepseek', 'anthropic', 'wavespeed'…). Wins over baseURL/api. */
  providerId?: string
  baseURL?: string
  api?: ProviderApi
  apiKey?: string
}

const QUOTA = /quota|billing|credit|insufficient|balance|exceeded your current|payment|plan limit|out of tokens/i
const KEY_WORDS = /api[ _-]?key|invalid.*(key|token)|unauthori[sz]ed|authentication|permission/i

/** Turn an HTTP answer into a verdict. `null` = the key works. */
export function classifyKeyStatus(status: number, detail: string): KeyCheckReason | null {
  if (status >= 200 && status < 300) return null
  if (status === 401 || status === 403) return 'rejected'
  if (status === 402) return 'no-credit'
  if (status === 429) return QUOTA.test(detail) ? 'no-credit' : 'network'
  // Gemini answers a bad key with 400 API_KEY_INVALID.
  if (status === 400 && KEY_WORDS.test(detail)) return 'rejected'
  if (status === 400 && QUOTA.test(detail)) return 'no-credit'
  return 'network'
}
