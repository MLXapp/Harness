/**
 * Custom endpoint… — any OpenAI- or Anthropic-compatible server (a gateway,
 * a self-hosted vLLM, another Mac). Replaces the old "Remote Endpoint" form:
 * the endpoint becomes a provider, so its models show up in the chat picker.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { providerIdFromName } from '../../../../shared/accountSetup'
import { cleanPastedKey } from '../../../../shared/providers/apiKey'
import type { ProviderApi, ProviderView } from '../../../../shared/providers/types'
import { Reveal } from '../ui/Reveal'
import { AccountGlyph } from './AccountGlyph'
import { KeyStatus } from './KeyStatus'
import { ModelChecklist, type ChecklistModel } from './ModelChecklist'
import { Sheet, SheetFooter, SheetHeader } from './Sheet'
import { Btn, Spinner, countKey } from './ui'
import { useKeyCheck } from './useKeyCheck'

const PROTOCOLS: Array<[ProviderApi, string]> = [
  ['openai-completions', 'accounts.custom.protocolChat'],
  ['openai-responses', 'accounts.custom.protocolResponses'],
  ['anthropic-messages', 'accounts.custom.protocolAnthropic'],
]

export function validEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

const field = 'h-8 w-full rounded-[8px] border border-input bg-background px-2.5 text-[13px] leading-[18px] transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25'

export function CustomEndpointSheet({ open, providers, onClose, onClosed, onSaved }: {
  open: boolean
  providers: readonly ProviderView[]
  onClose: () => void
  onClosed?: () => void
  onSaved?: (provider: ProviderView) => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [api, setApi] = useState<ProviderApi>('openai-completions')
  const [key, setKey] = useState('')
  const [extra, setExtra] = useState<ChecklistModel[]>([])
  const [typedModel, setTypedModel] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setBaseURL('')
    setApi('openai-completions')
    setKey('')
    setExtra([])
    setTypedModel('')
    setChecked(new Set())
    setSaving(false)
    setError(null)
  }, [open])

  const urlOk = validEndpointUrl(baseURL)
  const cleanKey = cleanPastedKey(key)
  const { state, retry } = useKeyCheck({ baseURL: baseURL.trim(), api, ...(cleanKey ? { apiKey: cleanKey } : {}) }, open && urlOk, 600)
  const found = state.phase === 'done' && state.result.ok ? state.result.discovered : []
  const models = useMemo(() => {
    const seen = new Set<string>()
    const out: ChecklistModel[] = []
    for (const m of [...extra, ...found]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push({ id: m.id, ...(m.name ? { name: m.name } : {}) })
    }
    return out
  }, [found, extra])

  // A short list starts all checked; a long one starts empty (pick what you use).
  useEffect(() => {
    if (state.phase !== 'done' || !state.result.ok) return
    const ids = state.result.discovered.map(m => m.id)
    setChecked(prev => (prev.size > 0 ? prev : new Set(ids.length <= 8 ? ids : [])))
  }, [state])

  const taken = useMemo(() => new Set(providers.map(p => p.id)), [providers])
  const id = providerIdFromName(name || hostOf(baseURL), taken)
  const canSave = urlOk && name.trim().length > 0 && checked.size > 0 && !saving

  const addTyped = () => {
    const value = typedModel.trim()
    if (!value) return
    setExtra(prev => (prev.some(m => m.id === value) ? prev : [{ id: value }, ...prev]))
    setChecked(prev => new Set(prev).add(value))
    setTypedModel('')
  }

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const all = [...extra, ...found.filter(f => !extra.some(e => e.id === f.id))]
      const result = await window.api.providers.save(
        {
          id,
          kind: 'custom',
          displayName: name.trim(),
          api,
          baseURL: baseURL.trim(),
          models: all.map(m => {
            const discovered = found.find(f => f.id === m.id)
            return {
              id: m.id,
              ...(m.name ? { name: m.name } : {}),
              ...(discovered?.contextWindow ? { contextWindow: discovered.contextWindow } : {}),
              ...(discovered?.maxTokens ? { maxTokens: discovered.maxTokens } : {}),
              input: discovered?.input ?? ['text'],
              ...(checked.has(m.id) ? {} : { hidden: true }),
            }
          }),
        },
        cleanKey || undefined,
      )
      if (!result.ok) {
        setError(result.error)
        setSaving(false)
        return
      }
      onSaved?.(result.provider)
      onClose()
    } catch (err) {
      setError(String(err))
      setSaving(false)
    }
  }

  const index = PROTOCOLS.findIndex(([value]) => value === api)
  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} labelledBy={titleId} width={500}>
      <form onSubmit={(event) => { event.preventDefault(); void save() }} className="flex min-h-0 flex-col">
        <SheetHeader
          id={titleId}
          icon={<AccountGlyph name={name || '?'} size={32} />}
          title={t('accounts.custom.title')}
          subtitle={t('accounts.custom.subtitle')}
        />
        <div className="space-y-4 overflow-y-auto px-6 pb-6">
          <label className="block space-y-1.5">
            <span className="block text-[13px] font-medium">{t('accounts.custom.name')}</span>
            <input data-autofocus value={name} onChange={e => setName(e.target.value)} placeholder={t('accounts.custom.namePlaceholder')} className={field} />
          </label>
          <label className="block space-y-1.5">
            <span className="block text-[13px] font-medium">{t('accounts.custom.url')}</span>
            <input
              value={baseURL}
              onChange={e => setBaseURL(e.target.value)}
              placeholder={api === 'anthropic-messages' ? 'https://gateway.example' : 'https://gateway.example/v1'}
              spellCheck={false}
              aria-invalid={baseURL.trim() !== '' && !urlOk}
              className={`${field} font-mono ${baseURL.trim() !== '' && !urlOk ? 'border-destructive' : ''}`}
            />
          </label>
          <div className="space-y-1.5">
            <span className="block text-[13px] font-medium">{t('accounts.custom.protocol')}</span>
            <div role="radiogroup" aria-label={t('accounts.custom.protocol')} className="relative grid grid-cols-3 rounded-[9px] bg-foreground/[0.06] p-[3px]">
              <div
                aria-hidden
                className="absolute bottom-[3px] left-[3px] top-[3px] rounded-[7px] bg-card shadow-[0_1px_2px_var(--lg-depth),0_2px_8px_-4px_var(--shadow)] ring-1 ring-border/50 transition-transform duration-200 ease-mlx"
                style={{ width: 'calc((100% - 6px) / 3)', transform: `translateX(${index * 100}%)` }}
              />
              {PROTOCOLS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={api === value}
                  onClick={() => setApi(value)}
                  className={`relative h-7 rounded-[7px] text-[13px] font-medium transition-colors duration-200 ${api === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
          <label className="block space-y-1.5">
            <span className="block text-[13px] font-medium">{t('accounts.custom.key')}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder={t('accounts.custom.keyPlaceholder')}
              className={`${field} font-mono`}
            />
          </label>

          <div>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[13px] font-medium">{t('accounts.custom.models')}</span>
              <Btn size="md" disabled={!urlOk || state.phase === 'checking'} onClick={retry}>
                {t('accounts.custom.fetch')}
              </Btn>
            </div>
            <KeyStatus
              state={state}
              service={hostOf(baseURL) || t('accounts.custom.server')}
              onRetry={retry}
              okText={found.length > 0 ? t(countKey('accounts.custom.found', found.length), { count: found.length }) : t('accounts.custom.foundNone')}
            />
            <Reveal open={models.length > 0}>
              <div className="pt-3">
                <ModelChecklist
                  models={models}
                  checked={checked}
                  onToggle={(modelId) => setChecked(prev => {
                    const next = new Set(prev)
                    if (next.has(modelId)) next.delete(modelId)
                    else next.add(modelId)
                    return next
                  })}
                  onSetAll={(ids, on) => setChecked(prev => {
                    const next = new Set(prev)
                    for (const modelId of ids) on ? next.add(modelId) : next.delete(modelId)
                    return next
                  })}
                  maxHeight={200}
                />
              </div>
            </Reveal>
            <div className="flex items-center gap-2 pt-3">
              <input
                value={typedModel}
                onChange={e => setTypedModel(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addTyped()
                  }
                }}
                placeholder={t('accounts.custom.typeModel')}
                spellCheck={false}
                className={`${field} font-mono`}
              />
              <Btn size="lg" onClick={addTyped} disabled={!typedModel.trim()} aria-label={t('accounts.custom.addModel')}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t('accounts.custom.addModel')}
              </Btn>
            </div>
          </div>

          <Reveal open={!!error}>
            <p role="alert" className="text-[13px] text-destructive break-words">{error}</p>
          </Reveal>
        </div>
        <SheetFooter note={checked.size > 0 ? t(countKey('accounts.models.shownCount', checked.size), { count: checked.size }) : t('accounts.custom.pickOne')}>
          <Btn size="lg" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn size="lg" variant="primary" type="submit" data-default disabled={!canSave}>
            {saving && <Spinner />}
            {t('accounts.custom.add')}
          </Btn>
        </SheetFooter>
      </form>
    </Sheet>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host
  } catch {
    return ''
  }
}
