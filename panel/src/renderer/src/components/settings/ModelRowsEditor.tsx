/**
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License
 * (packages/client/ui-settings-models/src/client/ModelListEditor.tsx and
 * ModelReasoningEfforts.tsx).
 *
 * A provider's model rows: "Fetch available models" opens a searchable
 * multi-select of what the endpoint advertises; "Add selected" turns the
 * picks into editable rows (context window, max output tokens, image input,
 * reasoning levels). Rows can also be added by id. Rows open and close by
 * height, never with a jump.
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Download, Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Reveal } from '../ui/Reveal'
import { formatCapacity, isValidCapacity, parseCapacity } from '../../../../shared/providers/capacity'
import {
  PROVIDER_REASONING_LEVELS,
  type DiscoveredModel,
  type ProviderModel,
  type ProviderReasoningLevel,
} from '../../../../shared/providers/types'

export interface ModelDraftRow {
  key: string
  id: string
  name: string
  contextText: string
  maxText: string
  image: boolean
  reasoning: ProviderReasoningLevel[] | null
  open: boolean
  /** Not offered in the chat picker (kept as it was; Accounts → Choose models… sets it). */
  hidden?: boolean
}

let rowSeq = 0
const nextKey = () => `row-${++rowSeq}`

const DEFAULT_LEVELS: ProviderReasoningLevel[] = ['low', 'medium', 'high']

export function rowsFromModels(models: ProviderModel[]): ModelDraftRow[] {
  return models.map(m => ({
    key: nextKey(),
    id: m.id,
    name: m.name ?? '',
    contextText: formatCapacity(m.contextWindow),
    maxText: formatCapacity(m.maxTokens),
    image: m.input.includes('image'),
    reasoning: m.reasoningEfforts ? [...m.reasoningEfforts] : null,
    open: true,
    ...(m.hidden ? { hidden: true } : {}),
  }))
}

function rowFromDiscovered(m: DiscoveredModel): ModelDraftRow {
  return {
    key: nextKey(),
    id: m.id,
    name: m.name ?? '',
    contextText: formatCapacity(m.contextWindow),
    maxText: formatCapacity(m.maxTokens),
    image: m.input?.includes('image') ?? false,
    reasoning: null,
    open: true,
  }
}

export type RowProblem = 'idRequired' | 'idDuplicate' | 'capacity' | 'levels'

/** Validate rows; returns per-row problems and the models to save. */
export function modelsFromRows(rows: ModelDraftRow[]): { models: ProviderModel[]; problems: Map<string, RowProblem> } {
  const problems = new Map<string, RowProblem>()
  const seen = new Set<string>()
  const models: ProviderModel[] = []
  for (const row of rows.filter(r => r.open)) {
    const id = row.id.trim()
    const contextWindow = parseCapacity(row.contextText)
    const maxTokens = parseCapacity(row.maxText)
    if (!id) problems.set(row.key, 'idRequired')
    else if (seen.has(id)) problems.set(row.key, 'idDuplicate')
    else if (!isValidCapacity(contextWindow) || !isValidCapacity(maxTokens)) problems.set(row.key, 'capacity')
    else if (row.reasoning && !row.reasoning.some(l => l !== 'off')) problems.set(row.key, 'levels')
    seen.add(id)
    if (problems.has(row.key)) continue
    models.push({
      id,
      ...(row.name.trim() ? { name: row.name.trim() } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      input: row.image ? ['text', 'image'] : ['text'],
      ...(row.reasoning ? { reasoningEfforts: PROVIDER_REASONING_LEVELS.filter(l => row.reasoning!.includes(l)) } : {}),
      ...(row.hidden ? { hidden: true } : {}),
    })
  }
  return { models, problems }
}

const PROBLEM_KEYS: Record<RowProblem, string> = {
  idRequired: 'providers.rowIdRequired',
  idDuplicate: 'providers.rowIdDuplicate',
  capacity: 'providers.rowCapacity',
  levels: 'providers.rowLevels',
}

const inputClass =
  'w-full h-7 px-2 bg-background border border-input rounded-[7px] text-[13px] focus:outline-none focus:ring-1 focus:ring-ring transition-colors'

export function ModelRowsEditor({ rows, onChange, onDiscover, canDiscover, idPrefix, showProblems }: {
  rows: ModelDraftRow[]
  onChange: Dispatch<SetStateAction<ModelDraftRow[]>>
  onDiscover: () => Promise<{ ok: true; models: DiscoveredModel[] } | { ok: false; error: string }>
  canDiscover: boolean
  idPrefix: string
  showProblems: boolean
}) {
  const { t } = useTranslation()
  const [candidates, setCandidates] = useState<DiscoveredModel[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [manualId, setManualId] = useState('')

  const { problems } = useMemo(() => modelsFromRows(rows), [rows])
  const existingIds = useMemo(() => new Set(rows.filter(r => r.open).map(r => r.id.trim())), [rows])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = candidates ?? []
    return q ? list.filter(m => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)) : list
  }, [candidates, query])

  const update = (key: string, patch: Partial<ModelDraftRow>) =>
    onChange(current => current.map(r => (r.key === key ? { ...r, ...patch } : r)))

  const discover = async () => {
    setDiscovering(true)
    setDiscoverError(null)
    try {
      const result = await onDiscover()
      if (!result.ok) {
        setDiscoverError(result.error)
        return
      }
      setCandidates(result.models)
      setSelected(new Set())
      setQuery('')
      setPickerOpen(true)
    } catch (err) {
      setDiscoverError(String(err))
    } finally {
      setDiscovering(false)
    }
  }

  const addSelected = () => {
    const picks = (candidates ?? []).filter(m => selected.has(m.id) && !existingIds.has(m.id))
    onChange(current => [...current, ...picks.map(rowFromDiscovered)])
    setPickerOpen(false)
    setSelected(new Set())
  }

  const addManual = () => {
    const id = manualId.trim()
    if (!id || existingIds.has(id)) return
    onChange(current => [...current, { key: nextKey(), id, name: '', contextText: '', maxText: '', image: false, reasoning: null, open: true }])
    setManualId('')
  }

  const openRows = rows.filter(r => r.open)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground flex-1">{t('providers.modelsHeading')}</span>
        <button
          type="button"
          onClick={discover}
          disabled={!canDiscover || discovering}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-50 transition-colors"
        >
          {discovering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {discovering ? t('providers.fetching') : t('providers.fetchModels')}
        </button>
      </div>

      <Reveal open={!!discoverError}>
        <p role="alert" className="text-[12px] text-destructive break-words pb-1">{discoverError}</p>
      </Reveal>

      {/* Searchable multi-select of what the endpoint advertises. */}
      <Reveal open={pickerOpen && candidates !== null}>
        <div className="border border-border rounded-md p-2 space-y-2 bg-background/60">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('providers.searchModels')}
              aria-label={t('providers.searchModels')}
              className={`${inputClass} pl-6`}
            />
          </div>
          <div className="max-h-56 overflow-y-auto space-y-0.5" role="listbox" aria-multiselectable="true">
            {visible.length === 0 && (
              <p className="text-[12px] text-muted-foreground px-1 py-2">{t('providers.noModelsFound')}</p>
            )}
            {visible.map(m => {
              const already = existingIds.has(m.id)
              const checked = already || selected.has(m.id)
              return (
                <label
                  key={m.id}
                  title={m.name || m.id}
                  className={`flex items-center gap-2 px-1.5 py-1 rounded text-xs transition-colors ${already ? 'opacity-50' : 'hover:bg-accent cursor-pointer'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={already}
                    onChange={() => {
                      const next = new Set(selected)
                      if (next.has(m.id)) next.delete(m.id)
                      else next.add(m.id)
                      setSelected(next)
                    }}
                  />
                  <span className="font-mono truncate">{m.id}</span>
                  {m.name && <span className="text-muted-foreground truncate">{m.name}</span>}
                </label>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSelected(new Set([...selected, ...visible.filter(m => !existingIds.has(m.id)).map(m => m.id)]))}
            >
              {t('providers.selectAll')}
            </button>
            <button
              type="button"
              className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSelected(new Set())}
            >
              {t('providers.deselectAll')}
            </button>
            <span className="flex-1" />
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground px-2 py-1" onClick={() => setPickerOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={addSelected}
              disabled={selected.size === 0}
              className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {t('providers.addSelected', { count: selected.size })}
            </button>
          </div>
        </div>
      </Reveal>

      <Reveal open={openRows.length === 0}>
        <p className="text-[12px] text-muted-foreground pb-1">{t('providers.noModelsYet')}</p>
      </Reveal>

      {rows.map(row => {
        const problem = showProblems ? problems.get(row.key) : undefined
        const fieldId = `${idPrefix}-${row.key}`
        return (
          <Reveal key={row.key} open={row.open} onClosed={() => onChange(current => current.filter(r => r.key !== row.key))}>
            <div className={`border rounded-md p-2 space-y-2 mb-1 transition-colors ${problem ? 'border-destructive/60' : 'border-border'}`}>
              <div className="flex items-center gap-2">
                <input
                  value={row.id}
                  onChange={e => update(row.key, { id: e.target.value })}
                  aria-label={t('providers.modelId')}
                  placeholder={t('providers.modelId')}
                  spellCheck={false}
                  className={`${inputClass} font-mono flex-[3]`}
                />
                <input
                  value={row.name}
                  onChange={e => update(row.key, { name: e.target.value })}
                  aria-label={t('providers.modelName')}
                  placeholder={t('providers.modelName')}
                  className={`${inputClass} flex-[2]`}
                />
                <button
                  type="button"
                  onClick={() => update(row.key, { open: false })}
                  aria-label={t('providers.removeModel')}
                  title={t('providers.removeModel')}
                  className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground" htmlFor={`${fieldId}-ctx`}>
                  {t('providers.contextWindow')}
                  <input
                    id={`${fieldId}-ctx`}
                    value={row.contextText}
                    onChange={e => update(row.key, { contextText: e.target.value })}
                    onBlur={() => {
                      const value = parseCapacity(row.contextText)
                      if (value !== undefined && isValidCapacity(value)) update(row.key, { contextText: formatCapacity(value) })
                    }}
                    placeholder="128K"
                    className={`${inputClass} w-20 font-mono mlx-num`}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground" htmlFor={`${fieldId}-max`}>
                  {t('providers.maxTokens')}
                  <input
                    id={`${fieldId}-max`}
                    value={row.maxText}
                    onChange={e => update(row.key, { maxText: e.target.value })}
                    onBlur={() => {
                      const value = parseCapacity(row.maxText)
                      if (value !== undefined && isValidCapacity(value)) update(row.key, { maxText: formatCapacity(value) })
                    }}
                    placeholder="8K"
                    className={`${inputClass} w-20 font-mono mlx-num`}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={row.image} onChange={e => update(row.key, { image: e.target.checked })} />
                  {t('providers.imageInput')}
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer" title={t('providers.reasoningHelp')}>
                  <input
                    type="checkbox"
                    checked={row.reasoning !== null}
                    onChange={e => update(row.key, { reasoning: e.target.checked ? [...DEFAULT_LEVELS] : null })}
                  />
                  {t('providers.reasoning')}
                </label>
              </div>
              <Reveal open={row.reasoning !== null}>
                <div className="flex flex-wrap gap-1 pt-0.5" role="group" aria-label={t('providers.reasoning')}>
                  {PROVIDER_REASONING_LEVELS.map(level => {
                    const on = row.reasoning?.includes(level) ?? false
                    return (
                      <button
                        key={level}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onChange(current => current.map(r => {
                          if (r.key !== row.key) return r
                          const levels = r.reasoning ?? []
                          return { ...r, reasoning: levels.includes(level) ? levels.filter(l => l !== level) : [...levels, level] }
                        }))}
                        className={`px-2 py-0.5 text-[12px] rounded-full border transition-colors ${
                          on ? 'bg-primary/15 border-primary/40 text-primary' : 'border-border text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {t(`providers.levels.${level}`)}
                      </button>
                    )
                  })}
                </div>
              </Reveal>
              <Reveal open={!!problem}>
                <p className="text-[12px] text-destructive">{problem ? t(PROBLEM_KEYS[problem]) : ''}</p>
              </Reveal>
            </div>
          </Reveal>
        )
      })}

      <div className="flex items-center gap-2">
        <input
          value={manualId}
          onChange={e => setManualId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual() } }}
          placeholder={t('providers.addModelById')}
          aria-label={t('providers.addModelById')}
          spellCheck={false}
          className={`${inputClass} font-mono flex-1`}
        />
        <button
          type="button"
          onClick={addManual}
          disabled={!manualId.trim() || existingIds.has(manualId.trim())}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-50 transition-colors"
        >
          <Plus className="h-3 w-3" />
          {t('providers.add')}
        </button>
      </div>
    </div>
  )
}
