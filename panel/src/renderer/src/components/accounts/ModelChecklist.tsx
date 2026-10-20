/**
 * A checklist of models (featured first), with search once there are more
 * than eight. Used by "Choose models…" and the Custom endpoint sheet.
 */
import { useMemo, useState } from 'react'
import { Check, Search } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { featuredModelIds } from '../../../../shared/accountSetup'
import { Badge } from './ui'

export interface ChecklistModel {
  id: string
  name?: string
}

export function ModelChecklist({ models, checked, onToggle, onSetAll, maxHeight = 280 }: {
  models: readonly ChecklistModel[]
  checked: ReadonlySet<string>
  onToggle: (id: string) => void
  onSetAll?: (ids: string[], on: boolean) => void
  maxHeight?: number
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const featured = useMemo(() => featuredModelIds(), [])
  const q = query.trim().toLowerCase()
  const visible = q
    ? models.filter(m => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q))
    : models
  return (
    <div className="space-y-2">
      {models.length > 8 && (
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('accounts.models.search', { count: models.length })}
              aria-label={t('accounts.models.searchLabel')}
              className="h-8 w-full rounded-[8px] border border-input bg-background pl-8 pr-2.5 text-[13px] transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25"
            />
          </label>
          {onSetAll && q && visible.length > 0 && (
            <button
              type="button"
              onClick={() => onSetAll(visible.map(m => m.id), !visible.every(m => checked.has(m.id)))}
              className="h-7 shrink-0 rounded-[7px] px-2 text-[13px] font-medium text-[color:var(--link)] transition-colors hover:bg-foreground/[0.06]"
            >
              {visible.every(m => checked.has(m.id)) ? t('accounts.models.noneOfThese') : t('accounts.models.allOfThese')}
            </button>
          )}
        </div>
      )}
      <div className="overflow-y-auto rounded-[10px] border border-border divide-y divide-border/70" style={{ maxHeight }}>
        {visible.length === 0 && (
          <p className="px-3 py-2.5 text-[13px] text-muted-foreground">{t('accounts.models.noMatch')}</p>
        )}
        {visible.map(model => {
          const on = checked.has(model.id)
          return (
            <button
              key={model.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onToggle(model.id)}
              className="flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-150 hover:bg-foreground/[0.04]"
            >
              <span
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-200 ${
                  on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
                }`}
                aria-hidden
              >
                <Check className={`h-3 w-3 transition-opacity duration-200 ${on ? 'opacity-100' : 'opacity-0'}`} strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-[18px]">{model.name || model.id}</span>
                {model.name && model.name !== model.id && (
                  <span className="block truncate font-mono text-[12px] leading-4 text-muted-foreground">{model.id}</span>
                )}
              </span>
              {featured.has(model.id) && <Badge>{t('accounts.models.recommended')}</Badge>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
