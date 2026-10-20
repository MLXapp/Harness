// MLX Harness's in-app updater (Sparkle-style). Checks latest.json at launch
// (after 5 s), every 6 hours and from "Check for Updates…"; announces a newer
// version in the window and, when no window has focus, once per version as a
// macOS notification; on Update downloads the DMG, verifies it (size, SHA-256,
// bundle id, Developer ID signature with our team, notarization, newer
// version), stages the app next to the running one and swaps it in after quit.
// After quit it also renames a copy still called "MLX Studio.app" (0.1.x) to
// "MLX Harness.app" (never over an existing one; see planRename).
// The rules are pure functions in ../shared/appUpdate.ts (tested there).
import { app, BrowserWindow, dialog, ipcMain, net, Notification, shell, type MessageBoxOptions } from 'electron'
import { execFile, spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  accessSync, constants, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, renameSync, rmSync, statSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { db } from './database'
import { t } from './i18n'
import { setUpdateCheckHandler } from './application-menu'
import { decideUpdate, LATEST_MANIFEST_URL, parseLatestRelease, type LatestRelease } from './update-manifest'
import {
  LEGACY_APP_NAMES,
  STUDIO_APP_NAME,
  STUDIO_BUNDLE_ID,
  STUDIO_LATEST_RELEASE_PAGE,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_NOTIFIED_SETTING,
  appBundlePath,
  backupPathFor,
  checkCandidate,
  checkDownload,
  codesignVerifyArgs,
  hdiutilAttachArgs,
  hdiutilDetachArgs,
  isSha256,
  leftoverNames,
  notificationBody,
  planInPlaceInstall,
  planRename,
  preferredAppPath,
  renameCommand,
  shouldNotify,
  spctlAccepted,
  spctlArgs,
  swapCommand,
  type InstallPlan,
  type UpdateFailure,
  type UpdateState,
} from '../shared/appUpdate'

const log = (...a: unknown[]) => console.log('[UPDATE]', ...a)

class UpdateFail extends Error {
  constructor(readonly code: UpdateFailure, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

let getWindow: () => BrowserWindow | null = () => null
let currentVersion = '0.0.0'
let started = false
let state: UpdateState = { phase: 'idle', currentVersion }
let release: LatestRelease | null = null
let plan: InstallPlan | null = null
let staged: { appPath: string; stagingPath: string; version: string } | null = null
let dismissedVersion: string | null = null
let relaunchAfterSwap = false
let checking: Promise<CheckOutcome> | null = null
let installing: Promise<void> | null = null
let cleanedUp = false

export type CheckOutcome =
  | { kind: 'current' }
  | { kind: 'available'; version: string }
  | { kind: 'error' }

// ---------------------------------------------------------------------------
// State → renderer

function send(next: UpdateState): void {
  state = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('app:updateState', state)
}

function patch(p: Partial<UpdateState>): void {
  send({ ...state, ...p })
}

function focusWindow(): void {
  let win = getWindow()
  if (!win || win.isDestroyed()) {
    app.emit('activate')
    win = getWindow()
  }
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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

function remove(path: string): void {
  try { rmSync(path, { recursive: true, force: true }) } catch (e) { log(`could not remove ${path}: ${(e as Error).message}`) }
}

const updatesDir = (): string => join(app.getPath('userData'), 'updates')
const runningAppPath = (): string | null => appBundlePath(app.getPath('exe'))

function computePlan(r: LatestRelease): InstallPlan {
  const appPath = runningAppPath()
  return planInPlaceInstall({
    platform: process.platform,
    packaged: app.isPackaged,
    appPath,
    parentWritable: !!appPath && writable(dirname(appPath)),
    appWritable: !!appPath && writable(appPath),
    hasChecksum: isSha256(r.sha256),
  })
}

/** Leftovers of earlier attempts: partial downloads, staged copies, moved-aside old copies. All names are ours. */
function cleanUpLeftovers(): void {
  if (cleanedUp || process.platform !== 'darwin') return
  cleanedUp = true
  try {
    const dir = updatesDir()
    if (existsSync(dir)) for (const n of readdirSync(dir)) if (/\.(dmg|part)$/.test(n)) remove(join(dir, n))
  } catch { /* nothing to clean */ }
  const appPath = runningAppPath()
  if (!appPath || !app.isPackaged) return
  const parent = dirname(appPath)
  if (!writable(parent)) return
  // Current and 0.1.x names: ".MLX Harness.update.app", ".MLX Studio.update.app", ".MLX … .old-<tag>.app".
  const { staging, oldPrefixes } = leftoverNames(appPath)
  try {
    for (const n of readdirSync(parent)) {
      const p = join(parent, n)
      if (staging.includes(n) || (oldPrefixes.some(prefix => n.startsWith(prefix)) && n.endsWith('.app'))) {
        log(`removing leftover ${p}`)
        remove(p)
      }
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Checking

async function fetchManifest(): Promise<LatestRelease | null> {
  try {
    const res = await net.fetch(LATEST_MANIFEST_URL, { method: 'GET', cache: 'no-store' })
    if (!res.ok) { log(`${LATEST_MANIFEST_URL}: HTTP ${res.status}`); return null }
    return parseLatestRelease(await res.json())
  } catch (e) {
    log(`${LATEST_MANIFEST_URL}: ${(e as Error).message}`)
    return null
  }
}

function check(manual: boolean): Promise<CheckOutcome> {
  checking ??= doCheck(manual).finally(() => { checking = null })
  return checking
}

async function doCheck(manual: boolean): Promise<CheckOutcome> {
  cleanUpLeftovers()
  const manifest = await fetchManifest()
  if (!manifest) return { kind: 'error' }
  const decision = decideUpdate(manifest, currentVersion)
  if (decision.kind === 'no-download') log(`v${decision.version} is announced but has no download yet`)
  if (decision.kind === 'untrusted') log(`ignoring v${decision.version}: untrusted download URL ${decision.url}`)
  if (decision.kind !== 'available') {
    if (decision.kind === 'current') log(`up to date (${currentVersion}; latest ${manifest.version})`)
    return { kind: 'current' }
  }
  const r = decision.release
  if (manual) dismissedVersion = null
  // An install of this version in progress or ready: keep it, just reveal it again.
  const busy = state.phase === 'downloading' || state.phase === 'verifying' || state.phase === 'ready'
  if (busy && state.version === r.version) {
    if (manual) patch({ dismissed: false })
    return { kind: 'available', version: r.version }
  }
  if (busy) return { kind: 'available', version: state.version! }
  release = r
  plan = computePlan(r)
  log(`new version available: ${currentVersion} → ${r.version}${plan.ok ? '' : ` (manual: ${plan.reason})`}`)
  send({
    phase: 'available',
    currentVersion,
    version: r.version,
    notes: r.notes,
    blocked: plan.ok ? null : plan.reason,
    dismissed: dismissedVersion === r.version,
  })
  if (!manual) maybeNotify(r)
  return { kind: 'available', version: r.version }
}

function maybeNotify(r: LatestRelease): void {
  let notified: string | undefined
  try { notified = db.getSetting(UPDATE_NOTIFIED_SETTING) } catch { /* settings unavailable */ }
  const focused = BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isFocused())
  if (!shouldNotify({ version: r.version, notifiedVersion: notified, windowFocused: focused, supported: Notification.isSupported() })) return
  try { db.setSetting(UPDATE_NOTIFIED_SETTING, r.version) } catch { /* still notify this time */ }
  const n = new Notification({
    title: t('update.notification.title', { version: r.version }),
    body: notificationBody(r.notes, t('update.notification.body')),
  })
  n.on('click', () => { dismissedVersion = null; if (state.version === r.version) patch({ dismissed: false }); focusWindow() })
  n.show()
}

// ---------------------------------------------------------------------------
// Installing

/** Download into `dmg` with progress; returns the byte count and SHA-256 actually received. */
async function download(url: string, dmg: string, expectedSize: number | undefined, signal: AbortSignal,
  onProgress: (received: number, total: number) => void): Promise<{ size: number; sha256: string }> {
  const part = `${dmg}.part`
  remove(part)
  let res: Response
  try { res = await net.fetch(url, { signal, cache: 'no-store' }) } catch (e) { throw new UpdateFail('network', (e as Error).message) }
  if (!res.ok || !res.body) throw new UpdateFail('network', `HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length')) || 0
  if (expectedSize && length && length !== expectedSize) throw new UpdateFail('size', `${length} != ${expectedSize}`)
  const total = expectedSize || length
  const hash = createHash('sha256')
  const out = createWriteStream(part)
  // A disk error (full, removed) must fail the install, never surface as an unhandled 'error' event.
  let writeError: Error | null = null
  out.on('error', (e) => { writeError = e })
  const failIfWriteError = () => { if (writeError) throw new UpdateFail('copy', `write: ${writeError.message}`) }
  const reader = res.body.getReader()
  let received = 0
  let last = 0
  try {
    onProgress(0, total)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (expectedSize && received > expectedSize) throw new UpdateFail('size', 'more bytes than announced')
      hash.update(value)
      failIfWriteError()
      if (!out.write(value)) await new Promise<void>((r) => { out.once('drain', r); out.once('close', r) })
      failIfWriteError()
      const now = Date.now()
      if (now - last >= 120) { last = now; onProgress(received, total) }
    }
    onProgress(received, total || received)
    await new Promise<void>((resolve) => { out.once('close', resolve); out.end() })
    failIfWriteError()
  } catch (e) {
    out.destroy()
    try { await reader.cancel() } catch { /* closed */ }
    remove(part)
    if (e instanceof UpdateFail) throw e
    throw new UpdateFail('network', (e as Error).message)
  }
  renameSync(part, dmg)
  return { size: received, sha256: hash.digest('hex') }
}

/** The running copy is our signed app (so replacing it is ours to do). Not deep: only the bundle's own seal. */
async function verifyRunningApp(appPath: string): Promise<boolean> {
  const info = await readBundleInfo(appPath)
  if (info?.CFBundleIdentifier !== STUDIO_BUNDLE_ID) return false
  return (await run('/usr/bin/codesign', codesignVerifyArgs(appPath, false), 180_000)).ok
}

/**
 * The app at the top of the mounted image (a real folder, not a link):
 * "MLX Harness.app" (or a 0.1.x "MLX Studio.app") when present (its bundle id
 * is checked next), otherwise the one other .app carrying our bundle id.
 */
async function findStudioApp(mount: string): Promise<string | null> {
  const isDir = (p: string) => { try { return lstatSync(p).isDirectory() } catch { return false } }
  for (const name of [STUDIO_APP_NAME, ...LEGACY_APP_NAMES]) {
    const named = join(mount, name)
    if (isDir(named)) return named
  }
  let entries: string[] = []
  try { entries = readdirSync(mount) } catch { return null }
  for (const n of entries.filter(e => e.endsWith('.app'))) {
    const p = join(mount, n)
    if (isDir(p) && (await readBundleInfo(p))?.CFBundleIdentifier === STUDIO_BUNDLE_ID) return p
  }
  return null
}

async function detach(mount: string): Promise<void> {
  if (!(await run('/usr/bin/hdiutil', hdiutilDetachArgs(mount), 60_000)).ok) {
    await run('/usr/bin/hdiutil', hdiutilDetachArgs(mount, true), 60_000)
  }
}

function install(): Promise<void> {
  if (!release || !(state.phase === 'available' || state.phase === 'error')) return Promise.resolve()
  plan = computePlan(release)
  if (!plan.ok) {
    patch({ blocked: plan.reason })
    openManualDownload()
    return Promise.resolve()
  }
  installing ??= doInstall(release, plan).finally(() => { installing = null })
  return installing
}

async function doInstall(r: LatestRelease, p: Extract<InstallPlan, { ok: true }>): Promise<void> {
  const version = r.version
  send({ phase: 'downloading', currentVersion, version, notes: r.notes, blocked: null, received: 0, total: r.size ?? 0 })
  const dir = updatesDir()
  const dmg = join(dir, `MLX-Harness-${version.replace(/[^0-9A-Za-z.-]/g, '')}.dmg`)
  const abort = new AbortController()
  let notOurs = false
  const ownCheck = verifyRunningApp(p.appPath).then((ok) => {
    if (!ok) { notOurs = true; abort.abort() }
    return ok
  })
  let mount: string | null = null
  let stagedOk = false
  try {
    mkdirSync(dir, { recursive: true })
    let got: { size: number; sha256: string }
    try {
      got = await download(r.url, dmg, typeof r.size === 'number' ? r.size : undefined, abort.signal,
        (received, total) => patch({ received, total }))
    } catch (e) {
      if (notOurs) throw new UpdateFail('currentApp')
      throw e
    }
    if (!(await ownCheck)) throw new UpdateFail('currentApp')
    const bad = checkDownload({ expectedSize: r.size, expectedSha256: r.sha256 ?? '', size: got.size, sha256: got.sha256 })
    if (bad) throw new UpdateFail(bad, `${got.size} bytes, sha256 ${got.sha256}`)

    patch({ phase: 'verifying' })
    mount = mkdtempSync(join(tmpdir(), 'mlx-harness-update-'))
    const attach = await run('/usr/bin/hdiutil', hdiutilAttachArgs(dmg, mount), 180_000)
    if (!attach.ok) throw new UpdateFail('mount', attach.out)
    const candidate = await findStudioApp(mount)
    if (!candidate) throw new UpdateFail('notFound')
    const info = await readBundleInfo(candidate)
    const wrong = checkCandidate({ bundleId: info?.CFBundleIdentifier, version: info?.CFBundleShortVersionString, runningVersion: currentVersion })
    if (wrong) throw new UpdateFail(wrong, String(info?.CFBundleShortVersionString ?? ''))
    const sig = await run('/usr/bin/codesign', codesignVerifyArgs(candidate), 600_000)
    if (!sig.ok) throw new UpdateFail('signature', sig.out)
    const gk = await run('/usr/sbin/spctl', spctlArgs(candidate), 180_000)
    if (!spctlAccepted(gk.ok, gk.out)) throw new UpdateFail('notarization', gk.out)

    // Copy next to the running app (same volume → the swap is a rename), then check the copy too.
    remove(p.stagingPath)
    const copy = await run('/usr/bin/ditto', [candidate, p.stagingPath], 600_000)
    if (!copy.ok) throw new UpdateFail('copy', copy.out)
    const stagedSig = await run('/usr/bin/codesign', codesignVerifyArgs(p.stagingPath), 600_000)
    if (!stagedSig.ok) throw new UpdateFail('signature', `staged copy: ${stagedSig.out}`)
    const stagedInfo = await readBundleInfo(p.stagingPath)
    if (checkCandidate({ bundleId: stagedInfo?.CFBundleIdentifier, version: stagedInfo?.CFBundleShortVersionString, runningVersion: currentVersion })) {
      throw new UpdateFail('copy', 'staged copy differs')
    }
    staged = { appPath: p.appPath, stagingPath: p.stagingPath, version: String(stagedInfo?.CFBundleShortVersionString) }
    stagedOk = true
    log(`MLX Harness ${staged.version} is staged at ${p.stagingPath}`)
    send({ phase: 'ready', currentVersion, version, notes: r.notes, blocked: null, dismissed: false })
  } catch (e) {
    const code: UpdateFailure = e instanceof UpdateFail ? e.code : 'copy'
    log(`install failed: ${(e as Error).message}`)
    send({ phase: 'error', currentVersion, version, notes: r.notes, blocked: null, error: code, dismissed: false })
  } finally {
    abort.abort()
    if (mount) {
      await detach(mount)
      try { if (existsSync(mount) && readdirSync(mount).length === 0) rmSync(mount, { recursive: true, force: true }) } catch { /* still mounted */ }
    }
    remove(dmg)
    remove(`${dmg}.part`)
    if (!stagedOk) remove(p.stagingPath)
  }
}

function openManualDownload(): void {
  // The DMG for a copy that can't replace itself; the release page after a failed install.
  const url = state.phase === 'error' || !release?.url ? STUDIO_LATEST_RELEASE_PAGE : release.url
  void shell.openExternal(url)
}

function restartToUpdate(): void {
  if (!staged || !existsSync(staged.stagingPath)) {
    staged = null
    send({ ...state, phase: 'error', error: 'copy' })
    return
  }
  relaunchAfterSwap = true
  app.quit()
}

/** A quit that was cancelled (an engine would not stop) must not relaunch later. */
export function cancelUpdateRelaunch(): void {
  relaunchAfterSwap = false
}

/**
 * Called as the very last step of quitting: if a verified update is staged,
 * start the detached swap (it waits for this process to exit). It relaunches
 * only when the quit came from "Restart to update"; any other quit installs
 * it for the next launch. A copy still called "MLX Studio.app" gets the new
 * copy under "MLX Harness.app" (the swap falls back to the old name when
 * that exists). With nothing staged, such a copy is renamed after quit
 * instead (runPendingRename).
 */
export function runPendingUpdateSwap(): void {
  if (process.platform !== 'darwin') return
  if (!staged) { runPendingRename(); return }
  try {
    if (!statSync(staged.stagingPath).isDirectory()) { runPendingRename(); return }
    const dir = updatesDir()
    mkdirSync(dir, { recursive: true })
    const target = preferredAppPath(staged.appPath)
    const { file, args } = swapCommand({
      pid: process.pid,
      appPath: staged.appPath,
      stagedPath: staged.stagingPath,
      backupPath: backupPathFor(staged.appPath, process.pid),
      targetPath: target,
      relaunch: relaunchAfterSwap,
      logPath: join(dir, 'swap.log'),
    })
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.unref()
    log(`swap to ${staged.version} started (relaunch: ${relaunchAfterSwap}${target !== staged.appPath ? `, as ${target}` : ''})`)
    staged = null
  } catch (e) {
    log(`could not start the swap: ${(e as Error).message}`)
  }
}

/**
 * 0.1.x → 0.2.0: the old app's updater swapped this version into
 * "MLX Studio.app". Rename it to "MLX Harness.app" once this process (and
 * everything running from the bundle) has exited. Renaming a running bundle
 * would break Electron's helpers and the bundled engine, so it never happens
 * while the app runs. Never over an existing "MLX Harness.app"; if it can't
 * happen the app keeps its old name and the next quit tries again.
 */
function runPendingRename(): void {
  try {
    const appPath = runningAppPath()
    const target = appPath ? preferredAppPath(appPath) : null
    const plan = planRename({
      platform: process.platform,
      packaged: app.isPackaged,
      appPath,
      parentWritable: !!appPath && writable(dirname(appPath)),
      appWritable: !!appPath && writable(appPath),
      targetExists: !!target && target !== appPath && existsSync(target),
    })
    if (!plan) return
    const dir = updatesDir()
    mkdirSync(dir, { recursive: true })
    const { file, args } = renameCommand({ pid: process.pid, appPath: plan.from, targetPath: plan.to, logPath: join(dir, 'rename.log') })
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.unref()
    log(`renaming ${plan.from} → ${plan.to} after quit`)
  } catch (e) {
    log(`could not start the rename: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// "Check for Updates…" (app menu)

function showMessage(opts: MessageBoxOptions) {
  const win = getWindow()
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
}

export async function checkForUpdatesInteractive(): Promise<void> {
  if (state.phase === 'downloading' || state.phase === 'verifying') {
    dismissedVersion = null
    patch({ dismissed: false })
    focusWindow()
    return
  }
  if (state.phase === 'ready' && staged) {
    const { response } = await showMessage({
      type: 'info',
      message: t('update.dialog.readyTitle', { version: state.version ?? '' }),
      detail: t('update.dialog.readyDetail'),
      buttons: [t('update.banner.restart'), t('update.banner.later')],
      defaultId: 0, cancelId: 1, noLink: true,
    })
    if (response === 0) restartToUpdate()
    return
  }
  const outcome = await check(true)
  if (outcome.kind === 'error') {
    await showMessage({
      type: 'warning',
      message: t('update.dialog.failedTitle'),
      detail: t('update.dialog.failedDetail'),
      buttons: [t('main.dialog.ok')], noLink: true,
    })
    return
  }
  if (outcome.kind === 'current') {
    await showMessage({
      type: 'info',
      message: t('update.dialog.upToDateTitle'),
      detail: t('update.dialog.upToDateDetail', { version: currentVersion }),
      buttons: [t('main.dialog.ok')], noLink: true,
    })
    return
  }
  if (state.phase !== 'available') { focusWindow(); return }
  const auto = !state.blocked
  const reason = state.blocked ? `\n\n${t(`update.reason.${state.blocked}`)}` : ''
  const { response } = await showMessage({
    type: 'info',
    message: t('update.dialog.availableTitle', { version: outcome.version }),
    detail: `${state.notes ? `${state.notes}\n\n` : ''}${t('update.dialog.availableDetail', { current: currentVersion })}${reason}`,
    buttons: [auto ? t('update.banner.update') : t('update.banner.download'), t('update.banner.later')],
    defaultId: 0, cancelId: 1, noLink: true,
  })
  if (response !== 0) { dismissedVersion = outcome.version; patch({ dismissed: true }); return }
  if (auto) { focusWindow(); void install() } else openManualDownload()
}

// ---------------------------------------------------------------------------
// Start

export function startAppUpdater(opts: { getWindow: () => BrowserWindow | null; currentVersion: string; autoCheck?: boolean }): void {
  if (started) return
  started = true
  getWindow = opts.getWindow
  currentVersion = opts.currentVersion
  state = { phase: 'idle', currentVersion }

  ipcMain.handle('app:updateState', () => state)
  ipcMain.handle('app:updateInstall', () => install())
  ipcMain.handle('app:updateRestart', () => restartToUpdate())
  ipcMain.handle('app:updateLater', () => {
    if (state.version) dismissedVersion = state.version
    // Later on a failed install goes back to the offer (hidden until the next version or launch).
    if (state.phase === 'error') send({ ...state, phase: 'available', error: undefined, dismissed: true })
    else patch({ dismissed: true })
  })
  ipcMain.handle('app:updateOpenDownload', () => openManualDownload())
  setUpdateCheckHandler(() => {
    checkForUpdatesInteractive().catch(e => log(`check failed: ${(e as Error).message}`))
  })

  if (opts.autoCheck === false) return
  const tick = () => { check(false).catch(e => log(`check failed: ${(e as Error).message}`)) }
  setTimeout(tick, UPDATE_CHECK_DELAY_MS)
  setInterval(tick, UPDATE_CHECK_INTERVAL_MS).unref?.()
}

/** A background check now (tests, diagnostics); "Check for Updates…" uses checkForUpdatesInteractive. */
export function checkNow(): Promise<CheckOutcome> {
  return check(false)
}

export function getUpdateState(): UpdateState {
  return state
}
