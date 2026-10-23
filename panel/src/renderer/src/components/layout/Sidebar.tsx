import { useState } from 'react'
import { SidebarHeader } from './SidebarHeader'
import { ChatHistory } from './ChatHistory'

interface SidebarProps {
  embedded?: boolean
  collapsed: boolean
  currentChatId: string | null
  onChatSelect: (chatId: string, modelPath: string, codeDirectory?: string) => void
  onNewChat: () => void
  filter?: 'chat' | 'code'
}

export function Sidebar({ embedded = false, collapsed, currentChatId, onChatSelect, onNewChat, filter = 'chat' }: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <div
      className={`h-full bg-sidebar flex flex-col overflow-hidden ${embedded ? 'w-full' : 'border-r border-sidebar-border'} ${
        embedded ? '' : collapsed ? 'w-0' : 'w-[260px]'
      }`}
    >
      <SidebarHeader
        onNewChat={onNewChat}
        onSearch={setSearchQuery}
        title={filter === 'code' ? 'code' : 'chats'}
      />
      <ChatHistory
        currentChatId={currentChatId}
        onChatSelect={onChatSelect}
        searchQuery={searchQuery}
        filter={filter}
      />
    </div>
  )
}
