/**
 * "Your Mac" for first-run setup: chip, Mac model, memory and free disk, so
 * MLX Harness can recommend local models that fit.
 *
 * Fail-soft everywhere: any probe that does not answer (another OS, a sandbox,
 * a slow system_profiler) falls back to what Node knows, and the whole thing
 * never throws.
 */

import { execFile } from 'child_process'
import { statfs } from 'fs/promises'
import { homedir, totalmem } from 'os'
import type { HardwareInfo } from '../shared/hardware'

/** `sysctl -n machdep.cpu.brand_string` → "Apple M3 Pro". */
export function parseChip(brand: string | undefined): string | undefined {
  const value = (brand ?? '').replace(/\s+/g, ' ').trim()
  return value || undefined
}

/**
 * `system_profiler SPHardwareDataType -json`: the Mac's marketing name
 * ("MacBook Pro"), and its chip and memory when sysctl gave none.
 */
export function parseSystemProfiler(json: string | undefined): { modelName?: string; chip?: string; memoryGB?: number } {
  try {
    const parsed = JSON.parse(json ?? '')
    const item = parsed?.SPHardwareDataType?.[0]
    if (!item || typeof item !== 'object') return {}
    const modelName = typeof item.machine_name === 'string' && item.machine_name.trim() ? item.machine_name.trim() : undefined
    const chip = typeof item.chip_type === 'string' && item.chip_type.trim() ? item.chip_type.trim() : undefined
    const memoryMatch = typeof item.physical_memory === 'string' ? /^(\d+(?:\.\d+)?)\s*(GB|TB)/i.exec(item.physical_memory) : null
    const memoryGB = memoryMatch
      ? Math.round(Number(memoryMatch[1]) * (memoryMatch[2].toUpperCase() === 'TB' ? 1024 : 1))
      : undefined
    return { ...(modelName ? { modelName } : {}), ...(chip ? { chip } : {}), ...(memoryGB ? { memoryGB } : {}) }
  } catch {
    return {}
  }
}

/**
 * `sysctl -n hw.model` → a marketing name when the identifier says it
 * ("MacBookPro18,3" → "MacBook Pro"). Newer Macs report "Mac15,8", which
 * names no family: undefined.
 */
export function modelNameFromIdentifier(identifier: string | undefined): string | undefined {
  const id = (identifier ?? '').trim()
  const families: Array<[RegExp, string]> = [
    [/^MacBookPro\d/, 'MacBook Pro'],
    [/^MacBookAir\d/, 'MacBook Air'],
    [/^Macmini\d/, 'Mac mini'],
    [/^iMac\d/, 'iMac'],
    [/^MacPro\d/, 'Mac Pro'],
    [/^MacBook\d/, 'MacBook'],
  ]
  return families.find(([pattern]) => pattern.test(id))?.[1]
}

/** Free space from a statfs result, in whole GB (blocks available to a normal user). */
export function freeGBFromStatfs(stats: { bavail: number | bigint; bsize: number | bigint } | undefined): number | undefined {
  if (!stats) return undefined
  const bytes = Number(stats.bavail) * Number(stats.bsize)
  return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes / 1024 ** 3) : undefined
}

export interface HardwareProbes {
  platform: NodeJS.Platform
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<string | undefined>
  statfs: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint } | undefined>
  totalMemBytes: number
  /** Where models are downloaded (free space is measured there), then home. */
  paths: string[]
}

/** Assemble the hardware summary from whatever the probes return. */
export async function readHardware(probes: HardwareProbes): Promise<HardwareInfo> {
  const fallbackMemory = Math.round(probes.totalMemBytes / 1024 ** 3)
  let chip: string | undefined
  let modelName: string | undefined
  let memoryGB: number | undefined
  if (probes.platform === 'darwin') {
    const [brand, profiler, identifier] = await Promise.all([
      probes.run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], 2000),
      probes.run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], 4000),
      probes.run('/usr/sbin/sysctl', ['-n', 'hw.model'], 2000),
    ])
    const fromProfiler = parseSystemProfiler(profiler)
    chip = parseChip(brand) ?? fromProfiler.chip
    modelName = fromProfiler.modelName ?? modelNameFromIdentifier(identifier)
    memoryGB = fromProfiler.memoryGB
  }
  let freeDiskGB: number | undefined
  for (const path of probes.paths) {
    freeDiskGB = freeGBFromStatfs(await probes.statfs(path).catch(() => undefined))
    if (freeDiskGB !== undefined) break
  }
  return {
    chip: chip ?? 'Apple silicon',
    ...(modelName ? { modelName } : {}),
    memoryGB: memoryGB ?? fallbackMemory,
    ...(freeDiskGB !== undefined ? { freeDiskGB } : {}),
  }
}

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error ? undefined : String(stdout))
      })
    } catch {
      resolve(undefined)
    }
  })
}

let cached: Promise<HardwareInfo> | undefined

/** The Mac's hardware, read once per launch (free disk is re-read each call). */
export async function getHardware(downloadDir?: string): Promise<HardwareInfo> {
  const probes: HardwareProbes = {
    platform: process.platform,
    run: runCommand,
    statfs: path => statfs(path),
    totalMemBytes: totalmem(),
    paths: [...(downloadDir ? [downloadDir] : []), homedir()],
  }
  cached ??= readHardware({ ...probes, paths: [] })
  const base = await cached
  let freeDiskGB: number | undefined
  for (const path of probes.paths) {
    freeDiskGB = freeGBFromStatfs(await probes.statfs(path).catch(() => undefined))
    if (freeDiskGB !== undefined) break
  }
  return { ...base, ...(freeDiskGB !== undefined ? { freeDiskGB } : {}) }
}
