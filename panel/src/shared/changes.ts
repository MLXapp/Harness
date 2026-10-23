/** Changes review: what a turn's file tools changed (shared by main and the window). */

export type ChangeKind = 'added' | 'modified' | 'deleted'

export interface FileChange {
  /** Absolute path. */
  path: string
  /** Path as shown (relative to the working folder when inside it). */
  shown: string
  kind: ChangeKind
  added: number
  removed: number
  /** Not diffable (binary or too big): listed, its lines not shown. */
  opaque?: boolean
  /** sha1 of the content the turn left (null: the file was removed). */
  afterHash: string | null
  /** Set once reverted. */
  reverted?: boolean
  /** Its original was kept (or the turn created it), so it can be put back. */
  revertible?: boolean
}

export interface TurnChangeSet {
  chatId: string
  /** The assistant message the turn produced. */
  messageId: string
  at: number
  workingDir: string
  files: FileChange[]
}

export interface RevertResult {
  reverted: string[]
  /** Changed since the turn: not reverted unless confirmed. */
  conflicts: string[]
  failed: string[]
}

export interface FileTexts {
  before: string
  after: string
  opaque: boolean
  /** The file changed after the turn ended. */
  changedSince: boolean
}

/** Totals for a change set: "3 files changed +42 −7". */
export function changeTotals(set: Pick<TurnChangeSet, 'files'>): { files: number; added: number; removed: number; reverted: number } {
  let added = 0, removed = 0, reverted = 0
  for (const f of set.files) { added += f.added; removed += f.removed; if (f.reverted) reverted++ }
  return { files: set.files.length, added, removed, reverted }
}
