// MLX Node (bundle id app.mlx.mac): find it, install the copy MLX Harness
// carries (Contents/Resources/bundled-node/MLX Node.zip), open it, and offer
// it once on first run. Decisions are pure functions in shared/mlxNode.ts.
import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { execFile } from 'child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { db } from './database'
import { t } from './i18n'
import type { MlxAppStatus } from '../shared/mlxNetwork'
import {
  MLX_NODE_APP_NAMES,
  MLX_NODE_BUNDLE_ID,
  MLX_NODE_BUNDLED_DIR,
  MLX_NODE_BUNDLED_META,
  MLX_NODE_BUNDLED_ZIP,
  MLX_NODE_DOWNLOAD_URL,
  MLX_NODE_OFFER_SETTING,
  MLX_NODE_REQUIREMENT,
  isInstalledLocation,
  planMlxNodeInstall,
  shouldMarkMlxNodeOffered,
  shouldOfferMlxNode,
  type MlxNodeInstallError,
  type MlxNodeInstallResult,
} from '../shared/mlxNode'

const SYSTEM_APPS = '/Applications'
const userApps = (): string => join(homedir(), 'Applications')

function run(cmd: string, args: string[], timeout = 4000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
  })
}

async function readBundleInfo(appPath: string): Promise<Record<string, unknown> | null> {
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])
  try { return stdout ? JSON.parse(stdout) : null } catch { return null }
}

const isMlxNode = (info: Record<string, unknown> | null): boolean => info?.CFBundleIdentifier === MLX_NODE_BUNDLE_ID

/** Installed MLX Node: the usual folders under either name, then Spotlight (top-level apps only). */
export async function findMlxNode(): Promise<{ path: string; info: Record<string, unknown> } | null> {
  if (process.platform !== 'darwin') return null
  for (const dir of [SYSTEM_APPS, userApps()]) {
    for (const name of MLX_NODE_APP_NAMES) {
      const path = join(dir, name)
      const info = await readBundleInfo(path)
      if (isMlxNode(info)) return { path, info: info! }
    }
  }
  const { stdout } = await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${MLX_NODE_BUNDLE_ID}'`])
  const found = stdout.split('\n').map(s => s.trim()).filter(isInstalledLocation)
  for (const path of found) {
    const info = await readBundleInfo(path)
    if (isMlxNode(info)) return { path, info: info! }
  }
  return null
}

/** The zip this build carries (resources/bundled-node in a dev checkout). */
export function bundledZipPath(): string {
  const base = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(base, MLX_NODE_BUNDLED_DIR, MLX_NODE_BUNDLED_ZIP)
}

function bundledVersion(): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(bundledZipPath(), '..', MLX_NODE_BUNDLED_META), 'utf8'))
    return typeof meta?.version === 'string' ? meta.version : undefined
  } catch { return undefined }
}

const isBundled = (): boolean => process.platform === 'darwin' && existsSync(bundledZipPath())

function writableDir(dir: string): boolean {
  try { return statSync(dir).isDirectory() && (accessSync(dir, constants.W_OK), true) } catch { return false }
}

export async function mlxNodeStatus(): Promise<MlxAppStatus> {
  if (process.platform !== 'darwin') return { installed: false, running: false, bundled: false }
  const bundled = isBundled()
  const extra = bundled ? { bundled, bundledVersion: bundledVersion() } : { bundled }
  const found = await findMlxNode()
  if (!found) return { installed: false, running: false, ...extra }
  const exe = typeof found.info.CFBundleExecutable === 'string' ? found.info.CFBundleExecutable : 'MLX'
  const binary = join(found.path, 'Contents', 'MacOS', exe)
  const processes = (await run('/bin/ps', ['-Axo', 'comm='])).stdout.split('\n').map(s => s.trim())
  const running = processes.some(p => p === binary)
  const version = typeof found.info.CFBundleShortVersionString === 'string' ? found.info.CFBundleShortVersionString : undefined
  return { installed: true, running, path: found.path, version, ...extra }
}

/**
 * Open MLX Node at this path. `panel` also drops its menu bar panel down
 * (mlx://open, sent to this copy only); `launch` just starts it.
 */
export async function openMlxNode(path: string, mode: 'launch' | 'panel' = 'panel'): Promise<boolean> {
  if (mode === 'panel' && (await run('/usr/bin/open', ['-a', path, 'mlx://open'])).ok) return true
  return (await run('/usr/bin/open', [path])).ok
}

let installing: Promise<MlxNodeInstallResult> | null = null

/** Install the bundled copy (one at a time). Never overwrites; opens MLX Node when done. */
export function installMlxNode(): Promise<MlxNodeInstallResult> {
  installing ??= doInstall().finally(() => { installing = null })
  return installing
}

async function doInstall(): Promise<MlxNodeInstallResult> {
  const fail = (error: MlxNodeInstallError, why?: unknown): MlxNodeInstallResult => {
    console.warn(`[MLX Node] install: ${error}${why ? ` (${why instanceof Error ? why.message : String(why)})` : ''}`)
    return { ok: false, error }
  }
  const found = await findMlxNode()
  const home = homedir()
  const user = userApps()
  const plan = planMlxNodeInstall({
    platform: process.platform,
    installedPath: found?.path ?? null,
    bundled: isBundled(),
    systemAppsWritable: writableDir(SYSTEM_APPS),
    userAppsWritable: existsSync(user) ? writableDir(user) : writableDir(home),
    systemAppsDir: SYSTEM_APPS,
    userAppsDir: user,
  })
  if (plan.action === 'download') return fail(plan.reason)
  if (plan.action === 'open') {
    await openMlxNode(plan.path, 'launch')
    return { ok: true, path: plan.path, installed: false }
  }

  // Something already has the name: open it if it's MLX Node, never replace it.
  const atDest = async (): Promise<MlxNodeInstallResult | null> => {
    if (!existsSync(plan.dest)) return null
    if (!isMlxNode(await readBundleInfo(plan.dest))) return fail('occupied', plan.dest)
    await openMlxNode(plan.dest, 'launch')
    return { ok: true, path: plan.dest, installed: false }
  }
  const early = await atDest()
  if (early) return early

  let staging: string | null = null
  try {
    mkdirSync(plan.dir, { recursive: true })
    // Unpack next to the destination (same volume, so the final move is one rename).
    staging = mkdtempSync(join(plan.dir, '.mlx-node-install-'))
    const unzip = await run('/usr/bin/ditto', ['-x', '-k', bundledZipPath(), staging], 180_000)
    if (!unzip.ok) return fail('failed', unzip.stderr.trim() || 'ditto')
    const apps = readdirSync(staging).filter(n => n.endsWith('.app'))
    if (apps.length !== 1) return fail('failed', `expected one app in the zip, found ${apps.length}`)
    const staged = join(staging, apps[0])
    if (!isMlxNode(await readBundleInfo(staged))) return fail('signature', 'bundle id')
    // Our own copy only: the zip may carry the quarantine flag of the MLX Harness download.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged], 30_000)
    const verify = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=${MLX_NODE_REQUIREMENT}`, staged], 120_000)
    if (!verify.ok) return fail('signature', verify.stderr.trim())
    const late = await atDest()
    if (late) return late
    renameSync(staged, plan.dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return fail(code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'notWritable' : 'failed', err)
  } finally {
    if (staging) { try { rmSync(staging, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
  console.log(`[MLX Node] installed ${plan.dest}`)
  await openMlxNode(plan.dest, 'launch')
  return { ok: true, path: plan.dest, installed: true }
}

function showMessage(win: BrowserWindow | null, opts: MessageBoxOptions) {
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
}

/** Friendly failure with a way out: the download page. */
export async function showMlxNodeInstallError(win: BrowserWindow | null, error: MlxNodeInstallError): Promise<void> {
  const { response } = await showMessage(win, {
    type: 'warning',
    message: t('main.dialog.mlxNodeFailedTitle'),
    detail: t(`main.dialog.mlxNodeFailed.${error}`),
    buttons: [t('main.dialog.mlxNodeGet'), t('main.dialog.ok')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) void shell.openExternal(MLX_NODE_DOWNLOAD_URL)
}

/**
 * First run: if this build carries MLX Node and it isn't installed, ask once.
 * The flag is stored before asking, so the question never comes back.
 */
export async function offerMlxNodeOnFirstRun(getWindow: () => BrowserWindow | null): Promise<void> {
  if (process.platform !== 'darwin') return
  let offered = false
  try { offered = !!db.getSetting(MLX_NODE_OFFER_SETTING) } catch { return }
  if (offered) return
  const bundled = isBundled()
  const installed = !!(await findMlxNode())
  const facts = { platform: process.platform, offered, installed, bundled }
  if (shouldMarkMlxNodeOffered(facts)) {
    try { db.setSetting(MLX_NODE_OFFER_SETTING, new Date().toISOString()) } catch { return }
  }
  if (!shouldOfferMlxNode(facts)) return
  const { response } = await showMessage(getWindow(), {
    type: 'none',
    message: t('main.dialog.mlxNodeOfferTitle'),
    detail: t('main.dialog.mlxNodeOfferDetail'),
    buttons: [t('main.dialog.mlxNodeInstall'), t('main.dialog.mlxNodeNotNow')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) return
  const result = await installMlxNode()
  if (!result.ok) await showMlxNodeInstallError(getWindow(), result.error)
}
