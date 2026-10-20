/**
 * The short, curated lists MLX Harness shows by default: the five accounts
 * people actually connect, the handful of cloud models worth picking, and the
 * local models recommended for this Mac's memory.
 *
 * Everything else stays reachable ("Other provider…", "More models", search),
 * but nothing else is shown up front.
 *
 * Facts checked against the providers' own docs on 20 Oct 2026:
 *  - DeepSeek: api-docs.deepseek.com (models & pricing, 1017 release note).
 *    "V4 Pro Max" is deepseek-v4-pro at reasoning_effort "max" (DeepSeek's
 *    model card name); "Flash 1017" is served as deepseek-flash.
 *  - Anthropic: platform.claude.com/docs (models overview, pricing).
 *  - OpenAI: developers.openai.com/api/docs/models/gpt-6-astra, pricing.
 *  - Google: ai.google.dev/gemini-api/docs/models + pricing (Argon promo
 *    price until 30 Nov 2026).
 *  - WaveSpeed AI: wavespeed.ai/docs (LLM gateway llm.wavespeed.ai/v1, media
 *    API api.wavespeed.ai/api/v3).
 *  - Local repos: Hugging Face API (all mlx-community ids below exist);
 *    download sizes from the repos' file listings.
 * Prices change: they are shown as "from", per 1M tokens, and only where a
 * provider publishes them. Re-check when a provider ships a new model.
 */

import type { ProviderReasoningLevel } from './providers/types'

// ── Accounts ────────────────────────────────────────────────────────────────

export type FeaturedAccountId = 'deepseek' | 'anthropic' | 'openai' | 'google' | 'wavespeed'

export interface FeaturedAccount {
  id: FeaturedAccountId
  /** Id in PROVIDER_CATALOG (the saved provider uses this id). */
  catalogId: string
  /** Name people know the service by. */
  name: string
  /** Who runs it (shown small, under the name in sheets). */
  company: string
  /** One line: what it is good for. */
  tagline: string
  /** Where the user creates an API key. */
  keyUrl: string
  keySiteName: string
  /** Typical key prefix, used only to hint that a pasted key looks right. */
  keyPrefix?: string
  /** Tile colour for the monogram (no third-party logos are drawn). */
  tint: string
  monogram: string
}

export const FEATURED_ACCOUNTS: readonly FeaturedAccount[] = [
  {
    id: 'deepseek',
    catalogId: 'deepseek',
    name: 'DeepSeek',
    company: 'DeepSeek',
    tagline: 'Strong coding and reasoning at a very low price.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keySiteName: 'DeepSeek Platform',
    keyPrefix: 'sk-',
    tint: '#4D6BFE',
    monogram: 'D',
  },
  {
    id: 'anthropic',
    catalogId: 'anthropic',
    name: 'Claude',
    company: 'Anthropic',
    tagline: 'The best model for hard work, long documents and coding.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keySiteName: 'Claude Console',
    keyPrefix: 'sk-ant-',
    tint: '#D97757',
    monogram: 'C',
  },
  {
    id: 'openai',
    catalogId: 'openai',
    name: 'OpenAI',
    company: 'OpenAI',
    tagline: 'GPT models for everyday work and code.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keySiteName: 'OpenAI Platform',
    keyPrefix: 'sk-',
    tint: '#10A37F',
    monogram: 'O',
  },
  {
    id: 'google',
    catalogId: 'google',
    name: 'Gemini',
    company: 'Google',
    tagline: 'Very long context, images and video.',
    keyUrl: 'https://aistudio.google.com/api-keys',
    keySiteName: 'Google AI Studio',
    keyPrefix: 'AIza',
    tint: '#4285F4',
    monogram: 'G',
  },
  {
    id: 'wavespeed',
    catalogId: 'wavespeed',
    name: 'WaveSpeed AI',
    company: 'WaveSpeed AI',
    tagline: 'One key for the top chat models, plus images, video and music.',
    keyUrl: 'https://wavespeed.ai/accesskey',
    keySiteName: 'WaveSpeed AI',
    tint: '#7C3AED',
    monogram: 'W',
  },
]

export function featuredAccount(id: string): FeaturedAccount | undefined {
  return FEATURED_ACCOUNTS.find(a => a.id === id || a.catalogId === id)
}

// ── Cloud models ────────────────────────────────────────────────────────────

export type Purpose = 'chat' | 'code' | 'image' | 'video' | 'music'

export interface FeaturedCloudModel {
  /** Stable id for settings and tests. */
  key: string
  name: string
  /** Short line under the name. */
  blurb: string
  /** Where it is served natively, and the API id there. */
  account: FeaturedAccountId
  modelId: string
  /** Reasoning effort to use by default (e.g. DeepSeek "Pro Max" = max). */
  effort?: ProviderReasoningLevel
  /** Same model through WaveSpeed's LLM gateway, for people who only have that key. */
  wavespeedId?: string
  /** USD per 1M tokens, as published (input / output). */
  price?: { input: number; output: number; note?: string }
  badge?: 'Best' | 'Best value' | 'Fast'
  purposes: Purpose[]
}

export const FEATURED_CLOUD_MODELS: readonly FeaturedCloudModel[] = [
  {
    key: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    blurb: 'Best for hard tasks and code',
    account: 'anthropic',
    modelId: 'claude-opus-5-5',
    effort: 'high',
    wavespeedId: 'anthropic/claude-opus-5.5',
    price: { input: 4, output: 20 },
    badge: 'Best',
    purposes: ['chat', 'code'],
  },
  {
    key: 'deepseek-v4-pro-max',
    name: 'DeepSeek V4 Pro Max',
    blurb: 'Top quality, low price',
    account: 'deepseek',
    modelId: 'deepseek-v4-pro',
    effort: 'max',
    wavespeedId: 'deepseek/deepseek-v4-pro-0813',
    price: { input: 0.66, output: 1.98, note: 'off-peak; double at peak hours' },
    badge: 'Best value',
    purposes: ['chat', 'code'],
  },
  {
    key: 'deepseek-flash',
    name: 'DeepSeek Flash',
    blurb: 'V4.1 Flash 1017, very cheap',
    account: 'deepseek',
    modelId: 'deepseek-flash',
    wavespeedId: 'deepseek/deepseek-v4.1-flash-1017',
    price: { input: 0.15, output: 0.6, note: 'off-peak; double at peak hours' },
    badge: 'Fast',
    purposes: ['chat', 'code'],
  },
  {
    key: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    blurb: "OpenAI's most capable model",
    account: 'openai',
    modelId: 'gpt-6-astra',
    effort: 'high',
    wavespeedId: 'openai/gpt-6-astra',
    price: { input: 10, output: 50 },
    purposes: ['chat', 'code'],
  },
  {
    key: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    blurb: "Google's flagship",
    account: 'google',
    modelId: 'gemini-4-argon',
    wavespeedId: 'google/gemini-4-argon',
    price: { input: 2, output: 10, note: 'until 30 Nov 2026, then $4 / $20' },
    purposes: ['chat', 'code'],
  },
]

/** Featured models a set of connected accounts can reach, best route first. */
export function reachableFeaturedModels(
  connected: ReadonlySet<string>,
): { model: FeaturedCloudModel; providerId: string; modelId: string; via: 'native' | 'wavespeed' }[] {
  const out: { model: FeaturedCloudModel; providerId: string; modelId: string; via: 'native' | 'wavespeed' }[] = []
  for (const model of FEATURED_CLOUD_MODELS) {
    const native = featuredAccount(model.account)!
    if (connected.has(native.catalogId)) {
      out.push({ model, providerId: native.catalogId, modelId: model.modelId, via: 'native' })
    } else if (model.wavespeedId && connected.has('wavespeed')) {
      out.push({ model, providerId: 'wavespeed', modelId: model.wavespeedId, via: 'wavespeed' })
    }
  }
  return out
}

/** Media models on WaveSpeed's API, for the Image / Video / Music tabs. */
export interface FeaturedMediaModel {
  name: string
  purpose: 'image' | 'video' | 'music'
  wavespeedId: string
  price: string
}

export const FEATURED_MEDIA_MODELS: readonly FeaturedMediaModel[] = [
  { name: 'GPT Image 2.5', purpose: 'image', wavespeedId: 'openai/gpt-image-2.5-sunburst/text-to-image', price: 'from $0.01 / image' },
  { name: 'Nano Banana 2.1', purpose: 'image', wavespeedId: 'google/nano-banana-2.1/text-to-image', price: '$0.04 / image' },
  { name: 'Seedream 5 Pro', purpose: 'image', wavespeedId: 'bytedance/seedream-v5.0-pro', price: '$0.045 / image' },
  { name: 'FLUX 3', purpose: 'image', wavespeedId: 'black-forest-labs/flux-3/text-to-image', price: '$0.05 / image' },
  { name: 'Seedance 2.5', purpose: 'video', wavespeedId: 'bytedance/seedance-2.5/text-to-video', price: 'from $0.36 / second' },
  { name: 'Gemini Omni Flash', purpose: 'video', wavespeedId: 'google/gemini-omni-1.1-flash/text-to-video', price: '$0.10 / second' },
  { name: 'Kling 3.0 Pro', purpose: 'video', wavespeedId: 'kwaivgi/kling-v3.0-pro/text-to-video', price: '$0.84 / 5 s' },
  { name: 'Wan 3.0', purpose: 'video', wavespeedId: 'alibaba/wan-3.0/text-to-video', price: '$0.10 / second' },
  { name: 'Lyria 3.5', purpose: 'music', wavespeedId: 'google/lyria-3.5/music', price: '$0.10 / song' },
  { name: 'MiniMax Music 3', purpose: 'music', wavespeedId: 'minimax/music-3.0', price: '$0.15 / song' },
  { name: 'ElevenLabs Music', purpose: 'music', wavespeedId: 'elevenlabs/music-v2.5', price: '$0.75 / minute' },
]

// ── Local models for this Mac ──────────────────────────────────────────────

export interface LocalPick {
  /** Hugging Face repo to download. */
  repo: string
  name: string
  blurb: string
  purpose: 'chat' | 'code' | 'image'
  /** Download size in GB (from the repo's files). */
  sizeGB: number
  /**
   * Memory the model needs to run comfortably (weights + context + the rest
   * of macOS). Defaults to sizeGB / 0.6 for text models; image models give it
   * explicitly because their peak memory is far above the file size.
   */
  needsGB?: number
  /** For image picks: id in IMAGE_MODELS. */
  imageModelId?: string
}

/**
 * Best first within each purpose. The picker walks the list and keeps the
 * first models that fit, so a bigger Mac gets the bigger models.
 */
export const LOCAL_PICKS: readonly LocalPick[] = [
  // Chat
  { purpose: 'chat', repo: 'mlx-community/Qwen3.8-Flash-Next-4bit', name: 'Qwen 3.8 Flash Next', blurb: 'Very large and fast (mixture of experts)', sizeGB: 111.5 },
  { purpose: 'chat', repo: 'mlx-community/gpt-oss-120b-MXFP4-Q8', name: 'gpt-oss 120B', blurb: "OpenAI's open model, strong reasoning", sizeGB: 63.4 },
  { purpose: 'chat', repo: 'mlx-community/Qwen3.8-27B-8bit', name: 'Qwen 3.8 27B (8-bit)', blurb: 'Excellent all-rounder, higher precision', sizeGB: 29.5 },
  { purpose: 'chat', repo: 'mlx-community/Qwen3.8-27B-4bit', name: 'Qwen 3.8 27B', blurb: 'Excellent all-rounder', sizeGB: 16.1 },
  { purpose: 'chat', repo: 'mlx-community/gemma-4-26b-a4b-it-4bit', name: 'Gemma 4 26B', blurb: "Google's open model, fast", sizeGB: 15.4 },
  { purpose: 'chat', repo: 'mlx-community/Qwen3.5-9B-4bit', name: 'Qwen 3.5 9B', blurb: 'Smart and quick on any Mac with 16 GB', sizeGB: 6.0 },
  { purpose: 'chat', repo: 'mlx-community/gemma-4-12B-it-4bit', name: 'Gemma 4 12B', blurb: "Google's open model", sizeGB: 6.8 },
  { purpose: 'chat', repo: 'mlx-community/Qwen3.5-4B-4bit', name: 'Qwen 3.5 4B', blurb: 'Small and fast', sizeGB: 3.1 },
  { purpose: 'chat', repo: 'mlx-community/gemma-4-e2b-it-4bit', name: 'Gemma 4 E2B', blurb: 'Tiny, for 8 GB Macs', sizeGB: 3.6 },
  { purpose: 'chat', repo: 'mlx-community/Qwen3.5-2B-4bit', name: 'Qwen 3.5 2B', blurb: 'Smallest useful model', sizeGB: 1.7 },
  // Code
  { purpose: 'code', repo: 'mlx-community/Qwen3-Coder-Next-8bit', name: 'Qwen3 Coder Next (8-bit)', blurb: 'Best local coding agent', sizeGB: 84.7 },
  { purpose: 'code', repo: 'mlx-community/Qwen3-Coder-Next-4bit', name: 'Qwen3 Coder Next', blurb: 'Best local coding agent', sizeGB: 44.9 },
  { purpose: 'code', repo: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit', name: 'Qwen3 Coder 30B', blurb: 'Fast coding agent', sizeGB: 17.2 },
  { purpose: 'code', repo: 'mlx-community/Devstral-Small-2-24B-Instruct-2512-4bit', name: 'Devstral Small 2', blurb: "Mistral's coding agent", sizeGB: 15.1 },
  { purpose: 'code', repo: 'mlx-community/gpt-oss-20b-MXFP4-Q8', name: 'gpt-oss 20B', blurb: 'Good at tools and code', sizeGB: 12.1 },
  { purpose: 'code', repo: 'mlx-community/Qwen3.5-9B-4bit', name: 'Qwen 3.5 9B', blurb: 'Capable helper for small Macs', sizeGB: 6.0 },
  { purpose: 'code', repo: 'mlx-community/Qwen3.5-4B-4bit', name: 'Qwen 3.5 4B', blurb: 'Small and fast', sizeGB: 3.1 },
  // Images (mflux)
  { purpose: 'image', imageModelId: 'qwen-image-2.1', repo: 'Qwen/Qwen-Image-2.1', name: 'Qwen Image 2.1', blurb: 'Best local image quality and text in images', sizeGB: 41, needsGB: 64 },
  { purpose: 'image', imageModelId: 'klein-9b', repo: 'black-forest-labs/FLUX.2-klein-9B', name: 'FLUX.2 Klein 9B', blurb: 'High quality, edits too', sizeGB: 18, needsGB: 32 },
  { purpose: 'image', imageModelId: 'z-image-turbo', repo: 'filipstrand/Z-Image-Turbo-mflux-4bit', name: 'Z-Image Turbo', blurb: 'Fast, 4 steps', sizeGB: 6, needsGB: 16 },
  { purpose: 'image', imageModelId: 'klein-4b', repo: 'RunPod/FLUX.2-klein-4B-mflux-4bit', name: 'FLUX.2 Klein 4B', blurb: 'Small and fast', sizeGB: 4.6, needsGB: 8 },
]

export type FitLevel = 'good' | 'tight' | 'no'

/**
 * How well a pick fits this Mac. macOS keeps ~25% of memory for itself and
 * apps; text models also need room for context.
 *  good  — needs ≤ total memory (needsGB), i.e. weights ≤ 60% of memory
 *  tight — weights ≤ 75% of memory
 */
export function fitFor(pick: LocalPick, memoryGB: number): FitLevel {
  if (pick.needsGB !== undefined) {
    if (memoryGB >= pick.needsGB) return 'good'
    return 'no'
  }
  if (pick.sizeGB <= memoryGB * 0.6) return 'good'
  if (pick.sizeGB <= memoryGB * 0.75) return 'tight'
  return 'no'
}

/**
 * The recommended local models for a Mac with `memoryGB` of memory: up to
 * `perPurpose` per purpose, best that fits well first (a "tight" model only
 * when nothing better fits well), no repo twice.
 */
export function localPicksFor(memoryGB: number, perPurpose = 2): LocalPick[] {
  const out: LocalPick[] = []
  const used = new Set<string>()
  for (const purpose of ['chat', 'code', 'image'] as const) {
    const list = LOCAL_PICKS.filter(p => p.purpose === purpose && !used.has(p.repo))
    const good = list.filter(p => fitFor(p, memoryGB) === 'good')
    const tight = list.filter(p => fitFor(p, memoryGB) === 'tight')
    const chosen = [...good, ...tight].slice(0, perPurpose)
    for (const pick of chosen) {
      used.add(pick.repo)
      out.push(pick)
    }
  }
  return out
}

/** Repos that are not chat models (voice, image, embeddings…), kept out of chat pickers. */
export function isChatModelRepo(repo: string): boolean {
  const r = repo.toLowerCase()
  return !/(whisper|parakeet|kokoro|tts|stt|voxtral-asr|sam-audio|chatterbox|vibevoice|voxcpm|embed|rerank|flux|z-image|qwen-image|stable-diffusion|sdxl|mflux|seedvr|ideogram)/.test(r)
}
