/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (packages/client/ui-settings-models/src/client/ModelsSection.tsx).
 *
 * Preferences → Models: local servers found on this Mac, the providers the
 * user added (a dot says whether a key is saved), one editor card at a time,
 * and "Add model provider". Keys are write-only; nothing here reads one.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Reveal } from '../ui/Reveal'
import { ProviderEditor, type CatalogEntry } from './ProviderEditor'
import { useProviders } from './useProviders'
import type { ProviderView } from '../../../../shared/providers/types'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function StatusDot({ provider }: { provider: ProviderView }) {
  const { t } = useTranslation()
  const tone = provider.configured ? 'bg-success' : provider.needsKey ? 'bg-warning' : 'bg-muted-foreground'
  const label = provider.configured
    ? t('providers.statusConfigured')
    : provider.needsKey ? t('providers.statusMissingKey') : t('providers.statusNoKey')
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={label}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors ${tone}`} aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </span>
  )
}

export function ModelProvidersPreference() {
  const { t } = useTranslation()
  const { providers, localServers, probing, probe, reload, error } = useProviders({ probe: true })
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Array<{ sessionId: string; remoteUrl: string; remoteModel: string }>>([])
  const [rowError, setRowError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api.providers.catalog().then(list => { if (alive) setCatalog(list) }).catch(() => undefined)
    window.api.providers.remoteSessionCandidates().then(list => { if (alive) setCandidates(list) }).catch(() => undefined)
    return () => { alive = false }
  }, [])

  const takenIds = useMemo(() => new Set(providers.map(p => p.id)), [providers])
  const importable = candidates.filter(c => {
    const base = c.remoteUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1'
    return !providers.some(p => p.baseURL === base && p.models.some(m => m.id === c.remoteModel))
  })

  const remove = async (id: string) => {
    setRowError(null)
    const result = await window.api.providers.delete(id)
    if (!result.ok) setRowError(result.error)
    setConfirmRemove(null)
    if (editing === id) setEditing(null)
    void reload()
  }

  const importSession = async (sessionId: string) => {
    setRowError(null)
    const result = await window.api.providers.importRemoteSession(sessionId)
    if (!result.ok) setRowError(result.error)
    void reload()
  }

  return (
    <section data-vmlx-section="model-providers" className="border border-border rounded-lg p-5 space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('providers.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('providers.subtitle')}</p>
      </div>

      {/* Local servers */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium flex-1">{t('providers.localServers')}</span>
          <button
            type="button"
            onClick={() => void probe()}
            disabled={probing}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60 transition-colors"
          >
            {probing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {probing ? t('providers.checking') : t('common.refresh')}
          </button>
        </div>
        <Reveal open={localServers.length === 0}>
          <p className="text-[11px] text-muted-foreground">{t('providers.localServersHint')}</p>
        </Reveal>
        {localServers.map(server => (
          <div key={server.id} className="flex items-center gap-3 px-3 py-2 rounded-md border border-border mlx-view-in">
            <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" aria-hidden="true" />
            <span className="text-xs font-medium">{server.displayName}</span>
            <span className="text-[11px] text-muted-foreground font-mono truncate">{hostOf(server.baseURL)}</span>
            <span className="flex-1" />
            <span className="text-[11px] text-muted-foreground mlx-num">{t('providers.modelsCount', { count: server.models.length })}</span>
          </div>
        ))}
      </div>

      {/* Stored providers */}
      <div className="space-y-2">
        <span className="text-xs font-medium">{t('providers.providersHeading')}</span>
        <Reveal open={providers.length === 0 && !adding}>
          <p className="text-[11px] text-muted-foreground">{t('providers.noProviders')}</p>
        </Reveal>
        {providers.map(provider => (
          <div key={provider.id} className="space-y-2 mlx-view-in">
            <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-border">
              <StatusDot provider={provider} />
              <span className="text-xs font-medium truncate">{provider.displayName}</span>
              <span className="text-[11px] text-muted-foreground font-mono truncate hidden sm:inline">{hostOf(provider.baseURL)}</span>
              <span className="flex-1" />
              <span className="text-[11px] text-muted-foreground mlx-num whitespace-nowrap">{t('providers.modelsCount', { count: provider.models.length })}</span>
              <button
                type="button"
                onClick={() => { setAdding(false); setConfirmRemove(null); setEditing(editing === provider.id ? null : provider.id) }}
                aria-expanded={editing === provider.id}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil className="h-3 w-3" />
                {t('providers.edit')}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(null); setConfirmRemove(confirmRemove === provider.id ? null : provider.id) }}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="h-3 w-3" />
                {t('providers.remove')}
              </button>
            </div>
            <Reveal open={confirmRemove === provider.id}>
              <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-destructive/40 bg-destructive/5">
                <span className="text-xs flex-1">{t('providers.confirmRemove', { name: provider.displayName })}</span>
                <button type="button" onClick={() => setConfirmRemove(null)} className="text-xs text-muted-foreground hover:text-foreground">
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(provider.id)}
                  className="px-2.5 py-1 text-xs rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t('providers.confirm')}
                </button>
              </div>
            </Reveal>
            <Reveal open={editing === provider.id}>
              <ProviderEditor
                existing={provider}
                catalog={catalog}
                takenIds={takenIds}
                onSaved={() => { setEditing(null); void reload() }}
                onCancel={() => setEditing(null)}
              />
            </Reveal>
          </div>
        ))}

        <Reveal open={!!rowError || !!error}>
          <p role="alert" className="text-xs text-destructive break-words">{rowError ?? error}</p>
        </Reveal>

        <Reveal open={adding}>
          <ProviderEditor
            key={adding ? 'adding' : 'idle'}
            catalog={catalog}
            takenIds={takenIds}
            onSaved={() => { setAdding(false); void reload() }}
            onCancel={() => setAdding(false)}
          />
        </Reveal>
        <Reveal open={!adding}>
          <button
            type="button"
            onClick={() => { setEditing(null); setConfirmRemove(null); setAdding(true) }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-dashed border-border hover:bg-accent hover:border-solid transition-colors"
          >
            <Plus className="h-3 w-3" />
            {t('providers.addProvider')}
          </button>
        </Reveal>
      </div>

      {/* Remote connections made before providers existed */}
      <Reveal open={importable.length > 0}>
        <div className="space-y-2">
          <span className="text-xs font-medium">{t('providers.importTitle')}</span>
          <p className="text-[11px] text-muted-foreground">{t('providers.importHint')}</p>
          {importable.map(c => (
            <div key={c.sessionId} className="flex items-center gap-3 px-3 py-2 rounded-md border border-border">
              <span className="text-xs font-mono truncate">{c.remoteModel}</span>
              <span className="text-[11px] text-muted-foreground font-mono truncate">{hostOf(c.remoteUrl)}</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void importSession(c.sessionId)}
                className="text-[11px] text-primary hover:text-primary/80 whitespace-nowrap"
              >
                {t('providers.importButton')}
              </button>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  )
}
