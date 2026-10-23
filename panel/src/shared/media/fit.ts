/**
 * Will this model run on this Mac, and which model should a tab start with?
 * Pure, so the rules are unit-tested (tests/media-fit.test.ts).
 *
 * The memory rule is the one the catalog states per model: below
 * `minMemoryGB` it does not run (greyed out, with the reason and the cloud
 * model to use instead); from `recMemoryGB` it runs well; in between it runs
 * but close to the limit.
 */

import { modelsFor, type MediaKind, type MediaModel, type MediaProviderId } from './catalog'

export type MediaFit =
  | { state: 'good' }
  | { state: 'tight'; needGB: number; haveGB: number }
  | { state: 'no'; needGB: number; haveGB: number }
  /** The runner is not in this build yet; `wouldFit` says how it would do. */
  | { state: 'soon'; wouldFit: 'good' | 'tight' | 'no'; needGB: number; haveGB: number }
  | { state: 'cloud'; connected: boolean }

export interface MacInfo {
  memoryGB: number
}

export function mediaFit(model: MediaModel, mac: MacInfo | null, connected: ReadonlySet<MediaProviderId>): MediaFit {
  if (model.where === 'cloud') return { state: 'cloud', connected: connected.has(model.provider) }
  const haveGB = mac?.memoryGB ?? 0
  const memory: 'good' | 'tight' | 'no' = haveGB >= model.recMemoryGB ? 'good' : haveGB >= model.minMemoryGB ? 'tight' : 'no'
  if (!model.available) return { state: 'soon', wouldFit: memory, needGB: model.minMemoryGB, haveGB }
  if (memory === 'good') return { state: 'good' }
  return { state: memory, needGB: memory === 'no' ? model.minMemoryGB : model.recMemoryGB, haveGB }
}

/** Can the user press Generate with this model right now (before a key check)? */
export function canRun(fit: MediaFit): boolean {
  return fit.state === 'good' || fit.state === 'tight' || (fit.state === 'cloud' && fit.connected)
}

/** Picker order: what can run first (local before cloud), then the rest, each by catalog order. */
export function pickerSections(kind: MediaKind, mac: MacInfo | null, connected: ReadonlySet<MediaProviderId>) {
  const all = modelsFor(kind).map(model => ({ model, fit: mediaFit(model, mac, connected) }))
  return {
    local: all.filter(r => r.model.where === 'local'),
    cloud: all.filter(r => r.model.where === 'cloud')
      .sort((a, b) => Number(b.fit.state === 'cloud' && b.fit.connected) - Number(a.fit.state === 'cloud' && a.fit.connected)),
  }
}

/**
 * The model a tab starts with:
 *  1. a local model this Mac runs well (private, free) — Audio's Kokoro;
 *  2. else the first "Best value" cloud model on a connected account;
 *  3. else any cloud model on a connected account;
 *  4. else the first "Best value" cloud model (the composer then offers to
 *     connect its account).
 * A local model that only fits "tight" is still offered, but is not chosen
 * over a connected cloud model for video and music, where it would be slow.
 */
export function recommendedModel(kind: MediaKind, mac: MacInfo | null, connected: ReadonlySet<MediaProviderId>): MediaModel | undefined {
  const rows = modelsFor(kind).map(model => ({ model, fit: mediaFit(model, mac, connected) }))
  const goodLocal = rows.find(r => r.fit.state === 'good')
  if (goodLocal) return goodLocal.model
  const ready = rows.filter(r => r.fit.state === 'cloud' && r.fit.connected)
  const value = (list: typeof rows) => list.find(r => r.model.badge === 'Best value') ?? list[0]
  if (ready.length > 0) return value(ready)!.model
  const tightLocal = rows.find(r => r.fit.state === 'tight')
  if (tightLocal && (kind === 'audio' || kind === 'image')) return tightLocal.model
  return value(rows.filter(r => r.model.where === 'cloud'))?.model
}

/** Whether a whole tab can only run in the cloud on this build/Mac (for the banner). */
export function localPossible(kind: MediaKind, mac: MacInfo | null): { runsHere: boolean; couldRunHere: boolean } {
  const local = modelsFor(kind).filter((m): m is Extract<MediaModel, { where: 'local' }> => m.where === 'local')
  const mem = mac?.memoryGB ?? 0
  return {
    runsHere: local.some(m => m.available && mem >= m.minMemoryGB),
    couldRunHere: local.some(m => mem >= m.minMemoryGB),
  }
}
