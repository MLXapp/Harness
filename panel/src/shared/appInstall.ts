/**
 * MLX Harness's installer: the pure rules (shared with the tests). Windows,
 * processes and the file system live in src/main/app-installer.ts.
 *
 * The DMG carries only the app (no Applications drag target). Opened from the
 * disk image (or App-Translocated by macOS, e.g. straight from Downloads), the
 * app shows a small install window instead of starting: Install copies it into
 * /Applications (~/Applications when this account can't write there), checks
 * the copy's signature, relaunches it from there and ejects the disk image.
 *
 * Never a downgrade: when the same or a newer MLX Harness is already
 * installed, the window offers to open that one instead; an older one is
 * replaced (quit first if it is running). Why not Electron's
 * app.moveToApplicationsFolder(): it copies the bundle (about 1.5 GB) on the
 * main thread, so the window freezes with no progress; on the password path
 * it never calls its conflictHandler (rm -rf of whatever is there); and it
 * can't eject a disk image the app was translocated from.
 */

import {
  HARNESS_APP_NAME,
  HARNESS_BUNDLE_ID,
  LEGACY_APP_NAMES,
  compareAppVersions,
  isOnMountedImage,
  isTranslocated,
} from './appUpdate'

export const SYSTEM_APPS_DIR = '/Applications'
/** Start normally from the disk image (no installer): argument or environment. */
export const INSTALLER_OPT_OUT_ARG = '--mlx-no-install'
export const INSTALLER_OPT_OUT_ENV = 'MLX_HARNESS_NO_INSTALLER'

// ---------------------------------------------------------------------------
// Paths (POSIX, macOS only; no Node path module so the renderer can share this)

function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function basename(p: string): string {
  const s = p.replace(/\/+$/, '')
  return s.slice(s.lastIndexOf('/') + 1)
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

// ---------------------------------------------------------------------------
// Is this launch the installer?

export type InstallerSource = 'dmg' | 'translocated'

export interface InstallerLaunchFacts {
  platform: string
  /** app.isPackaged */
  packaged: boolean
  /** Bundle around the running executable (appBundlePath), if any. */
  appPath: string | null
  argv: readonly string[]
  env: Record<string, string | undefined>
  /** --mlx-self-test (CI) */
  selfTest: boolean
  /** An isolated proof instance (--vmlx-allow-secondary-instance with its own userData). */
  secondaryInstance: boolean
}

/**
 * Whether this launch may be the installer: a packaged Mac copy running from
 * a mounted volume (confirmed as a disk image before the window shows, so an
 * app kept on an external drive starts normally) or translocated by macOS.
 * Never for CI's self-test, proof instances or with the opt-out.
 */
export function installerSource(f: InstallerLaunchFacts): InstallerSource | null {
  if (f.platform !== 'darwin' || !f.packaged || !f.appPath || !f.appPath.endsWith('.app')) return null
  if (f.selfTest || f.secondaryInstance) return null
  if (f.argv.includes(INSTALLER_OPT_OUT_ARG) || f.env[INSTALLER_OPT_OUT_ENV] === '1') return null
  if (isTranslocated(f.appPath)) return 'translocated'
  if (isOnMountedImage(f.appPath)) return 'dmg'
  return null
}

/** "/Volumes/MLX Harness 0.5.5/MLX Harness.app" → "/Volumes/MLX Harness 0.5.5". */
export function volumeRoot(path: string): string | null {
  const m = /^(\/Volumes\/[^/]+)(\/|$)/.exec(String(path ?? ''))
  return m ? m[1] : null
}

function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[e])
}

/** Mount points of attached disk images, from `hdiutil info -plist`. */
export function diskImageMountPoints(plistXml: string): string[] {
  const out: string[] = []
  const re = /<key>mount-point<\/key>\s*<string>([^<]*)<\/string>/g
  for (const m of String(plistXml ?? '').matchAll(re)) out.push(unescapeXml(m[1]))
  return out
}

/**
 * Where a translocated app really lives, from `/sbin/mount` output. macOS
 * runs it from a read-only nullfs mount,
 *   "<original> on /private/var/folders/…/AppTranslocation/<UUID> (nullfs, …)",
 * and the app sits under that mount ("…/<UUID>/d/MLX Harness.app").
 */
export function translocationOrigin(mountOutput: string, appPath: string): string | null {
  const m = /^(.*\/AppTranslocation\/[^/]+)\//.exec(String(appPath ?? ''))
  if (!m) return null
  const roots = new Set([m[1], m[1].replace(/^\/private\//, '/'), m[1].startsWith('/private/') ? m[1] : `/private${m[1]}`])
  for (const line of String(mountOutput ?? '').split('\n')) {
    for (const root of roots) {
      const i = line.lastIndexOf(` on ${root} (`)
      if (i > 0) return line.slice(0, i)
    }
  }
  return null
}

/**
 * The disk image to eject after installing: the /Volumes root the app runs
 * from (directly, or under translocation), when `hdiutil info` lists it as
 * an attached image. Anything else (an external drive, Downloads) is left alone.
 */
export function ejectTarget(x: { source: InstallerSource; appPath: string; origin: string | null; imageMounts: readonly string[] }): string | null {
  const from = x.source === 'translocated' ? x.origin : x.appPath
  const root = from ? volumeRoot(from) : null
  return root && x.imageMounts.includes(root) ? root : null
}

// ---------------------------------------------------------------------------
// Running copies (`ps -axo pid=,comm=`: comm is each process's executable path on macOS)

const MAIN_NAMES = [HARNESS_APP_NAME, ...LEGACY_APP_NAMES]

export interface RunningCopy {
  pid: number
  /** The .app bundle the main executable runs from. */
  appPath: string
}

/** MLX Harness (or 0.1.x "MLX Studio") main processes; helpers, engines and `selfPid` are left out. */
export function parseRunningCopies(psOutput: string, selfPid: number): RunningCopy[] {
  const out: RunningCopy[] = []
  for (const raw of String(psOutput ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\/.+)$/.exec(raw)
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue
    const exe = m[2].trimEnd()
    const b = /^(\/.+\.app)\/Contents\/MacOS\/([^/]+)$/.exec(exe)
    if (!b) continue
    const app = b[1]
    const name = basename(app)
    if (!MAIN_NAMES.includes(name) || !MAIN_NAMES.includes(`${b[2]}.app`)) continue
    // Not an app nested inside another bundle (an MLX Harness.app inside some other .app).
    if (app.slice(0, -'.app'.length).includes('.app/')) continue
    out.push({ pid, appPath: app })
  }
  return out
}

/** Another installer (a copy running from a disk image or translocated) is open. */
export function isInstallerCopy(appPath: string): boolean {
  return isTranslocated(appPath) || isOnMountedImage(appPath)
}

// ---------------------------------------------------------------------------
// What Install does

/** Where installed copies are looked for, in order of preference. */
export function knownInstallPaths(systemAppsDir: string, userAppsDir: string): string[] {
  return [systemAppsDir, userAppsDir].flatMap(dir => MAIN_NAMES.map(n => joinPath(dir, n)))
}

export interface FoundCopy {
  path: string
  bundleId?: unknown
  version?: unknown
  running: boolean
  /** The bundle itself can be moved or deleted by this user. */
  writable: boolean
}

export interface InstallerFacts {
  /** The version running from the disk image. */
  runningVersion: string
  /** What sits at knownInstallPaths, plus running copies elsewhere (never this one). */
  copies: FoundCopy[]
  systemAppsDir: string
  userAppsDir: string
  /** /Applications can be written by this user. */
  systemAppsWritable: boolean
  /** ~/Applications exists and can be written, or can be created. */
  userAppsWritable: boolean
}

export type InstallerPlan =
  /** The same or a newer MLX Harness is installed (or running): open it, never downgrade. */
  | { action: 'open'; path: string; version: string; newer: boolean }
  | {
    action: 'install'
    dir: string
    dest: string
    /** The older copy at dest that the new one replaces. */
    replaces: FoundCopy | null
    /** Older copies that are running: quit before installing (one MLX Harness at a time). */
    quitFirst: FoundCopy[]
    /** Older copies in the Applications folders besides dest: moved to the Trash afterwards. */
    trash: string[]
  }
  | { action: 'blocked'; reason: 'notWritable' | 'occupied' }

const isOurs = (c: FoundCopy): boolean => c.bundleId === HARNESS_BUNDLE_ID

/**
 * Decide what the install window offers. Never a downgrade: any copy of ours
 * at the same or a newer version wins (a version that can't be read counts as
 * not older). /Applications is preferred, ~/Applications the fallback; a
 * destination held by something that isn't MLX Harness is never touched.
 */
export function planInstall(f: InstallerFacts): InstallerPlan {
  const ours = f.copies.filter(isOurs)
  const keep = ours
    .map((c, i) => ({ c, i, v: String(c.version ?? '') }))
    .filter(x => compareAppVersions(x.v, f.runningVersion) >= 0)
    .sort((a, b) => compareAppVersions(b.v, a.v) || a.i - b.i)
  if (keep.length) {
    const best = keep[0]
    return { action: 'open', path: best.c.path, version: best.v, newer: compareAppVersions(best.v, f.runningVersion) > 0 }
  }

  const at = (dest: string) => f.copies.find(c => c.path === dest)
  const usable = (dirWritable: boolean, dest: string): 'ok' | 'occupied' | 'no' => {
    if (!dirWritable) return 'no'
    const there = at(dest)
    if (!there) return 'ok'
    if (!isOurs(there)) return 'occupied'
    return there.writable ? 'ok' : 'no'
  }
  const sysDest = joinPath(f.systemAppsDir, HARNESS_APP_NAME)
  const userDest = joinPath(f.userAppsDir, HARNESS_APP_NAME)
  const sys = usable(f.systemAppsWritable, sysDest)
  const user = usable(f.userAppsWritable, userDest)
  const pick = sys === 'ok' ? { dir: f.systemAppsDir, dest: sysDest } : user === 'ok' ? { dir: f.userAppsDir, dest: userDest } : null
  if (!pick) return { action: 'blocked', reason: sys === 'occupied' || user === 'occupied' ? 'occupied' : 'notWritable' }

  const replaces = at(pick.dest) ?? null
  const appsDirs = new Set([f.systemAppsDir, f.userAppsDir])
  return {
    action: 'install',
    dir: pick.dir,
    dest: pick.dest,
    replaces,
    quitFirst: ours.filter(c => c.running),
    trash: ours.filter(c => c.path !== pick.dest && appsDirs.has(dirname(c.path)) && c.writable).map(c => c.path),
  }
}

/** The copy being made, hidden next to its destination (same volume: the last step is a rename). */
export function installStagingPath(dest: string): string {
  return joinPath(dirname(dest), `.${basename(dest).replace(/\.app$/, '')}.install.app`)
}

/** Where an older copy at the destination is moved aside while the new one goes in. */
export function installBackupPath(dest: string, tag: string | number): string {
  const safe = String(tag).replace(/[^A-Za-z0-9_-]/g, '')
  return joinPath(dirname(dest), `.${basename(dest).replace(/\.app$/, '')}.replaced-${safe}.app`)
}

/** Free space needed for a copy of `bundleBytes`: the copy plus 5% and 256 MB to spare. */
export function bytesNeeded(bundleBytes: number): number {
  return Math.ceil(Math.max(0, bundleBytes) * 1.05) + 256 * 1024 * 1024
}

/** The copy is ours and the same version as the running app. */
export function checkCopy(x: { bundleId: unknown; version: unknown; runningVersion: string }): 'notOurs' | 'version' | null {
  if (x.bundleId !== HARNESS_BUNDLE_ID) return 'notOurs'
  if (typeof x.version !== 'string' || !x.version.trim() || x.version.trim() !== x.runningVersion.trim()) return 'version'
  return null
}

// ---------------------------------------------------------------------------
// Progress (one bar across the steps)

export type InstallStep = 'quitting' | 'copying' | 'checking' | 'finishing' | 'opening'

const STEP_RANGE: Record<InstallStep, [number, number]> = {
  quitting: [0, 0.04],
  copying: [0.04, 0.86],
  checking: [0.86, 0.97],
  finishing: [0.97, 1],
  opening: [1, 1],
}

/** Overall progress 0…1 for a step and how far it is (0…1). Never NaN. */
export function installProgress(step: InstallStep, fraction = 0): number {
  const [a, b] = STEP_RANGE[step]
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  return a + (b - a) * f
}

/**
 * The install window's language: the one chosen in MLX Harness (an earlier
 * install on this Mac), otherwise the first of the system's preferred
 * languages the app speaks ("zh-Hans-CN" → zh), otherwise English.
 */
export function installerLocale(saved: string | null | undefined, preferred: readonly string[], supported: readonly string[]): string {
  if (saved && supported.includes(saved)) return saved
  for (const tag of preferred) {
    const base = String(tag ?? '').toLowerCase().split(/[-_]/)[0]
    if (supported.includes(base)) return base
  }
  return supported.includes('en') ? 'en' : supported[0] ?? 'en'
}

// ---------------------------------------------------------------------------
// What the window shows (built in main with translated strings)

export type InstallerAction = 'install' | 'open' | 'quit' | 'retry'

export interface InstallerScreen {
  /** Same key: the texts update in place; a new key cross-fades to a new screen. */
  key: 'offer' | 'installed' | 'blocked' | 'working' | 'failed'
  title: string
  text: string
  /** A second, quieter line. */
  note?: string
  primary?: { label: string; action: InstallerAction }
  secondary?: { label: string; action: InstallerAction }
  /** 0…1: the screen shows the progress bar instead of buttons. */
  progress?: number
}

export function isInstallerAction(v: unknown): v is InstallerAction {
  return v === 'install' || v === 'open' || v === 'quit' || v === 'retry'
}

// ---------------------------------------------------------------------------
// After the installer quits: open the installed app, then eject the disk image

/**
 * Runs detached under /bin/sh once the installer's window has faded out.
 * Every path arrives as a positional argument and is only used inside double
 * quotes (spaces, quotes, $ and ; stay inert).
 *
 *   $1 pid to wait for   $2 app to open ("" = none)   $3 disk image to eject ("" = none)
 *   $4 open binary       $5 hdiutil binary            $6 log file
 *
 * Waits for the installer to exit (up to 2 minutes; past that nothing is
 * opened, so two copies never race for the same data), opens the app, then
 * ejects the image without force, retrying while macOS still holds it
 * (Finder, the translocation mount); if it stays busy it is left mounted.
 */
export const RELAUNCH_SCRIPT = `
PID="$1"; APP="$2"; VOL="$3"; OPEN="$4"; HDIUTIL="$5"; LOG="$6"
trap '' HUP INT TERM
exec >>"$LOG" 2>&1
echo "[$(date)] MLX Harness installer: waiting for pid $PID"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then echo "the installer is still running; nothing opened"; exit 1; fi
  sleep 0.1
done
if [ -n "$APP" ]; then
  if "$OPEN" "$APP"; then echo "opened $APP"; else echo "could not open $APP"; fi
fi
if [ -n "$VOL" ]; then
  j=0
  while [ "$j" -lt 20 ]; do
    sleep 1
    if [ ! -d "$VOL" ]; then echo "$VOL is gone"; exit 0; fi
    if "$HDIUTIL" detach "$VOL" -quiet; then echo "ejected $VOL"; exit 0; fi
    j=$((j + 1))
  done
  echo "could not eject $VOL; left mounted"
fi
exit 0
`.trim()

export interface RelaunchCommandInput {
  pid: number
  /** The installed app to open, or null. */
  appPath: string | null
  /** The disk image's mount point to eject, or null. */
  volume: string | null
  logPath: string
  openBin?: string
  hdiutilBin?: string
}

/** The exact argv for spawn('/bin/sh', args, { detached: true }). */
export function relaunchCommand(x: RelaunchCommandInput): { file: string; args: string[] } {
  if (!Number.isInteger(x.pid) || x.pid <= 0) throw new Error('relaunchCommand: bad pid')
  const abs = (p: string) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')
  if (!abs(x.logPath)) throw new Error('relaunchCommand: the log path must be absolute')
  if (x.appPath !== null && (!abs(x.appPath) || !x.appPath.endsWith('.app'))) throw new Error('relaunchCommand: bad app path')
  if (x.volume !== null && (!abs(x.volume) || volumeRoot(x.volume) !== x.volume)) throw new Error('relaunchCommand: only a /Volumes/<name> mount is ejected')
  return {
    file: '/bin/sh',
    args: [
      '-c', RELAUNCH_SCRIPT, 'mlx-harness-install',
      String(x.pid), x.appPath ?? '', x.volume ?? '', x.openBin ?? '/usr/bin/open', x.hdiutilBin ?? '/usr/bin/hdiutil', x.logPath,
    ],
  }
}
