/**
 * Quit confirmation while the coding agent is working.
 *
 * Closing the window never stops an agent turn (the app keeps running in the
 * Dock / menu bar and the turn finishes in the main process). Quitting does,
 * so Quit asks first, naming the chats that are still working and the
 * background processes the agent started. Nothing running: quit silently.
 *
 * Adapted from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness),
 * apps/desktop/src/quit-confirmation.ts. Copyright (c) 2026 DeepSeek, MIT License
 * (the full MIT notice is in panel/src/main/agent/seatbelt.ts).
 */

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'

/** What quitting would interrupt. */
export interface QuitInspection {
  /** Titles of chats with a running turn. */
  chats: string[]
  /** Running background processes started by spawn_process. */
  processes: number
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Join chat titles for the dialog: up to three, quoted, then "+N". */
export function formatChatNames(titles: readonly string[], max = 3): string {
  const clean = titles.map(t => {
    const s = (t || '').replace(/\s+/g, ' ').trim() || 'New Chat'
    return `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”`
  })
  if (clean.length <= max) return clean.join(', ')
  return `${clean.slice(0, max).join(', ')} +${clean.length - max}`
}

/**
 * The dialog's detail text, or undefined when quitting interrupts nothing.
 * An inspection that failed ('unknown') warns rather than quitting silently.
 */
export function resolveQuitPrompt(inspection: QuitInspection | 'unknown', t: Translate): string | undefined {
  if (inspection === 'unknown') return t('main.dialog.quitAgentDetail')
  const lines: string[] = []
  if (inspection.chats.length > 0) lines.push(t('main.dialog.quitAgentChats', { names: formatChatNames(inspection.chats) }))
  if (inspection.processes > 0) lines.push(t('main.dialog.quitAgentProcesses', { count: inspection.processes }))
  if (lines.length === 0) return undefined
  lines.push(t('main.dialog.quitAgentDetail'))
  return lines.join('\n\n')
}

export interface QuitConfirmationOptions {
  inspect: () => QuitInspection
  t: Translate
  /** Native message box without an owner window (a hidden window stays hidden). */
  show: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  /** Bring the app (and the open box) to the front. */
  focus?: () => void
}

/** One decision at a time: a second Quit while the box is open joins it. */
export class QuitConfirmation {
  private pending: Promise<boolean> | undefined

  constructor(private readonly options: QuitConfirmationOptions) {}

  /** true to quit now, false when the user cancelled. */
  confirm(): Promise<boolean> {
    if (this.pending) {
      this.options.focus?.()
      return this.pending
    }
    const pending = this.decide().finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  private async decide(): Promise<boolean> {
    let inspection: QuitInspection | 'unknown'
    try {
      inspection = this.options.inspect()
    } catch (err) {
      console.warn('[QUIT] could not inspect running agent work', err)
      inspection = 'unknown'
    }
    const detail = resolveQuitPrompt(inspection, this.options.t)
    if (detail === undefined) return true
    this.options.focus?.()
    const { t } = this.options
    // macOS lays buttons out right-to-left from index 0: "Quit" sits right of "Cancel".
    const result = await this.options.show({
      type: 'warning',
      message: t('main.dialog.quitAgentTitle'),
      detail,
      buttons: [t('main.dialog.quitAgentQuit'), t('main.dialog.quitAgentCancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
}
