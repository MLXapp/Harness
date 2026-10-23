import { useEffect, useState } from 'react'
import { Globe, Maximize2, Minimize2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'

/**
 * Live view of the agent's browser: the page after each action, in a small
 * card at the top right of the chat. Grows on click; hides with ×. Shows up
 * again on the next browser action.
 */
export function BrowserLiveView({ chatId }: { chatId: string }) {
  const { t } = useTranslation()
  const [view, setView] = useState<{ url: string; frame: string } | null>(null)
  const [hidden, setHidden] = useState(false)
  const [big, setBig] = useState(false)
  useEffect(() => {
    setView(null)
    return window.api.chat.onBrowserFrame?.(data => {
      if (data.chatId !== chatId) return
      if (!data.open || !data.frame) { setView(null); return }
      setView({ url: data.url, frame: data.frame })
      setHidden(false)
    })
  }, [chatId])
  const shown = !!view && !hidden
  let host = ''
  try { host = view ? new URL(view.url).host : '' } catch { host = view?.url ?? '' }
  return (
    <div data-vmlx-section="browser-live" aria-hidden={!shown}
      className={`pointer-events-none absolute right-4 top-3 z-20 transition-[opacity,transform] duration-300 ease-mlx ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}>
      {view && (
        <div className={`mlx-live ${shown ? 'pointer-events-auto' : ''}`} style={{ width: big ? 520 : 260 }}>
          <div className="flex h-8 items-center gap-1.5 px-2.5">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" title={view.url}>{host}</span>
            <button type="button" onClick={() => setBig(b => !b)} className="mlx-icon-btn h-6 w-6" aria-label={big ? t('browser.smaller') : t('browser.bigger')}>
              {big ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
            <button type="button" onClick={() => setHidden(true)} className="mlx-icon-btn h-6 w-6" aria-label={t('browser.hide')}><X className="h-3.5 w-3.5" /></button>
          </div>
          <img src={view.frame} alt={t('browser.alt', { host })} className="block w-full rounded-b-[12px]" />
        </div>
      )}
    </div>
  )
}
