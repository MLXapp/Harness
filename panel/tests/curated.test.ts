import { describe, expect, it } from 'vitest'
import {
  FEATURED_ACCOUNTS, FEATURED_CLOUD_MODELS, LOCAL_PICKS, fitFor, isChatModelRepo,
  localPicksFor, reachableFeaturedModels,
} from '../src/shared/curated'
import { catalogProvider } from '../src/shared/providers/catalog'
import { IMAGE_MODELS } from '../src/shared/imageModels'

describe('curated accounts and models', () => {
  it('offers exactly the five featured accounts, each backed by a catalog provider with an https key page', () => {
    expect(FEATURED_ACCOUNTS.map(a => a.name)).toEqual(['DeepSeek', 'Claude', 'OpenAI', 'Gemini', 'WaveSpeed AI'])
    for (const a of FEATURED_ACCOUNTS) {
      expect(catalogProvider(a.catalogId)).toBeTruthy()
      expect(new URL(a.keyUrl).protocol).toBe('https:')
    }
  })

  it('pins the featured cloud model ids checked against the providers on 20 Oct 2026', () => {
    expect(FEATURED_CLOUD_MODELS.map(m => `${m.account}:${m.modelId}${m.effort ? '@' + m.effort : ''}`)).toEqual([
      'anthropic:claude-opus-5-5@high',
      'deepseek:deepseek-v4-pro@max',
      'deepseek:deepseek-flash',
      'openai:gpt-6-astra@high',
      'google:gemini-4-argon',
    ])
  })

  it('routes featured models natively first, else through WaveSpeed', () => {
    expect(reachableFeaturedModels(new Set())).toEqual([])
    const viaWs = reachableFeaturedModels(new Set(['wavespeed']))
    expect(viaWs).toHaveLength(5)
    expect(viaWs.every(r => r.via === 'wavespeed' && r.providerId === 'wavespeed')).toBe(true)
    const mixed = reachableFeaturedModels(new Set(['deepseek', 'wavespeed']))
    expect(mixed.find(r => r.model.key === 'deepseek-flash')).toMatchObject({ via: 'native', modelId: 'deepseek-flash' })
    expect(mixed.find(r => r.model.key === 'claude-opus-5-5')).toMatchObject({ via: 'wavespeed', modelId: 'anthropic/claude-opus-5.5' })
    expect(reachableFeaturedModels(new Set(['anthropic'])).map(r => r.model.key)).toEqual(['claude-opus-5-5'])
  })

  it('recommends bigger local models for bigger Macs, never one that does not fit', () => {
    for (const mem of [8, 16, 18, 24, 36, 48, 64, 96, 128, 192, 512]) {
      const picks = localPicksFor(mem)
      expect(picks.length).toBeGreaterThan(0)
      for (const p of picks) expect(fitFor(p, mem)).not.toBe('no')
      expect(new Set(picks.map(p => p.repo)).size).toBe(picks.length)
    }
    const chat = (mem: number) => localPicksFor(mem).filter(p => p.purpose === 'chat')[0].repo
    expect(chat(16)).toBe('mlx-community/Qwen3.5-9B-4bit')
    expect(chat(36)).toBe('mlx-community/Qwen3.8-27B-4bit')
    expect(chat(128)).toBe('mlx-community/gpt-oss-120b-MXFP4-Q8')
    expect(localPicksFor(36).filter(p => p.purpose === 'code')[0].repo).toBe('mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit')
  })

  it('image picks point at real image model definitions and their download repos', () => {
    for (const p of LOCAL_PICKS.filter(p => p.purpose === 'image')) {
      const def = IMAGE_MODELS.find(m => m.id === p.imageModelId)
      expect(def, p.imageModelId).toBeTruthy()
      expect(Object.values(def!.repoMap)).toContain(p.repo)
    }
  })

  it('keeps voice and image repos out of chat pickers', () => {
    expect(isChatModelRepo('mlx-community/whisper-large-v3-turbo')).toBe(false)
    expect(isChatModelRepo('mlx-community/Kokoro-82M-bf16')).toBe(false)
    expect(isChatModelRepo('filipstrand/Z-Image-Turbo-mflux-4bit')).toBe(false)
    expect(isChatModelRepo('mlx-community/Qwen3.5-9B-4bit')).toBe(true)
  })
})
