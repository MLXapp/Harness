/**
 * What the Image, Video, Audio and Music tabs offer: models that run on this
 * Mac and models in the cloud (WaveSpeed AI, Atlas Cloud), with what each
 * needs, costs and is licensed for.
 *
 * Facts checked on 23 Oct 2026 against the providers' own pages and the model
 * cards (per-model llms.txt on wavespeed.ai and atlascloud.ai, Hugging Face
 * repo listings, the mflux, mlx-audio, ltx-2-mlx, mlx-video and ACE-Step 1.5
 * READMEs). Prices are list prices; both providers say the quote in their
 * console is what is charged. Re-check when a provider changes a model.
 *
 *  - Wan 3.0 has no open weights (Atlas Cloud: "not open source, not open
 *    weights"), so it is cloud-only. The newest open Wan is 2.2 (Apache-2.0).
 *  - Local video and music runners (ltx-2-mlx, mlx-video, ACE-Step 1.5) are not
 *    bundled yet: their rows say so and show whether this Mac could run them.
 *  - Local speech runs on mlx-audio (bundled) through vmlx_engine.audio.job.
 *
 * Every number shown in the app comes from this file; nothing is estimated
 * at run time except the fit (memory) check in ./fit.ts.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'music'
export type MediaTask = 'text-to-image' | 'text-to-video' | 'text-to-speech' | 'speech-to-text' | 'song'
export type MediaProviderId = 'wavespeed' | 'atlascloud'
export type LocalRunner = 'mlx-audio' | 'ltx-2-mlx' | 'mlx-video' | 'ace-step' | 'mflux'

/** One control in the composer. `field` is the provider's own parameter name. */
export type MediaParam =
  | { key: string; field: string; type: 'select'; options: Array<string | number>; default: string | number; label: ParamLabel }
  | { key: string; field: string; type: 'number'; min: number; max: number; step: number; default: number; label: ParamLabel; unit?: 's' }
  | { key: string; field: string; type: 'toggle'; default: boolean; label: ParamLabel }

/** Labels are i18n keys under media.param.* */
export type ParamLabel = 'duration' | 'aspect' | 'resolution' | 'audio' | 'voice' | 'speed' | 'language' | 'instrumental' | 'size'

export interface MediaPrice {
  usd: number
  /** Per-second price by the `resolution` setting, where it changes the price. */
  byResolution?: Record<string, number>
  /** What one `usd` buys. 'second' = per second of output video/audio. */
  per: 'image' | 'second' | 'run' | '1k-chars' | 'song'
  /** Price depends on settings (e.g. sound on); shown as "from". */
  from?: boolean
}

export interface MediaLicense {
  name: string
  /** False: outputs or weights are non-commercial (a badge says so). */
  commercial: boolean
}

interface MediaModelBase {
  /** Stable id (settings, tests, job rows). */
  id: string
  kind: MediaKind
  task: MediaTask
  name: string
  maker: string
  /** One short line (English, like the curated chat models). */
  blurb: string
  badge?: 'Best' | 'Best value' | 'Fast' | 'New'
  license: MediaLicense
  /** The text field the prompt goes into. */
  promptField: string
  /** Optional second text box (lyrics). */
  lyricsField?: string
  params: MediaParam[]
}

export interface CloudMediaModel extends MediaModelBase {
  where: 'cloud'
  provider: MediaProviderId
  /** WaveSpeed: the URL path; Atlas Cloud: the model id in the body. */
  path: string
  price?: MediaPrice
  /** Fixed fields always sent (e.g. Atlas's output format). */
  fixed?: Record<string, string | number | boolean>
}

export interface LocalMediaModel extends MediaModelBase {
  where: 'local'
  runner: LocalRunner
  /** Hugging Face repo the runner loads (only where verified). */
  repo?: string
  /** Download size from the repo listing (only where verified). */
  downloadGB?: number
  /** Below this the model does not run (greyed, with the reason). */
  minMemoryGB: number
  /** At or above this it runs comfortably ("Runs well on this Mac"). */
  recMemoryGB: number
  /** Sourced timing, shown as-is (with the chip it was measured on). */
  speed?: string
  /** False: the runner is not part of this build yet. */
  available: boolean
  /** Same model in the cloud, offered when this Mac cannot run it. */
  cloudTwin?: string
}

export type MediaModel = CloudMediaModel | LocalMediaModel

// ── Shared parameter sets ───────────────────────────────────────────────────

const aspect = (field: string, options: string[], def = options[0]): MediaParam =>
  ({ key: 'aspect', field, type: 'select', options, default: def, label: 'aspect' })
const resolution = (field: string, options: string[], def: string): MediaParam =>
  ({ key: 'resolution', field, type: 'select', options, default: def, label: 'resolution' })
const seconds = (field: string, options: number[], def: number): MediaParam =>
  ({ key: 'duration', field, type: 'select', options, default: def, label: 'duration' })
const soundOn = (field: string, def = true): MediaParam => ({ key: 'audio', field, type: 'toggle', default: def, label: 'audio' })
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

// ── Video ───────────────────────────────────────────────────────────────────

const VIDEO: MediaModel[] = [
  {
    id: 'ws:wan-3.0', kind: 'video', task: 'text-to-video', where: 'cloud', provider: 'wavespeed',
    path: 'alibaba/wan-3.0/text-to-video', name: 'Wan 3.0', maker: 'Alibaba',
    blurb: '2 to 30 second clips with sound, up to 1080p.', badge: 'Best value',
    // WaveSpeed quotes (23 Oct 2026, 5 s with sound): 480p $0.2375, 720p $0.475, 1080p $0.95.
    price: { usd: 0.0475, per: 'second', from: true, byResolution: { '480p': 0.0475, '720p': 0.095, '1080p': 0.19 } },
    license: { name: 'Alibaba Wan 3.0 (API only)', commercial: true },
    promptField: 'prompt',
    params: [seconds('duration', range(2, 30), 5), aspect('aspect_ratio', ['16:9', '9:16', '1:1', '4:3', '3:4']),
      resolution('resolution', ['480p', '720p', '1080p'], '720p'), soundOn('generate_audio')],
  },
  {
    id: 'at:wan-3.0', kind: 'video', task: 'text-to-video', where: 'cloud', provider: 'atlascloud',
    path: 'alibaba/wan-3.0/text-to-video', name: 'Wan 3.0', maker: 'Alibaba',
    blurb: '2 to 30 second clips with sound, up to 1080p.', badge: 'Best value',
    price: { usd: 0.04, per: 'second' },
    license: { name: 'Alibaba Wan 3.0 (API only)', commercial: true },
    promptField: 'prompt',
    params: [seconds('duration', range(2, 30), 5), aspect('ratio', ['16:9', '9:16', '1:1', '4:3', '3:4']),
      resolution('resolution', ['480p', '720p', '1080p'], '720p'), soundOn('audio')],
  },
  {
    id: 'at:seedance-2.0', kind: 'video', task: 'text-to-video', where: 'cloud', provider: 'atlascloud',
    path: 'bytedance/seedance-2.0/text-to-video', name: 'Seedance 2.0', maker: 'ByteDance',
    blurb: 'Film-like motion and sound, 4 to 15 seconds.', badge: 'Best',
    price: { usd: 0.09, per: 'second' },
    license: { name: 'ByteDance Seedance (API only)', commercial: true },
    promptField: 'prompt',
    params: [seconds('duration', range(4, 15), 5), aspect('ratio', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']), soundOn('generate_audio')],
  },
  {
    id: 'ws:kling-3.0-std', kind: 'video', task: 'text-to-video', where: 'cloud', provider: 'wavespeed',
    path: 'kwaivgi/kling-v3.0-std/text-to-video', name: 'Kling 3.0', maker: 'Kuaishou',
    blurb: 'Clean, steady shots, 3 to 15 seconds.',
    price: { usd: 0.084, per: 'second', from: true },
    license: { name: 'Kling (API only)', commercial: true },
    promptField: 'prompt',
    params: [seconds('duration', range(3, 15), 5), aspect('aspect_ratio', ['16:9', '9:16', '1:1']), soundOn('sound', false)],
  },
  {
    id: 'at:kling-3.0-std', kind: 'video', task: 'text-to-video', where: 'cloud', provider: 'atlascloud',
    path: 'kwaivgi/kling-v3.0-std/text-to-video', name: 'Kling 3.0', maker: 'Kuaishou',
    blurb: 'Clean, steady shots, 3 to 15 seconds.',
    price: { usd: 0.071, per: 'second' },
    license: { name: 'Kling (API only)', commercial: true },
    promptField: 'prompt',
    params: [seconds('duration', range(3, 15), 5), aspect('aspect_ratio', ['16:9', '9:16', '1:1']), soundOn('sound', false)],
  },
  {
    id: 'at:veo-3.1-fast', kind: 'video', task: 'text-to-video', where: 'cloud', provider: 'atlascloud',
    path: 'google/veo3.1-fast/text-to-video', name: 'Veo 3.1 Fast', maker: 'Google',
    blurb: "Google's video model, 4 to 8 seconds, up to 4K.",
    price: { usd: 0.08, per: 'second' },
    license: { name: 'Google Veo (API only)', commercial: true },
    promptField: 'prompt',
    params: [seconds('duration', [4, 6, 8], 8), aspect('aspect_ratio', ['16:9', '9:16']),
      resolution('resolution', ['720p', '1080p', '4k'], '720p'), soundOn('generate_audio', false)],
  },
  {
    id: 'local:ltx-2.3-int4', kind: 'video', task: 'text-to-video', where: 'local', runner: 'ltx-2-mlx',
    repo: 'PocketAiHub/LTX-2.3-Distilled-MLX', name: 'LTX-2.3 (4-bit)', maker: 'Lightricks',
    blurb: 'Short, low-resolution clips on a 16 GB Mac.',
    downloadGB: 12, minMemoryGB: 16, recMemoryGB: 24,
    speed: '24 s for a 17-frame 256×256 clip (PocketAI model card)',
    available: false, cloudTwin: 'ws:wan-3.0',
    license: { name: 'LTX-2 Community License', commercial: true },
    promptField: 'prompt', params: [],
  },
  {
    id: 'local:ltx-2.3-int8', kind: 'video', task: 'text-to-video', where: 'local', runner: 'ltx-2-mlx',
    name: 'LTX-2.3 (8-bit)', maker: 'Lightricks',
    blurb: 'Better quality; needs 32 GB.',
    downloadGB: 26, minMemoryGB: 32, recMemoryGB: 48,
    available: false, cloudTwin: 'ws:wan-3.0',
    license: { name: 'LTX-2 Community License', commercial: true },
    promptField: 'prompt', params: [],
  },
  {
    id: 'local:wan-2.2-ti2v-5b', kind: 'video', task: 'text-to-video', where: 'local', runner: 'mlx-video',
    repo: 'Anes1032/Wan2.2-TI2V-5B-mlx-q8', name: 'Wan 2.2 TI2V 5B', maker: 'Alibaba',
    blurb: 'The newest open Wan. Slow on a Mac.',
    downloadGB: 19.6, minMemoryGB: 32, recMemoryGB: 64,
    speed: 'About 15 min for 41 frames at 720p on a 64 GB Mac (model card)',
    available: false, cloudTwin: 'ws:wan-3.0',
    license: { name: 'Apache-2.0', commercial: true },
    promptField: 'prompt', params: [],
  },
  {
    id: 'local:ltx-2.5-q8', kind: 'video', task: 'text-to-video', where: 'local', runner: 'ltx-2-mlx',
    name: 'LTX-2.5 (8-bit)', maker: 'Lightricks',
    blurb: 'Longer clips with sound; a 75 GB download.',
    downloadGB: 75, minMemoryGB: 96, recMemoryGB: 128,
    speed: '563–701 s for 241 frames at 576×1024 on M1 Max (ltx-2-mlx README)',
    available: false, cloudTwin: 'at:seedance-2.0',
    license: { name: 'LTX-2 Community License', commercial: true },
    promptField: 'prompt', params: [],
  },
]

// ── Image (cloud; on-device image models live in the existing image studio) ──

const IMAGE: MediaModel[] = [
  {
    id: 'ws:z-image-turbo', kind: 'image', task: 'text-to-image', where: 'cloud', provider: 'wavespeed',
    path: 'wavespeed-ai/z-image/turbo', name: 'Z-Image Turbo', maker: 'Alibaba Tongyi',
    blurb: 'Fast, sharp images for half a cent.', badge: 'Best value',
    price: { usd: 0.005, per: 'image' }, license: { name: 'Apache-2.0', commercial: true },
    promptField: 'prompt',
    params: [{ key: 'size', field: 'size', type: 'select', options: ['1024*1024', '1024*1536', '1536*1024', '768*1344', '1344*768'], default: '1024*1024', label: 'size' }],
  },
  {
    id: 'ws:nano-banana-2', kind: 'image', task: 'text-to-image', where: 'cloud', provider: 'wavespeed',
    path: 'google/nano-banana-2/text-to-image', name: 'Nano Banana 2', maker: 'Google',
    blurb: 'Follows long prompts and renders text well.', badge: 'Best',
    price: { usd: 0.063, per: 'image' }, license: { name: 'Google (API only)', commercial: true },
    promptField: 'prompt',
    params: [aspect('aspect_ratio', ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']), resolution('resolution', ['1k', '2k', '4k'], '1k')],
  },
  {
    id: 'at:flux-2-pro', kind: 'image', task: 'text-to-image', where: 'cloud', provider: 'atlascloud',
    path: 'black-forest-labs/flux-2-pro/text-to-image', name: 'FLUX.2 Pro', maker: 'Black Forest Labs',
    blurb: 'Photographic detail and skin tones.',
    price: { usd: 0.03, per: 'image' }, license: { name: 'BFL (API only)', commercial: true },
    promptField: 'prompt',
    params: [{ key: 'size', field: 'size', type: 'select', options: ['1024*1024', '1024*1536', '1536*1024'], default: '1024*1024', label: 'size' }],
  },
  {
    id: 'at:z-image-turbo', kind: 'image', task: 'text-to-image', where: 'cloud', provider: 'atlascloud',
    path: 'z-image/turbo', name: 'Z-Image Turbo', maker: 'Alibaba Tongyi',
    blurb: 'Fast, sharp images for half a cent.', badge: 'Best value',
    price: { usd: 0.005, per: 'image' }, license: { name: 'Apache-2.0', commercial: true },
    promptField: 'prompt',
    params: [{ key: 'size', field: 'size', type: 'select', options: ['1024*1024', '1024*1536', '1536*1024'], default: '1024*1024', label: 'size' }],
  },
]

// ── Audio (speech) ──────────────────────────────────────────────────────────

const KOKORO_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis']
const speed: MediaParam = { key: 'speed', field: 'speed', type: 'number', min: 0.5, max: 2, step: 0.1, default: 1, label: 'speed' }

const AUDIO: MediaModel[] = [
  {
    id: 'local:kokoro-82m', kind: 'audio', task: 'text-to-speech', where: 'local', runner: 'mlx-audio',
    repo: 'mlx-community/Kokoro-82M-bf16', name: 'Kokoro', maker: 'hexgrad',
    blurb: 'Natural English voices in a second. Tiny and private.', badge: 'Fast',
    downloadGB: 0.39, minMemoryGB: 8, recMemoryGB: 8, available: true, cloudTwin: 'ws:qwen3-tts',
    license: { name: 'Apache-2.0', commercial: true },
    promptField: 'text',
    params: [{ key: 'voice', field: 'voice', type: 'select', options: KOKORO_VOICES, default: 'af_heart', label: 'voice' }, speed],
  },
  {
    id: 'local:chatterbox-turbo', kind: 'audio', task: 'text-to-speech', where: 'local', runner: 'mlx-audio',
    repo: 'mlx-community/chatterbox-turbo-fp16', name: 'Chatterbox Turbo', maker: 'Resemble AI',
    blurb: 'Expressive speech in many languages.',
    minMemoryGB: 8, recMemoryGB: 16, available: true, cloudTwin: 'at:elevenlabs-v3',
    license: { name: 'MIT', commercial: true },
    promptField: 'text', params: [speed],
  },
  {
    id: 'local:vibevoice-0.5b', kind: 'audio', task: 'text-to-speech', where: 'local', runner: 'mlx-audio',
    repo: 'mlx-community/VibeVoice-Realtime-0.5B-4bit', name: 'VibeVoice Realtime', maker: 'Microsoft',
    blurb: 'Long-form narration with low latency.',
    minMemoryGB: 8, recMemoryGB: 16, available: true,
    license: { name: 'MIT', commercial: true },
    promptField: 'text', params: [],
  },
  {
    id: 'ws:qwen3-tts', kind: 'audio', task: 'text-to-speech', where: 'cloud', provider: 'wavespeed',
    path: 'wavespeed-ai/qwen3-tts/text-to-speech', name: 'Qwen3-TTS', maker: 'Alibaba Qwen',
    blurb: 'Ten languages, nine voices, style instructions.',
    price: { usd: 0.005, per: 'run', from: true },
    license: { name: 'Apache-2.0', commercial: true },
    promptField: 'text',
    params: [
      { key: 'voice', field: 'voice', type: 'select', options: ['Vivian', 'Serena', 'Ono_Anna', 'Sohee', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden'], default: 'Vivian', label: 'voice' },
      { key: 'language', field: 'language', type: 'select', options: ['auto', 'English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Russian'], default: 'auto', label: 'language' },
    ],
  },
  {
    id: 'at:elevenlabs-v3', kind: 'audio', task: 'text-to-speech', where: 'cloud', provider: 'atlascloud',
    path: 'elevenlabs/v3/text-to-speech', name: 'ElevenLabs v3', maker: 'ElevenLabs',
    blurb: 'The most lifelike voices, with emotion tags.', badge: 'Best',
    price: { usd: 0.10, per: '1k-chars' }, license: { name: 'ElevenLabs (API only)', commercial: true },
    promptField: 'text', params: [],
  },
  {
    id: 'ws:elevenlabs-v3', kind: 'audio', task: 'text-to-speech', where: 'cloud', provider: 'wavespeed',
    path: 'elevenlabs/eleven-v3', name: 'ElevenLabs v3', maker: 'ElevenLabs',
    blurb: 'The most lifelike voices, with emotion tags.', badge: 'Best',
    price: { usd: 0.20, per: '1k-chars' }, license: { name: 'ElevenLabs (API only)', commercial: true },
    promptField: 'text', fixed: { voice_id: 'Alicia' }, params: [],
  },
]

// ── Music ───────────────────────────────────────────────────────────────────

const MUSIC: MediaModel[] = [
  {
    id: 'ws:ace-step-1.5', kind: 'music', task: 'song', where: 'cloud', provider: 'wavespeed',
    path: 'wavespeed-ai/ace-step-1.5', name: 'ACE-Step 1.5', maker: 'ACE Studio · StepFun',
    blurb: 'Full songs with vocals from a style and lyrics.', badge: 'Best value',
    price: { usd: 0.0003, per: 'second' }, license: { name: 'MIT', commercial: true },
    promptField: 'tags', lyricsField: 'lyrics',
    params: [{ key: 'duration', field: 'duration', type: 'number', min: 5, max: 240, step: 5, default: 60, label: 'duration', unit: 's' }],
  },
  {
    id: 'at:minimax-music-3', kind: 'music', task: 'song', where: 'cloud', provider: 'atlascloud',
    path: 'minimax/music-3.0', name: 'MiniMax Music 3.0', maker: 'MiniMax',
    blurb: 'Radio-ready songs, vocals or instrumental.', badge: 'Best',
    price: { usd: 0.15, per: 'song' }, license: { name: 'MiniMax (API only)', commercial: true },
    promptField: 'prompt', lyricsField: 'lyrics', fixed: { format: 'mp3' },
    params: [{ key: 'instrumental', field: 'is_instrumental', type: 'toggle', default: false, label: 'instrumental' }],
  },
  {
    id: 'ws:elevenlabs-music', kind: 'music', task: 'song', where: 'cloud', provider: 'wavespeed',
    path: 'elevenlabs/music', name: 'ElevenLabs Music', maker: 'ElevenLabs',
    blurb: 'Soundtracks and songs from a description.',
    price: { usd: 0.01, per: 'second' },
    license: { name: 'ElevenLabs (API only)', commercial: true },
    promptField: 'prompt',
    params: [
      { key: 'duration', field: 'music_length_ms', type: 'select', options: [10000, 30000, 60000, 120000, 180000], default: 30000, label: 'duration' },
      { key: 'instrumental', field: 'force_instrumental', type: 'toggle', default: true, label: 'instrumental' },
    ],
  },
  {
    id: 'local:ace-step-1.5-turbo', kind: 'music', task: 'song', where: 'local', runner: 'ace-step',
    name: 'ACE-Step 1.5 Turbo', maker: 'ACE Studio · StepFun',
    blurb: 'Songs with vocals on a 16 GB Mac.',
    minMemoryGB: 16, recMemoryGB: 32,
    speed: '200 s of music in 58.5 s on M1 Max 64 GB (dev.to, Jul 2026)',
    available: false, cloudTwin: 'ws:ace-step-1.5',
    license: { name: 'MIT', commercial: true },
    promptField: 'tags', lyricsField: 'lyrics', params: [],
  },
  {
    id: 'local:minimax-music-3-4bit', kind: 'music', task: 'song', where: 'local', runner: 'mlx-audio',
    repo: 'mlx-community/MiniMax-Music3-4bit', name: 'MiniMax Music 3 (4-bit)', maker: 'MiniMax',
    blurb: 'Open-weight songs; needs a newer mlx-audio.',
    downloadGB: 9.2, minMemoryGB: 24, recMemoryGB: 32,
    available: false, cloudTwin: 'at:minimax-music-3',
    license: { name: 'MiniMax Music3 Community License', commercial: false },
    promptField: 'prompt', lyricsField: 'lyrics', params: [],
  },
]

export const MEDIA_MODELS: readonly MediaModel[] = [...IMAGE, ...VIDEO, ...AUDIO, ...MUSIC]

export function mediaModel(id: string | null | undefined): MediaModel | undefined {
  return id ? MEDIA_MODELS.find(m => m.id === id) : undefined
}

export function modelsFor(kind: MediaKind): MediaModel[] {
  return MEDIA_MODELS.filter(m => m.kind === kind)
}

/** The provider's display name (also an i18n-free brand). */
export const MEDIA_PROVIDER_NAMES: Record<MediaProviderId, string> = {
  wavespeed: 'WaveSpeed AI',
  atlascloud: 'Atlas Cloud',
}

/** Default values for a model's controls. */
export function defaultParams(model: MediaModel): Record<string, string | number | boolean> {
  return Object.fromEntries(model.params.map(p => [p.key, p.default]))
}

/**
 * The price of one run with these settings, in USD, when it can be known
 * from the list price (per second × duration, per 1K characters × text).
 */
export function estimateCost(model: MediaModel, values: Record<string, unknown>, text = ''): number | undefined {
  if (model.where !== 'cloud' || !model.price) return undefined
  const { usd, per } = model.price
  if (per === 'image' || per === 'run' || per === 'song') return usd
  if (per === '1k-chars') return text ? usd * Math.max(1, Math.ceil(text.length / 1000)) : usd
  const duration = Number(values.duration)
  if (!Number.isFinite(duration) || duration <= 0) return undefined
  // ElevenLabs-style lengths are in milliseconds.
  const secondsOut = duration > 1000 ? duration / 1000 : duration
  const rate = model.price.byResolution?.[String(values.resolution)] ?? usd
  return rate * secondsOut
}
