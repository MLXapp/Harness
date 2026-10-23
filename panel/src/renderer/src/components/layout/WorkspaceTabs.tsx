import { useLayoutEffect, useRef, useState } from 'react'
import { AudioLines, Clapperboard, ImageIcon, MessageSquare, Music2, SquareTerminal, type LucideIcon } from 'lucide-react'
import { useAppState } from '../../contexts/AppStateContext'
import { useTranslation } from '../../i18n'
import { WORKSPACE_TABS, isWorkspaceTab } from '../../lib/consoleNavigation'
import type { WorkspaceTab } from '../../types/app-state'

const ICONS: Record<WorkspaceTab, LucideIcon> = {
  chat: MessageSquare,
  image: ImageIcon,
  video: Clapperboard,
  audio: AudioLines,
  music: Music2,
  code: SquareTerminal,
}

/**
 * Chat · Image · Video · Audio · Music · Code, as one segmented control in the
 * window's top strip. The raised thumb slides between segments (measured, so
 * every language lines up) and fades away on pages that are not a workspace
 * (Models, Servers & API, Network). Below 900px only the icons show.
 */
export function WorkspaceTabs() {
  const { state, setMode } = useAppState()
  const { t } = useTranslation()
  const active = isWorkspaceTab(state.mode) ? state.mode : null
  const refs = useRef(new Map<WorkspaceTab, HTMLButtonElement>())
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)
  const last = useRef<{ x: number; w: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = active ? refs.current.get(active) : null
      const next = el ? { x: el.offsetLeft, w: el.offsetWidth } : null
      if (next) last.current = next
      setThumb(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    refs.current.forEach(el => ro.observe(el))
    return () => ro.disconnect()
  }, [active, t])

  // When no tab is active the thumb stays where it was and fades out, so
  // coming back slides from a sensible place instead of from zero.
  const pos = thumb ?? last.current
  return (
    <nav aria-label={t('shell.tabs.label')} data-vmlx-section="workspace-tabs"
      className="mlx-seg no-drag" role="tablist">
      <div aria-hidden className="mlx-seg-thumb"
        style={{ transform: `translateX(${pos?.x ?? 0}px)`, width: pos?.w ?? 0, opacity: thumb ? 1 : 0 }} />
      {WORKSPACE_TABS.map(tab => {
        const Icon = ICONS[tab]
        const selected = active === tab
        const label = t(`shell.tabs.${tab}`)
        return (
          <button key={tab} role="tab" aria-selected={selected} title={label}
            data-vmlx-control={`tab-${tab}`} data-vmlx-state={selected ? 'active' : 'inactive'}
            ref={el => { if (el) refs.current.set(tab, el); else refs.current.delete(tab) }}
            onClick={() => setMode(tab)}
            className={`mlx-seg-item ${selected ? 'is-on' : ''}`}>
            <Icon className="mlx-seg-icon" strokeWidth={1.9} aria-hidden />
            <span className="mlx-seg-label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
