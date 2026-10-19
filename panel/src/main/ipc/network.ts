// MLX Network tie-in (Network page): live network totals, a wallet's live
// mining, and whether "MLX for macOS" (bundle app.mlx.mac) is installed and
// running. HTTP calls run here in the main process, so the renderer's CSP
// stays closed to remote hosts.
import { app, ipcMain, net, shell } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  MLX_MAC_BUNDLE_ID,
  MLX_NETWORK_TOTALS_URL,
  miningUrl,
  normalizeWalletName,
  parseNetworkTotals,
  parseWalletMining,
  type FetchResult,
  type MlxAppStatus,
  type NetworkSnapshot,
  type WalletMining,
} from '../../shared/mlxNetwork'

const TIMEOUT_MS = 10_000

async function fetchJson<T>(url: string, parse: (raw: unknown) => T | null): Promise<FetchResult<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': `MLXStudio/${app.getVersion()}` },
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    const data = parse(await res.json())
    return data ? { ok: true, data } : { ok: false, error: 'Unexpected response' }
  } catch (err) {
    return { ok: false, error: ctrl.signal.aborted ? 'Timed out' : (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

async function readBundleInfo(appPath: string): Promise<Record<string, unknown> | null> {
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  const out = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])
  try { return out ? JSON.parse(out) : null } catch { return null }
}

/** Where MLX for macOS lives: the usual folders first, then Spotlight. */
async function findMlxApp(): Promise<{ path: string; info: Record<string, unknown> } | null> {
  const candidates = ['/Applications/MLX.app', join(homedir(), 'Applications', 'MLX.app')]
  for (const path of candidates) {
    const info = await readBundleInfo(path)
    if (info?.CFBundleIdentifier === MLX_MAC_BUNDLE_ID) return { path, info }
  }
  const found = (await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${MLX_MAC_BUNDLE_ID}'`]))
    .split('\n').map(s => s.trim()).filter(s => s.endsWith('.app'))
  for (const path of found) {
    const info = await readBundleInfo(path)
    if (info?.CFBundleIdentifier === MLX_MAC_BUNDLE_ID) return { path, info }
  }
  return null
}

async function mlxAppStatus(): Promise<MlxAppStatus> {
  if (process.platform !== 'darwin') return { installed: false, running: false }
  const found = await findMlxApp()
  if (!found) return { installed: false, running: false }
  const exe = typeof found.info.CFBundleExecutable === 'string' ? found.info.CFBundleExecutable : 'MLX'
  const binary = join(found.path, 'Contents', 'MacOS', exe)
  const processes = (await run('/bin/ps', ['-Axo', 'comm='])).split('\n').map(s => s.trim())
  const running = processes.some(p => p === binary)
  const version = typeof found.info.CFBundleShortVersionString === 'string' ? found.info.CFBundleShortVersionString : undefined
  return { installed: true, running, path: found.path, version }
}

export function registerNetworkHandlers(): void {
  ipcMain.handle('network:totals', (): Promise<FetchResult<NetworkSnapshot>> =>
    fetchJson(MLX_NETWORK_TOTALS_URL, parseNetworkTotals))

  ipcMain.handle('network:mining', async (_e, name: unknown): Promise<FetchResult<WalletMining>> => {
    const full = typeof name === 'string' ? normalizeWalletName(name) : null
    if (!full) return { ok: false, error: 'Invalid wallet name' }
    return fetchJson(miningUrl(full), parseWalletMining)
  })

  ipcMain.handle('network:mlxAppStatus', () => mlxAppStatus())

  // Opens MLX for macOS and its menu bar panel (the app handles mlx:// links);
  // falls back to launching it by bundle id.
  ipcMain.handle('network:openMlxApp', async (): Promise<boolean> => {
    if (process.platform !== 'darwin') return false
    try {
      await shell.openExternal('mlx://open')
      return true
    } catch {
      const out = await new Promise<boolean>((resolve) =>
        execFile('/usr/bin/open', ['-b', MLX_MAC_BUNDLE_ID], { timeout: 4000 }, (err) => resolve(!err)))
      return out
    }
  })
}
