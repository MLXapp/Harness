/** Apps (Composio) types shared by main and the renderer. */
export type AppRule = 'ask' | 'always' | 'blocked'

export interface AppsStatusView {
  state: 'off' | 'connecting' | 'waiting-for-browser' | 'connected' | 'error'
  via: 'oauth' | 'key' | null
  error?: string
  toolCount?: number
  featured?: Array<{ id: string; name: string; connected?: boolean }>
}
