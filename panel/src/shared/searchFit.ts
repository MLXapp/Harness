/**
 * Will a Hugging Face search result fit this Mac? The same rule as the
 * curated picks (shared/curated.ts fitFor): weights up to 60% of memory run
 * well, up to 75% run close to the limit, more doesn't fit. Size comes from
 * the repo's safetensors metadata (no download); unknown size → no badge.
 */
export type SearchFit = 'good' | 'tight' | 'no'

export function searchFit(sizeBytes: number | undefined, memoryGB: number | undefined): SearchFit | null {
  if (!sizeBytes || !(sizeBytes > 0) || !memoryGB || !(memoryGB > 0)) return null
  const gb = sizeBytes / 1024 ** 3
  if (gb <= memoryGB * 0.6) return 'good'
  if (gb <= memoryGB * 0.75) return 'tight'
  return 'no'
}

/** Memory a Mac needs for this model to run well (for "needs N GB"). */
export function memoryToRunWell(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 1024 ** 3 / 0.6)
}
