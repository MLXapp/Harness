/**
 * Turn Flash MoE (expert streaming from the SSD) on by itself for a mixture-
 * of-experts text model whose files are too big to sit comfortably in this
 * Mac's memory. Since 0.5.3 the engine streams experts from the moment such a
 * model loads, so it starts instead of pushing the Mac into swap.
 *
 * Only architectures the engine streams exactly from load qualify
 * (STREAM_FROM_LOAD_MODEL_TYPES); JANG bundles (their own eager loader),
 * multimodal models, DSV4 and anything else keep loading as before. The
 * session setting "Turn on by itself" (flashMoeAuto, on by default) opts out.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { STREAM_FROM_LOAD_MODEL_TYPES } from '../shared/flashMoeLaunch'

/** Above this share of memory a listed MoE model streams (about where Metal's working-set limit sits). */
export const AUTO_STREAM_SHARE = 0.75

/** Same files vmlx_engine's is_jang_model looks for. */
const JANG_CONFIG_FILES = ['jang_config.json', 'jjqf_config.json', 'jang_cfg.json']

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Whether config.json names an architecture that streams exactly from load. */
export function streamsFromLoad(config: Record<string, any> | null): boolean {
  if (!config) return false
  const types: readonly string[] = STREAM_FROM_LOAD_MODEL_TYPES
  return [config, config.text_config].some(scope => scope && types.includes(String(scope.model_type)))
}

export interface AutoStreamInput {
  modelPath: string
  modelFileBytes: number
  totalBytes: number
  /** The user turned Flash MoE on (nothing to decide). */
  requested: boolean
  /** The user turned the automatic switch off. */
  optedOut: boolean
  /** Paths that can't stream from load: image, multimodal, smelt, distributed, DSV4. */
  excluded: boolean
}

export function shouldAutoStreamExperts(input: AutoStreamInput): boolean {
  if (input.requested || input.optedOut || input.excluded) return false
  if (!(input.modelFileBytes > 0) || !(input.totalBytes > 0)) return false
  if (input.modelFileBytes <= input.totalBytes * AUTO_STREAM_SHARE) return false
  if (JANG_CONFIG_FILES.some(name => existsSync(join(input.modelPath, name)))) return false
  return streamsFromLoad(readJson(join(input.modelPath, 'config.json')))
}

/**
 * The model-side half of the decision (listed architecture, not JANG, files
 * over 75% of memory), for the command preview; the session settings decide
 * the rest the same way buildArgs does.
 */
export function autoStreamCandidate(modelPath: string, modelFileBytes: number, totalBytes: number): boolean {
  return shouldAutoStreamExperts({ modelPath, modelFileBytes, totalBytes, requested: false, optedOut: false, excluded: false })
}

export { launchSlotBank, raisePrefillStepForStreaming } from '../shared/flashMoeLaunch'
