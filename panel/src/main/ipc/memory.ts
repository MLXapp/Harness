/**
 * IPC for Preferences → Memory: list, add, edit, delete, clear, on/off.
 * Event memory:changed tells open windows to reload the list.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { db } from '../database'
import { looksSecret } from '../memory/store'

function changed(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('memory:changed')
}

export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:list', () => db.memory.list())
  ipcMain.handle('memory:enabled', () => db.getSetting('memory_enabled') !== '0')
  ipcMain.handle('memory:setEnabled', (_e, on: boolean) => {
    db.setSetting('memory_enabled', on ? '1' : '0')
    changed()
    return !!on
  })
  ipcMain.handle('memory:add', (_e, text: string) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' }
    if (looksSecret(text)) return { ok: false, error: 'secret' }
    try { db.memory.add(text); changed(); return { ok: true } } catch (err: any) { return { ok: false, error: String(err?.message ?? err) } }
  })
  ipcMain.handle('memory:update', (_e, id: string, text: string) => {
    if (typeof id !== 'string' || typeof text !== 'string') return { ok: false }
    if (looksSecret(text)) return { ok: false, error: 'secret' }
    const r = db.memory.update(id, text)
    changed()
    return { ok: !!r }
  })
  ipcMain.handle('memory:delete', (_e, id: string) => { const ok = typeof id === 'string' && db.memory.delete(id); changed(); return ok })
  ipcMain.handle('memory:clear', () => { db.memory.clear(); changed(); return true })
}
