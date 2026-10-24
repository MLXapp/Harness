import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Clapperboard, ImageIcon, Music2, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  controlsFor, defaultParams, INSTRUMENTAL_PARAM, estimateCost, mediaModel, modelsFor, MEDIA_PROVIDER_NAMES,
  type MediaKind, type MediaModel,
} from '../../../../shared/media/catalog'
import { canRun, localPossible, mediaFit, recommendedModel } from '../../../../shared/media/fit'
import type { MediaJob } from '../../../../shared/media/jobs'
import { openConnectAccount } from '../accounts/events'
import { Reveal } from '../ui/Reveal'
import { MediaCard } from './MediaCard'
import { ModelPicker } from './ModelPicker'
import { ParamChips } from './ParamChips'
import { VoiceSamplePanel, type VoiceSampleValue } from './VoiceSample'
import { readStored, useMac, useMediaAccounts, useMediaJobs, writeStored } from './hooks'
import { usd } from './format'

/** Section tags the music models read, inserted from the pills (kept in English: the models expect them). */
const SECTIONS = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro']

/** Seconds of work per second of music, measured on this Mac (from the last finished run). */
const rateKey = (modelId: string) => `mlx.media.rate.${modelId}`

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
  const [voice, setVoice] = useState<VoiceSampleValue | null>(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [voiceConsent, setVoiceConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const lyricsRef = useRef<HTMLTextAreaElement>(null)

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

  // Music: one Lyrics box and one Instrumental switch for every model.
  const instrumental = !!model?.instrumental && values.instrumental === true
  const takesLyrics = !!(model?.lyricsField || model?.lyricsInPrompt) && !instrumental
  const needsLyrics = !!model?.lyricsRequired && !instrumental && !lyrics.trim()
  const insertSection = (name: string) => {
    const el = lyricsRef.current
    const tag = `[${name}]`
    const at = el ? el.selectionStart : lyrics.length
    const before = lyrics.slice(0, at)
    const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''
    const next = `${before}${lead}${tag}\n${lyrics.slice(at)}`
    setLyrics(next)
    requestAnimationFrame(() => { const pos = before.length + lead.length + tag.length + 1; el?.focus(); el?.setSelectionRange(pos, pos) })
  }
  const openLyrics = () => { setLyricsOpen(true); requestAnimationFrame(() => lyricsRef.current?.focus()) }

  // A local song's time, once this Mac has made one with this model.
  const [rates, setRates] = useState<Record<string, number>>({})
  useEffect(() => {
    const next: Record<string, number> = {}
    for (const m of modelsFor(kind)) {
      const v = Number(readStored(rateKey(m.id)))
      if (Number.isFinite(v) && v > 0) next[m.id] = v
    }
    // The newest finished local run (not one that first downloaded the model) updates it.
    for (const job of jobs) {
      const secs = Number(job.values.duration)
      if (job.where !== 'local' || job.status !== 'done' || job.downloadedModel || !job.finishedAt || !(secs > 0)) continue
      const rate = (job.finishedAt - job.createdAt) / 1000 / secs
      if (next[job.modelId] === undefined || readStored(`${rateKey(job.modelId)}.job`) !== job.id) {
        next[job.modelId] = rate
        writeStored(rateKey(job.modelId), String(rate))
        writeStored(`${rateKey(job.modelId)}.job`, job.id)
      }
      break
    }
    setRates(next)
  }, [jobs, kind])
  const localSeconds = model?.where === 'local' && rates[model.id] && Number(values.duration) > 0 ? rates[model.id] * Number(values.duration) : undefined

  // Speech in a sample's voice: only with a model that can, and only once the
  // right to use that voice is confirmed.
  const clones = model?.where === 'local' && !!model.voiceCloning
  const useVoice = clones && !!voice
  const needsConsent = useVoice && !voiceConsent

  const needsConnect = model?.where === 'cloud' && fit?.state === 'cloud' && !fit.connected
  const ready = !!model && !!fit && canRun(fit) && prompt.trim().length > 0 && !needsLyrics && !needsConsent && !busy
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
      const result = await window.api.media.submit({
        modelId: model.id, prompt, lyrics: takesLyrics ? lyrics : undefined, values,
        ...(useVoice && voiceConsent ? { voiceSample: voice!.id } : {}),
      })
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
          {kind === 'music' && (
            <Reveal open={takesLyrics && lyricsOpen}>
              <div className="mx-3 mb-1 rounded-[14px] bg-[rgb(var(--bg-3-rgb)/0.6)]">
                <textarea ref={lyricsRef} data-vmlx-control="media-lyrics" value={lyrics} onChange={e => setLyrics(e.target.value)} rows={4}
                  placeholder={t('media.music.lyricsPlaceholder')}
                  className="block w-full resize-y bg-transparent px-3 pb-1 pt-2 text-[14px] leading-[1.5] placeholder:text-muted-foreground focus:outline-none" />
                <div className="flex flex-wrap items-center gap-1 px-2 pb-2" role="group" aria-label={t('media.music.sections')}>
                  {SECTIONS.map(name => (
                    <button key={name} type="button" onClick={() => insertSection(name)} className="mlx-tag-pill" data-vmlx-control={`media-section-${name}`}>
                      [{name}]
                    </button>
                  ))}
                </div>
              </div>
            </Reveal>
          )}
          {kind === 'audio' && (
            <Reveal open={clones && voiceOpen}>
              <VoiceSamplePanel sample={voice} onChange={setVoice} consent={voiceConsent} onConsent={setVoiceConsent} />
            </Reveal>
          )}
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1">
            <ModelPicker kind={kind} model={model} mac={mac} connected={connected} onPick={choose} />
            {/* Vocals or instrumental first: it decides whether there are lyrics. */}
            {model?.instrumental && <ParamChips params={[INSTRUMENTAL_PARAM]} values={values} onChange={(k, v) => setValues(prev => ({ ...prev, [k]: v }))} />}
            {/* Instrumental folds the Lyrics chip away (no jump: its width animates). */}
            {!!(model?.lyricsField || model?.lyricsInPrompt) && (
              <span className={`mlx-hcollapse ${takesLyrics ? '' : 'is-closed'}`} {...(takesLyrics ? {} : { inert: '' })}>
                <span className="min-w-0 overflow-hidden">
                  <button type="button" onClick={() => lyricsOpen ? setLyricsOpen(false) : openLyrics()} className={`mlx-chip ${lyricsOpen ? 'is-on' : ''}`}
                    aria-expanded={lyricsOpen} data-vmlx-control="media-lyrics-toggle">
                    <Plus className={`h-3.5 w-3.5 transition-transform duration-200 ${lyricsOpen ? 'rotate-45' : ''}`} />{t('media.music.lyrics')}
                  </button>
                </span>
              </span>
            )}
            {kind === 'audio' && (
              <span className={`mlx-hcollapse ${clones ? '' : 'is-closed'}`} {...(clones ? {} : { inert: '' })}>
                <span className="min-w-0 overflow-hidden">
                  <button type="button" onClick={() => setVoiceOpen(o => !o)} className={`mlx-chip ${voiceOpen || voice ? 'is-on' : ''}`}
                    aria-expanded={voiceOpen} data-vmlx-control="media-voice-toggle">
                    <Plus className={`h-3.5 w-3.5 transition-transform duration-200 ${voiceOpen ? 'rotate-45' : ''}`} />
                    {voice ? t('media.voice.chipOn', { n: Math.round(voice.seconds) }) : t('media.voice.chip')}
                  </button>
                </span>
              </span>
            )}
            {model && <ParamChips params={model.params} values={values} onChange={(k, v) => setValues(prev => ({ ...prev, [k]: v }))} />}
            <span className="min-w-0 flex-1" />
            {estimate !== undefined && !needsConnect && (
              <span className="px-1 text-[12.5px] text-muted-foreground mlx-num" title={t('media.estimateTitle')}>≈ {usd(estimate)}</span>
            )}
            {localSeconds !== undefined && localSeconds >= 20 && (
              <span className="px-1 text-[12.5px] text-muted-foreground mlx-num" title={t('media.localTimeTitle')} data-vmlx-section="media-local-time">
                ≈ {localSeconds < 90 ? t('media.value.seconds', { n: Math.round(localSeconds / 5) * 5 }) : t('media.value.minutes', { n: Math.round(localSeconds / 60) })}
              </span>
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
        {/* A model that sings needs words; say so before Generate is pressed in vain. */}
        <Reveal open={needsLyrics && prompt.trim().length > 0 && !!fit && canRun(fit)}>
          <p className="flex flex-wrap items-center justify-center gap-x-1 px-4 pt-2 text-[12.5px] text-muted-foreground" data-vmlx-section="media-needs-lyrics">
            <span>{t('media.music.needsLyrics', { name: model?.name ?? '' })}</span>
            <button type="button" className="mlx-link" onClick={openLyrics}>{t('media.music.addLyrics')}</button>
            {model?.instrumental && <>
              <span aria-hidden>·</span>
              <button type="button" className="mlx-link" onClick={() => setValues(v => ({ ...v, instrumental: true }))}>{t('media.music.makeInstrumental')}</button>
            </>}
          </p>
        </Reveal>
        <Reveal open={needsConsent && !voiceOpen && prompt.trim().length > 0}>
          <p className="flex flex-wrap items-center justify-center gap-x-1 px-4 pt-2 text-[12.5px] text-muted-foreground" data-vmlx-section="media-needs-consent">
            <span>{t('media.voice.needsConsent')}</span>
            <button type="button" className="mlx-link" onClick={() => setVoiceOpen(true)}>{t('media.voice.review')}</button>
          </p>
        </Reveal>
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
  for (const p of controlsFor(model)) {
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
