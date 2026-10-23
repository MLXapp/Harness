import { createContext, useContext } from 'react'

/** Which workspace a chat view sits in: the Chat tab or a Code session. */
export const WorkspaceKindContext = createContext<'chat' | 'code'>('chat')
export const useWorkspaceKind = () => useContext(WorkspaceKindContext)

/** Put text in the composer (starter prompts). */
export const COMPOSER_FILL_EVENT = 'vmlx:composer-fill'
export function fillComposer(text: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_FILL_EVENT, { detail: { text } }))
}
