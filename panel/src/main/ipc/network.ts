// MLX Network tie-in (Network page): live network totals, a wallet's live
// mining, and MLX Node (bundle app.mlx.mac): installed, running, bundled,
// install and open (main/mlx-node.ts). HTTP calls run here in the main
// process, so the renderer's CSP stays closed to remote hosts.
import { app, ipcMain, net, shell } from 'electron'
import { execFile } from 'child_process'
import { findMlxNode, installMlxNode, mlxNodeStatus, openMlxNode } from '../mlx-node'
import { evaluateYield, yieldEnabled, YIELD_SETTING } from '../mlxNodeYield'
import { db } from '../database'
import {
  MLX_MAC_BUNDLE_ID,
  MLX_NETWORK_TOTALS_URL,
  miningUrl,
  normalizeWalletName,
  parseNetworkTotals,
  parseWalletMining,
  type FetchResult,
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
      headers: { Accept: 'application/json', 'User-Agent': `MLXHarness/${app.getVersion()}` },
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

export function registerNetworkHandlers(): void {
  ipcMain.handle('network:totals', (): Promise<FetchResult<NetworkSnapshot>> =>
    fetchJson(MLX_NETWORK_TOTALS_URL, parseNetworkTotals))

  ipcMain.handle('network:mining', async (_e, name: unknown): Promise<FetchResult<WalletMining>> => {
    const full = typeof name === 'string' ? normalizeWalletName(name) : null
    if (!full) return { ok: false, error: 'Invalid wallet name' }
    return fetchJson(miningUrl(full), parseWalletMining)
  })

  ipcMain.handle('network:mlxAppStatus', () => mlxNodeStatus())

  // Installs the copy this build carries (opens an installed one instead).
  ipcMain.handle('network:installMlxNode', () => installMlxNode())

  // Opens MLX Node and its menu bar panel: mlx://open sent to the installed
  // copy we found, then the system's mlx:// handler, then the bundle id.
  ipcMain.handle('network:yieldEnabled', () => yieldEnabled())
  ipcMain.handle('network:setYieldEnabled', async (_e, on: boolean) => {
    db.setSetting(YIELD_SETTING, on ? '1' : '0')
    await evaluateYield()
    return !!on
  })
  ipcMain.handle('network:openMlxApp', async (): Promise<boolean> => {
    if (process.platform !== 'darwin') return false
    const found = await findMlxNode()
    if (found && await openMlxNode(found.path, 'panel')) return true
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
