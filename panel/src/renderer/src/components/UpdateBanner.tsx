import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ArrowDownCircle, CheckCircle2 } from 'lucide-react'
import { useTranslation } from '../i18n'
import { bannerVisible, progressPercent, type UpdateState } from '../../../shared/appUpdate'

type T = (key: string, params?: Record<string, string | number>) => string

export interface UpdateBannerActions {
  onUpdate: () => void
  onLater: () => void
  onRestart: () => void
  onDownload: () => void
}

/** Failures where trying the same download again can help. */
const RETRYABLE = new Set(['network', 'size', 'checksum', 'mount', 'copy', 'busy'])

function megabytes(bytes: number | undefined): string {
  return String(Math.max(0, Math.round((bytes ?? 0) / 1_000_000)))
}

/**
 * In-app updates (src/main/app-updater.ts): offer → download with progress →
 * verify → Restart to update. The row opens and closes by animating its height,
 * and the progress bar moves with a transform, so nothing jumps.
 */
export function UpdateBanner() {
  const { t } = useTranslation()
  const [state, setState] = useState<UpdateState | null>(null)
  // Keep the last visible state while the row closes, so it doesn't empty out mid-animation.
  const [shown, setShown] = useState<UpdateState | null>(null)

  useEffect(() => {
    let alive = true
    const unsub = window.api.app.onUpdateState((next) => { if (alive) setState(next) })
    window.api.app.getUpdateState()
      .then((initial) => { if (alive) setState(prev => prev ?? initial) })
      .catch(() => {})
    return () => { alive = false; unsub() }
  }, [])

  const visible = bannerVisible(state)
  useEffect(() => { if (visible) setShown(state) }, [visible, state])

  const actions: UpdateBannerActions = {
    onUpdate: () => { void window.api.app.installUpdate() },
    onLater: () => { void window.api.app.dismissUpdate() },
    onRestart: () => { void window.api.app.restartToUpdate() },
    onDownload: () => { void window.api.app.openUpdateDownload() },
  }

  return (
    <Reveal open={visible}>
      {(visible ? state : shown) && <UpdateBannerContent state={(visible ? state : shown)!} t={t} {...actions} />}
    </Reveal>
  )
}

/** Height follows the content (measured), so opening, closing and every state change glide. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setHeight(el.offsetHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="mlx-update-reveal" data-open={open ? 'true' : 'false'} aria-hidden={!open}
      style={{ height: open ? height : 0 }} {...(!open ? { inert: '' } : {})}>
      <div ref={inner}>{children}</div>
    </div>
  )
}

export function UpdateBannerContent({ state, t, onUpdate, onLater, onRestart, onDownload }:
  { state: UpdateState; t: T } & UpdateBannerActions) {
  const { phase } = state
  const version = state.version ?? ''
  const working = phase === 'downloading' || phase === 'verifying'
  // The buttons that were there before work began, kept while they slide shut.
  const actionsPhase = working ? 'available' : phase
  const percent = phase === 'verifying' ? 100 : progressPercent(state.received, state.total)
  const reason = phase === 'error' && state.error ? state.error : phase === 'available' && state.blocked ? state.blocked : null

  const icon = phase === 'ready'
    ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
    : phase === 'error'
      ? <AlertCircle className="h-4 w-4 text-warning" aria-hidden />
      : <ArrowDownCircle className="h-4 w-4 text-primary" aria-hidden />

  let title: ReactNode
  if (phase === 'downloading') title = t('update.banner.downloading', { version })
  else if (phase === 'verifying') title = t('update.banner.verifying', { version })
  else if (phase === 'ready') title = t('update.banner.ready', { version })
  else if (phase === 'error') title = t('update.banner.failed', { version })
  else title = <><strong className="font-semibold">{t('update.banner.versionLabel', { version })}</strong>{' '}{t('update.banner.available')}</>

  const detail = reason
    ? t(`update.reason.${reason}`)
    : phase === 'available' || phase === 'ready' ? state.notes : undefined

  return (
    <div role="status" aria-live="polite" data-vmlx-section="release-update" data-vmlx-update-phase={phase}
      className="flex items-center gap-3 px-4 py-2 bg-accent/40 border-b border-border text-xs">
      <span className="shrink-0 flex items-center">{icon}</span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span key={phase} className="mlx-update-fade min-w-0 truncate text-foreground">{title}</span>
          {working && (
            <span className="mlx-update-fade ml-auto shrink-0 w-10 text-right text-muted-foreground mlx-num" data-vmlx-control="release-update-percent">
              {percent}%
            </span>
          )}
        </div>
        {detail && !working && (
          <div key={`${phase}:${reason ?? ''}`} className="mlx-update-fade mt-0.5 truncate text-muted-foreground" title={detail}>
            {detail}
          </div>
        )}
        {working && (
          <div className="mlx-update-fade mt-1.5">
            <div className="mlx-update-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
              data-vmlx-control="release-update-progress">
              <div className={`mlx-update-fill${phase === 'verifying' ? ' mlx-update-fill-busy' : ''}`}
                style={{ transform: `scaleX(${percent / 100})` }} />
            </div>
            <div key={phase} className="mlx-update-fade mt-1 text-muted-foreground mlx-num">
              {phase === 'verifying'
                ? t('update.banner.verifyingDetail')
                : t('update.banner.progress', { received: megabytes(state.received), total: megabytes(state.total) })}
            </div>
          </div>
        )}
      </div>

      {/* While working the buttons slide shut (width + fade) instead of vanishing. */}
      <div className="mlx-update-actions" data-hidden={working ? 'true' : 'false'} aria-hidden={working}>
        {actionsPhase === 'error' && (
          <a href="#" data-vmlx-control="release-update-manual" tabIndex={working ? -1 : undefined}
            onClick={(e) => { e.preventDefault(); onDownload() }}
            className="px-2 text-primary hover:text-primary/80 font-medium">
            {t('update.banner.downloadManually')}
          </a>
        )}
        <button type="button" data-vmlx-control="release-update-later" onClick={onLater} disabled={working}
          className="h-6 px-3 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent">
          {t('update.banner.later')}
        </button>
        {actionsPhase === 'available' && (
          <button type="button" data-vmlx-control={state.blocked ? 'release-update-download' : 'release-update-install'}
            onClick={state.blocked ? onDownload : onUpdate} disabled={working}
            className="h-6 px-3 rounded-full bg-primary text-primary-foreground font-medium">
            {state.blocked === 'mlxNode' ? t('update.banner.openNode') : state.blocked ? t('update.banner.download') : t('update.banner.update')}
          </button>
        )}
        {actionsPhase === 'ready' && (
          <button type="button" data-vmlx-control="release-update-restart" onClick={onRestart}
            className="h-6 px-3 rounded-full bg-primary text-primary-foreground font-medium">
            {t('update.banner.restart')}
          </button>
        )}
        {actionsPhase === 'error' && state.error && RETRYABLE.has(state.error) && (
          <button type="button" data-vmlx-control="release-update-retry" onClick={onUpdate}
            className="h-6 px-3 rounded-full bg-primary text-primary-foreground font-medium">
            {t('update.banner.retry')}
          </button>
        )}
      </div>
    </div>
  )
}
