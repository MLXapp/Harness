/**
 * Flash MoE launch values shared by the engine launch (main) and the command
 * preview (renderer), so both show the same command.
 */

/** 256 was the fixed slot count before 0.5.3; a session still holding it gets the automatic size. */
export const LEGACY_DEFAULT_SLOT_BANK = 256

export const DEFAULT_PREFILL_STEP_SIZE = 2048
/** Streaming reads each needed expert once per prompt chunk, so bigger chunks read the SSD less. */
export const FLASH_MOE_PREFILL_STEP_SIZE = 4096

/** The slot count to pass, or null for the engine's automatic (memory-sized) cache. */
export function explicitSlotBank(value: unknown): number | null {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0 || n === LEGACY_DEFAULT_SLOT_BANK) return null
  return n
}

/**
 * Raise a default prompt chunk (2048) to 4096 while experts stream (Strata
 * measured 700 → 1,100 prompt tok/s on a Mac). A size the user chose stays.
 */
export function raisePrefillStepForStreaming(args: string[]): void {
  const at = args.indexOf('--prefill-step-size')
  if (at >= 0 && args[at + 1] === String(DEFAULT_PREFILL_STEP_SIZE)) {
    args[at + 1] = String(FLASH_MOE_PREFILL_STEP_SIZE)
  }
}
