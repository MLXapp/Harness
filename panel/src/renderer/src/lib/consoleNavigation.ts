import type { AppMode, WorkspaceTab } from '../types/app-state'

export type ConsolePage = 'chat' | 'server' | 'models' | 'network'

/** The top bar's workspaces, in order. */
export const WORKSPACE_TABS: readonly WorkspaceTab[] = ['chat', 'image', 'video', 'audio', 'music', 'code']

export function isWorkspaceTab(mode: AppMode | string | null | undefined): mode is WorkspaceTab {
  return (WORKSPACE_TABS as readonly string[]).includes(mode ?? '')
}

// Keep persisted modes and existing navigation events compatible. The six
// workspaces share the 'chat' page; the sidebar's pages are the rest.
export function consolePageForMode(mode: AppMode): ConsolePage {
  if (isWorkspaceTab(mode)) return 'chat'
  if (mode === 'tools' || mode === 'models') return 'models'
  if (mode === 'network') return 'network'
  return 'server'
}

export function restoreAppMode(value: string | null | undefined): AppMode {
  return ['chat', 'image', 'video', 'audio', 'music', 'code', 'server', 'api', 'tools', 'models', 'network'].includes(value ?? '')
    ? value as AppMode
    : 'chat'
}
