/**
 * Pure helpers behind Connect account, Preferences → Accounts and first-run
 * setup: which models a newly connected account adds to the chat picker, how
 * a saved provider maps back to a featured account, the onboarding steps and
 * which model "Start a chat" opens.
 */

import {
  FEATURED_ACCOUNTS,
  MEDIA_ACCOUNTS,
  FEATURED_CLOUD_MODELS,
  reachableFeaturedModels,
  type FeaturedAccount,
  type FeaturedAccountId,
  type FeaturedCloudModel,
  type LocalPick,
} from './curated'
import { catalogProvider } from './providers/catalog'
import { featuredProviderModel } from './providers/switcherGroups'
import type {
  DiscoveredModel,
  ProviderDraft,
  ProviderModel,
  ProviderReasoningLevel,
  ProviderView,
} from './providers/types'

// ── Models an account adds ─────────────────────────────────────────────────

/** All five featured models take 1M tokens of context (providers' model pages). */
export const FEATURED_CONTEXT_WINDOW = 1_000_000

/**
 * The models a newly connected account shows in the chat picker: its
 * featured models (native ids), or for WaveSpeed AI every featured model
 * through its gateway. Same shape (name, inputs, reasoning levels) as the
 * composer's model switcher adds (`featuredProviderModel`), so a model looks
 * the same however it was added.
 */
export function featuredModelsFor(accountId: FeaturedAccountId): ProviderModel[] {
  const via = (m: FeaturedCloudModel) => (accountId === 'wavespeed' ? m.wavespeedId : m.account === accountId ? m.modelId : undefined)
  return FEATURED_CLOUD_MODELS
    .filter(m => via(m))
    .map(m => ({ ...featuredProviderModel(m, via(m)!), contextWindow: FEATURED_CONTEXT_WINDOW }))
}

/**
 * The provider row saved when an account is connected (or its key replaced):
 * featured models first and shown; models the user already had keep their
 * shown/hidden choice; everything else the service listed is stored hidden,
 * so "Choose models…" can offer it without cluttering the picker.
 */
export function accountDraft(
  account: FeaturedAccount,
  discovered: readonly DiscoveredModel[],
  existing?: Pick<ProviderView, 'models'>,
): ProviderDraft {
  const catalog = catalogProvider(account.catalogId)
  if (!catalog) throw new Error(`${account.catalogId} is not in the catalog`)
  const previous = new Map((existing?.models ?? []).map(m => [m.id, m]))
  const models: ProviderModel[] = []
  const seen = new Set<string>()
  for (const model of featuredModelsFor(account.id)) {
    const before = previous.get(model.id)
    models.push(before?.hidden ? { ...model, hidden: true } : model)
    seen.add(model.id)
  }
  for (const model of existing?.models ?? []) {
    if (seen.has(model.id)) continue
    models.push(model)
    seen.add(model.id)
  }
  for (const found of discovered) {
    if (!found.id || seen.has(found.id)) continue
    seen.add(found.id)
    models.push({
      id: found.id,
      ...(found.name ? { name: found.name } : {}),
      ...(found.contextWindow ? { contextWindow: found.contextWindow } : {}),
      ...(found.maxTokens ? { maxTokens: found.maxTokens } : {}),
      input: found.input ?? ['text'],
      hidden: true,
    })
  }
  return {
    id: catalog.id,
    kind: 'catalog',
    displayName: account.name,
    api: catalog.api,
    baseURL: catalog.baseURL,
    models,
  }
}

/** Ids of featured models, for sorting "Choose models…" (featured first). */
export function featuredModelIds(): Set<string> {
  const ids = new Set<string>()
  for (const m of FEATURED_CLOUD_MODELS) {
    ids.add(m.modelId)
    if (m.wavespeedId) ids.add(m.wavespeedId)
  }
  return ids
}

/** Featured models first (in curated order), then the rest by name. */
export function sortModelsForChooser(models: readonly ProviderModel[]): ProviderModel[] {
  const order = new Map<string, number>()
  FEATURED_CLOUD_MODELS.forEach((m, i) => {
    order.set(m.modelId, i)
    if (m.wavespeedId) order.set(m.wavespeedId, i)
  })
  return [...models].sort((a, b) => {
    const fa = order.get(a.id)
    const fb = order.get(b.id)
    if (fa !== undefined || fb !== undefined) return (fa ?? 99) - (fb ?? 99)
    return (a.name ?? a.id).localeCompare(b.name ?? b.id)
  })
}

/** Show exactly `shown` (by id); keeps every other field. */
export function withShownModels(models: readonly ProviderModel[], shown: ReadonlySet<string>): ProviderModel[] {
  return models.map(m => {
    const { hidden: _hidden, ...rest } = m
    return shown.has(m.id) ? rest : { ...rest, hidden: true }
  })
}

// ── Connected accounts ─────────────────────────────────────────────────────

/** Saved providers that stand for a featured account, with a key. */
export function connectedAccountIds(providers: readonly ProviderView[]): Set<string> {
  const ids = new Set<string>()
  for (const account of FEATURED_ACCOUNTS) {
    const provider = providers.find(p => p.id === account.catalogId)
    if (provider && provider.configured) ids.add(account.catalogId)
  }
  return ids
}

/** Catalog providers and custom endpoints that are not one of the five. */
export function otherProviders(providers: readonly ProviderView[]): ProviderView[] {
  const featured = new Set([...FEATURED_ACCOUNTS, ...MEDIA_ACCOUNTS].map(a => a.catalogId))
  return providers.filter(p => p.kind !== 'local-server' && !featured.has(p.id))
}

/** "from $0.15 / $0.60" — the published price per 1M tokens, input / output. */
export function formatPrice(price: { input: number; output: number }): { input: string; output: string } {
  const fmt = (n: number) => `$${n < 1 ? n.toFixed(2) : Number.isInteger(n) ? String(n) : n.toFixed(2)}`
  return { input: fmt(price.input), output: fmt(price.output) }
}

// ── Custom endpoints ───────────────────────────────────────────────────────

/** A provider id from a name: "My Server" → "my-server", unique among `taken`. */
export function providerIdFromName(name: string, taken: ReadonlySet<string>): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'endpoint'
  const reserved = (id: string) => taken.has(id) || id === 'ollama' || id === 'lmstudio' || !!catalogProvider(id)
  if (!reserved(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!reserved(candidate)) return candidate
  }
}

// ── First-run setup ────────────────────────────────────────────────────────

export const ONBOARDING_STEPS = ['welcome', 'accounts', 'mac', 'done'] as const
export type OnboardingStep = typeof ONBOARDING_STEPS[number]

/** Setting key written when setup is finished or skipped. */
export const ONBOARDING_DONE_KEY = 'onboardingDone'

export function nextStep(step: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(step)
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)]
}

export function previousStep(step: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(step)
  return ONBOARDING_STEPS[Math.max(i - 1, 0)]
}

/** Shown once: after the engine is installed, until finished or skipped. */
export function shouldShowOnboarding(engineInstalled: boolean, doneSetting: string | null | undefined): boolean {
  return engineInstalled && !doneSetting
}

export type StartChoice =
  | { kind: 'cloud'; providerId: string; modelId: string; name: string; effort?: ProviderReasoningLevel }
  | { kind: 'local'; modelPath: string; name: string }
  | { kind: 'none' }

/**
 * What "Start a chat" opens: the best featured cloud model the connected
 * accounts reach (Claude Opus 5.5, then DeepSeek V4 Pro Max, then the rest in
 * curated order), as long as the saved provider still lists it; otherwise a
 * downloaded local chat model, best pick first.
 */
export function chooseStartModel(
  providers: readonly ProviderView[],
  downloaded: ReadonlyArray<{ pick: LocalPick; path: string }>,
): StartChoice {
  const connected = connectedAccountIds(providers)
  for (const route of reachableFeaturedModels(connected)) {
    const provider = providers.find(p => p.id === route.providerId)
    if (!provider?.models.some(m => m.id === route.modelId)) continue
    return {
      kind: 'cloud',
      providerId: route.providerId,
      modelId: route.modelId,
      name: route.model.name,
      ...(route.via === 'native' && route.model.effort ? { effort: route.model.effort } : {}),
    }
  }
  const local = downloaded.find(d => d.pick.purpose === 'chat') ?? downloaded.find(d => d.pick.purpose === 'code')
  if (local) return { kind: 'local', modelPath: local.path, name: local.pick.name }
  return { kind: 'none' }
}

/** Whether a scanned local model path is a pick's repo (download dir or HF cache layout). */
export function pathMatchesRepo(path: string, repo: string): boolean {
  const p = path.replace(/\/+$/, '').toLowerCase()
  const r = repo.toLowerCase()
  const [org, name] = r.split('/')
  return p.endsWith(`/${r}`) || p.includes(`/models--${org}--${name}`) || (!!name && p.endsWith(`/${name}`))
}
