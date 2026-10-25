/** Lets a reply's card open the workspace panel its chat shows. */
import { createContext, useContext, type ReactNode } from 'react'

export interface WorkspaceApi {
  /** Open a reply's files (the page, or one file). */
  open: (messageId: string, path?: string) => void
  activeMessageId: string | null
}

const WorkspaceContext = createContext<WorkspaceApi>({ open: () => undefined, activeMessageId: null })
export const useWorkspace = () => useContext(WorkspaceContext)

export function WorkspaceProvider({ value, children }: { value: WorkspaceApi; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

