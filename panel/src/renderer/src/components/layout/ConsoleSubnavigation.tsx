import { useLayoutEffect, useRef, useState } from 'react'
import { useAppState } from '../../contexts/AppStateContext'
import { useTranslation } from '../../i18n'
import { consolePageForMode } from '../../lib/consoleNavigation'
import type { AppMode } from '../../types/app-state'

export function ConsoleSubnavigation() {
  const { state, setMode } = useAppState()
  const { t } = useTranslation()
  const page = consolePageForMode(state.mode)
  const items: Array<[AppMode, string]> = page === 'chat'
    ? [['chat', t('app.mode.chat')], ['image', t('app.mode.image')]]
    : page === 'server'
      ? [['server', t('app.mode.server')], ['api', t('app.mode.api')]]
      : [['tools', t('console.libraryTools')], ['models', t('console.findDownload')]]

  // A segmented control whose selection slides between segments. Position is
  // measured from the buttons so translated labels of any length line up.
  const refs = useRef(new Map<AppMode, HTMLButtonElement>())
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)
  const [animate, setAnimate] = useState(false)
  const pageRef = useRef(page)
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current.get(state.mode)
      setThumb(el ? { x: el.offsetLeft, w: el.offsetWidth } : null)
    }
    // Slide within a page; place without motion when the whole bar changes.
    setAnimate(pageRef.current === page)
    pageRef.current = page
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [state.mode, page, t])

  // The Network page has a single view: no section bar.
  if (page === 'network') return null
  return (
    <nav aria-label={t('console.sections')} data-vmlx-section="console-subnavigation"
      className="flex shrink-0 items-center border-b border-border px-4 h-11 bg-background">
      <div className="relative flex items-center gap-0.5 rounded-[10px] bg-foreground/[0.05] p-[3px]">
        <div aria-hidden
          className={`absolute top-[3px] bottom-[3px] left-0 rounded-[8px] bg-card shadow-[0_1px_2px_var(--lg-depth),0_4px_12px_-6px_var(--shadow)] ring-1 ring-border/50 ${animate ? 'transition-[transform,width,opacity] duration-300 ease-mlx' : ''}`}
          style={{ transform: `translateX(${thumb?.x ?? 0}px)`, width: thumb?.w ?? 0, opacity: thumb ? 1 : 0 }} />
        {items.map(([mode, label]) => (
          <button key={mode} data-vmlx-control={`section-${mode}`} aria-current={state.mode === mode ? 'page' : undefined}
            ref={(el) => { if (el) refs.current.set(mode, el); else refs.current.delete(mode) }}
            onClick={() => setMode(mode)}
            className={`relative px-3.5 h-7 text-[12.5px] font-medium rounded-[8px] transition-colors ${state.mode === mode
              ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {label}
          </button>
        ))}
      </div>
    </nav>
  )
}
