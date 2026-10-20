/** What first-run setup knows about this Mac (main: src/main/hardware.ts). */
export interface HardwareInfo {
  /** "Apple M3 Pro"; "Apple silicon" when the chip could not be read. */
  chip: string
  /** "MacBook Pro", when macOS says. */
  modelName?: string
  /** Unified memory in GB. */
  memoryGB: number
  /** Free space where models are downloaded (or the home folder), in GB. */
  freeDiskGB?: number
}

/** The parts of the one-line summary, in order: model · chip · memory · free disk. */
export function hardwareParts(
  hw: HardwareInfo,
  t: (key: string, params?: Record<string, string | number>) => string,
): string[] {
  return [
    ...(hw.modelName ? [hw.modelName] : []),
    hw.chip,
    t('onboarding.mac.memory', { gb: hw.memoryGB }),
    ...(hw.freeDiskGB !== undefined ? [t('onboarding.mac.free', { gb: hw.freeDiskGB })] : []),
  ]
}
