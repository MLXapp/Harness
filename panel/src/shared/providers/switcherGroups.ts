/**
 * What the composer's model switcher lists, in order:
 *   1. Top models    — the curated cloud models the connected accounts reach
 *   2. On this Mac   — MLX Harness sessions and local servers (chat models only)
 *   3. More from …   — the rest of each connected account's chat models
 *   4. Other connections — remote-endpoint sessions from before accounts existed
 *
 * Voice, image and embedding models never appear here (`isChatModelRepo`):
 * the Models library lists everything in the Hugging Face cache, chat lists
 * only what can chat.
 *
 * Pure: the renderer passes in sessions and providers, gets rows back.
 */

import {
  FEATURED_ACCOUNTS,
  featuredAccount,
  isChatModelRepo,
  reachableFeaturedModels,
  type FeaturedAccount,
  type FeaturedAccountId,
  type FeaturedCloudModel,
} from '../curated'
import { groupPickerEntries, type PickerSession } from './pickerGroups'
import type { ChatModelBinding, ProviderModel, ProviderReasoningLevel, ProviderView } from './types'

/**
 * Reasoning levels a featured model offers when its account's saved model
 * does not list any yet (the switcher adds the model to the account with
 * these). Only models with a default `effort` reason.
 */
const FEATURED_LEVELS: Partial<Record<FeaturedAccountId, ProviderReasoningLevel[]>> = {
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  openai: ['low', 'medium', 'high', 'xhigh'],
  deepseek: ['high', 'max'],
}

export function featuredReasoningLevels(model: FeaturedCloudModel): ProviderReasoningLevel[] | undefined {
  if (!model.effort) return undefined
  const levels = FEATURED_LEVELS[model.account]
  if (!levels) return [model.effort]
  return levels.includes(model.effort) ? levels : [...levels, model.effort]
}

/** The provider model a featured model becomes when it is added to an account. */
export function featuredProviderModel(model: FeaturedCloudModel, modelId: string): ProviderModel {
  const levels = featuredReasoningLevels(model)
  return {
    id: modelId,
    name: model.name,
    input: ['text', 'image'],
    ...(levels ? { reasoningEfforts: levels } : {}),
  }
}

export interface SwitcherFeaturedRow {
  kind: 'featured'
  key: string
  model: FeaturedCloudModel
  providerId: string
  modelId: string
  via: 'native' | 'wavespeed'
  provider?: ProviderView
  /** The account already lists this model (otherwise selecting adds it). */
  present: boolean
}

export interface SwitcherSessionRow<S extends PickerSession> {
  kind: 'session'
  key: string
  session: S
}

export interface SwitcherProviderRow {
  kind: 'provider-model'
  key: string
  provider: ProviderView
  model: ProviderModel
  /** Ollama / LM Studio on this Mac. */
  local: boolean
}

export type SwitcherRow<S extends PickerSession> = SwitcherFeaturedRow | SwitcherSessionRow<S> | SwitcherProviderRow

export interface SwitcherMoreGroup {
  provider: ProviderView
  /** Name people know the account by (Claude, Gemini…), else the provider's name. */
  label: string
  rows: SwitcherProviderRow[]
}

export interface SwitcherGroups<S extends PickerSession> {
  featured: SwitcherFeaturedRow[]
  /** No featured model is reachable: offer to connect an account instead. */
  showConnect: boolean
  /** Featured accounts that are not connected yet (for the connect chips). */
  connectable: FeaturedAccount[]
  onThisMac: Array<SwitcherSessionRow<S> | SwitcherProviderRow>
  more: SwitcherMoreGroup[]
  remoteSessions: SwitcherSessionRow<S>[]
}

/** Case-insensitive subsequence match ("cop" matches "Claude Opus"); spaces in the query are ignored. */
export function subsequenceMatch(query: string, text: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return true
  const t = text.toLowerCase()
  let i = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++
  }
  return i === q.length
}

/** Accounts (provider ids) the user can use: keys stored, or no key needed. */
export function connectedProviderIds(providers: readonly ProviderView[]): Set<string> {
  return new Set(
    providers
      .filter(p => p.kind !== 'local-server' && (!p.needsKey || p.configured))
      .map(p => p.id),
  )
}

function isHidden(model: ProviderModel): boolean {
  return (model as ProviderModel & { hidden?: boolean }).hidden === true
}

function sessionName(s: PickerSession): string {
  return s.modelName || s.modelPath.split('/').pop() || s.modelPath
}

function isChatSession(s: PickerSession): boolean {
  return isChatModelRepo(s.modelPath) && isChatModelRepo(s.modelName ?? '')
}

export function accountLabel(provider: Pick<ProviderView, 'id' | 'displayName'>): string {
  return featuredAccount(provider.id)?.name ?? provider.displayName
}

export function buildSwitcherGroups<S extends PickerSession>(input: {
  sessions: readonly S[]
  localServers: readonly ProviderView[]
  providers: readonly ProviderView[]
  query?: string
}): SwitcherGroups<S> {
  const query = (input.query ?? '').trim()
  const base = groupPickerEntries(input.sessions, input.localServers, input.providers)
  const connected = connectedProviderIds(input.providers)
  const byId = new Map(input.providers.map(p => [p.id, p]))

  const reachable = reachableFeaturedModels(connected)
  const featuredKeys = new Set(reachable.map(r => `${r.providerId}/${r.modelId}`))
  const featured: SwitcherFeaturedRow[] = reachable
    .map(r => {
      const provider = byId.get(r.providerId)
      return {
        kind: 'featured' as const,
        key: `featured:${r.model.key}`,
        model: r.model,
        providerId: r.providerId,
        modelId: r.modelId,
        via: r.via,
        provider,
        present: !!provider?.models.some(m => m.id === r.modelId),
      }
    })
    .filter(row => subsequenceMatch(query, `${row.model.name} ${featuredAccount(row.model.account)?.name ?? ''}`))

  const onThisMac: Array<SwitcherSessionRow<S> | SwitcherProviderRow> = [
    ...base.onThisMac
      .filter(isChatSession)
      .filter(s => subsequenceMatch(query, `${sessionName(s)} ${s.modelPath}`))
      .map(session => ({ kind: 'session' as const, key: `session:${session.id}`, session })),
    ...base.localServers.flatMap(group =>
      group.models
        .filter(m => !isHidden(m) && isChatModelRepo(m.id))
        .filter(m => subsequenceMatch(query, `${m.name ?? ''} ${m.id} ${group.provider.displayName}`))
        .map(model => ({
          kind: 'provider-model' as const,
          key: `${group.provider.id}/${model.id}`,
          provider: group.provider,
          model,
          local: true,
        })),
    ),
  ]

  const more: SwitcherMoreGroup[] = base.cloud
    .map(group => {
      const label = accountLabel(group.provider)
      return {
        provider: group.provider,
        label,
        rows: group.models
          .filter(m => !isHidden(m) && isChatModelRepo(m.id) && !featuredKeys.has(`${group.provider.id}/${m.id}`))
          .filter(m => subsequenceMatch(query, `${m.name ?? ''} ${m.id} ${label}`))
          .map(model => ({
            kind: 'provider-model' as const,
            key: `${group.provider.id}/${model.id}`,
            provider: group.provider,
            model,
            local: false,
          })),
      }
    })
    .filter(group => group.rows.length > 0)

  const remoteSessions = base.remoteSessions
    .filter(s => subsequenceMatch(query, `${sessionName(s)} ${s.modelPath}`))
    .map(session => ({ kind: 'session' as const, key: `session:${session.id}`, session }))

  const anyFeaturedConnected = FEATURED_ACCOUNTS.some(a => connected.has(a.catalogId))
  return {
    featured,
    showConnect: !anyFeaturedConnected && !query,
    connectable: FEATURED_ACCOUNTS.filter(a => !connected.has(a.catalogId)),
    onThisMac,
    more,
    remoteSessions,
  }
}

/**
 * Rows the keyboard walks, top to bottom. `expanded` names the "More from …"
 * groups that are open (all of them while searching).
 */
export function selectableRows<S extends PickerSession>(
  groups: SwitcherGroups<S>,
  expanded: ReadonlySet<string>,
  searching: boolean,
): SwitcherRow<S>[] {
  return [
    ...groups.featured,
    ...groups.onThisMac,
    ...groups.more.flatMap(g => (searching || expanded.has(g.provider.id) ? g.rows : [])),
    ...groups.remoteSessions,
  ]
}

/** The featured model a binding points at, by account and API id. */
export function featuredForBinding(
  binding: Pick<ChatModelBinding, 'providerId' | 'modelId'> | null | undefined,
): FeaturedCloudModel | undefined {
  if (!binding) return undefined
  const reach = reachableFeaturedModels(new Set([binding.providerId]))
  return reach.find(r => r.providerId === binding.providerId && r.modelId === binding.modelId)?.model
}

export interface SwitcherSelection {
  /** Nothing to send to: no session and no provider model. */
  none: boolean
  name: string
  local: boolean
  providerId?: string
  /** Levels the selected model declares (provider models only). */
  levels?: ProviderReasoningLevel[]
  /** The level in effect: the chat's choice, else the featured default. */
  effort?: ProviderReasoningLevel
  /** The curated default level, marked in the reasoning control. */
  defaultEffort?: ProviderReasoningLevel
  /** MLX session status, when a session is selected. */
  status?: string
}

/** What the pill shows for the chat's current model. */
export function describeSelection(input: {
  binding: ChatModelBinding | null | undefined
  session: PickerSession | undefined
  localServers: readonly ProviderView[]
  providers: readonly ProviderView[]
}): SwitcherSelection {
  const { binding, session } = input
  if (binding) {
    const provider = [...input.localServers, ...input.providers].find(p => p.id === binding.providerId)
    const model = provider?.models.find(m => m.id === binding.modelId)
    const featured = featuredForBinding(binding)
    const levels = model?.reasoningEfforts ?? (featured ? featuredReasoningLevels(featured) : undefined)
    const defaultEffort = featured?.effort
    return {
      none: false,
      name: featured?.name ?? model?.name ?? binding.modelId,
      local: provider?.kind === 'local-server',
      providerId: binding.providerId,
      ...(levels && levels.length ? { levels } : {}),
      ...(levels && levels.length ? { effort: binding.reasoningEffort ?? defaultEffort } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
    }
  }
  if (session) {
    return {
      none: false,
      name: sessionName(session),
      local: session.type !== 'remote',
      status: session.status,
    }
  }
  return { none: true, name: '', local: false }
}
