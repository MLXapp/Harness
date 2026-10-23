/**
 * IPC for the Image (cloud), Video, Audio and Music tabs:
 *   media:list(kind) · media:submit(request) · media:cancel(id) · media:delete(id)
 *   media:save(id) (Save As…) · media:reveal(id) (Show in Finder)
 *   event media:job (one job changed)
 * Files are served to the page by the mlx-media:// protocol (media/protocol.ts).
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { copyFileSync } from 'fs'
import { basename, join } from 'path'
import { db } from '../database'
import { getBundledPythonPath, getDevelopmentProjectVenv, getDevelopmentSourceRoot } from '../engine-manager'
import { normalizeHfTokenSetting } from '../../shared/hfSettings'
import type { MediaKind, MediaProviderId } from '../../shared/media/catalog'
import type { MediaSubmitRequest } from '../../shared/media/jobs'
import { MediaRunner } from '../media/runner'

const KINDS: readonly MediaKind[] = ['image', 'video', 'audio', 'music']

export function mediaRoot(): string {
  return join(app.getPath('userData'), 'media')
}

/** The Python that can run vmlx_engine.audio.job: bundled, else the dev checkout's venv. */
function audioPython(): { path: string; env: NodeJS.ProcessEnv; cwd?: string } | null {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONPATH: '' }
  const hfToken = normalizeHfTokenSetting(db.getSetting('hf_api_key'))
  if (hfToken) env.HF_TOKEN = hfToken
  delete env.HF_ENDPOINT
  const bundled = getBundledPythonPath()
  if (bundled) return { path: bundled, env }
  const root = getDevelopmentSourceRoot()
  const venv = getDevelopmentProjectVenv(root)
  if (venv && root) return { path: venv.pythonPath, env: { ...env, PYTHONPATH: root }, cwd: root }
  return null
}

let runner: MediaRunner | null = null

export function registerMediaHandlers(getWindow: () => BrowserWindow | null): void {
  runner = new MediaRunner({
    store: () => db.media,
    mediaRoot,
    resolveKey: (provider: MediaProviderId) => db.providers.resolveCredential(provider),
    python: audioPython,
    spawn: (cmd, args, opts) => spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }),
    emit: (job) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('media:job', job)
    },
  })
  runner.resume()

  ipcMain.handle('media:list', (_, kind: MediaKind) => (KINDS.includes(kind) ? runner!.list(kind) : []))
  ipcMain.handle('media:submit', (_, request: MediaSubmitRequest) => runner!.submit(request))
  ipcMain.handle('media:quote', (_, request: MediaSubmitRequest) => runner!.quote(request))
  ipcMain.handle('media:cancel', (_, id: string) => runner!.cancel(String(id)))
  ipcMain.handle('media:delete', (_, id: string) => runner!.delete(String(id)))
  ipcMain.handle('media:reveal', (_, id: string) => {
    const path = runner!.filePath(String(id))
    if (path) shell.showItemInFolder(path)
    return { ok: !!path }
  })
  ipcMain.handle('media:save', async (_, id: string) => {
    const path = runner!.filePath(String(id))
    if (!path) return { ok: false, error: 'Not found' }
    const win = getWindow()
    const options = { defaultPath: join(app.getPath('downloads'), basename(path)) }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
    copyFileSync(path, result.filePath)
    return { ok: true, path: result.filePath }
  })
}
