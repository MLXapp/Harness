import { ipcMain, Menu } from 'electron'

/**
 * Apple Dictation for the chat composer's mic button.
 *
 * The renderer focuses the composer, then asks for dictation here. On macOS
 * this sends `startDictation:` down the responder chain, exactly what Edit →
 * Start Dictation… does: the system Dictation UI appears at the caret and the
 * text lands in the focused field. If Dictation is turned off, macOS itself
 * offers to turn it on. Other platforms have no system dictation; the
 * renderer falls back to Whisper there.
 */
export function startDictation(
  platform: NodeJS.Platform = process.platform,
  send: (action: string) => void = action => Menu.sendActionToFirstResponder(action),
): { ok: boolean; reason?: 'unsupported' } {
  if (platform !== 'darwin') return { ok: false, reason: 'unsupported' }
  send('startDictation:')
  return { ok: true }
}

export function registerDictationIpc(): void {
  ipcMain.handle('dictation:start', () => startDictation())
}
