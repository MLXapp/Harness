/**
 * Turns what the user set in a media tab into a provider request, and a
 * provider's reply into one shape. Pure (no fetch, no keys), unit-tested in
 * tests/media-request.test.ts against the documented request and result
 * schemas (wavespeed.ai/docs, atlascloud.ai/docs, checked 23 Oct 2026):
 *
 *  - WaveSpeed AI: POST https://api.wavespeed.ai/api/v3/{model path} with only
 *    the model's parameters; poll GET /api/v3/predictions/{id}/result.
 *    Envelope {code, message, data:{id, status, outputs[], error}}; status
 *    created | processing | completed | failed | cancelled | timeout | deleted.
 *  - Atlas Cloud: POST https://api.atlascloud.ai/api/v1/model/generate{Image|Video|Audio}
 *    with {model, ...parameters}; poll GET /api/v1/model/prediction/{id}.
 *    Envelope {code, msg, data:{id, status, outputs[], error}}; done is
 *    completed or succeeded; failed or timeout ends it.
 */

import type { CloudMediaModel, MediaKind, MediaParam, MediaProviderId } from './catalog'

export const WAVESPEED_API = 'https://api.wavespeed.ai/api/v3'
export const ATLAS_API = 'https://api.atlascloud.ai/api/v1'

export const MAX_PROMPT_CHARS = 5000

export interface MediaInput {
  prompt: string
  lyrics?: string
  values: Record<string, unknown>
}

export interface CloudRequest {
  url: string
  body: Record<string, unknown>
}

const ATLAS_ENDPOINT: Record<MediaKind, string> = {
  image: 'generateImage',
  video: 'generateVideo',
  audio: 'generateAudio',
  music: 'generateAudio',
}

/** A value the control allows, else its default. */
export function coerceParam(param: MediaParam, raw: unknown): string | number | boolean {
  if (param.type === 'toggle') return typeof raw === 'boolean' ? raw : param.default
  if (param.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) return param.default
    const clamped = Math.min(param.max, Math.max(param.min, n))
    const decimals = (String(param.step).split('.')[1] ?? '').length
    return Number((Math.round(clamped / param.step) * param.step).toFixed(decimals))
  }
  return param.options.some(o => o === raw) ? raw as string | number : param.default
}

export function buildCloudRequest(model: CloudMediaModel, input: MediaInput): CloudRequest {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('Write a prompt first')
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`Keep the prompt under ${MAX_PROMPT_CHARS} characters`)
  const fields: Record<string, unknown> = { [model.promptField]: prompt }
  if (model.lyricsField) {
    const lyrics = (input.lyrics ?? '').trim()
    // ACE-Step needs lyrics; an empty string asks for an instrumental.
    fields[model.lyricsField] = lyrics
  }
  for (const param of model.params) fields[param.field] = coerceParam(param, input.values[param.key])
  Object.assign(fields, model.fixed ?? {})
  if (model.provider === 'wavespeed') {
    return { url: `${WAVESPEED_API}/${model.path}`, body: fields }
  }
  return { url: `${ATLAS_API}/model/${ATLAS_ENDPOINT[model.kind]}`, body: { model: model.path, ...fields } }
}

export function pollUrl(provider: MediaProviderId, remoteId: string): string {
  const id = encodeURIComponent(remoteId)
  return provider === 'wavespeed' ? `${WAVESPEED_API}/predictions/${id}/result` : `${ATLAS_API}/model/prediction/${id}`
}

export type RemoteState =
  | { state: 'pending'; status: string }
  | { state: 'done'; outputs: RemoteOutput[] }
  | { state: 'failed'; error: string; code?: number | string }

export type RemoteOutput = { kind: 'url'; url: string } | { kind: 'text'; text: string }

function envelopeMessage(json: any): string | undefined {
  const m = json?.message ?? json?.msg ?? json?.error?.message ?? json?.detail
  return typeof m === 'string' && m.trim() ? m.trim() : undefined
}

/** The prediction id from a submit reply, or an error message. */
export function parseSubmit(json: any, httpStatus: number): { id: string } | { error: string } {
  const id = json?.data?.id ?? json?.id
  if (httpStatus >= 200 && httpStatus < 300 && typeof id === 'string' && id) return { id }
  return { error: envelopeMessage(json) ?? `The service answered ${httpStatus}` }
}

function readOutputs(raw: unknown): RemoteOutput[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteOutput[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(/^https?:\/\//i.test(item) ? { kind: 'url', url: item } : { kind: 'text', text: item })
    } else if (item && typeof item === 'object') {
      const url = (item as any).url ?? (item as any).audio_url ?? (item as any).video_url ?? (item as any).image_url
      const text = (item as any).text
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) out.push({ kind: 'url', url })
      else if (typeof text === 'string') out.push({ kind: 'text', text })
    }
  }
  return out
}

export function parsePoll(provider: MediaProviderId, json: any, httpStatus: number): RemoteState {
  if (httpStatus === 401 || httpStatus === 403) return { state: 'failed', error: envelopeMessage(json) ?? 'The key was not accepted', code: httpStatus }
  const data = json?.data ?? json
  const status = String(data?.status ?? '').toLowerCase()
  const done = provider === 'wavespeed' ? status === 'completed' : status === 'completed' || status === 'succeeded'
  const failed = provider === 'wavespeed'
    ? ['failed', 'cancelled', 'timeout', 'deleted'].includes(status)
    : ['failed', 'timeout'].includes(status)
  if (done) {
    const outputs = readOutputs(data?.outputs)
    if (outputs.length === 0) return { state: 'failed', error: 'The service finished without a result' }
    return { state: 'done', outputs }
  }
  if (failed) {
    const error = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : status === 'timeout' ? 'The job timed out' : 'The job failed'
    return { state: 'failed', error, ...(data?.code !== undefined ? { code: data.code } : {}) }
  }
  if (httpStatus >= 500 || httpStatus === 429) return { state: 'pending', status: 'retrying' }
  if (httpStatus >= 400) return { state: 'failed', error: envelopeMessage(json) ?? `The service answered ${httpStatus}`, code: httpStatus }
  return { state: 'pending', status: status || 'processing' }
}

/**
 * How long to wait before the next poll: never faster than 2 s (WaveSpeed's
 * rule), stretching to 5 s for images and 10 s for video, music and long
 * jobs as they age.
 */
export function nextPollDelayMs(kind: MediaKind, attempt: number): number {
  const cap = kind === 'image' ? 5000 : 10000
  return Math.min(cap, 2000 + attempt * 1000)
}

/** File extension for a downloaded output, from its URL or the kind. */
export function outputExtension(url: string, kind: MediaKind): string {
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(url).pathname)
  const ext = match?.[1]?.toLowerCase()
  const allowed: Record<MediaKind, string[]> = {
    image: ['png', 'jpg', 'jpeg', 'webp'],
    video: ['mp4', 'mov', 'webm'],
    audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a'],
    music: ['mp3', 'wav', 'flac', 'ogg', 'm4a'],
  }
  if (ext && allowed[kind].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext
  return kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'
}
