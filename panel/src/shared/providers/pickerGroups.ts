/**
 * The chat model picker, local first:
 *   1. On this Mac  — MLX Studio sessions (as before)
 *   2. Local servers — Ollama / LM Studio while they run
 *   3. Cloud providers — providers the user added, then remote connections
 */

import type { ProviderModel, ProviderView } from './types'

export interface PickerSession {
  id: string
  modelPath: string
  modelName?: string
  status: string
  type?: 'local' | 'remote'
}

export interface PickerProviderGroup {
  provider: ProviderView
  models: ProviderModel[]
}

export interface PickerGroups<S extends PickerSession> {
  onThisMac: S[]
  localServers: PickerProviderGroup[]
  cloud: PickerProviderGroup[]
  /** Remote-endpoint sessions from before providers existed (listed under Cloud). */
  remoteSessions: S[]
}

const USABLE = new Set(['running', 'loading', 'standby'])

export function groupPickerEntries<S extends PickerSession>(
  sessions: readonly S[],
  localServers: readonly ProviderView[],
  providers: readonly ProviderView[],
): PickerGroups<S> {
  const local = sessions.filter(s => s.type !== 'remote')
  // Ready models first, otherwise keep the existing order.
  const onThisMac = [...local.filter(s => USABLE.has(s.status)), ...local.filter(s => !USABLE.has(s.status))]
  return {
    onThisMac,
    localServers: localServers
      .filter(p => p.reachable !== false && p.models.length > 0)
      .map(provider => ({ provider, models: provider.models })),
    cloud: providers
      .filter(p => p.kind !== 'local-server' && p.models.length > 0 && (!p.needsKey || p.configured))
      .map(provider => ({ provider, models: provider.models })),
    remoteSessions: sessions.filter(s => s.type === 'remote'),
  }
}

/** Find the provider/model a chat is bound to among the picker's providers. */
export function findBoundModel(
  binding: { providerId: string; modelId: string } | null | undefined,
  localServers: readonly ProviderView[],
  providers: readonly ProviderView[],
): { provider?: ProviderView; model?: ProviderModel } {
  if (!binding) return {}
  const provider = [...localServers, ...providers].find(p => p.id === binding.providerId)
  return { provider, model: provider?.models.find(m => m.id === binding.modelId) }
}
