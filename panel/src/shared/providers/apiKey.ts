/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (packages/llm/llm/src/api-key.ts and
 * packages/client/ui-settings-models/src/client/apiKey.ts).
 *
 * Judgement of a typed or stored provider API key. Shared by the renderer
 * (field-level validation before anything is sent) and the main process
 * (which re-checks before storing, and before putting a key in a header).
 */

/**
 * Characters an HTTP header value carries verbatim and every known provider
 * key uses: printable ASCII, space excluded. A key outside this set cannot
 * reach any provider — `fetch` refuses to build the header.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/**
 * A pasted `NAME=value` environment line. The name must be upper-case, so
 * `sk-` forms break at the hyphen, and the `=` must be followed by something
 * other than another `=`, so base64 padding (`ABCD==`) is not mistaken for an
 * assignment.
 */
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

export type ApiKeyRejection = 'empty' | 'illegalCharacters' | 'envLine' | 'quoted'

export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/** Whether a value is wrapped in one matching pair of quotes. */
function isQuoted(value: string): boolean {
  const first = value[0]
  if (first !== '"' && first !== "'" && first !== '`') return false
  return value.length > 1 && value.endsWith(first)
}

/**
 * Judge one supplied API key, trimming surrounding whitespace first.
 * Refuses blank keys, non-printable or non-ASCII characters, pasted
 * `NAME=value` lines and quoted pastes.
 */
export function checkApiKey(raw: string): ApiKeyCheck {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (ENV_LINE.test(value)) return { ok: false, reason: 'envLine' }
  if (isQuoted(value)) return { ok: false, reason: 'quoted' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/**
 * Field-level verdict for the key input. An empty field is not a failure (it
 * means "keep the stored key"); whitespace only is.
 */
export function apiKeyFieldError(draft: string): ApiKeyRejection | undefined {
  if (draft.length === 0) return undefined
  const check = checkApiKey(draft)
  return check.ok ? undefined : check.reason
}
