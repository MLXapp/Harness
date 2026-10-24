/**
 * Turn Flash MoE (expert streaming from the SSD) on by itself for a mixture-
 * of-experts text model whose files are too big to sit comfortably in this
 * Mac's memory. Since 0.5.3 the engine streams experts from the moment the
 * model loads, so such a model starts instead of pushing the Mac into swap.
 *
 * Only the engine's generic mlx-lm text path loads lazily, so JANG bundles,
 * multimodal models, DSV4 (its own expert hydration) and JANGTQ stay out.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** Above this share of memory, a MoE model's experts stream (Strata's ~75% line). */
export const AUTO_STREAM_SHARE = 0.75

const EXPERT_KEYS = ['num_experts', 'n_routed_experts', 'num_local_experts', 'moe_num_experts', 'num_experts_per_layer']

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Number of routed experts per layer from config.json, 0 for a dense model. */
export function routedExpertCount(config: Record<string, any> | null): number {
  if (!config) return 0
  for (const scope of [config, config.text_config, config.language_config, config.llm_config]) {
    if (!scope || typeof scope !== 'object') continue
    for (const key of EXPERT_KEYS) {
      const n = Number(scope[key])
      if (Number.isFinite(n) && n > 1) return n
    }
  }
  return 0
}

export interface AutoStreamInput {
  modelPath: string
  modelFileBytes: number
  totalBytes: number
  /** The user turned Flash MoE on (nothing to decide). */
  requested: boolean
  /** Paths that can't stream from load: multimodal, smelt, distributed, DSV4. */
  excluded: boolean
}

export function shouldAutoStreamExperts(input: AutoStreamInput): boolean {
  if (input.requested || input.excluded) return false
  if (!(input.modelFileBytes > 0) || !(input.totalBytes > 0)) return false
  if (input.modelFileBytes <= input.totalBytes * AUTO_STREAM_SHARE) return false
  // JANG bundles load through their own loader (not lazily); JANGTQ can't stream.
  if (existsSync(join(input.modelPath, 'jang_config.json'))) return false
  return routedExpertCount(readJson(join(input.modelPath, 'config.json'))) > 0
}

export { explicitSlotBank, raisePrefillStepForStreaming } from '../shared/flashMoeLaunch'
