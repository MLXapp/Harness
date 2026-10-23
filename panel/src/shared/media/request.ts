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

import { controlsFor, type CloudMediaModel, type MediaKind, type MediaModel, type MediaParam, type MediaProviderId } from './catalog'

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

/** Every control's value, coerced (the Instrumental switch included). */
export function coerceValues(model: MediaModel, raw: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  return Object.fromEntries(controlsFor(model).map(p => [p.key, coerceParam(p, raw?.[p.key])]))
}

export interface SongText {
  prompt: string
  /** What goes in the lyrics field (models with one). */
  lyrics?: string
  instrumental: boolean
}

/**
 * The prompt and lyrics a music model gets, from the one Lyrics box and the
 * Instrumental switch: lyrics go to the model's field or into the prompt; an
 * instrumental is asked for the way the model understands. Throws (English,
 * like the other request errors) when a song with vocals has no lyrics and the
 * model needs them.
 */
export function songText(model: MediaModel, input: MediaInput): SongText {
  let prompt = input.prompt.trim()
  if (!prompt) throw new Error('Write a prompt first')
  const instrumental = !!model.instrumental && input.values.instrumental === true
  const lyrics = instrumental ? '' : (input.lyrics ?? '').trim()
  if (!instrumental && model.lyricsRequired && !lyrics) throw new Error(`${model.name} sings your lyrics: add lyrics, or turn on Instrumental`)
  if (lyrics && model.lyricsInPrompt) prompt = `${prompt}\n\nLyrics:\n${lyrics}`
  if (instrumental && model.instrumental && 'prompt' in model.instrumental) prompt = `${prompt}\n\n${model.instrumental.prompt}`
  const max = Math.min(MAX_PROMPT_CHARS, model.maxPrompt ?? MAX_PROMPT_CHARS)
  if (prompt.length > max) throw new Error(`Keep the prompt${lyrics && model.lyricsInPrompt ? ' and lyrics' : ''} under ${max} characters`)
  const out: SongText = { prompt, instrumental }
  if (model.lyricsField) {
    out.lyrics = instrumental && model.instrumental && 'lyrics' in model.instrumental ? model.instrumental.lyrics : lyrics
  }
  return out
}

export function buildCloudRequest(model: CloudMediaModel, input: MediaInput): CloudRequest {
  const song = model.kind === 'music' ? songText(model, input) : null
  const prompt = song?.prompt ?? input.prompt.trim()
  if (!prompt) throw new Error('Write a prompt first')
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`Keep the prompt under ${MAX_PROMPT_CHARS} characters`)
  const instrumental = song?.instrumental ? model.instrumental : undefined
  // Mureka's instrumental is its own endpoint, which takes only the prompt.
  if (instrumental && 'path' in instrumental) {
    const body = { [model.promptField]: prompt, ...(model.fixed ?? {}) }
    return model.provider === 'wavespeed'
      ? { url: `${WAVESPEED_API}/${instrumental.path}`, body }
      : { url: `${ATLAS_API}/model/${ATLAS_ENDPOINT[model.kind]}`, body: { model: instrumental.path, ...body } }
  }
  const fields: Record<string, unknown> = { [model.promptField]: prompt }
  if (model.lyricsField) fields[model.lyricsField] = song?.lyrics ?? (input.lyrics ?? '').trim()
  for (const param of model.params) {
    const value = coerceParam(param, input.values[param.key])
    // An empty choice ("Any singer") leaves the field out.
    if (value !== '') fields[param.field] = value
  }
  if (model.instrumental && 'field' in model.instrumental) fields[model.instrumental.field] = !!song?.instrumental
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

/**
 * A price quote for the same request (no charge, nothing runs):
 *  - WaveSpeed AI: POST /api/v3/model/price {model_id, inputs} (the endpoint
 *    WaveSpeed's own MCP server uses for its price quotes).
 *  - Atlas Cloud: POST /api/v1/model/calculate with the generate body.
 */
export function buildQuoteRequest(model: CloudMediaModel, input: MediaInput): CloudRequest {
  const req = buildCloudRequest(model, input)
  if (model.provider === 'wavespeed') {
    return { url: `${WAVESPEED_API}/model/price`, body: { model_id: model.path, inputs: req.body } }
  }
  return { url: `${ATLAS_API}/model/calculate`, body: req.body }
}

/** USD from a quote reply (either provider), or undefined. */
export function parseQuote(json: any): number | undefined {
  const d = json?.data ?? json
  for (const v of [d?.discounted_price, d?.price, d?.unit_price]) {
    const n = typeof v === 'string' ? Number(v) : v
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
  }
  return undefined
}
