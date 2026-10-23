import { useState, useEffect, useRef } from 'react'
import { Pencil, Trash2, X, Check, MessageSquare, Search, Trash } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface ChatSummary {
  id: string
  title: string
  modelId: string
  modelPath: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** Set when the chat is a Code session (its project folder). */
  codeDirectory?: string
}

interface ChatHistoryProps {
  currentChatId: string | null
  onChatSelect: (chatId: string, modelPath: string, codeDirectory?: string) => void
  searchQuery: string
  /** Chat tab: chats; Code tab: Code sessions. */
  filter?: 'chat' | 'code'
}

interface DateGroup {
  label: string
  chats: ChatSummary[]
}

function groupByDate(chats: ChatSummary[]): DateGroup[] {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7)
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30)

  const groups: Record<string, ChatSummary[]> = {
    'Today': [],
    'Yesterday': [],
    'This Week': [],
    'This Month': [],
    'Older': [],
  }

  for (const chat of chats) {
    const ts = chat.updatedAt
    if (ts >= today.getTime()) groups['Today'].push(chat)
    else if (ts >= yesterday.getTime()) groups['Yesterday'].push(chat)
    else if (ts >= weekAgo.getTime()) groups['This Week'].push(chat)
    else if (ts >= monthAgo.getTime()) groups['This Month'].push(chat)
    else groups['Older'].push(chat)
  }

  return Object.entries(groups)
    .filter(([_, chats]) => chats.length > 0)
    .map(([label, chats]) => ({ label, chats }))
}

export function ChatHistory({ currentChatId, onChatSelect, searchQuery, filter = 'chat' }: ChatHistoryProps) {
  const { t } = useTranslation()
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)
  const chatsRef = useRef(chats)
  chatsRef.current = chats

  const loadChats = async () => {
    try {
      const recent = await window.api.chat.getRecent(200)
      setChats(recent)
    } catch (e) {
      console.error('Failed to load chats:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadChats() }, [])
  // A chat became (or stopped being) a Code session, or was created elsewhere.
  useEffect(() => {
    const reload = () => { void loadChats() }
    window.addEventListener('vmlx:chats-changed', reload)
    return () => window.removeEventListener('vmlx:chats-changed', reload)
  }, [])

  // Refresh when a new chat is opened that we don't know about
  useEffect(() => {
    if (currentChatId && !chatsRef.current.find(c => c.id === currentChatId)) {
      loadChats()
    }
  }, [currentChatId])

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus()
      renameRef.current.select()
    }
  }, [renamingId])

  const handleRename = async (id: string) => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== chats.find(c => c.id === id)?.title) {
      await window.api.chat.update(id, { title: trimmed })
      setChats(prev => prev.map(c => c.id === id ? { ...c, title: trimmed } : c))
    }
    setRenamingId(null)
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    // vmlx#70: shift-click skips the confirm dialog for quick-delete mode
    // (matches the convention @scannermobs asked for — other apps use
    // shift as a modifier for destructive actions).
    if (!e.shiftKey && !confirm(t('layout.chatHistory.deleteConfirm'))) return
    await window.api.chat.delete(id)
    // Deselect if the deleted chat was the active one
    if (id === currentChatId) {
      onChatSelect('', '')
    }
    // Reload from DB to get a consistent view (avoids stale backfill on next refresh)
    loadChats()
  }

  // vmlx#70 @scannermobs: bulk-wipe all chats across every model. Calls
  // the already-exposed chat:deleteAll IPC (ChatList.tsx had it, but the
  // global Sidebar ChatHistory was stuck per-chat-only).
  const handleClearAll = async () => {
    const total = chats.length
    if (total === 0) return
    if (!confirm(t('layout.chatHistory.clearAllConfirm', { n: total }))) return
    try {
      const res = await window.api.chat.deleteAll()
      if (!res?.success) {
        console.error('[ChatHistory] clearAll failed:', res?.error)
        return
      }
      if (currentChatId) onChatSelect('', '')
      await loadChats()
    } catch (err) {
      console.error('[ChatHistory] clearAll error:', err)
    }
  }

  // This tab's chats, then the search.
  const inTab = chats.filter(c => (filter === 'code') === !!c.codeDirectory)
  const filtered = searchQuery
    ? inTab.filter(c => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : inTab

  const groups = groupByDate(filtered)

  if (loading) {
    return <div className="px-3 py-4 text-xs text-muted-foreground">{t('layout.chatHistory.loading')}</div>
  }

  if (filtered.length === 0) {
    return (
      <div className="px-3 py-8 flex flex-col items-center text-center">
        {searchQuery ? (
          <>
            <Search className="h-5 w-5 text-muted-foreground/40 mb-2" />
            <span className="text-xs text-muted-foreground">{t('layout.chatHistory.noResults')}</span>
          </>
        ) : (
          <>
            <MessageSquare className="h-5 w-5 text-muted-foreground/40 mb-2" />
            <span className="text-xs text-muted-foreground">{t(filter === 'code' ? 'layout.chatHistory.emptyCode' : 'layout.chatHistory.empty')}</span>
            <span className="text-[11px] text-muted-foreground/50 mt-0.5">{t(filter === 'code' ? 'layout.chatHistory.emptyCodeHint' : 'layout.chatHistory.emptyHint')}</span>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map(group => (
        <div key={group.label}>
          <div className="pl-[22px] pr-4 pt-3 pb-1 text-[11px] font-medium text-muted-foreground/80">
            {t(`layout.chatHistory.group${group.label.replace(/\s+/g, '')}`)}
          </div>
          {group.chats.map(chat => (
            <div
              key={chat.id}
              onClick={() => onChatSelect(chat.id, chat.modelPath, chat.codeDirectory)}
              className={`group flex min-h-[34px] items-center gap-2 px-2.5 py-1 mx-3 rounded-[10px] cursor-pointer transition-colors ${
                chat.id === currentChatId
                  ? 'bg-[var(--sidebar-row)] text-foreground'
                  : 'text-foreground/80 hover:bg-[var(--sidebar-hover)]'
              }`}
            >
              {renamingId === chat.id ? (
                <div className="flex-1 flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <input
                    ref={renameRef}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRename(chat.id)
                      if (e.key === 'Escape') { setRenamingId(null); setRenameValue('') }
                    }}
                    className="flex-1 min-w-0 bg-background border border-input rounded-md px-2 py-1 text-[13px]"
                  />
                  <button onClick={() => handleRename(chat.id)} className="flex h-6 w-6 items-center justify-center rounded-md text-primary hover:bg-foreground/[0.06]" aria-label={t('common.save')}>
                    <Check className="h-4 w-4" />
                  </button>
                  <button onClick={() => { setRenamingId(null); setRenameValue('') }} className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06]" aria-label={t('common.cancel')}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <span className="flex-1 text-[13.5px] leading-5 truncate">{chat.title}</span>
                  <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingId(chat.id)
                        setRenameValue(chat.title)
                      }}
                      className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] rounded-md"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(chat.id, e)}
                      className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {/* vmlx#70: delete every chat — a quiet row at the end of the list
          (shift-click skips the confirmation). */}
      {chats.length > 1 && !searchQuery && (
        <div className="px-3 pb-3 pt-4">
          <button
            type="button"
            onClick={handleClearAll}
            className="flex min-h-[32px] w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            aria-label={t('layout.chatHistory.clearAllAria')}
            title={t('layout.chatHistory.chatCountHint', { n: chats.length })}
          >
            <Trash className="h-3.5 w-3.5" />
            {t('layout.chatHistory.clearAll')}…
          </button>
        </div>
      )}
    </div>
  )
}
