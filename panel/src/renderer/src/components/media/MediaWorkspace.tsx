import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Clapperboard, ImageIcon, Music2, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  defaultParams, estimateCost, mediaModel, modelsFor, MEDIA_PROVIDER_NAMES,
  type MediaKind, type MediaModel,
} from '../../../../shared/media/catalog'
import { canRun, localPossible, mediaFit, recommendedModel } from '../../../../shared/media/fit'
import type { MediaJob } from '../../../../shared/media/jobs'
import { openConnectAccount } from '../accounts/events'
import { Reveal } from '../ui/Reveal'
import { MediaCard } from './MediaCard'
import { ModelPicker } from './ModelPicker'
import { ParamChips } from './ParamChips'
import { readStored, useMac, useMediaAccounts, useMediaJobs, writeStored } from './hooks'
import { usd } from './format'

const ICON: Record<MediaKind, LucideIcon> = { image: ImageIcon, video: Clapperboard, audio: AudioLines, music: Music2 }

type Values = Record<string, string | number | boolean>

/**
 * A creative workspace (Video, Audio, Music, and Image in the cloud): results
 * above, an R26 composer below with the model, its settings, the list-price
 * estimate and Generate. The model menu ranks what runs on this Mac first,
 * greys out what this Mac cannot run (saying why, with the cloud model to use
 * instead) and offers to connect an account where one is missing.
 */
export function MediaWorkspace({ kind }: { kind: MediaKind }) {
  const { t } = useTranslation()
  const mac = useMac()
  const connected = useMediaAccounts()
  const { jobs, loaded, remove } = useMediaJobs(kind)
  const storageKey = `mlx.media.model.${kind}`
  const [modelId, setModelId] = useState<string | null>(() => readStored(storageKey))
  const [prompt, setPrompt] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [values, setValues] = useState<Values>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  // The stored pick, else the recommendation for this Mac and these accounts.
  const recommended = useMemo(() => recommendedModel(kind, mac, connected), [kind, mac, connected])
  const stored = mediaModel(modelId)
  const model: MediaModel | undefined = stored && stored.kind === kind ? stored : recommended
  const fit = model ? mediaFit(model, mac, connected) : null

  useEffect(() => { if (model) setValues(v => ({ ...defaultParams(model), ...pick(v, model) })) }, [model?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onNew = (e: Event) => {
      if ((e as CustomEvent).detail?.tab !== kind) return
      setPrompt(''); setLyrics(''); setError(null)
      promptRef.current?.focus()
    }
    window.addEventListener('vmlx:new', onNew)
    return () => window.removeEventListener('vmlx:new', onNew)
  }, [kind])

  const choose = (m: MediaModel) => { setModelId(m.id); writeStored(storageKey, m.id); setError(null) }
  const reuse = (job: MediaJob) => {
    const m = mediaModel(job.modelId)
    if (m) choose(m)
    setPrompt(job.prompt)
    if (job.lyrics) { setLyrics(job.lyrics); setLyricsOpen(true) }
    setValues(v => ({ ...v, ...job.values }))
    promptRef.current?.focus()
  }

  const needsConnect = model?.where === 'cloud' && fit?.state === 'cloud' && !fit.connected
  const ready = !!model && !!fit && canRun(fit) && prompt.trim().length > 0 && !busy
  const listEstimate = model ? estimateCost(model, values, prompt) : undefined
  // The provider's own quote for exactly these settings (no charge), a moment
  // after the settings stop changing; the list price shows until it arrives.
  const [quote, setQuote] = useState<{ key: string; usd: number } | null>(null)
  const quoteKey = model ? `${model.id}|${JSON.stringify(values)}|${model.where === 'cloud' && model.price?.per === '1k-chars' ? prompt.length : ''}` : ''
  useEffect(() => {
    if (!model || model.where !== 'cloud' || needsConnect) return
    let alive = true
    const id = window.setTimeout(() => {
      window.api.media.quote({ modelId: model.id, prompt: prompt || 'preview', values })
        .then(r => { if (alive && r.ok) setQuote({ key: quoteKey, usd: r.usd }) })
        .catch(() => undefined)
    }, 600)
    return () => { alive = false; window.clearTimeout(id) }
  }, [quoteKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const estimate = quote && quote.key === quoteKey ? quote.usd : listEstimate

  const generate = async () => {
    if (!model || !ready) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.media.submit({ modelId: model.id, prompt, lyrics: model.lyricsField ? lyrics : undefined, values })
      if (!result.ok) setError(result.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const Icon = ICON[kind]
  const wide = kind === 'image' || kind === 'video'
  const possible = localPossible(kind, mac)

  return (
    <div data-vmlx-surface={`media-${kind}`} className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-4">
        {loaded && jobs.length === 0 ? (
          <div className="mx-auto flex min-h-full max-w-[720px] flex-col items-center justify-center pb-10 text-center mlx-view-in">
            <div className="mlx-hero-tile"><Icon className="h-8 w-8" strokeWidth={1.7} /></div>
            <h2 className="mt-5 text-[26px] font-semibold tracking-[-0.02em]">{t(`media.${kind}.title`)}</h2>
            <p className="mt-2 max-w-[520px] text-[15px] leading-[22px] text-muted-foreground">{t(`media.${kind}.subtitle`)}</p>
            <MacNote kind={kind} possible={possible} mac={mac} />
            <div className="mt-6 flex max-w-[640px] flex-wrap justify-center gap-2">
              {[0, 1, 2].map(i => {
                const idea = t(`media.${kind}.ideas.${i}`)
                return (
                  <button key={i} type="button" onClick={() => { setPrompt(idea); promptRef.current?.focus() }}
                    className="mlx-idea">{idea}</button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className={wide
            ? 'mx-auto grid max-w-[1200px] grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4'
            : 'mx-auto flex max-w-[820px] flex-col gap-3'}>
            {jobs.map(job => <MediaCard key={job.id} job={job} onReuse={reuse} onDeleted={remove} />)}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-[868px] px-6 pb-5 pt-1">
        <div className="mlx-composer">
          <textarea ref={promptRef} data-vmlx-control="media-prompt" value={prompt}
            onChange={e => setPrompt(e.target.value)} rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || !e.shiftKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void generate() } }}
            placeholder={t(`media.${kind}.placeholder`)}
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 min-h-[56px] max-h-[200px] text-[15px] leading-[1.5] placeholder:text-muted-foreground focus:outline-none" />
          {model?.lyricsField && (
            <Reveal open={lyricsOpen}>
              <textarea data-vmlx-control="media-lyrics" value={lyrics} onChange={e => setLyrics(e.target.value)} rows={4}
                placeholder={t('media.music.lyricsPlaceholder')}
                className="mx-3 mb-1 block w-[calc(100%-24px)] resize-y rounded-[14px] bg-[rgb(var(--bg-3-rgb)/0.6)] px-3 py-2 text-[14px] leading-[1.5] placeholder:text-muted-foreground focus:outline-none" />
            </Reveal>
          )}
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1">
            <ModelPicker kind={kind} model={model} mac={mac} connected={connected} onPick={choose} />
            {model?.lyricsField && (
              <button type="button" onClick={() => setLyricsOpen(o => !o)} className={`mlx-chip ${lyricsOpen ? 'is-on' : ''}`}
                data-vmlx-control="media-lyrics-toggle">
                <Plus className={`h-3.5 w-3.5 transition-transform duration-200 ${lyricsOpen ? 'rotate-45' : ''}`} />{t('media.music.lyrics')}
              </button>
            )}
            {model && <ParamChips params={model.params} values={values} onChange={(k, v) => setValues(prev => ({ ...prev, [k]: v }))} />}
            <span className="min-w-0 flex-1" />
            {estimate !== undefined && !needsConnect && (
              <span className="px-1 text-[12.5px] text-muted-foreground mlx-num" title={t('media.estimateTitle')}>≈ {usd(estimate)}</span>
            )}
            {needsConnect && model?.where === 'cloud' ? (
              <button type="button" data-vmlx-control="media-connect" onClick={() => openConnectAccount(model.provider)}
                className="flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-[13.5px] font-medium text-background hover:opacity-90">
                {t('media.connect', { name: MEDIA_PROVIDER_NAMES[model.provider] })}
              </button>
            ) : (
              <button type="button" data-vmlx-control="media-generate" disabled={!ready} onClick={() => void generate()}
                className="mlx-generate">
                <Sparkles className="h-4 w-4" strokeWidth={2} />
                {t('media.generate')}
              </button>
            )}
          </div>
        </div>
        <Reveal open={!!error}>
          <p role="alert" className="px-4 pt-2 text-[12.5px] text-destructive">{error}</p>
        </Reveal>
        {model?.where === 'cloud' && !needsConnect && (
          <p className="px-4 pt-2 text-center text-[11.5px] text-muted-foreground/80">{t('media.cloudNote', { name: MEDIA_PROVIDER_NAMES[model.provider] })}</p>
        )}
      </div>
    </div>
  )
}

/** Values that still apply to the newly chosen model (same key, allowed value). */
function pick(values: Values, model: MediaModel): Values {
  const out: Values = {}
  for (const p of model.params) {
    const v = values[p.key]
    if (v === undefined) continue
    if (p.type === 'select' && !p.options.some(o => o === v)) continue
    if (p.type === 'toggle' && typeof v !== 'boolean') continue
    out[p.key] = v
  }
  return out
}

/** What this Mac can do for this tab, said once under the title. */
function MacNote({ kind, possible, mac }: { kind: MediaKind; possible: { runsHere: boolean; couldRunHere: boolean }; mac: ReturnType<typeof useMac> }) {
  const { t } = useTranslation()
  if (!mac || kind === 'image') return null
  const chip = mac.chip.replace(/^Apple /, '')
  const local = modelsFor(kind).filter(m => m.where === 'local')
  const minGB = Math.min(...local.map(m => (m.where === 'local' ? m.minMemoryGB : Infinity)))
  const key = possible.runsHere ? 'runsHere' : possible.couldRunHere ? 'soon' : 'cloudOnly'
  return (
    <div data-vmlx-section="media-mac-note" className="mt-5 inline-flex max-w-full items-start gap-2 rounded-[14px] bg-[rgb(var(--bg-2-rgb))] px-3.5 py-1.5 text-left text-[13px] leading-[19px] text-muted-foreground shadow-[var(--elev-1)]">
      {/* The dot sits on the first line, also when the sentence wraps. */}
      <span className={`mt-[6.5px] h-1.5 w-1.5 shrink-0 rounded-full ${possible.runsHere ? 'bg-success' : possible.couldRunHere ? 'bg-warning' : 'bg-[var(--sys-blue)]'}`} />
      <span>{t(`media.mac.${key}`, { chip, gb: mac.memoryGB, need: Number.isFinite(minGB) ? minGB : 16, what: t(`media.mac.what.${kind}`) })}</span>
    </div>
  )
}
