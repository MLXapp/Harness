import { useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface SidebarHeaderProps {
  onNewChat: () => void
  onSearch: (query: string) => void
  /** 'code' in the Code tab (its list holds Code sessions). */
  title?: 'chats' | 'code'
}

export function SidebarHeader({ onNewChat, onSearch, title = 'chats' }: SidebarHeaderProps) {
  const { t } = useTranslation()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  const handleSearchChange = (value: string) => {
    setQuery(value)
    onSearch(value)
  }

  const closeSearch = () => {
    setQuery('')
    setSearchOpen(false)
    onSearch('')
  }

  return (
    <div className="flex flex-col gap-2 pl-[22px] pr-3 pt-3 pb-1">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-muted-foreground flex-1">{title === 'code' ? t('code.sessions') : t('layout.sidebarHeader.chats')}</span>
        <button
          onClick={() => setSearchOpen(!searchOpen)}
          className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent transition-colors"
          title={t('layout.sidebarHeader.searchTitle')}
        >
          <Search className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onNewChat}
          data-vmlx-control="chat-new"
          className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent transition-colors"
          title={t('layout.sidebarHeader.newTitle')}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {searchOpen && (
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={e => handleSearchChange(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && closeSearch()}
            placeholder={t('layout.sidebarHeader.searchPlaceholder')}
            className="w-full pl-7 pr-7 h-8 bg-[rgb(var(--well-rgb)/0.7)] shadow-[var(--elev-1)] rounded-[9px] text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
          {query && (
            <button
              onClick={closeSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
