/**
 * Models page: popular local models, each with what it is good at, and a
 * dropdown of its builds (standard quantizations and, where one exists, an
 * abliterated build) with download size, the memory it needs and a Download
 * button. A download asks once (unless "Don't ask again"), and always says
 * so when the disk is too full or the build is too big for this Mac.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Download, Eye, HardDrive, Info, Search } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useMac } from '../media/hooks'
import { Reveal } from '../ui/Reveal'
import { Btn, Spinner } from '../accounts/ui'
import {
  CATALOG, CATALOG_CATEGORIES, bestForMac, catalogKey, catalogMatches, checkDownload, formatGB, memoryNeededGB,
  smallestStandard, variantFit, type CatalogCategory, type CatalogModel, type CatalogVariant,
} from '../../../../shared/modelCatalog'
import type { SearchFit } from '../../../../shared/searchFit'

const SKIP_CONFIRM_KEY = 'models_skip_download_confirm'

export function ModelCatalog({ downloading, downloaded, onDownload }: {
  downloading: ReadonlySet<string>
  downloaded: ReadonlySet<string>
  onDownload: (repo: string) => void
}) {
  const { t } = useTranslation()
  const mac = useMac()
  const memoryGB = mac?.memoryGB
  const [category, setCategory] = useState<CatalogCategory | 'all'>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<{ model: CatalogModel; variant: CatalogVariant; free: number | null } | null>(null)

  const refreshFree = async (): Promise<number | null> => {
    try {
      const r = await window.api.models.diskFree()
      setFreeBytes(r.freeBytes)
      return r.freeBytes
    } catch { return null }
  }
  useEffect(() => { void refreshFree() }, [])
  // Space changes as downloads land.
  useEffect(() => { void refreshFree() }, [downloading.size, downloaded.size])

  const models = useMemo(
    () => CATALOG.filter(m => (category === 'all' || m.category === category) && catalogMatches(m, query)),
    [category, query],
  )

  const start = async (model: CatalogModel, variant: CatalogVariant) => {
    const free = await refreshFree()
    const check = checkDownload(variant.bytes, free, memoryGB)
    let skip = false
    try { skip = (await window.api.settings.get(SKIP_CONFIRM_KEY)) === '1' } catch { /* ask */ }
    // "Don't ask again" skips only a download with nothing to warn about.
    if (skip && !check.hasIssue) { onDownload(variant.repo); return }
    setConfirm({ model, variant, free })
  }

  const chips: Array<CatalogCategory | 'all'> = ['all', ...CATALOG_CATEGORIES]

  return (
    <div className="space-y-4" data-vmlx-surface="model-catalog">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        {memoryGB ? <span>{t('models.catalog.thisMac', { gb: memoryGB })}</span> : null}
        {freeBytes !== null && (
          <span className="inline-flex items-center gap-1"><HardDrive className="h-3.5 w-3.5" />{t('models.catalog.freeSpace', { size: formatGB(freeBytes) })}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('models.catalog.categories')}>
          {chips.map(c => (
            <button key={c} type="button" role="tab" aria-selected={category === c} onClick={() => setCategory(c)}
              data-vmlx-control={`catalog-category-${c}`}
              className={`h-7 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-200 ${category === c ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'}`}>
              {t(`models.catalog.category.${c}`)}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('models.catalog.search')}
            data-vmlx-control="catalog-search"
            className="h-8 w-[220px] rounded-[8px] border border-input bg-background pl-8 pr-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
        </label>
      </div>

      <div className="overflow-hidden rounded-[12px] border border-border/70 bg-[rgb(var(--bg-2-rgb)/0.5)]">
        {models.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{t('models.catalog.none')}</p>}
        {models.map((model, i) => (
          <ModelRow key={model.id} model={model} first={i === 0} open={open === model.id} memoryGB={memoryGB}
            onToggle={() => setOpen(o => (o === model.id ? null : model.id))}
            downloading={downloading} downloaded={downloaded} onDownload={v => void start(model, v)} />
        ))}
      </div>
      <p className="px-1 text-[12px] leading-[17px] text-muted-foreground">{t('models.catalog.footnote')}</p>

      <DownloadConfirm request={confirm} memoryGB={memoryGB} onClose={() => setConfirm(null)}
        onConfirm={async (skipNext) => {
          if (!confirm) return
          if (skipNext) { try { await window.api.settings.set(SKIP_CONFIRM_KEY, '1') } catch { /* asks again */ } }
          onDownload(confirm.variant.repo)
          setConfirm(null)
        }} />
    </div>
  )
}

function FitTag({ fit, memoryGB, bytes }: { fit: SearchFit | null; memoryGB?: number; bytes: number }) {
  const { t } = useTranslation()
  if (!fit) return null
  const cls = fit === 'good' ? 'bg-success/15 text-success' : fit === 'tight' ? 'bg-warning/15 text-warning' : 'bg-destructive/10 text-destructive'
  return (
    <span className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ${cls}`} data-vmlx-fit={fit}
      title={fit === 'no' ? t('models.catalog.tooBigTitle', { gb: memoryGB ?? 0, need: memoryNeededGB(bytes) }) : undefined}>
      {t(`models.catalog.fit.${fit}`)}
    </span>
  )
}

function ModelRow({ model, first, open, memoryGB, onToggle, downloading, downloaded, onDownload }: {
  model: CatalogModel
  first: boolean
  open: boolean
  memoryGB?: number
  onToggle: () => void
  downloading: ReadonlySet<string>
  downloaded: ReadonlySet<string>
  onDownload: (v: CatalogVariant) => void
}) {
  const { t } = useTranslation()
  const small = smallestStandard(model)
  const best = bestForMac(model, memoryGB)
  const standard = model.variants.filter(v => v.kind === 'standard')
  const abliterated = model.variants.filter(v => v.kind === 'abliterated')
  const have = model.variants.some(v => downloaded.has(v.repo))
  return (
    <div className={first ? '' : 'border-t border-border/60'} data-vmlx-catalog-model={model.id}>
      <button type="button" onClick={onToggle} aria-expanded={open} data-vmlx-control={`catalog-toggle-${model.id}`}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200 hover:bg-foreground/[0.03]">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[14px] font-semibold">{model.name}</span>
            <span className="text-[12px] text-muted-foreground">{model.maker}</span>
            {model.vision && (
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 text-[11px] text-muted-foreground">
                <Eye className="h-3 w-3" />{t('models.catalog.vision')}
              </span>
            )}
            {have && (
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-primary/10 px-2 text-[11px] font-medium text-primary">
                <Check className="h-3 w-3" />{t('models.catalog.onThisMac')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-[17px] text-muted-foreground">{t(`models.catalog.desc.${catalogKey(model.id)}`)}</p>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
          {small && <span className="text-[12.5px] text-foreground mlx-num">{t('models.catalog.from', { size: formatGB(small.bytes) })}</span>}
          {best && <FitTag fit={variantFit(best.bytes, memoryGB)} memoryGB={memoryGB} bytes={best.bytes} />}
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-mlx ${open ? 'rotate-180' : ''}`} />
      </button>
      <Reveal open={open}>
        <div className="space-y-3 px-4 pb-4">
          <VariantGroup title={t('models.catalog.standard')} variants={standard} memoryGB={memoryGB}
            downloading={downloading} downloaded={downloaded} onDownload={onDownload} />
          <div>
            <p className="mb-1 flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('models.catalog.abliterated')}
              <span title={t('models.catalog.abliteratedHelp')} className="inline-flex"><Info className="h-3 w-3" /></span>
            </p>
            {abliterated.length > 0 ? (
              <VariantGroup variants={abliterated} memoryGB={memoryGB} showRepo
                downloading={downloading} downloaded={downloaded} onDownload={onDownload} />
            ) : (
              <p className="rounded-[9px] bg-foreground/[0.03] px-3 py-2 text-[12.5px] text-muted-foreground" data-vmlx-abliterated-none={model.id}>
                {t('models.catalog.notAvailable')}
              </p>
            )}
          </div>
        </div>
      </Reveal>
    </div>
  )
}

function VariantGroup({ title, variants, memoryGB, showRepo, downloading, downloaded, onDownload }: {
  title?: string
  variants: CatalogVariant[]
  memoryGB?: number
  showRepo?: boolean
  downloading: ReadonlySet<string>
  downloaded: ReadonlySet<string>
  onDownload: (v: CatalogVariant) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      {title && <p className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>}
      <div className="overflow-hidden rounded-[9px] bg-foreground/[0.03]">
        {variants.map((v, i) => {
          const fit = variantFit(v.bytes, memoryGB)
          const busy = downloading.has(v.repo)
          const done = downloaded.has(v.repo)
          return (
            <div key={v.repo} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${i ? 'border-t border-border/50' : ''}`}
              data-vmlx-variant={v.repo}>
              <span className="w-[92px] shrink-0 text-[13px] font-medium">{v.label}</span>
              <span className="w-[76px] shrink-0 text-[12.5px] text-foreground mlx-num" title={t('models.catalog.sizeTitle')}>{formatGB(v.bytes)}</span>
              <span className="min-w-[150px] text-[12.5px] text-muted-foreground mlx-num">{t('models.catalog.memory', { gb: memoryNeededGB(v.bytes) })}</span>
              <FitTag fit={fit} memoryGB={memoryGB} bytes={v.bytes} />
              {showRepo && <span className="min-w-0 basis-full truncate font-mono text-[11px] text-muted-foreground sm:basis-auto sm:flex-1" title={v.repo}>{v.repo.split('/').pop()}</span>}
              <span className="flex-1" />
              {done && !busy ? (
                <span className="inline-flex h-7 items-center gap-1.5 px-1 text-[12.5px] text-muted-foreground"><Check className="h-3.5 w-3.5 text-success" />{t('models.catalog.downloaded')}</span>
              ) : (
                <Btn size="md" variant="secondary" disabled={busy} data-vmlx-control={`catalog-download-${v.repo}`}
                  onClick={() => onDownload(v)}>
                  {busy ? <Spinner /> : <Download className="h-3.5 w-3.5" />}
                  {busy ? t('models.catalog.downloading') : t('models.catalog.download')}
                </Btn>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const EXIT_MS = 320

function DownloadConfirm({ request, memoryGB, onClose, onConfirm }: {
  request: { model: CatalogModel; variant: CatalogVariant; free: number | null } | null
  memoryGB?: number
  onClose: () => void
  onConfirm: (skipNext: boolean) => void
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  const [current, setCurrent] = useState(request)
  const [skipNext, setSkipNext] = useState(false)
  useEffect(() => {
    if (request) {
      setCurrent(request)
      setSkipNext(false)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const id = window.setTimeout(() => setCurrent(null), EXIT_MS)
    return () => window.clearTimeout(id)
  }, [request])
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, onClose])
  if (!current) return null
  const { model, variant, free } = current
  const check = checkDownload(variant.bytes, free, memoryGB)
  const need = memoryNeededGB(variant.bytes)
  return createPortal(
    <div className={`mlx-sheet-root ${shown ? 'is-shown' : ''}`} data-vmlx-surface="catalog-download-confirm">
      <div className="mlx-sheet-scrim" onMouseDown={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label={t('models.catalog.confirmTitle', { name: model.name })}
        className="mlx-sheet w-[440px] max-w-full p-5">
        {check.noSpace ? (
          <>
            <h2 className="text-[15px] font-semibold" data-vmlx-status="catalog-no-space">{t('models.catalog.noSpace')}</h2>
            <p className="mt-1.5 text-[13px] leading-[19px] text-muted-foreground">
              {t('models.catalog.noSpaceDetail', { size: formatGB(variant.bytes), free: formatGB(free ?? 0) })}
            </p>
            <div className="mt-5 flex justify-end">
              <Btn variant="primary" size="lg" onClick={onClose}>{t('common.ok')}</Btn>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-[15px] font-semibold">{t('models.catalog.confirmTitle', { name: model.name })}</h2>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted-foreground">{t('models.catalog.build')}</dt>
              <dd>{variant.label}{variant.kind === 'abliterated' ? ` · ${t('models.catalog.abliterated')}` : ''}</dd>
              <dt className="text-muted-foreground">{t('models.catalog.downloadSize')}</dt>
              <dd className="mlx-num">{formatGB(variant.bytes)}</dd>
              {free !== null && <>
                <dt className="text-muted-foreground">{t('models.catalog.freeOnMac')}</dt>
                <dd className="mlx-num">{formatGB(free)}</dd>
              </>}
              <dt className="text-muted-foreground">{t('models.catalog.memoryNeeded')}</dt>
              <dd className="mlx-num">{memoryGB ? t('models.catalog.memoryVsMac', { need, have: memoryGB }) : `${need} GB`}</dd>
            </dl>
            {check.fit === 'no' && (
              <p className="mt-3 rounded-[9px] bg-destructive/10 px-3 py-2 text-[12.5px] leading-[18px] text-destructive" data-vmlx-status="catalog-too-big">
                {t('models.catalog.warnTooBig', { need, have: memoryGB ?? 0 })}
              </p>
            )}
            {check.fit === 'tight' && (
              <p className="mt-3 rounded-[9px] bg-warning/10 px-3 py-2 text-[12.5px] leading-[18px] text-warning" data-vmlx-status="catalog-tight">
                {t('models.catalog.warnTight')}
              </p>
            )}
            {variant.kind === 'abliterated' && (
              <p className="mt-3 text-[12.5px] leading-[18px] text-muted-foreground">{t('models.catalog.abliteratedHelp')}</p>
            )}
            <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground" title={variant.repo}>{variant.repo}</p>
            <div className="mt-5 flex items-center gap-2">
              {!check.hasIssue && (
                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
                  <input type="checkbox" checked={skipNext} onChange={e => setSkipNext(e.target.checked)} data-vmlx-control="catalog-skip-confirm" />
                  {t('models.catalog.dontAsk')}
                </label>
              )}
              <span className="flex-1" />
              <Btn size="lg" onClick={onClose}>{t('common.cancel')}</Btn>
              <Btn variant="primary" size="lg" data-vmlx-control="catalog-confirm-download" onClick={() => onConfirm(skipNext)}>
                <Download className="h-3.5 w-3.5" />{t('models.catalog.download')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
