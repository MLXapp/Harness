/**
 * Workspace files: what a reply made, written to MLX Harness's folder
 * (userData/workspace/<chat>/<message>/), served for the side panel's
 * preview, saved where the user chooses, opened in the browser.
 */
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { safeArtifactPath } from '../../shared/artifacts'
import { ONLINE_MARKER, isPreviewUrl, previewOrigin, startPreviewServer } from './previewServer'

const MAX_BYTES = 25 * 1024 * 1024
const ID = /^[\w-]{1,100}$/

export interface WorkspaceFile { path: string; content: string }

export function workspaceRoot(): string {
  return join(app.getPath('userData'), 'workspace')
}

/** Validated files, or an error message. */
export function checkFiles(files: unknown): WorkspaceFile[] | string {
  if (!Array.isArray(files) || files.length === 0 || files.length > 200) return 'No files.'
  let total = 0
  const out: WorkspaceFile[] = []
  for (const f of files) {
    const path = typeof f?.path === 'string' ? safeArtifactPath(f.path) : null
    if (!path || typeof f.content !== 'string') return 'A file name is not allowed.'
    total += Buffer.byteLength(f.content)
    if (total > MAX_BYTES) return 'The files are too large.'
    out.push({ path, content: f.content })
  }
  return out
}

function writeAll(dir: string, files: WorkspaceFile[]): void {
  for (const f of files) {
    const full = join(dir, f.path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, f.content, 'utf8')
  }
}

/** A folder name that doesn't exist yet: "Bakery", "Bakery 2", … */
function freeName(parent: string, base: string): string {
  const clean = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Workspace'
  let name = clean
  for (let n = 2; existsSync(join(parent, name)); n++) name = `${clean} ${n}`
  return name
}

export function registerWorkspaceHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('workspace:publish', async (_e, chatId: string, messageId: string, files: unknown, entry: string, online?: boolean) => {
    if (!ID.test(String(chatId)) || !ID.test(String(messageId))) return { ok: false, error: 'Bad id.' }
    const checked = checkFiles(files)
    if (typeof checked === 'string') return { ok: false, error: checked }
    const entryPath = safeArtifactPath(String(entry))
    if (!entryPath || !checked.some(f => f.path === entryPath)) return { ok: false, error: 'No page to show.' }
    const dir = join(workspaceRoot(), chatId, messageId)
    try {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeAll(dir, checked)
      if (online === true) writeFileSync(join(dir, ONLINE_MARKER), '1')
      const port = await startPreviewServer(workspaceRoot())
      const url = `http://127.0.0.1:${port}/${chatId}/${messageId}/${entryPath.split('/').map(encodeURIComponent).join('/')}`
      return { ok: true, url, dir }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  })

  ipcMain.handle('workspace:save', async (_e, files: unknown, name: string) => {
    const checked = checkFiles(files)
    if (typeof checked === 'string') return { ok: false, error: checked }
    const win = getWindow()
    if (checked.length === 1) {
      const opts = { defaultPath: join(app.getPath('downloads'), checked[0].path.split('/').pop()!) }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      writeFileSync(r.filePath, checked[0].content, 'utf8')
      shell.showItemInFolder(r.filePath)
      return { ok: true, path: r.filePath }
    }
    const opts = { defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    const dir = join(r.filePaths[0], freeName(r.filePaths[0], String(name || 'Workspace')))
    mkdirSync(dir, { recursive: true })
    writeAll(dir, checked)
    shell.showItemInFolder(join(dir, checked[0].path))
    return { ok: true, path: dir }
  })

  ipcMain.handle('workspace:openExternal', async (_e, url: string) => {
    if (typeof url !== 'string' || !isPreviewUrl(url)) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle('workspace:origin', () => previewOrigin())
}
