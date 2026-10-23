import { Boxes, CalendarClock, Globe, PanelLeftClose, Server, Settings, SquarePen, type LucideIcon } from 'lucide-react'
import { Reveal } from '../ui/Reveal'
import { useTasks } from '../preferences/TasksPreference'
import { useAppState } from '../../contexts/AppStateContext'
import { useTranslation } from '../../i18n'
import { consolePageForMode, isWorkspaceTab, type ConsolePage } from '../../lib/consoleNavigation'
import { Emblem, Wordmark } from '../brand/Logo'
import { Sidebar } from './Sidebar'

interface ConsoleSidebarProps {
  onChatSelect: (chatId: string, modelPath: string) => void
  onNewChat: () => void
}

// Item geometry is fixed so the selection can slide between rows.
const ROW = 34
const GAP = 2

/**
 * The sidebar: window glass on macOS (vibrancy 'sidebar' under a translucent
 * MLX orange -> coral wash), the traffic lights in its 52px top strip, a New
 * button for the current workspace, the app's other pages, history, and
 * Preferences at the bottom. Hiding it slides the width to zero; the inner
 * column keeps its width so nothing reflows while it moves.
 */
export function ConsoleSidebar({ onChatSelect, onNewChat }: ConsoleSidebarProps) {
  const { state, setMode, dispatch, openPreferences } = useAppState()
  const { t } = useTranslation()
  const page = consolePageForMode(state.mode)
  const collapsed = state.sidebarCollapsed
  const workspace = isWorkspaceTab(state.mode) ? state.mode : 'chat'
  const items: Array<[Exclude<ConsolePage, 'chat'>, LucideIcon, string]> = [
    ['models', Boxes, t('console.models')],
    ['server', Server, t('console.serversApi')],
    ['network', Globe, t('console.network')],
  ]
  const activeIndex = items.findIndex(([mode]) => mode === page)

  const go = (mode: Exclude<ConsolePage, 'chat'>) => {
    if (mode === 'models') setMode('tools')
    else setMode(mode)
  }

  const startNew = () => {
    if (workspace === 'code') {
      // A Code session starts on the Code start screen (folder + access).
      setMode('code')
      dispatch({ type: 'CLOSE_CHAT' })
    } else if (workspace === 'chat') {
      setMode('chat')
      onNewChat()
    } else {
      setMode(workspace)
      window.dispatchEvent(new CustomEvent('vmlx:new', { detail: { tab: workspace } }))
    }
  }

  return (
    <aside data-vmlx-section="console-sidebar" aria-hidden={collapsed || undefined}
      // Hidden: out of the Tab order too, not just out of sight.
      {...(collapsed ? { inert: '' } : {})}
      className={`mlx-sidebar shrink-0 min-h-0 overflow-hidden transition-[width] duration-300 ease-mlx ${collapsed ? 'w-0' : 'w-[272px] max-[900px]:w-[236px]'}`}>
      <div className={`h-full w-[272px] max-[900px]:w-[236px] flex flex-col transition-opacity duration-300 ease-mlx ${collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
        {/* Top strip: traffic lights (left, drawn by macOS) and the hide button. */}
        <div className="h-[52px] shrink-0 flex items-center justify-end px-3 drag-region">
          <button type="button" onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
            data-vmlx-control="sidebar-hide" title={t('app.sidebar.hide')} aria-label={t('app.sidebar.hide')}
            className="mlx-icon-btn no-drag">
            <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex items-center gap-2.5 px-[18px] pb-3 shrink-0" aria-label="MLX Harness">
          <Emblem size={24} className="shrink-0" />
          <span data-vmlx-control="app-logo" className="text-[16px] leading-none text-foreground whitespace-nowrap">
            <Wordmark /> <span className="font-medium text-muted-foreground">Harness</span>
          </span>
        </div>

        <div className="px-3 pb-2 shrink-0">
          <button type="button" data-vmlx-control="workspace-new" onClick={startNew}
            className="mlx-new-btn">
            <SquarePen className="h-[17px] w-[17px] text-primary" strokeWidth={1.9} aria-hidden />
            <span key={workspace} className="mlx-fade-in">{t(`shell.new.${workspace}`)}</span>
          </button>
        </div>

        <nav aria-label={t('console.pages')} className="relative px-3 pb-2 shrink-0">
          {/* Sliding selection */}
          <div aria-hidden
            className="absolute left-3 right-3 rounded-[10px] bg-[var(--sidebar-row)] transition-[transform,opacity] duration-300 ease-mlx"
            style={{ height: ROW, transform: `translateY(${Math.max(0, activeIndex) * (ROW + GAP)}px)`, opacity: activeIndex < 0 ? 0 : 1 }} />
          <div className="relative flex flex-col" style={{ gap: GAP }}>
            {items.map(([mode, Icon, label]) => {
              const active = page === mode
              return <button key={mode} data-vmlx-control={`mode-${mode}`}
                data-vmlx-state={active ? 'active' : 'inactive'} aria-current={active ? 'page' : undefined}
                title={label} aria-label={label}
                onClick={() => go(mode)}
                style={{ height: ROW }}
                className={`w-full flex items-center gap-3 px-[10px] rounded-[10px] text-[13.5px] text-left whitespace-nowrap ${active
                  ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-[var(--sidebar-hover)]'}`}>
                <Icon className={`h-[18px] w-[18px] shrink-0 transition-colors ${active ? 'text-primary' : ''}`} strokeWidth={1.8} />
                <span>{label}</span>
              </button>
            })}
          </div>
        </nav>

        {/* Keep history/search state across page changes. */}
        <div className="flex-1 min-h-0 mlx-hair-t">
          <Sidebar embedded collapsed={false} currentChatId={state.activeChatId}
            filter={workspace === 'code' ? 'code' : 'chat'}
            onNewChat={startNew}
            onChatSelect={(id, path, codeDirectory) => {
              // A Code session opens in Code, any other chat in Chat.
              if (id) setMode(codeDirectory ? 'code' : 'chat')
              onChatSelect(id, path)
            }} />
        </div>

        <TasksLink onOpen={() => openPreferences('tasks')} />
        <button data-vmlx-control="console-preferences" title={t('console.preferences')}
          aria-label={t('console.preferences')}
          className="shrink-0 mlx-hair-t h-12 px-[21px] flex items-center gap-3 text-[13.5px] text-left text-muted-foreground hover:text-foreground hover:bg-[var(--sidebar-hover)] whitespace-nowrap"
          onClick={() => openPreferences()}>
          <Settings className="h-[18px] w-[18px] shrink-0" strokeWidth={1.8} />
          <span>{t('console.preferences')}</span>
        </button>
      </div>
    </aside>
  )
}

/** Shown only while scheduled tasks exist: how many, and whether one runs. */
function TasksLink({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation()
  const tasks = useTasks()
  const count = tasks?.length ?? 0
  const running = tasks?.some(x => x.running) ?? false
  return (
    <Reveal open={count > 0}>
      <button type="button" data-vmlx-control="console-tasks" onClick={onOpen}
        className="mlx-hair-t flex h-11 w-full items-center gap-3 px-[21px] text-left text-[13.5px] text-muted-foreground hover:bg-[var(--sidebar-hover)] hover:text-foreground">
        <CalendarClock className="h-[18px] w-[18px] shrink-0" strokeWidth={1.8} />
        <span className="flex-1">{t('tasks.sidebar')}</span>
        {running ? <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--acc)] animate-pulse" /> : <span className="text-[12px] tabular-nums">{count}</span>}
      </button>
    </Reveal>
  )
}
