import { PanelLeft } from 'lucide-react'
import { useAppState } from '../../contexts/AppStateContext'
import { useTranslation } from '../../i18n'
import { consolePageForMode } from '../../lib/consoleNavigation'
import { WorkspaceTabs } from './WorkspaceTabs'
import { CHROME_END_ID } from './ChromeSlot'

/**
 * The content pane's 52px top strip: the window drags from it, the six
 * workspace tabs sit in the middle, and while the sidebar is hidden the
 * traffic lights get room on the left with the toggle beside them.
 * Language and appearance live only in Preferences.
 */
export function AppHeader() {
  const { state, dispatch } = useAppState()
  const { t } = useTranslation()
  const page = consolePageForMode(state.mode)
  const collapsed = state.sidebarCollapsed
  const title = page === 'models' ? t('console.models')
    : page === 'server' ? t('console.serversApi')
      : page === 'network' ? t('console.network')
        : ''

  return (
    <header data-vmlx-section="app-header" className="mlx-chrome drag-region">
      <div className="mlx-chrome-start">
        <div aria-hidden className="mlx-chrome-lights" style={{ width: collapsed ? 76 : 0 }} />
        <button type="button" onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          data-vmlx-control="sidebar-show" tabIndex={collapsed ? 0 : -1} aria-hidden={!collapsed || undefined}
          title={t('app.sidebar.show')} aria-label={t('app.sidebar.show')}
          className={`mlx-icon-btn no-drag ${collapsed ? 'opacity-100' : 'opacity-0 pointer-events-none -ml-8'}`}>
          <PanelLeft className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
        <span key={title} className="mlx-chrome-title mlx-fade-in">{title}</span>
      </div>
      <WorkspaceTabs />
      <div id={CHROME_END_ID} className="mlx-chrome-end" />
    </header>
  )
}
