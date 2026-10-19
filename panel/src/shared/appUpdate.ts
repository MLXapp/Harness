/**
 * MLX Studio's in-app updater: the pure rules (shared with the renderer and
 * the tests). Network, processes and the file system live in
 * src/main/app-updater.ts.
 *
 * The flow, Sparkle-style: latest.json announces a version → the banner (and
 * a macOS notification when no window is focused) offers it → Update
 * downloads the DMG into userData/updates, checks size and SHA-256, mounts it
 * read-only, checks the app inside (bundle id, Developer ID signature with our
 * team and bundle id, notarization, newer version), copies it next to the
 * running app as a hidden staged copy → Restart to update quits, and a
 * detached shell script swaps the staged copy into the original path with two
 * renames on the same volume, then relaunches it.
 */

export const STUDIO_BUNDLE_ID = 'app.mlx.studio'
export const STUDIO_TEAM_ID = 'CCKXS9W488'
export const STUDIO_APP_NAME = 'MLX Studio.app'

/**
 * Designated requirement a downloaded MLX Studio must satisfy: Apple-anchored
 * chain, a Developer ID Application certificate (the two Apple OIDs: Developer
 * ID intermediate and Developer ID leaf), our team, our bundle id.
 */
export const STUDIO_REQUIREMENT =
  `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists ` +
  `and certificate leaf[field.1.2.840.113635.100.6.1.13] exists ` +
  `and certificate leaf[subject.OU] = "${STUDIO_TEAM_ID}" and identifier "${STUDIO_BUNDLE_ID}"`

export const UPDATE_CHECK_DELAY_MS = 5_000
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Settings-store key: the last version a macOS notification was shown for. */
export const UPDATE_NOTIFIED_SETTING = 'studio_update_notified_version'
/** Where people download by hand when the app can't update itself. */
export const STUDIO_LATEST_RELEASE_PAGE = 'https://github.com/MLXapp/studio/releases/latest'

/** Why this copy can't replace itself (the banner then offers the DMG instead). */
export type InstallBlock =
  | 'development' // unpackaged dev build: report only
  | 'unsupported' // not macOS
  | 'notApp' // no .app bundle around the running executable
  | 'mountedDmg' // running from the disk image
  | 'translocated' // macOS App Translocation (opened straight from Downloads, quarantined)
  | 'notWritable' // the app or its folder can't be written by this user
  | 'noChecksum' // the manifest has no SHA-256 for the download

/** What went wrong during an install (every one falls back to downloading by hand). */
export type UpdateFailure =
  | 'network' // the download failed or was cut off
  | 'size' // byte count differs from the manifest
  | 'checksum' // SHA-256 differs from the manifest
  | 'mount' // hdiutil could not attach the DMG
  | 'notFound' // no MLX Studio.app in the DMG
  | 'notOurs' // the app in the DMG has another bundle id
  | 'signature' // codesign: not signed by us / broken seal
  | 'notarization' // spctl: not accepted as Notarized Developer ID
  | 'notNewer' // the app in the DMG is not newer than this one
  | 'currentApp' // the running copy is not our signed app, so it's never replaced
  | 'copy' // ditto into the staging folder failed
  | 'busy' // another install is running

export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'verifying' | 'ready' | 'error'

/** Everything the renderer needs to draw the banner. */
export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  version?: string
  notes?: string
  /** null: Update installs in place. Otherwise why not; the banner offers the DMG. */
  blocked?: InstallBlock | null
  received?: number
  total?: number
  error?: UpdateFailure | InstallBlock
  /** "Later" was chosen for this version during this launch. */
  dismissed?: boolean
}

// ---------------------------------------------------------------------------
// Versions

function parts(v: string): number[] | null {
  const clean = String(v ?? '').trim().replace(/^v/i, '').replace(/[-+].*$/, '')
  if (!/^\d+(\.\d+)*$/.test(clean)) return null
  return clean.split('.').map(Number)
}

/** a > b → 1, a < b → -1, equal or unparseable → 0. Pre-release suffixes are ignored. */
export function compareAppVersions(a: string, b: string): number {
  const av = parts(a)
  const bv = parts(b)
  if (!av || !bv) return 0
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const x = av[i] ?? 0
    const y = bv[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** True only when `candidate` is strictly newer than `running` (unparseable → false). */
export function isNewerVersion(candidate: string, running: string): boolean {
  return compareAppVersions(candidate, running) > 0
}

// ---------------------------------------------------------------------------
// Where the running app lives, and whether it may replace itself

/** "/Applications/MLX Studio.app/Contents/MacOS/MLX Studio" → "/Applications/MLX Studio.app". */
export function appBundlePath(exePath: string): string | null {
  const m = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exePath ?? ''))
  return m ? m[1] : null
}

export function isTranslocated(path: string): boolean {
  return path.includes('/AppTranslocation/')
}

/**
 * Running from a mounted volume that isn't an Applications folder on another
 * disk (a DMG mount: /Volumes/MLX Studio/MLX Studio.app). An app installed
 * in /Volumes/<disk>/Applications/ is a real install.
 */
export function isOnMountedImage(path: string): boolean {
  if (!path.startsWith('/Volumes/')) return false
  return !/^\/Volumes\/[^/]+\/(Users\/[^/]+\/)?Applications\//.test(path)
}

function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function basename(p: string): string {
  const s = p.replace(/\/+$/, '')
  return s.slice(s.lastIndexOf('/') + 1)
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** Hidden staged copy next to the app (same folder, so the swap is a rename): ".MLX Studio.update.app". */
export function stagingPathFor(appPath: string): string {
  return join(dirname(appPath), `.${basename(appPath).replace(/\.app$/, '')}.update.app`)
}

/** Where the current copy is moved aside during the swap: ".MLX Studio.old-<tag>.app". */
export function backupPathFor(appPath: string, tag: string | number): string {
  const safe = String(tag).replace(/[^A-Za-z0-9_-]/g, '')
  return join(dirname(appPath), `.${basename(appPath).replace(/\.app$/, '')}.old-${safe}.app`)
}

export interface InstallFacts {
  platform: string
  /** app.isPackaged */
  packaged: boolean
  /** Bundle around the running executable (appBundlePath), if any. */
  appPath: string | null
  /** The folder holding the app can be written (renames happen there). */
  parentWritable: boolean
  /** The app bundle itself can be written (needed to move it aside and delete it). */
  appWritable: boolean
  /** The manifest carries a SHA-256 for the selected DMG. */
  hasChecksum: boolean
}

export type InstallPlan =
  | { ok: true; appPath: string; stagingPath: string }
  | { ok: false; reason: InstallBlock }

/**
 * Decide whether Update can install in place. Anything else falls back to
 * downloading by hand: development builds, mounted DMGs, translocated copies,
 * read-only locations, or a manifest without a checksum.
 */
export function planInPlaceInstall(f: InstallFacts): InstallPlan {
  if (f.platform !== 'darwin') return { ok: false, reason: 'unsupported' }
  if (!f.packaged) return { ok: false, reason: 'development' }
  if (!f.appPath || !f.appPath.endsWith('.app')) return { ok: false, reason: 'notApp' }
  if (isTranslocated(f.appPath)) return { ok: false, reason: 'translocated' }
  if (isOnMountedImage(f.appPath)) return { ok: false, reason: 'mountedDmg' }
  if (!f.parentWritable || !f.appWritable) return { ok: false, reason: 'notWritable' }
  if (!f.hasChecksum) return { ok: false, reason: 'noChecksum' }
  return { ok: true, appPath: f.appPath, stagingPath: stagingPathFor(f.appPath) }
}

// ---------------------------------------------------------------------------
// Verification

export function isSha256(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)
}

/** Downloaded bytes against the manifest. Size is checked when the manifest has one. */
export function checkDownload(x: {
  expectedSize?: number
  expectedSha256: string
  size: number
  sha256: string
}): 'size' | 'checksum' | null {
  if (typeof x.expectedSize === 'number' && x.expectedSize > 0 && x.size !== x.expectedSize) return 'size'
  if (!isSha256(x.expectedSha256) || x.sha256.toLowerCase() !== x.expectedSha256.toLowerCase()) return 'checksum'
  return null
}

/** The app found in the DMG: ours, and newer than the running copy. */
export function checkCandidate(x: {
  bundleId: unknown
  version: unknown
  runningVersion: string
}): 'notOurs' | 'notNewer' | null {
  if (x.bundleId !== STUDIO_BUNDLE_ID) return 'notOurs'
  if (typeof x.version !== 'string' || !isNewerVersion(x.version, x.runningVersion)) return 'notNewer'
  return null
}

export function hdiutilAttachArgs(dmgPath: string, mountPoint: string): string[] {
  return ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmgPath]
}

export function hdiutilDetachArgs(mountPoint: string, force = false): string[] {
  return force ? ['detach', mountPoint, '-force'] : ['detach', mountPoint]
}

/** codesign check: deep + strict, against our designated requirement. */
export function codesignVerifyArgs(appPath: string, deep = true): string[] {
  return ['--verify', ...(deep ? ['--deep'] : []), '--strict', '-R', `=${STUDIO_REQUIREMENT}`, appPath]
}

export function spctlArgs(appPath: string): string[] {
  return ['-a', '-t', 'exec', '-vv', appPath]
}

/** Gatekeeper must accept it, as a notarized Developer ID app. */
export function spctlAccepted(ok: boolean, output: string): boolean {
  return ok && /\baccepted\b/.test(output) && /source=Notarized Developer ID/.test(output)
}

// ---------------------------------------------------------------------------
// Notifications and the banner

/** Notify once per version, and only when no MLX Studio window has focus. */
export function shouldNotify(x: {
  version: string
  notifiedVersion: string | null | undefined
  windowFocused: boolean
  supported: boolean
}): boolean {
  return x.supported && !x.windowFocused && !!x.version && x.notifiedVersion !== x.version
}

/** First line of the release notes, trimmed for a notification body. */
export function notificationBody(notes: string | undefined, fallback: string, max = 180): string {
  const line = String(notes ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
  if (!line) return fallback
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export function progressPercent(received: number | undefined, total: number | undefined): number {
  if (!total || total <= 0 || !received || received <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)))
}

/** Whether the banner shows at all. "Later" hides the offer; work in progress and errors stay. */
export function bannerVisible(state: UpdateState | null | undefined): boolean {
  if (!state || state.phase === 'idle' || !state.version) return false
  if (state.dismissed && (state.phase === 'available' || state.phase === 'ready' || state.phase === 'error')) return false
  return true
}

// ---------------------------------------------------------------------------
// The swap after quit

/**
 * Runs detached under /bin/sh after MLX Studio quits. Every path arrives as
 * a positional argument and is only ever used inside double quotes, so no
 * path is ever parsed by the shell (spaces, quotes, $ and ; are all inert).
 *
 *   $1 pid to wait for   $2 app path        $3 staged app   $4 backup path
 *   $5 relaunch (1|0)    $6 open binary     $7 xattr binary $8 log file
 *
 * Two renames on the same volume: current app → backup, staged → app path.
 * If the second fails, the backup is renamed back. The new copy loses the
 * quarantine flag only if it has one; it is relaunched with `open`; the old
 * copy is deleted last.
 */
export const SWAP_SCRIPT = `
PID="$1"; APP="$2"; NEW="$3"; OLD="$4"; RELAUNCH="$5"; OPEN="$6"; XATTR="$7"; LOG="$8"
trap '' HUP INT TERM
exec >>"$LOG" 2>&1
echo "[$(date)] MLX Studio update: waiting for pid $PID"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then echo "MLX Studio is still running; update not installed"; exit 1; fi
  sleep 0.25
done
if [ ! -d "$NEW" ]; then echo "staged app missing: $NEW"; exit 1; fi
if [ ! -d "$APP" ]; then echo "current app missing: $APP"; exit 1; fi
if [ -e "$OLD" ]; then echo "backup path already exists: $OLD"; exit 1; fi
if ! mv "$APP" "$OLD"; then echo "could not move the current app aside"; exit 1; fi
if [ -e "$APP" ] || ! mv "$NEW" "$APP"; then
  echo "could not move the new app into place; restoring the current one"
  if [ ! -e "$APP" ]; then mv "$OLD" "$APP"; fi
  if [ "$RELAUNCH" = "1" ]; then "$OPEN" "$APP"; fi
  exit 1
fi
if "$XATTR" -p com.apple.quarantine "$APP" >/dev/null 2>&1; then
  "$XATTR" -dr com.apple.quarantine "$APP"
fi
if [ "$RELAUNCH" = "1" ]; then "$OPEN" "$APP"; fi
rm -rf "$OLD"
echo "[$(date)] MLX Studio update installed: $APP"
exit 0
`.trim()

export interface SwapCommandInput {
  pid: number
  appPath: string
  stagedPath: string
  backupPath: string
  relaunch: boolean
  logPath: string
  openBin?: string
  xattrBin?: string
}

/** The exact argv for spawn('/bin/sh', args, { detached: true }). */
export function swapCommand(x: SwapCommandInput): { file: string; args: string[] } {
  if (!Number.isInteger(x.pid) || x.pid <= 0) throw new Error('swapCommand: bad pid')
  for (const p of [x.appPath, x.stagedPath, x.backupPath, x.logPath]) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) throw new Error('swapCommand: paths must be absolute')
  }
  if (x.appPath === x.stagedPath || x.appPath === x.backupPath || x.stagedPath === x.backupPath) {
    throw new Error('swapCommand: paths must differ')
  }
  if (dirname(x.appPath) !== dirname(x.stagedPath) || dirname(x.appPath) !== dirname(x.backupPath)) {
    throw new Error('swapCommand: staged and backup copies must sit next to the app (same volume)')
  }
  return {
    file: '/bin/sh',
    args: [
      '-c', SWAP_SCRIPT, 'mlx-studio-update',
      String(x.pid), x.appPath, x.stagedPath, x.backupPath, x.relaunch ? '1' : '0',
      x.openBin ?? '/usr/bin/open', x.xattrBin ?? '/usr/bin/xattr', x.logPath,
    ],
  }
}
