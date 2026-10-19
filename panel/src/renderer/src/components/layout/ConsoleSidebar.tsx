import { MessageSquare, Server, Boxes, Globe, Settings, type LucideIcon } from 'lucide-react'
import { useAppState } from '../../contexts/AppStateContext'
import { useTranslation } from '../../i18n'
import { consolePageForMode, type ConsolePage } from '../../lib/consoleNavigation'
import { Emblem, Wordmark } from '../brand/Logo'
import { Sidebar } from './Sidebar'

interface ConsoleSidebarProps {
  onChatSelect: (chatId: string, modelPath: string) => void
  onNewChat: () => void
}

// Item geometry is fixed so the selection can slide between rows.
const ROW = 36
const GAP = 2

export function ConsoleSidebar({ onChatSelect, onNewChat }: ConsoleSidebarProps) {
  const { state, setMode, dispatch } = useAppState()
  const { t } = useTranslation()
  const page = consolePageForMode(state.mode)
  const collapsed = state.sidebarCollapsed
  const items: Array<[ConsolePage, LucideIcon, string]> = [
    ['chat', MessageSquare, t('console.chatImages')],
    ['server', Server, t('console.serversApi')],
    ['models', Boxes, t('console.models')],
    ['network', Globe, t('console.network')],
  ]
  const activeIndex = items.findIndex(([mode]) => mode === page)
  const fade = `transition-opacity duration-300 ease-mlx whitespace-nowrap ${collapsed ? 'opacity-0' : 'opacity-100'}`

  const go = (mode: ConsolePage) => {
    if (mode === 'models') setMode('tools')
    else {
      setMode(mode)
      if (mode === 'server' && state.serverPanel === 'about') dispatch({ type: 'SET_SERVER_PANEL', panel: 'dashboard' })
    }
  }

  return (
    <aside data-vmlx-section="console-sidebar"
      className={`shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col min-h-0 overflow-hidden transition-[width] duration-300 ease-mlx ${collapsed ? 'w-14' : 'w-[244px] max-[900px]:w-[208px]'}`}>
      <div className="h-16 flex items-center gap-2.5 px-[14px] shrink-0" aria-label="MLX Studio">
        <Emblem size={28} className="shrink-0" />
        <span data-vmlx-control="app-logo" className={`text-[17px] leading-none text-foreground ${fade}`}>
          <Wordmark /> <span className="font-medium text-muted-foreground">Studio</span>
        </span>
      </div>
      <nav aria-label={t('console.pages')} className="relative px-2 pb-3">
        {/* Sliding selection */}
        <div aria-hidden
          className="absolute left-2 right-2 rounded-[10px] bg-card shadow-[0_1px_2px_var(--lg-depth),0_8px_20px_-14px_var(--shadow)] ring-1 ring-border/60 transition-[transform,opacity] duration-300 ease-mlx"
          style={{ height: ROW, transform: `translateY(${Math.max(0, activeIndex) * (ROW + GAP)}px)`, opacity: activeIndex < 0 ? 0 : 1 }} />
        <div className="relative flex flex-col" style={{ gap: GAP }}>
          {items.map(([mode, Icon, label]) => {
            const active = page === mode
            return <button key={mode} data-vmlx-control={`mode-${mode}`}
              data-vmlx-state={active ? 'active' : 'inactive'} aria-current={active ? 'page' : undefined}
              title={label} aria-label={label}
              onClick={() => go(mode)}
              style={{ height: ROW }}
              className={`w-full flex items-center gap-3 px-[10px] rounded-[10px] text-[13px] font-medium text-left ${active
                ? 'text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]'}`}>
              <Icon className={`h-[18px] w-[18px] shrink-0 transition-colors ${active ? 'text-primary' : ''}`} strokeWidth={1.9} />
              <span className={fade}>{label}</span>
            </button>
          })}
        </div>
      </nav>
      {/* Retain history/search state across primary-page changes; fade instead of cutting. */}
      <div className={`flex-1 min-h-0 border-t border-sidebar-border transition-opacity duration-300 ease-mlx ${collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        aria-hidden={collapsed || undefined}>
        <div className="h-full w-[244px] max-[900px]:w-[208px]">
          <Sidebar embedded collapsed={false} currentChatId={state.activeChatId}
            onNewChat={() => { setMode('chat'); onNewChat() }}
            onChatSelect={(id, path) => { setMode('chat'); onChatSelect(id, path) }} />
        </div>
      </div>
      <button data-vmlx-control="console-preferences" title={t('console.preferences')}
        aria-label={t('console.preferences')}
        className="mt-auto shrink-0 border-t border-sidebar-border h-12 px-[18px] flex items-center gap-3 text-[13px] text-left text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]"
        onClick={() => { setMode('server'); dispatch({ type: 'SET_SERVER_PANEL', panel: 'about' }) }}>
        <Settings className="h-[18px] w-[18px] shrink-0" strokeWidth={1.9} />
        <span className={fade}>{t('console.preferences')}</span>
      </button>
    </aside>
  )
}
