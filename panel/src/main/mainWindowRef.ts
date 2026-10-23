/**
 * The app's main window, for code that lives outside index.ts (notification
 * clicks, scheduled tasks). index.ts registers how to find it and how to make
 * it again (macOS keeps the app alive after its last window closes).
 */
import type { BrowserWindow } from 'electron'

let get: () => BrowserWindow | null = () => null
let create: () => void = () => {}

export function registerMainWindow(getter: () => BrowserWindow | null, creator: () => void): void {
  get = getter
  create = creator
}

/** The main window if it is open. */
export function mainWindow(): BrowserWindow | null {
  const w = get()
  return w && !w.isDestroyed() ? w : null
}

/**
 * Brings the main window forward (making it again when it was closed), then
 * sends `channel` once its page is ready.
 */
export function revealMainWindow(channel?: string, payload?: unknown): void {
  let w = mainWindow()
  if (!w) {
    create()
    w = mainWindow()
  }
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  if (!channel) return
  const target = w
  const send = () => { if (!target.isDestroyed()) target.webContents.send(channel, payload) }
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', () => setTimeout(send, 300))
  else send()
}
