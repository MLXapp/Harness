import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Globe, X } from 'lucide-react'
import { useTranslation } from '../../i18n'

/**
 * Live view of the agent's browser. A small pill at the top right of the
 * chat ("example.com" with a thumbnail) that stays out of the transcript's
 * way; click it to see the page after the latest action. Hides with ×, comes
 * back on the next browser action. When the page closes, the pill fades out
 * with its last picture still in it (no jump cut).
 */
export function BrowserLiveView({ chatId }: { chatId: string }) {
  const { t } = useTranslation()
  const [view, setView] = useState<{ url: string; frame: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const clearTimer = useRef<number | null>(null)
  useEffect(() => {
    setView(null)
    setOpen(false)
    return window.api.chat.onBrowserFrame?.(data => {
      if (data.chatId !== chatId) return
      if (clearTimer.current) { window.clearTimeout(clearTimer.current); clearTimer.current = null }
      if (!data.open || !data.frame) {
        // Fade out first, then let the picture go.
        setOpen(false)
        clearTimer.current = window.setTimeout(() => { setView(null); setExpanded(false) }, 320)
        return
      }
      setView({ url: data.url, frame: data.frame })
      setOpen(true)
      setHidden(false)
    })
  }, [chatId])
  useEffect(() => () => { if (clearTimer.current) window.clearTimeout(clearTimer.current) }, [])
  const shown = !!view && open && !hidden
  let host = ''
  try { host = view ? new URL(view.url).host : '' } catch { host = view?.url ?? '' }
  return (
    <div data-vmlx-section="browser-live" aria-hidden={!shown} {...(!shown ? { inert: '' } : {})}
      className={`pointer-events-none absolute right-4 top-3 z-20 transition-[opacity,transform] duration-300 ease-mlx ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}>
      {view && (
        <div className={`mlx-live ${shown ? 'pointer-events-auto' : ''}`} style={{ width: expanded ? 440 : 216 }}>
          <div className="flex h-9 items-center gap-2 pl-1.5 pr-1.5">
            <button type="button" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}
              aria-label={expanded ? t('browser.smaller') : t('browser.bigger')}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-[9px] px-1 py-1 text-left hover:bg-foreground/[0.05]">
              <span className={`mlx-live-thumb ${expanded ? 'is-hidden' : ''}`} aria-hidden>
                <img src={view.frame} alt="" />
              </span>
              <Globe className={`h-3.5 w-3.5 shrink-0 text-muted-foreground ${expanded ? '' : 'hidden'}`} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" title={view.url}>{host}</span>
              <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-mlx ${expanded ? 'rotate-180' : ''}`} />
            </button>
            <button type="button" onClick={() => setHidden(true)} className="mlx-icon-btn h-6 w-6" aria-label={t('browser.hide')}><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="mlx-live-body" style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}>
            <div className="min-h-0 overflow-hidden">
              <img src={view.frame} alt={t('browser.alt', { host })} className="block w-full" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
