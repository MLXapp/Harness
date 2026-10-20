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
 * Tidy a pasted key before it is judged: surrounding whitespace, one pair of
 * quotes, an `export NAME=` / `NAME=` / `NAME: ` prefix, `Bearer ` and a
 * trailing `;` are removed, so a line copied from a .env file or a curl
 * example still works. Anything else is left for `checkApiKey` to judge.
 */
export function cleanPastedKey(raw: string): string {
  let value = typeof raw === 'string' ? raw.trim() : ''
  for (let pass = 0; pass < 3; pass++) {
    const before = value
    value = value.replace(/^export\s+/, '')
    const env = /^[A-Z][A-Z0-9_]*\s*[=:]\s*(?!=)([\s\S]+)$/.exec(value)
    if (env) value = env[1].trim()
    if (isQuoted(value)) value = value.slice(1, -1).trim()
    value = value.replace(/^Bearer\s+/i, '').replace(/;$/, '').trim()
    if (value === before) break
  }
  return value
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
