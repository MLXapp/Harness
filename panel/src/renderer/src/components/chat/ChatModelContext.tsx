import { createContext, useContext } from 'react'
import type { ChatModelBinding } from '../../../../shared/providers/types'

/**
 * The open chat's model, for the composer's model switcher: either a provider
 * model (binding) or an MLX session. Provided by the chat page (App.tsx);
 * absent elsewhere, where the composer shows no switcher.
 */
export interface ChatModelContextValue {
  chatId: string
  activeSessionId: string | null
  binding: ChatModelBinding | null
  /** Store (or clear) the chat's provider model. */
  setBinding: (next: ChatModelBinding | null) => Promise<void>
  /** Point the chat at an MLX session (local model or remote endpoint). */
  selectSession: (sessionId: string) => Promise<void>
  /** The chat has a model to send to. */
  hasModel: boolean
}

export const ChatModelContext = createContext<ChatModelContextValue | null>(null)

export function useChatModel(): ChatModelContextValue | null {
  return useContext(ChatModelContext)
}
