/**
 * Readable messages for provider HTTP failures. The "API error: <status> - "
 * prefix is kept so the chat's existing error classifiers still recognise
 * the failure; the text after it tells the user what to do.
 */

export type ProviderErrorKind = 'auth' | 'quota' | 'rate-limit' | 'overloaded' | 'not-found' | 'other'

const QUOTA_PATTERN = /quota|billing|credit|insufficient|balance|exceeded your current|payment|plan limit|out of tokens/i
const CONTEXT_PATTERN = /prompt is too long|context length|context_length|maximum context|too many tokens|prompt_too_long/i

export function classifyProviderError(status: number, detail: string): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'quota'
  if (status === 429) return QUOTA_PATTERN.test(detail) ? 'quota' : 'rate-limit'
  if (status === 529 || status === 503) return 'overloaded'
  if (status === 404) return 'not-found'
  if (status === 400 && QUOTA_PATTERN.test(detail) && !CONTEXT_PATTERN.test(detail)) return 'quota'
  return 'other'
}

/** Pull the human message out of an OpenAI- or Anthropic-style error body. */
export function providerErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.detail
    if (typeof message === 'string' && message) return message
  } catch {
    // not JSON
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

export function providerErrorMessage(status: number, rawDetail: string, providerName: string): string {
  const detail = providerErrorDetail(rawDetail)
  const suffix = detail ? ` (${detail})` : ''
  switch (classifyProviderError(status, detail)) {
    case 'auth':
      return `API error: ${status} - ${providerName} did not accept the API key: check the API key in Preferences → Models.${suffix}`
    case 'quota':
      return `API error: ${status} - ${providerName} says this account is out of quota or credit. Check your plan or billing with ${providerName}, or switch this chat to a model on this Mac.${suffix}`
    case 'rate-limit':
      return `API error: ${status} - ${providerName} rate limit reached. Wait a moment and send again, or switch this chat to a model on this Mac.${suffix}`
    case 'overloaded':
      return `API error: ${status} - ${providerName} is overloaded right now. Try again in a moment.${suffix}`
    case 'not-found':
      return `API error: ${status} - ${providerName} does not know this model or endpoint. Check the model id and endpoint in Preferences → Models.${suffix}`
    default:
      return `API error: ${status} - ${detail || 'request failed'}`
  }
}
