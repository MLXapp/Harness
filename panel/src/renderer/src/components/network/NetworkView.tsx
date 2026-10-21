// MLX Network page: the tie-in between MLX Harness and the MLX Network.
// Every number comes from mlx.app (via the main process) or from this Mac;
// while loading or on error the figures read "–", never a guess.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, Globe, Cpu, Wallet, ShieldAlert } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Emblem } from '../brand/Logo'
import { useMlxNode } from './useMlxNode'
import {
  MLX_DOWNLOAD_URL,
  MLX_RISKS_URL,
  MLX_WORLD_URL,
  formatMlx,
  normalizeWalletName,
  unitsToMlx,
  type NetworkSnapshot,
  type WalletMining,
} from '../../../../shared/mlxNetwork'

const INTL: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ko: 'ko-KR', ja: 'ja-JP', es: 'es-ES' }
const WALLET_SETTING = 'mlxWalletName'
const DASH = '–'

/** Poll while the window is visible; refresh at once when it comes back. */
function usePoll(fn: () => Promise<void> | void, ms: number, deps: unknown[] = []) {
  const saved = useRef(fn)
  saved.current = fn
  useEffect(() => {
    let stop = false
    let id: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try { await saved.current() } catch { /* reported by the callee */ }
      }
      if (!stop) id = setTimeout(tick, ms)
    }
    tick()
    const vis = () => { if (document.visibilityState === 'visible') { clearTimeout(id); tick() } }
    document.addEventListener('visibilitychange', vis)
    return () => { stop = true; clearTimeout(id); document.removeEventListener('visibilitychange', vis) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps])
}

/** A figure that glides to its new value instead of jumping (and never invents one). */
function AnimatedNumber({ value, format }: { value: number | null; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (value == null) { shown.current = null; el.textContent = DASH; return }
    const from = shown.current
    if (from == null || from === value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shown.current = value
      el.textContent = format(value)
      return
    }
    const start = performance.now()
    const dur = 700
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      const v = from + (value - from) * e
      shown.current = v
      el.textContent = format(p < 1 ? v : value)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, format])
  return <span ref={ref} className="mlx-num">{value == null ? DASH : format(value)}</span>
}

/**
 * Mined MLX that keeps counting while the wallet's Macs work: `base` at
 * local time `at`, growing `rate` MLX a second, redrawn every frame without
 * re-rendering. Small downward corrections are held (as on mlx.app).
 */
function LiveMlx({ base, rate, at, locale }: { base: number; rate: number; at: number; locale: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef<number | null>(null)
  useEffect(() => {
    let raf = 0
    let timer = 0
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let last = ''
    const draw = () => {
      let v = base + Math.max(0, rate) * Math.max(0, (Date.now() - at) / 1000)
      const prev = shown.current
      if (rate > 0 && prev != null && v < prev && prev - v <= rate * 90) v = prev
      shown.current = v
      const text = formatMlx(v, locale)
      if (ref.current && text !== last) { ref.current.textContent = text; last = text }
      if (rate > 0) {
        if (reduce) timer = window.setTimeout(draw, 1000)
        else raf = requestAnimationFrame(draw)
      }
    }
    draw()
    return () => { cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [base, rate, at, locale])
  return <span ref={ref} className="mlx-num">{formatMlx(base, locale)}</span>
}

/** Height follows content smoothly (grid-rows 0fr ↔ 1fr). */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-mlx ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      aria-hidden={!open || undefined}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

function Card({ tint, icon, title, children, section }: { tint: string; icon: ReactNode; title: string; children: ReactNode; section: string }) {
  return (
    <section data-vmlx-section={section} className={`glass ${tint} rounded-[20px] p-5 sm:p-6`}>
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-muted-foreground mb-4">
        {icon}{title}
      </h3>
      {children}
    </section>
  )
}

function Stat({ label, value, format }: { label: string; value: number | null; format: (n: number) => string }) {
  return (
    <div className="min-w-0">
      <div className="text-[26px] leading-none font-semibold tracking-[-0.02em] text-foreground truncate">
        <AnimatedNumber value={value} format={format} />
      </div>
      <div className="mt-2 text-xs text-muted-foreground truncate">{label}</div>
    </div>
  )
}

export function NetworkView() {
  const { t, locale } = useTranslation()
  const intl = INTL[locale] ?? 'en-US'
  const fmtInt = useCallback((n: number) => Math.round(n).toLocaleString(intl), [intl])
  // Big counts read better compact (18.2M).
  const fmtCount = useCallback((n: number) => n >= 100_000
    ? n.toLocaleString(intl, { notation: 'compact', maximumFractionDigits: 1 })
    : Math.round(n).toLocaleString(intl), [intl])

  // (a) live network totals
  const [net, setNet] = useState<{ snap: NetworkSnapshot | null; error: boolean; at: number | null }>({ snap: null, error: false, at: null })
  usePoll(async () => {
    const r = await window.api.network.getTotals()
    if (r.ok) setNet({ snap: r.data, error: false, at: Date.now() })
    else setNet(prev => ({ ...prev, error: true }))
  }, 15_000)
  const totals = net.snap?.totals ?? null

  // (b) MLX Node on this Mac (installable from the copy MLX Harness carries)
  const node = useMlxNode()
  const app = node.status
  // Keep the last message while its row folds away.
  const lastNodeError = useRef(node.error)
  if (node.error) lastNodeError.current = node.error

  // (c) wallet (name kept locally in the settings store)
  const [wallet, setWallet] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState(false)
  useEffect(() => {
    window.api.settings.get(WALLET_SETTING).then((v: string | null) => {
      const name = typeof v === 'string' ? normalizeWalletName(v) : null
      if (name) { setWallet(name); setDraft(name.replace(/\.mlx$/, '')) }
    }).catch(() => {})
  }, [])
  const [mining, setMining] = useState<{ data: WalletMining | null; skew: number; error: 'notFound' | 'unreachable' | null }>({ data: null, skew: 0, error: null })
  usePoll(async () => {
    if (!wallet) return
    const r = await window.api.network.getMining(wallet)
    if (r.ok) setMining({ data: r.data, skew: Date.now() - r.data.at, error: null })
    else setMining(prev => ({ ...prev, data: r.status === 404 ? null : prev.data, error: r.status === 404 ? 'notFound' : 'unreachable' }))
  }, 15_000, [wallet])
  const saveWallet = async () => {
    const name = normalizeWalletName(draft)
    if (!name) { setDraftError(true); return }
    setDraftError(false)
    if (name !== wallet) setMining({ data: null, skew: 0, error: null })
    setWallet(name)
    await window.api.settings.set(WALLET_SETTING, name)
  }
  const forgetWallet = async () => {
    setWallet(null)
    setDraft('')
    setMining({ data: null, skew: 0, error: null })
    await window.api.settings.delete(WALLET_SETTING)
  }

  const m = mining.data
  const minedBase = m ? unitsToMlx(m.locked) + unitsToMlx(m.pending) : 0
  const growing = !!m && m.state === 'mining' && m.rate > 0
  const stateText = !m ? '' : m.state === 'mining'
    ? t('network.stateMining', { n: m.macs, rate: formatMlx(m.rate * 3600, intl) })
    : m.state === 'paused' ? t('network.statePaused')
    : m.state === 'waiting' ? t('network.stateWaiting') : t('network.stateIdle')

  const appState = node.state
  const appDot = appState === 'running' ? 'bg-success'
    : appState === 'installing' ? 'bg-warning animate-[vmlx-pulse_2.4s_ease-in-out_infinite]'
    : appState === 'installed' ? 'bg-warning' : 'bg-muted-foreground/40'
  const canInstall = !!app && !app.installed && !!app.bundled

  return (
    <div data-vmlx-surface="network" className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto px-5 sm:px-8 py-8 space-y-5">
        <header className="flex items-start gap-4">
          <Emblem variant="circle-outline" size={40} className="shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h1 className="text-[28px] leading-tight font-bold tracking-[-0.025em]">{t('network.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground max-w-2xl">{t('network.subtitle')}</p>
          </div>
        </header>

        <Card section="network-live" tint="tint-blue" icon={<Globe className="h-4 w-4" />} title={t('network.liveTitle')}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-5">
            <Stat label={t('network.macsOnline')} value={totals?.online ?? null} format={fmtInt} />
            <Stat label={t('network.macsWorking')} value={totals?.working ?? null} format={fmtInt} />
            <Stat label={t('network.tokensPerSecond')} value={totals?.tps ?? null} format={fmtCount} />
            <Stat label={t('network.tokensToday')} value={totals?.tokensToday ?? null} format={fmtCount} />
            {(totals == null || totals.countries !== undefined) && (
              <Stat label={t('network.countries')} value={totals?.countries ?? null} format={fmtInt} />
            )}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${net.error ? 'bg-destructive' : net.snap ? 'bg-success animate-[vmlx-pulse_2.4s_ease-in-out_infinite]' : 'bg-muted-foreground/40'}`} />
              {net.error
                ? t('network.unreachable')
                : net.at ? t('network.updated', { time: new Date(net.at).toLocaleTimeString(intl) }) : t('network.loading')}
            </span>
            <a href={MLX_WORLD_URL} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[color:var(--link)] hover:underline">
              {t('network.openWorld')}<ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </Card>

        <div className="grid gap-5 md:grid-cols-2">
          <Card section="network-mac-app" tint="tint-orange" icon={<Cpu className="h-4 w-4" />} title={t('network.appTitle')}>
            <p className="text-sm text-muted-foreground">{t('network.appDesc')}</p>
            <div className="mt-4 flex items-center gap-2 text-sm">
              <span className={`h-2 w-2 rounded-full transition-colors duration-300 ${appDot}`} />
              <span data-vmlx-state={appState} className="font-medium">
                {appState === 'checking' ? t('network.appChecking')
                  : appState === 'installing' ? t('network.installing')
                  : appState === 'running' ? t('network.appRunning')
                  : appState === 'installed' ? t('network.appInstalled') : t('network.appMissing')}
              </span>
              {app?.installed && app.version && <span className="text-xs text-muted-foreground">· {t('network.appVersion', { version: app.version })}</span>}
              {canInstall && appState === 'missing' && <span className="text-xs text-muted-foreground">· {t('network.appBundled')}</span>}
            </div>
            <div className="mt-5">
              {app?.installed ? (
                <button data-vmlx-control="network-open-mlx" onClick={() => void node.open()} disabled={node.busy != null}
                  className="btn-core h-9 px-4 rounded-full text-sm font-semibold inline-flex items-center gap-2">
                  {t('network.openApp')}
                </button>
              ) : canInstall ? (
                <button data-vmlx-control="network-install-mlx-node" onClick={() => void node.install()} disabled={node.busy != null}
                  className="btn-core h-9 px-4 rounded-full text-sm font-semibold inline-flex items-center gap-2 transition-opacity duration-300 disabled:opacity-60">
                  {t('network.installApp')}
                </button>
              ) : (
                <a data-vmlx-control="network-get-mlx" href={MLX_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer"
                  aria-disabled={app == null || undefined}
                  className={`btn-core h-9 px-4 rounded-full text-sm font-semibold inline-flex items-center gap-2 transition-opacity duration-300 ${app == null ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                  {t('network.getApp')}<ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <Reveal open={node.error != null}>
              <p className="pt-3 text-xs text-muted-foreground">
                {lastNodeError.current ? t(`main.dialog.mlxNodeFailed.${lastNodeError.current}`) : ''}{' '}
                <a href={MLX_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[color:var(--link)] hover:underline">
                  {t('network.getApp')}<ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </Reveal>
          </Card>

                    <Card section="network-wallet" tint="tint-green" icon={<Wallet className="h-4 w-4" />} title={t('network.walletTitle')}>
            <p className="text-sm text-muted-foreground">{t('network.walletDesc')}</p>
            <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); void saveWallet() }}>
              <div className="relative flex-1 min-w-0">
                <input value={draft} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                  onChange={(e) => { setDraft(e.target.value); setDraftError(false) }}
                  placeholder={t('network.walletPlaceholder')} aria-label={t('network.walletTitle')}
                  aria-invalid={draftError || undefined}
                  className={`w-full h-9 pl-3 pr-12 rounded-[10px] bg-background/70 border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/25 ${draftError ? 'border-destructive' : 'border-input'}`} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-mono text-muted-foreground">{'.mlx'}</span>
              </div>
              <button type="submit" data-vmlx-control="network-wallet-save"
                className="h-9 px-4 rounded-full text-sm font-semibold bg-foreground text-background hover:opacity-90">
                {t('network.walletSave')}
              </button>
            </form>
            <Reveal open={draftError}>
              <p className="pt-2 text-xs text-destructive">{t('network.walletInvalid')}</p>
            </Reveal>
            <Reveal open={!!wallet}>
              <div className="pt-5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{t('network.mined')}</span>
                  <button type="button" onClick={() => void forgetWallet()} className="text-xs text-muted-foreground hover:text-foreground">
                    {t('network.walletClear')}
                  </button>
                </div>
                <div className="mt-1 text-[26px] leading-tight font-semibold tracking-[-0.02em] truncate" title={t('network.minedHint')}>
                  {m ? <LiveMlx base={minedBase} rate={growing ? m.rate : 0} at={m.at + mining.skew} locale={intl} /> : DASH}
                  <span className="ml-1.5 text-sm font-medium text-muted-foreground">MLX</span>
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground min-h-[18px]">
                  {mining.error === 'notFound' && wallet ? (
                    <span className="text-destructive">{t('network.walletNotFound', { name: wallet })}</span>
                  ) : mining.error === 'unreachable' && !m ? (
                    <span>{t('network.unreachable')}</span>
                  ) : m ? (
                    <>
                      <span className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${growing ? 'bg-success animate-[vmlx-pulse_2.4s_ease-in-out_infinite]' : m.state === 'paused' ? 'bg-warning' : 'bg-muted-foreground/40'}`} />
                      <span className="truncate">{stateText}</span>
                    </>
                  ) : wallet ? <span>{t('network.loading')}</span> : null}
                </div>
                {m && unitsToMlx(m.pending) > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground/80 mlx-num">
                    {t('network.unsettled', { amount: formatMlx(unitsToMlx(m.pending), intl) })}
                  </div>
                )}
              </div>
            </Reveal>
          </Card>
        </div>

        <Card section="network-explainer" tint="tint-indigo" icon={<ShieldAlert className="h-4 w-4" />} title={t('network.howTitle')}>
          <ul className="space-y-2 text-sm">
            <li>{t('network.howHarness')}</li>
            <li>{t('network.howMlx')}</li>
            <li className="text-muted-foreground">{t('network.howRisk')}</li>
          </ul>
          <a href={MLX_RISKS_URL} target="_blank" rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1 text-sm text-[color:var(--link)] hover:underline">
            {t('network.risks')}<ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Card>
      </div>
    </div>
  )
}
