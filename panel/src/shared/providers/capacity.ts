/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx).
 *
 * Typed model capacities: `256K` or `1M` instead of counting zeroes. Decimal
 * suffixes (1M = 1000K), matching how providers quote context windows.
 */

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i
const CAPACITY_SCALE = { k: 1_000, m: 1_000_000 } as const

/** The count; `undefined` when blank, `NaN` when unreadable. */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim().replace(/[,_\s]/g, '')
  if (trimmed.length === 0) return undefined
  const match = CAPACITY_PATTERN.exec(trimmed)
  if (match === null) return Number.NaN
  const suffix = match[2]?.toLowerCase()
  const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
  const scaled = Number(match[1]) * scale
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/** The shortest spelling that parses back to the same count. */
export function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`
  if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`
  return String(value)
}

/** A usable capacity: a positive whole number. */
export function isValidCapacity(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value > 0)
}
