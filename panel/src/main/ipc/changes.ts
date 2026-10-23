/**
 * Changes review IPC: what each turn's file tools changed, and putting it back.
 *   changes:list(chatId) · changes:file(chatId, messageId, path)
 *   changes:revert(chatId, messageId, paths, force) · changes:reveal(path)
 *   event changes:turn (a turn just finished with changes)
 */
import { app, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { TurnChanges } from '../agent/turnChanges'
import { appWindows } from '../browser/electronDriver'

function root(): string {
  try { return join(app.getPath('userData'), 'turn-changes') } catch { return join(tmpdir(), 'mlx-harness-turn-changes') }
}

export const turnChanges = new TurnChanges(root)

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function registerChangesHandlers(): void {
  ipcMain.handle('changes:list', (_e, chatId: string) => turnChanges.list(str(chatId)))
  ipcMain.handle('changes:file', (_e, chatId: string, messageId: string, path: string) =>
    turnChanges.fileTexts(str(chatId), str(messageId), str(path)))
  ipcMain.handle('changes:revert', (_e, chatId: string, messageId: string, paths: unknown, force: boolean) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    const result = turnChanges.revert(str(chatId), str(messageId), list, !!force)
    const set = turnChanges.list(str(chatId)).find(s => s.messageId === str(messageId))
    if (set) for (const w of appWindows()) w.webContents.send('changes:turn', set)
    return result
  })
  // Only paths a turn recorded can be revealed.
  ipcMain.handle('changes:reveal', (_e, chatId: string, messageId: string, path: string) => {
    const set = turnChanges.list(str(chatId)).find(s => s.messageId === str(messageId))
    const file = set?.files.find(f => f.path === str(path))
    if (!file) return false
    if (existsSync(file.path)) shell.showItemInFolder(file.path)
    else if (existsSync(dirname(file.path))) void shell.openPath(dirname(file.path))
    return true
  })
}
