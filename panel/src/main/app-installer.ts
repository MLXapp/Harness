// MLX Harness's installer. Opened from its disk image (or App-Translocated by
// macOS), the app shows a small install window instead of starting: Install
// copies it into /Applications (~/Applications when this account can't write
// there) in a child process with a smooth progress bar, checks the copy's
// signature, relaunches it from there and ejects the disk image. The same or
// a newer MLX Harness already installed is opened instead (never a
// downgrade); an older one is quit if running, then replaced.
// The rules are pure functions in ../shared/appInstall.ts (tested there).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, type IpcMainEvent } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, join } from 'path'
import { db } from './database'
import { getLocale, setLocale, SUPPORTED_LOCALES, t } from './i18n'
import { INSTALLER_SCRIPT, installerPage } from './app-installer-page'
import { appBundlePath, codesignVerifyArgs } from '../shared/appUpdate'
import {
  SYSTEM_APPS_DIR,
  bytesNeeded,
  checkCopy,
  diskImageMountPoints,
  ejectTarget,
  installBackupPath,
  installProgress,
  installStagingPath,
  installerLocale,
  installerSource,
  isInstallerAction,
  isInstallerCopy,
  knownInstallPaths,
  parseRunningCopies,
  planInstall,
  relaunchCommand,
  translocationOrigin,
  volumeRoot,
  type FoundCopy,
  type InstallStep,
  type InstallerAction,
  type InstallerFacts,
  type InstallerPlan,
  type InstallerScreen,
  type InstallerSource,
} from '../shared/appInstall'

const log = (...a: unknown[]) => console.log('[INSTALL]', ...a)

type Failure = 'copy' | 'space' | 'signature' | 'busy' | 'notWritable' | 'move'

class InstallFail extends Error {
  constructor(readonly code: Failure, readonly params: Record<string, string> = {}, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

// ---------------------------------------------------------------------------
// Processes and files

function run(cmd: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${String(stdout ?? '')}${String(stderr ?? '')}`.trim() }))
  })
}

async function readBundleInfo(appPath: string): Promise<Record<string, unknown> | null> {
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  const { ok, out } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], 15_000)
  if (!ok) return null
  try { return JSON.parse(out) } catch { return null }
}

function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true } catch { return false }
}

function writableDir(dir: string): boolean {
  try { return statSync(dir).isDirectory() && writable(dir) } catch { return false }
}

async function runningCopies() {
  return parseRunningCopies((await run('/bin/ps', ['-axo', 'pid=,comm='], 10_000)).out, process.pid)
}

/** Size of a folder in bytes (du's 1K blocks; close enough for progress and the space check). */
async function folderBytes(path: string): Promise<number> {
  const { out } = await run('/usr/bin/du', ['-sk', path], 120_000)
  const kb = Number(/^(\d+)/.exec(out)?.[1])
  return Number.isFinite(kb) ? kb * 1024 : 0
}

function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch { return null }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const userAppsDir = (): string => join(homedir(), 'Applications')

// ---------------------------------------------------------------------------
// Copy and verify (also run by the self-test against a temporary folder)

let copying: ChildProcess | null = null
let cleanupPath: string | null = null

/**
 * ditto `source` to `staging` (removed first), reporting 0…1 as the copy
 * grows, then check it: our bundle id and this version, and the signature
 * against our designated requirement. A copy of an unsigned build (local
 * builds) passes only if the source fails the same check. Returns whether it
 * is signed by us; the quarantine flag is removed only then.
 */
export async function copyAndVerify(source: string, staging: string, version: string,
  onStep: (step: InstallStep, fraction: number, bytes?: { done: number; total: number }) => void): Promise<{ signed: boolean; bytes: number }> {
  onStep('copying', 0)
  const total = await folderBytes(source)
  const free = freeBytes(join(staging, '..'))
  if (total > 0 && free !== null && free < bytesNeeded(total)) {
    throw new InstallFail('space', { gb: (bytesNeeded(total) / 1e9).toFixed(1) }, `${free} free`)
  }
  await rm(staging, { recursive: true, force: true })
  cleanupPath = staging
  let polling = false
  let copied = false
  const poll = setInterval(() => {
    if (polling || copied || total <= 0) return
    polling = true
    folderBytes(staging)
      .then(b => { if (!copied) onStep('copying', Math.min(0.995, b / total), { done: Math.min(b, total), total }) })
      .finally(() => { polling = false })
  }, 450)
  try {
    const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
      let err = ''
      const child = spawn('/usr/bin/ditto', [source, staging], { stdio: ['ignore', 'ignore', 'pipe'] })
      copying = child
      child.stderr?.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString() })
      child.on('error', (e) => resolve({ code: -1, err: e.message }))
      child.on('close', (code) => resolve({ code, err }))
    })
    copying = null
    if (result.code !== 0) {
      if (/no space left/i.test(result.err)) throw new InstallFail('space', { gb: (bytesNeeded(total) / 1e9).toFixed(1) }, result.err)
      if (/permission denied|operation not permitted|read-only/i.test(result.err)) throw new InstallFail('notWritable', {}, result.err)
      throw new InstallFail('copy', {}, result.err || `ditto exited ${result.code}`)
    }
  } finally {
    copied = true
    clearInterval(poll)
  }
  onStep('copying', 1, { done: total, total })
  onStep('checking', 0)
  const info = await readBundleInfo(staging)
  const wrong = checkCopy({ bundleId: info?.CFBundleIdentifier, version: info?.CFBundleShortVersionString, runningVersion: version })
  if (wrong) throw new InstallFail('copy', {}, `the copy is ${wrong}`)
  onStep('checking', 0.2)
  const signed = (await run('/usr/bin/codesign', codesignVerifyArgs(staging, false), 600_000)).ok
  onStep('checking', 0.8)
  if (!signed) {
    const src = await run('/usr/bin/codesign', codesignVerifyArgs(source, false), 600_000)
    if (src.ok) throw new InstallFail('signature', {}, 'the copy fails the check the original passes')
    log('this build is not signed by us; installing it unsigned')
  }
  if (signed) await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staging], 120_000)
  onStep('checking', 1)
  return { signed, bytes: total }
}

function cancelCopy(): void {
  try { copying?.kill('SIGKILL') } catch { /* gone */ }
  copying = null
  if (cleanupPath) { try { rmSync(cleanupPath, { recursive: true, force: true }) } catch { /* best effort */ } }
  cleanupPath = null
}

// ---------------------------------------------------------------------------
// State

interface Context {
  source: InstallerSource
  appPath: string
  version: string
  /** Disk image to eject after installing (null: not a disk image, or unknown). */
  volume: string | null
}

let ctx: Context | null = null
let win: BrowserWindow | null = null
let plan: InstallerPlan | null = null
let screen: InstallerScreen | null = null
let busy = false
let leaving = false

/**
 * ⌘Q (or any app.quit) while the install window is up: stop a copy in
 * progress, remove it, and leave with the same fade as Quit. index.ts calls
 * this first in its before-quit and does nothing else when it returns true.
 */
export function installerHandlesQuit(e: { preventDefault(): void }): boolean {
  if (!ctx) return false
  if (leaving) return true
  e.preventDefault()
  cancelCopy()
  busy = false
  void leave(null)
  return true
}

/** Bring the install window forward (a second launch, a Dock click). */
export function focusInstaller(): boolean {
  if (!win || win.isDestroyed()) return false
  if (!win.isVisible()) win.show()
  win.focus()
  return true
}

function folderName(dir: string): string {
  return dir === SYSTEM_APPS_DIR ? t('installer.folder.system') : t('installer.folder.user')
}

function screenForPlan(p: InstallerPlan): InstallerScreen {
  const quit = { label: t('installer.button.quit'), action: 'quit' as const }
  if (p.action === 'open') {
    return {
      key: 'installed',
      title: t('installer.installed.title'),
      text: t(p.newer ? 'installer.installed.newer' : 'installer.installed.same', { version: p.version || '?' }),
      note: p.path.startsWith(`${userAppsDir()}/`) ? t('installer.installed.inUser') : '',
      primary: { label: t('installer.button.open'), action: 'open' },
      secondary: quit,
    }
  }
  if (p.action === 'blocked') {
    return {
      key: 'blocked',
      title: t('installer.blocked.title'),
      text: t(`installer.blocked.${p.reason}`),
      primary: { label: t('installer.button.retry'), action: 'retry' },
      secondary: quit,
    }
  }
  const running = p.quitFirst.find(c => c.running)
  const note = running
    ? t('installer.offer.quits', { version: String(running.version ?? '') })
    : p.replaces ? t('installer.offer.replaces', { version: String(p.replaces.version ?? '') }) : ''
  return {
    key: 'offer',
    title: t('installer.offer.title'),
    text: p.dir === SYSTEM_APPS_DIR ? t('installer.offer.text') : t('installer.offer.textUser'),
    note,
    primary: { label: t('installer.button.install'), action: 'install' },
    secondary: quit,
  }
}

const gb = (n: number) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`

function workingScreen(step: InstallStep, fraction: number, params: Record<string, string> = {}, bytes?: { done: number; total: number }): InstallerScreen {
  return {
    key: 'working',
    title: step === 'opening' ? t('installer.working.done') : t('installer.working.title'),
    text: t(`installer.step.${step}`, params),
    note: step === 'copying' && bytes && bytes.total > 0 ? t('installer.bytes', { done: gb(bytes.done), total: gb(bytes.total) }) : '',
    progress: installProgress(step, fraction),
  }
}

function failedScreen(e: unknown): InstallerScreen {
  const f = e instanceof InstallFail ? e : new InstallFail('copy', {}, (e as Error)?.message)
  return {
    key: 'failed',
    title: t('installer.failed.title'),
    text: t(`installer.failed.${f.code}`, f.params),
    primary: { label: t('installer.button.retry'), action: 'retry' },
    secondary: { label: t('installer.button.quit'), action: 'quit' },
  }
}

function show(next: InstallerScreen): void {
  screen = next
  if (win && !win.isDestroyed()) win.webContents.send('installer:screen', next)
}

// ---------------------------------------------------------------------------
// Looking around

async function scan(c: Context): Promise<InstallerFacts> {
  const user = userAppsDir()
  const running = await runningCopies()
  const paths = knownInstallPaths(SYSTEM_APPS_DIR, user)
  for (const r of running) if (!paths.includes(r.appPath)) paths.push(r.appPath)
  const copies: FoundCopy[] = []
  for (const path of paths) {
    if (path === c.appPath || !existsSync(path)) continue
    const info = await readBundleInfo(path)
    copies.push({
      path,
      bundleId: info?.CFBundleIdentifier,
      version: info?.CFBundleShortVersionString,
      running: running.some(r => r.appPath === path),
      writable: writable(path),
    })
  }
  return {
    runningVersion: c.version,
    copies,
    systemAppsDir: SYSTEM_APPS_DIR,
    userAppsDir: user,
    systemAppsWritable: writableDir(SYSTEM_APPS_DIR),
    userAppsWritable: existsSync(user) ? writableDir(user) : writableDir(homedir()),
  }
}

async function refreshPlan(c: Context): Promise<InstallerPlan> {
  const facts = await scan(c)
  plan = planInstall(facts)
  log(`plan: ${JSON.stringify(plan)}`)
  return plan
}

/** Ask a running older copy to quit (its own clean shutdown, as on SIGTERM) and wait for everything from it to end. */
async function quitCopy(copy: FoundCopy): Promise<boolean> {
  const pids = (await runningCopies()).filter(r => r.appPath === copy.path).map(r => r.pid)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const until = Date.now() + 90_000
  while (pids.some(alive)) {
    if (Date.now() > until) return false
    await sleep(300)
  }
  // Its engines and helpers run from inside the bundle too.
  const inside = `${copy.path}/Contents/`
  const helpersUntil = Date.now() + 30_000
  while (Date.now() < helpersUntil) {
    const { out } = await run('/bin/ps', ['-axo', 'comm='], 10_000)
    if (!out.split('\n').some(l => l.trim().startsWith(inside))) break
    await sleep(400)
  }
  return true
}

// ---------------------------------------------------------------------------
// Install

async function install(c: Context): Promise<void> {
  if (busy || !plan || plan.action !== 'install') return
  busy = true
  if (win && !win.isDestroyed()) win.setClosable(false)
  let p: Extract<InstallerPlan, { action: 'install' }> = plan
  try {
    // One MLX Harness at a time: older copies that are open quit first.
    if (p.quitFirst.length) {
      const first = p.quitFirst[0]
      show(workingScreen('quitting', 0, { version: String(first.version ?? '') }))
      for (const [i, copy] of p.quitFirst.entries()) {
        if (!(await quitCopy(copy))) throw new InstallFail('busy', { version: String(copy.version ?? '') })
        show(workingScreen('quitting', (i + 1) / p.quitFirst.length, { version: String(first.version ?? '') }))
      }
      // A quitting copy may have swapped in an update it had staged: look again.
      await sleep(1500)
      const again = await refreshPlan(c)
      if (again.action !== 'install') {
        busy = false
        if (win && !win.isDestroyed()) win.setClosable(true)
        show(screenForPlan(again))
        return
      }
      p = again
    }

    const folder = folderName(p.dir)
    const onStep = (step: InstallStep, fraction: number, bytes?: { done: number; total: number }) =>
      show(workingScreen(step, fraction, { folder }, bytes))
    onStep('copying', 0)
    try { mkdirSync(p.dir, { recursive: true }) } catch { throw new InstallFail('notWritable', { folder }) }
    const staging = installStagingPath(p.dest)
    const { signed } = await copyAndVerify(c.appPath, staging, c.version, onStep)

    onStep('finishing', 0)
    // Look at the destination once more right before replacing it.
    if (existsSync(p.dest)) {
      const info = await readBundleInfo(p.dest)
      const now = planInstall(await scan(c))
      // Something changed while copying (a newer copy arrived, the old one was opened again): ask again.
      if (now.action !== 'install' || now.dest !== p.dest || now.quitFirst.length > 0) {
        await rm(staging, { recursive: true, force: true })
        cleanupPath = null
        busy = false
        if (win && !win.isDestroyed()) win.setClosable(true)
        plan = now
        show(screenForPlan(now))
        return
      }
      const backup = installBackupPath(p.dest, process.pid)
      await rm(backup, { recursive: true, force: true })
      try { renameSync(p.dest, backup) } catch (e) { throw new InstallFail('move', {}, (e as Error).message) }
      try {
        renameSync(staging, p.dest)
      } catch (e) {
        try { renameSync(backup, p.dest) } catch { /* left at backup; the next run sees no copy there */ }
        throw new InstallFail('move', {}, (e as Error).message)
      }
      cleanupPath = null
      log(`replaced MLX Harness ${String(info?.CFBundleShortVersionString ?? '?')} at ${p.dest}`)
      onStep('finishing', 0.4)
      await rm(backup, { recursive: true, force: true }).catch(err => log(`could not remove ${backup}: ${err.message}`))
    } else {
      try { renameSync(staging, p.dest) } catch (e) { throw new InstallFail('move', {}, (e as Error).message) }
      cleanupPath = null
    }
    for (const old of p.trash) {
      try { await shell.trashItem(old); log(`moved ${old} to the Trash`) } catch (e) { log(`could not move ${old} to the Trash: ${(e as Error).message}`) }
    }
    log(`installed ${p.dest}${signed ? '' : ' (unsigned build)'}`)
    onStep('finishing', 1)
    show(workingScreen('opening', 1))
    // Let the bar finish its glide before the window fades.
    await sleep(650)
    await leave({ open: p.dest })
  } catch (e) {
    log(`install failed: ${(e as Error).message}`)
    cancelCopy()
    busy = false
    if (win && !win.isDestroyed()) win.setClosable(true)
    show(failedScreen(e))
  }
}

// ---------------------------------------------------------------------------
// Leaving: fade out, start the relaunch/eject script, exit

function fade(w: BrowserWindow, to: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (w.isDestroyed()) return resolve()
    const from = w.getOpacity()
    const start = Date.now()
    const tick = () => {
      if (w.isDestroyed()) return resolve()
      const k = Math.min(1, (Date.now() - start) / ms)
      const eased = 1 - Math.pow(1 - k, 3)
      w.setOpacity(from + (to - from) * eased)
      if (k < 1) setTimeout(tick, 16)
      else resolve()
    }
    tick()
  })
}

async function leave(next: { open: string } | null): Promise<void> {
  if (leaving) return
  leaving = true
  if (next && ctx) {
    try {
      const dir = join(app.getPath('userData'), 'updates')
      mkdirSync(dir, { recursive: true })
      const { file, args } = relaunchCommand({ pid: process.pid, appPath: next.open, volume: ctx.volume, logPath: join(dir, 'install.log') })
      spawn(file, args, { detached: true, stdio: 'ignore' }).unref()
      log(`opening ${next.open} after exit${ctx.volume ? `, then ejecting ${ctx.volume}` : ''}`)
    } catch (e) {
      log(`could not start the relaunch: ${(e as Error).message}`)
    }
  }
  if (win && !win.isDestroyed()) {
    await fade(win, 0, 240)
    win.destroy()
  }
  try { db.close() } catch { /* not open */ }
  app.exit(0)
}

async function act(action: InstallerAction): Promise<void> {
  if (!ctx || leaving) return
  if (action === 'quit') { if (!busy) await leave(null); return }
  if (busy) return
  if (action === 'open' && plan?.action === 'open') { await leave({ open: plan.path }); return }
  if (action === 'install') { await install(ctx); return }
  if (action === 'retry') {
    const p = await refreshPlan(ctx)
    if (p.action === 'install' && screen?.key === 'failed') { await install(ctx); return }
    show(screenForPlan(p))
  }
}

// ---------------------------------------------------------------------------
// The window

function iconDataUrl(): string {
  const load = [
    () => nativeImage.createFromBuffer(readFileSync(join(app.getAppPath(), 'resources', 'icon.png'))),
    () => nativeImage.createFromPath(join(process.resourcesPath ?? '', 'icon.icns')),
  ]
  for (const get of load) {
    try {
      const img = get()
      if (!img.isEmpty()) return img.resize({ width: 168, height: 168, quality: 'best' }).toDataURL()
    } catch { /* next */ }
  }
  return 'data:,'
}

/** Per window: what its page went through (preload errors, console, loads). */
const installerTrace = new Map<number, string[]>()
export function installerWindowTrace(w: BrowserWindow): string {
  return (installerTrace.get(w.id) ?? []).join(' | ')
}

export interface InstallerWindowOptions {
  first: InstallerScreen
  onAction: (action: InstallerAction) => void
  /** Called once the page is ready (it has been sent the current screen). */
  onReady?: (w: BrowserWindow) => void
  /** The screen to send when the page is ready (default: `first`). */
  current?: () => InstallerScreen
}

/** The install window (also used, hidden, by the self-test). */
export function createInstallerWindow(o: InstallerWindowOptions): BrowserWindow {
  const w = new BrowserWindow({
    width: 440,
    height: 340,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    title: t('installer.windowTitle'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    // Same setup as the main window (file page, preload with contextIsolation),
    // the combination this packaged app is known to run.
    webPreferences: {
      preload: join(__dirname, '../preload/installer.js'),
      // The bundled installer preload needs nothing but electron.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  // What the page went through, for the log and the self-test.
  const trace: string[] = []
  const note = (s: string) => { if (trace.length < 40) trace.push(s.slice(0, 300)) }
  w.webContents.on('preload-error', (_e, path, err) => note(`preload error in ${path}: ${err?.message ?? err}`))
  w.webContents.on('did-fail-load', (_e, code, desc) => note(`load failed: ${code} ${desc}`))
  w.webContents.on('did-finish-load', () => note('loaded'))
  w.webContents.on('render-process-gone', (_e, d) => note(`renderer gone: ${d.reason}`))
  w.webContents.on('console-message', (event: any, ...args: any[]) => {
    const msg = typeof args[1] === 'string' ? args[1] : event?.message
    note(`console: ${String(msg)}`)
  })
  installerTrace.set(w.id, trace)
  const own = (e: IpcMainEvent) => !w.isDestroyed() && e.sender === w.webContents
  const onReady = (e: IpcMainEvent) => {
    if (!own(e)) return
    e.sender.send('installer:screen', o.current?.() ?? o.first)
    o.onReady?.(w)
  }
  const onAct = (e: IpcMainEvent, action: unknown) => {
    if (own(e) && isInstallerAction(action)) o.onAction(action)
  }
  ipcMain.on('installer:ready', onReady)
  ipcMain.on('installer:act', onAct)
  // A fresh private folder (0700, unpredictable name) for the page and its
  // script: the shared temp folder is writable by other programs, sandboxed
  // agent commands included.
  const pageDir = mkdtempSync(join(app.getPath('temp'), 'mlx-harness-installer-'))
  const page = join(pageDir, 'installer.html')
  const script = join(pageDir, 'installer.js')
  w.on('closed', () => {
    ipcMain.removeListener('installer:ready', onReady)
    ipcMain.removeListener('installer:act', onAct)
    try { rmSync(pageDir, { recursive: true, force: true }) } catch { /* temp */ }
  })
  const html = installerPage({
    lang: getLocale() === 'zh' ? 'zh-Hans' : getLocale(),
    title: t('installer.windowTitle'),
    iconDataUrl: iconDataUrl(),
    footer: t('installer.footer', { version: app.getVersion() }),
    script: basename(script),
  })
  writeFileSync(script, INSTALLER_SCRIPT, { flag: 'wx', mode: 0o600 })
  writeFileSync(page, html, { flag: 'wx', mode: 0o600 })
  w.loadFile(page).catch((e: Error) => note(`loadFile: ${e.message}`))
  return w
}

// ---------------------------------------------------------------------------
// Start

/** Synchronously, before the single-instance lock: could this launch be the installer? */
export function installerSourceAtStartup(o: { selfTest: boolean; secondaryInstance: boolean }): InstallerSource | null {
  return installerSource({
    platform: process.platform,
    packaged: app.isPackaged,
    appPath: appBundlePath(process.execPath),
    argv: process.argv,
    env: process.env,
    selfTest: o.selfTest,
    secondaryInstance: o.secondaryInstance,
  })
}

/**
 * Run the installer (after app ready). Returns false when this launch should
 * start normally after all (an app kept on an external drive, not a disk image).
 */
export async function runInstaller(o: { source: InstallerSource; lockHeld: boolean }): Promise<boolean> {
  const appPath = appBundlePath(process.execPath)
  if (!appPath) return false
  const imageMounts = diskImageMountPoints((await run('/usr/bin/hdiutil', ['info', '-plist'], 20_000)).out)
  const origin = o.source === 'translocated' ? translocationOrigin((await run('/sbin/mount', [], 10_000)).out, appPath) : null
  if (o.source === 'dmg' && !imageMounts.includes(volumeRoot(appPath) ?? '')) {
    log(`${appPath} is on a volume that isn't a disk image; starting normally`)
    return false
  }
  if (!o.lockHeld) {
    // Another install window is open (it focuses itself); otherwise an installed copy holds the lock.
    const others = (await runningCopies()).filter(r => isInstallerCopy(r.appPath))
    if (others.length) {
      log('another install window is open')
      app.exit(0)
      return true
    }
  }
  ctx = { source: o.source, appPath, version: app.getVersion(), volume: ejectTarget({ source: o.source, appPath, origin, imageMounts }) }
  log(`running from ${o.source === 'dmg' ? 'a disk image' : `a translocated copy of ${origin ?? 'an unknown place'}`}: ${appPath}`)

  let saved: string | undefined
  try { saved = db.getSetting('locale') || undefined } catch { /* no settings yet */ }
  setLocale(installerLocale(saved, app.getPreferredSystemLanguages(), SUPPORTED_LOCALES))

  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  app.on('activate', () => { focusInstaller() })

  const first = screenForPlan(await refreshPlan(ctx))
  screen = first
  win = createInstallerWindow({
    first,
    current: () => screen ?? first,
    onAction: (a) => { void act(a) },
    onReady: (w) => {
      if (w.isVisible()) return
      w.setOpacity(0)
      w.show()
      app.focus({ steal: true })
      void fade(w, 1, 220)
    },
  })
  win.on('close', (e) => {
    if (leaving) return
    e.preventDefault()
    if (!busy) void leave(null)
  })
  // Safety net: a page that never comes up must not leave an invisible app.
  const pending = win
  setTimeout(() => {
    if (leaving || pending.isDestroyed() || pending.isVisible()) return
    log(`the install window did not come up (${installerWindowTrace(pending)}); asking with a dialog instead`)
    win = null
    pending.destroy()
    void askWithDialog()
  }, 6000)
  return true
}

/** The same question as a native dialog (only if the window's page failed to load). */
async function askWithDialog(): Promise<void> {
  if (!ctx || !plan) return
  const s = screenForPlan(plan)
  const buttons = [s.primary, s.secondary].filter((b): b is NonNullable<typeof b> => !!b)
  const { response } = await dialog.showMessageBox({
    type: 'none',
    message: s.title,
    detail: [s.text, s.note].filter(Boolean).join('\n\n'),
    buttons: buttons.map(b => b.label),
    defaultId: 0,
    cancelId: Math.max(0, buttons.findIndex(b => b.action === 'quit')),
    noLink: true,
  })
  const action = buttons[response]?.action ?? 'quit'
  if (action === 'install' && plan.action === 'install') {
    await install(ctx)
    // install() leaves on success; on failure say why, then quit; if the situation changed, ask again.
    if (leaving) return
    if (screen?.key === 'failed') {
      await dialog.showMessageBox({ type: 'warning', message: screen.title, detail: screen.text, buttons: [t('installer.button.quit')], noLink: true })
      await leave(null)
      return
    }
    return askWithDialog()
  }
  if (action === 'retry') { await refreshPlan(ctx); return askWithDialog() }
  await act(action)
}

/**
 * Self-test (CI, from the packaged app): the window draws a screen and the
 * progress bar, and a real copy of this app into a temporary folder passes
 * the same checks as an install. Nothing is relaunched, ejected or left behind.
 */
export async function installerSelfTest(): Promise<string> {
  const appPath = appBundlePath(process.execPath)
  if (!appPath) throw new Error('not running from an app bundle')

  const drawn = await new Promise<string>((resolve, reject) => {
    let tw: BrowserWindow | null = null
    const timer = setTimeout(() => {
      const why = tw ? installerWindowTrace(tw) : 'no window'
      if (tw && !tw.isDestroyed()) tw.destroy()
      reject(new Error(`the install window did not draw within 15 s (${why})`))
    }, 15_000)
    tw = createInstallerWindow({
      first: {
        key: 'offer', title: t('installer.offer.title'), text: t('installer.offer.text'), note: '',
        primary: { label: t('installer.button.install'), action: 'install' },
        secondary: { label: t('installer.button.quit'), action: 'quit' },
      },
      onAction: () => {},
      onReady: (win2) => {
        setTimeout(async () => {
          try {
            const offer = await win2.webContents.executeJavaScript(
              `({ title: document.querySelector('.screen h1')?.textContent || '', buttons: [...document.querySelectorAll('.screen button')].map(b => b.dataset.action), icon: (document.getElementById('icon')?.naturalWidth || 0) })`)
            win2.webContents.send('installer:screen', workingScreen('copying', 0.5, { folder: folderName(SYSTEM_APPS_DIR) }))
            await sleep(900)
            const working = await win2.webContents.executeJavaScript(
              `({ bar: !!document.querySelector('#stage .screen:last-child .bar .fill'), text: document.querySelector('#stage .screen:last-child p')?.textContent || '' })`)
            clearTimeout(timer)
            win2.destroy()
            if (offer.title !== t('installer.offer.title')) throw new Error(`offer screen not drawn: ${JSON.stringify(offer)}`)
            if (offer.buttons.join(',') !== 'quit,install') throw new Error(`buttons: ${offer.buttons.join(',')}`)
            if (!offer.icon) throw new Error('the app icon did not load')
            if (!working.bar) throw new Error(`progress screen not drawn: ${JSON.stringify(working)}`)
            resolve(`window drew "${offer.title}" and the progress bar`)
          } catch (e) { clearTimeout(timer); if (!win2.isDestroyed()) win2.destroy(); reject(e) }
        }, 600)
      },
    })
  })

  const root = join(tmpdir(), `mlx-install-rehearsal-${process.pid}`)
  try {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    const dest = join(root, 'MLX Harness.app')
    const staging = installStagingPath(dest)
    const started = Date.now()
    let last = 0
    const { signed, bytes } = await copyAndVerify(appPath, staging, app.getVersion(), (step, f) => { last = installProgress(step, f) })
    renameSync(staging, dest)
    cleanupPath = null
    const info = await readBundleInfo(dest)
    if (checkCopy({ bundleId: info?.CFBundleIdentifier, version: info?.CFBundleShortVersionString, runningVersion: app.getVersion() })) {
      throw new Error('the installed copy has the wrong bundle id or version')
    }
    if (last < installProgress('checking', 1) - 1e-9) throw new Error(`progress stopped at ${last}`)
    return `${drawn}; copied ${(bytes / 1e9).toFixed(2)} GB and verified it (${signed ? 'signed by us' : 'unsigned build'}) in ${((Date.now() - started) / 1000).toFixed(1)} s`
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
