/**
 * Flash MoE launch values shared by the engine launch (main) and the command
 * preview (renderer), so both show the same command.
 */

/** 256 was the fixed slot count before 0.5.3; a session that never moved the slider gets the automatic size. */
export const LEGACY_DEFAULT_SLOT_BANK = 256

export const DEFAULT_PREFILL_STEP_SIZE = 2048
/** Streaming reads each needed expert once per prompt chunk, so bigger chunks read the SSD less. */
export const FLASH_MOE_PREFILL_STEP_SIZE = 4096

/**
 * Architectures whose experts stream exactly from the moment they load, and
 * that Flash MoE turns on for by itself (softmax top-k routing, checked
 * against the resident model). Keep equal to STREAM_FROM_LOAD_MODEL_TYPES in
 * vmlx_engine/flash_moe_config.py.
 */
export const STREAM_FROM_LOAD_MODEL_TYPES = ['qwen3_moe', 'qwen3_next', 'mixtral'] as const

/**
 * The slot count to pass, or null for the engine's automatic (memory-sized)
 * cache. `chosen` is set when the user moved the slider; before 0.5.3 every
 * session saved 256, which then means "never chosen".
 */
export function launchSlotBank(value: unknown, chosen?: unknown): number | null {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return null
  if (n === LEGACY_DEFAULT_SLOT_BANK && chosen !== true) return null
  return n
}

/**
 * Raise the default prompt chunk (2048) to 4096 while experts stream (Strata
 * measured 700 → 1,100 prompt tok/s on a Mac). Other sizes stay as set.
 */
export function raisePrefillStepForStreaming(args: string[]): void {
  const at = args.indexOf('--prefill-step-size')
  if (at >= 0 && args[at + 1] === String(DEFAULT_PREFILL_STEP_SIZE)) {
    args[at + 1] = String(FLASH_MOE_PREFILL_STEP_SIZE)
  }
}
