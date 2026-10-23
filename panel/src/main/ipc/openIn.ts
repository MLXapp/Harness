/**
 * "Open in": the project folder in Finder, a terminal or an editor. Only apps
 * that are installed are offered (found by bundle id with Spotlight, then in
 * the usual folders). `code:openIn` opens a folder that exists, nothing else.
 */
import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface OpenInApp { id: string; name: string; bundleId: string; kind: 'finder' | 'terminal' | 'editor' }

/** In menu order. Finder and Terminal ship with macOS. */
export const OPEN_IN_APPS: readonly OpenInApp[] = [
  { id: 'finder', name: 'Finder', bundleId: 'com.apple.finder', kind: 'finder' },
  { id: 'terminal', name: 'Terminal', bundleId: 'com.apple.Terminal', kind: 'terminal' },
  { id: 'iterm', name: 'iTerm', bundleId: 'com.googlecode.iterm2', kind: 'terminal' },
  { id: 'warp', name: 'Warp', bundleId: 'dev.warp.Warp-Stable', kind: 'terminal' },
  { id: 'ghostty', name: 'Ghostty', bundleId: 'com.mitchellh.ghostty', kind: 'terminal' },
  { id: 'xcode', name: 'Xcode', bundleId: 'com.apple.dt.Xcode', kind: 'editor' },
  { id: 'vscode', name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', kind: 'editor' },
  { id: 'cursor', name: 'Cursor', bundleId: 'com.todesktop.230313mxl7mo8f2', kind: 'editor' },
  { id: 'zed', name: 'Zed', bundleId: 'dev.zed.Zed', kind: 'editor' },
  { id: 'sublime', name: 'Sublime Text', bundleId: 'com.sublimetext.4', kind: 'editor' },
  { id: 'nova', name: 'Nova', bundleId: 'com.panic.Nova', kind: 'editor' },
]

const APP_FILES: Record<string, string> = {
  iterm: 'iTerm.app', warp: 'Warp.app', ghostty: 'Ghostty.app', xcode: 'Xcode.app', vscode: 'Visual Studio Code.app',
  cursor: 'Cursor.app', zed: 'Zed.app', sublime: 'Sublime Text.app', nova: 'Nova.app',
}

function spotlight(bundleId: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`], { timeout: 4000 }, (err, out) => resolve(!err && String(out).trim().length > 0))
  })
}

let cached: { at: number; ids: string[] } | null = null

export async function installedOpenInApps(): Promise<OpenInApp[]> {
  if (process.platform !== 'darwin') return []
  if (cached && Date.now() - cached.at < 5 * 60_000) return OPEN_IN_APPS.filter(a => cached!.ids.includes(a.id))
  const found: string[] = []
  for (const a of OPEN_IN_APPS) {
    if (a.id === 'finder' || a.id === 'terminal') { found.push(a.id); continue }
    const file = APP_FILES[a.id]
    const onDisk = file && [join('/Applications', file), join(homedir(), 'Applications', file)].some(p => existsSync(p))
    if (onDisk || await spotlight(a.bundleId)) found.push(a.id)
  }
  cached = { at: Date.now(), ids: found }
  return OPEN_IN_APPS.filter(a => found.includes(a.id))
}

export function openFolderIn(appId: string, folder: string): Promise<{ ok: boolean; error?: string }> {
  const app = OPEN_IN_APPS.find(a => a.id === appId)
  if (!app) return Promise.resolve({ ok: false, error: 'Unknown app.' })
  try { if (!statSync(folder).isDirectory()) return Promise.resolve({ ok: false, error: 'Not a folder.' }) } catch {
    return Promise.resolve({ ok: false, error: 'The folder is gone.' })
  }
  const args = app.id === 'finder' ? [folder] : ['-b', app.bundleId, folder]
  return new Promise(resolve => {
    execFile('/usr/bin/open', args, { timeout: 8000 }, err => resolve(err ? { ok: false, error: String(err.message || err) } : { ok: true }))
  })
}

export function registerOpenInHandlers(): void {
  ipcMain.handle('code:openInApps', () => installedOpenInApps().catch(() => []))
  ipcMain.handle('code:openIn', (_e, appId: string, folder: string) =>
    openFolderIn(typeof appId === 'string' ? appId : '', typeof folder === 'string' ? folder : ''))
}
