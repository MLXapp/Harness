/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (packages/client/ui-settings-models/src/client/ProviderEditor.tsx and
 * CustomProviderCard.tsx).
 *
 * Add or edit one model provider. Adding opens on a two-mode switch:
 * Catalog (a cloud provider MLX Harness knows) or Custom endpoint (id,
 * endpoint, protocol). The API key is write-only; models come from the
 * endpoint's listing or are typed by id.
 */
import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Reveal } from '../ui/Reveal'
import { ApiKeyField, apiKeyErrorText } from './ApiKeyField'
import { ModelRowsEditor, modelsFromRows, rowsFromModels, type ModelDraftRow } from './ModelRowsEditor'
import {
  PROVIDER_APIS,
  PROVIDER_ID_PATTERN,
  type ProviderApi,
  type ProviderKind,
  type ProviderView,
} from '../../../../shared/providers/types'

export interface CatalogEntry {
  id: string
  displayName: string
  api: ProviderApi
  baseURL: string
}

const PROTOCOL_KEYS: Record<ProviderApi, string> = {
  'openai-completions': 'providers.protocolOpenAiCompletions',
  'openai-responses': 'providers.protocolOpenAiResponses',
  'anthropic-messages': 'providers.protocolAnthropicMessages',
}

/** Endpoint placeholder per protocol: Anthropic SDKs append /v1/messages themselves. */
const ENDPOINT_EXAMPLE: Record<ProviderApi, string> = {
  'openai-completions': 'https://gateway.example/v1',
  'openai-responses': 'https://gateway.example/v1',
  'anthropic-messages': 'https://gateway.example',
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const inputClass =
  'w-full h-8 px-2.5 bg-background border border-input rounded-[8px] text-[13px] focus:outline-none focus:ring-1 focus:ring-ring transition-colors'

export function ProviderEditor({ existing, catalog, takenIds, onSaved, onCancel }: {
  /** The provider being edited; absent when adding. */
  existing?: ProviderView
  catalog: CatalogEntry[]
  takenIds: Set<string>
  onSaved: (provider: ProviderView) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const available = useMemo(() => catalog.filter(c => !takenIds.has(c.id)), [catalog, takenIds])
  const [mode, setMode] = useState<Exclude<ProviderKind, 'local-server'>>(
    existing ? (existing.kind === 'custom' ? 'custom' : 'catalog') : available.length > 0 ? 'catalog' : 'custom',
  )
  const firstCatalog = existing ? undefined : available[0]
  const [catalogId, setCatalogId] = useState(existing?.kind === 'catalog' ? existing.id : firstCatalog?.id ?? '')
  const [id, setId] = useState(existing?.id ?? '')
  const [displayName, setDisplayName] = useState(existing?.displayName ?? firstCatalog?.displayName ?? '')
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? firstCatalog?.baseURL ?? '')
  const [api, setApi] = useState<ProviderApi>(existing?.api ?? firstCatalog?.api ?? 'openai-completions')
  const [apiKey, setApiKey] = useState('')
  const [rows, setRows] = useState<ModelDraftRow[]>(() => rowsFromModels(existing?.models ?? []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)

  const providerId = existing?.id ?? (mode === 'catalog' ? catalogId : id.trim())
  const urlOk = validUrl(baseURL)
  const keyError = apiKeyErrorText(t, apiKey)
  const idError = !existing && mode === 'custom' && id.trim() !== '' && (!PROVIDER_ID_PATTERN.test(id.trim()) || takenIds.has(id.trim()))
  const needsKey = mode === 'catalog' && !(existing?.configured)
  const configured = !!existing?.configured

  const pickCatalog = (next: string) => {
    const entry = catalog.find(c => c.id === next)
    setCatalogId(next)
    if (entry) {
      setDisplayName(entry.displayName)
      setBaseURL(entry.baseURL)
      setApi(entry.api)
    }
    setRows([])
  }

  const switchMode = (next: 'catalog' | 'custom') => {
    if (next === mode || existing) return
    setMode(next)
    setError(null)
    setAttempted(false)
    if (next === 'catalog') {
      pickCatalog(available[0]?.id ?? '')
    } else {
      setDisplayName('')
      setBaseURL('')
      setApi('openai-completions')
      setRows([])
    }
  }

  const discover = () =>
    window.api.providers.discover({
      providerId: providerId || undefined,
      baseURL,
      api,
      apiKey: apiKey.trim() ? apiKey : undefined,
    })

  const save = async () => {
    setAttempted(true)
    setError(null)
    const { models, problems } = modelsFromRows(rows)
    if (problems.size > 0 || !urlOk || keyError || idError || !providerId) return
    if (needsKey && !apiKey.trim()) {
      setError(t('providers.statusMissingKey'))
      return
    }
    setSaving(true)
    try {
      const result = await window.api.providers.save(
        { id: providerId, kind: mode, displayName: displayName.trim(), api, baseURL: baseURL.trim(), models },
        apiKey.trim() ? apiKey : undefined,
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      setApiKey('')
      onSaved(result.provider)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const clearKey = async () => {
    if (!existing) return
    const result = await window.api.providers.clearKey(existing.id)
    if (!result.ok) setError(result.error)
  }

  const fieldId = `provider-${existing?.id ?? 'new'}`

  return (
    <div className="border border-border rounded-lg p-4 space-y-4 bg-card/40">
      {!existing && (
        <div className="space-y-1.5">
          <div role="tablist" className="inline-flex rounded-md border border-border p-0.5 bg-background">
            {(['catalog', 'custom'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={mode === tab}
                disabled={saving || (tab === 'catalog' && available.length === 0)}
                title={tab === 'catalog' && available.length === 0 ? t('providers.allAdded') : undefined}
                onClick={() => switchMode(tab)}
                className={`px-3 py-1 text-xs rounded transition-colors disabled:opacity-50 ${
                  mode === tab ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab === 'catalog' ? t('providers.modeCatalog') : t('providers.modeCustom')}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-muted-foreground">
            {mode === 'catalog' ? t('providers.modeCatalogHint') : t('providers.modeCustomHint')}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {mode === 'catalog' && !existing ? (
          <div className="space-y-1">
            <label htmlFor={`${fieldId}-catalog`} className="text-xs font-medium text-muted-foreground">{t('providers.chooseProvider')}</label>
            <select
              id={`${fieldId}-catalog`}
              value={catalogId}
              onChange={e => pickCatalog(e.target.value)}
              className={inputClass}
            >
              {available.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
            </select>
          </div>
        ) : mode === 'custom' && !existing ? (
          <div className="space-y-1">
            <label htmlFor={`${fieldId}-id`} className="text-xs font-medium text-muted-foreground">{t('providers.providerId')}</label>
            <input
              id={`${fieldId}-id`}
              value={id}
              onChange={e => setId(e.target.value.toLowerCase())}
              spellCheck={false}
              aria-invalid={idError}
              className={`${inputClass} font-mono ${idError || (attempted && !id.trim()) ? 'border-destructive' : ''}`}
            />
            <p className="text-[12px] text-muted-foreground">{t('providers.providerIdHint')}</p>
          </div>
        ) : null}
        <div className="space-y-1">
          <label htmlFor={`${fieldId}-name`} className="text-xs font-medium text-muted-foreground">{t('providers.displayName')}</label>
          <input id={`${fieldId}-name`} value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputClass} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${fieldId}-url`} className="text-xs font-medium text-muted-foreground">{t('providers.endpoint')}</label>
          <input
            id={`${fieldId}-url`}
            value={baseURL}
            onChange={e => setBaseURL(e.target.value)}
            placeholder={ENDPOINT_EXAMPLE[api]}
            spellCheck={false}
            aria-invalid={baseURL !== '' && !urlOk}
            className={`${inputClass} font-mono ${(baseURL !== '' || attempted) && !urlOk ? 'border-destructive' : ''}`}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${fieldId}-api`} className="text-xs font-medium text-muted-foreground">{t('providers.protocol')}</label>
          <select id={`${fieldId}-api`} value={api} onChange={e => setApi(e.target.value as ProviderApi)} className={inputClass}>
            {PROVIDER_APIS.map(value => <option key={value} value={value}>{t(PROTOCOL_KEYS[value])}</option>)}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <ApiKeyField
          id={`${fieldId}-key`}
          value={apiKey}
          onChange={setApiKey}
          configured={configured}
          optional={mode === 'custom'}
          disabled={saving}
        />
        {configured && (
          <button type="button" onClick={clearKey} className="text-[12px] text-muted-foreground hover:text-destructive transition-colors">
            {t('providers.keyRemove')}
          </button>
        )}
      </div>

      <ModelRowsEditor
        rows={rows}
        onChange={setRows}
        onDiscover={discover}
        canDiscover={urlOk && !keyError}
        idPrefix={fieldId}
        showProblems={attempted}
      />

      <Reveal open={!!error}>
        <p role="alert" className="text-xs text-destructive break-words">{t('providers.saveFailed')}: {error}</p>
      </Reveal>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !providerId}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
