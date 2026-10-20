/**
 * MLX Harness's in-app updater: the pure rules (shared with the renderer and
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
 *
 * The rename (0.2.0): up to 0.1.x the app was "MLX Studio.app". A copy still
 * named that is moved to "MLX Harness.app" in the same folder: by the swap
 * when an update is staged, otherwise by a small detached script after quit
 * (renameCommand). An existing "MLX Harness.app" is never replaced; if the
 * rename can't happen the app keeps working under the old name and tries
 * again at the next quit. Bundle id, team and the designated requirement are
 * unchanged (they are the identity; the folder name is not).
 */

// Internal identifiers: unchanged by the rename (compatibility with 0.1.x).
export const STUDIO_BUNDLE_ID = 'app.mlx.studio'
export const STUDIO_TEAM_ID = 'CCKXS9W488'
/** The app's bundle name: in the DMG, and where an installed copy should live. */
export const STUDIO_APP_NAME = 'MLX Harness.app'
/** Bundle names of earlier versions that are renamed to STUDIO_APP_NAME. */
export const LEGACY_APP_NAMES: readonly string[] = ['MLX Studio.app']

/**
 * Designated requirement a downloaded MLX Harness must satisfy: Apple-anchored
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
  | 'notFound' // no MLX Harness app (our bundle id) in the DMG
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

/** "/Applications/MLX Harness.app/Contents/MacOS/MLX Harness" → "/Applications/MLX Harness.app". */
export function appBundlePath(exePath: string): string | null {
  const m = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exePath ?? ''))
  return m ? m[1] : null
}

export function isTranslocated(path: string): boolean {
  return path.includes('/AppTranslocation/')
}

/**
 * Running from a mounted volume that isn't an Applications folder on another
 * disk (a DMG mount: /Volumes/MLX Harness/MLX Harness.app). An app installed
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

/**
 * Where this copy should live: next to itself under STUDIO_APP_NAME when it
 * still carries a 0.1.x name ("/Applications/MLX Studio.app" →
 * "/Applications/MLX Harness.app"), otherwise where it is (a name the user
 * chose is kept).
 */
export function preferredAppPath(appPath: string): string {
  return LEGACY_APP_NAMES.includes(basename(appPath)) ? join(dirname(appPath), STUDIO_APP_NAME) : appPath
}

/**
 * Hidden staged copy next to the app (same folder, so the swap is a rename),
 * named after where the app should live: ".MLX Harness.update.app" (also for
 * a copy still called "MLX Studio.app").
 */
export function stagingPathFor(appPath: string): string {
  return join(dirname(appPath), `.${basename(preferredAppPath(appPath)).replace(/\.app$/, '')}.update.app`)
}

/** Where the current copy is moved aside during the swap: ".MLX Harness.old-<tag>.app" (named after the copy itself). */
export function backupPathFor(appPath: string, tag: string | number): string {
  const safe = String(tag).replace(/[^A-Za-z0-9_-]/g, '')
  return join(dirname(appPath), `.${basename(appPath).replace(/\.app$/, '')}.old-${safe}.app`)
}

/**
 * Names of earlier attempts' leftovers next to the app, for the current and
 * the 0.1.x names: staged copies (".MLX Harness.update.app",
 * ".MLX Studio.update.app") and the prefixes of moved-aside copies
 * (".MLX Harness.old-", ".MLX Studio.old-"; each followed by a tag and ".app").
 */
export function leftoverNames(appPath: string): { staging: string[]; oldPrefixes: string[] } {
  const stems = new Set<string>([
    basename(appPath),
    basename(preferredAppPath(appPath)),
    STUDIO_APP_NAME,
    ...LEGACY_APP_NAMES,
  ].map(n => n.replace(/\.app$/, '')))
  return {
    staging: [...stems].map(n => `.${n}.update.app`),
    oldPrefixes: [...stems].map(n => `.${n}.old-`),
  }
}

export interface RenameFacts {
  platform: string
  /** app.isPackaged */
  packaged: boolean
  /** Bundle around the running executable (appBundlePath), if any. */
  appPath: string | null
  parentWritable: boolean
  appWritable: boolean
  /** Something already exists at the new name (it is never replaced). */
  targetExists: boolean
}

/**
 * Whether this copy should be renamed after quitting: a packaged macOS copy
 * still called by a 0.1.x name, in a writable folder that isn't a disk image
 * or a translocated copy, with nothing at the new name yet.
 */
export function planRename(f: RenameFacts): { from: string; to: string } | null {
  if (f.platform !== 'darwin' || !f.packaged || !f.appPath) return null
  const to = preferredAppPath(f.appPath)
  if (to === f.appPath) return null
  if (isTranslocated(f.appPath) || isOnMountedImage(f.appPath)) return null
  if (!f.parentWritable || !f.appWritable || f.targetExists) return null
  return { from: f.appPath, to }
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

/** Notify once per version, and only when no MLX Harness window has focus. */
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
 * Runs detached under /bin/sh after MLX Harness quits. Every path arrives as
 * a positional argument and is only ever used inside double quotes, so no
 * path is ever parsed by the shell (spaces, quotes, $ and ; are all inert).
 *
 *   $1 pid to wait for   $2 app path        $3 staged app   $4 backup path
 *   $5 relaunch (1|0)    $6 open binary     $7 xattr binary $8 log file
 *   $9 where the new copy goes (the app path, or "MLX Harness.app" next to a
 *      copy still called "MLX Studio.app"; the app path when that exists)
 *
 * Two renames on the same volume: current app → backup, staged → target.
 * If the second fails, the backup is renamed back. The new copy loses the
 * quarantine flag only if it has one; it is relaunched with `open`; the old
 * copy is deleted last.
 */
export const SWAP_SCRIPT = `
PID="$1"; APP="$2"; NEW="$3"; OLD="$4"; RELAUNCH="$5"; OPEN="$6"; XATTR="$7"; LOG="$8"; DEST="\${9:-$2}"
trap '' HUP INT TERM
exec >>"$LOG" 2>&1
echo "[$(date)] MLX Harness update: waiting for pid $PID"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then echo "MLX Harness is still running; update not installed"; exit 1; fi
  sleep 0.25
done
if [ ! -d "$NEW" ]; then echo "staged app missing: $NEW"; exit 1; fi
if [ ! -d "$APP" ]; then echo "current app missing: $APP"; exit 1; fi
if [ -e "$OLD" ]; then echo "backup path already exists: $OLD"; exit 1; fi
if [ "$DEST" != "$APP" ] && [ -e "$DEST" ]; then echo "$DEST already exists; updating in place"; DEST="$APP"; fi
if ! mv "$APP" "$OLD"; then echo "could not move the current app aside"; exit 1; fi
if [ -e "$DEST" ] || ! mv "$NEW" "$DEST"; then
  echo "could not move the new app into place; restoring the current one"
  if [ ! -e "$APP" ]; then mv "$OLD" "$APP"; fi
  if [ "$RELAUNCH" = "1" ]; then "$OPEN" "$APP"; fi
  exit 1
fi
if "$XATTR" -p com.apple.quarantine "$DEST" >/dev/null 2>&1; then
  "$XATTR" -dr com.apple.quarantine "$DEST"
fi
if [ "$RELAUNCH" = "1" ]; then "$OPEN" "$DEST"; fi
rm -rf "$OLD"
echo "[$(date)] MLX Harness update installed: $DEST"
exit 0
`.trim()

export interface SwapCommandInput {
  pid: number
  appPath: string
  stagedPath: string
  backupPath: string
  relaunch: boolean
  logPath: string
  /** Where the new copy goes (default: appPath). Must sit next to the app. */
  targetPath?: string
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
  const target = x.targetPath ?? x.appPath
  if (typeof target !== 'string' || !target.startsWith('/') || target.includes('\0') || !target.endsWith('.app')) {
    throw new Error('swapCommand: bad target path')
  }
  if (dirname(target) !== dirname(x.appPath)) throw new Error('swapCommand: the target must sit next to the app')
  if (target === x.stagedPath || target === x.backupPath) throw new Error('swapCommand: paths must differ')
  return {
    file: '/bin/sh',
    args: [
      '-c', SWAP_SCRIPT, 'mlx-harness-update',
      String(x.pid), x.appPath, x.stagedPath, x.backupPath, x.relaunch ? '1' : '0',
      x.openBin ?? '/usr/bin/open', x.xattrBin ?? '/usr/bin/xattr', x.logPath, target,
    ],
  }
}

/**
 * Renames a copy still called "MLX Studio.app" to "MLX Harness.app" after
 * MLX Harness quits (no update staged). Same rules as SWAP_SCRIPT: every
 * path is a positional argument used only inside double quotes.
 *
 *   $1 pid to wait for   $2 app path   $3 new path   $4 log file
 *   $5 ps binary         $6 grep binary
 *
 * Waits for the app to exit and for nothing to run from inside the bundle
 * any more (helpers, the engine: `ps -o comm` is each process's executable
 * path on macOS, so the grep never matches its own arguments), never replaces anything at the new name,
 * and is one rename on the same volume. On any doubt it leaves the app where
 * it is (the next quit tries again).
 */
export const RENAME_SCRIPT = `
PID="$1"; APP="$2"; DEST="$3"; LOG="$4"; PS="$5"; GREP="$6"
trap '' HUP INT TERM
exec >>"$LOG" 2>&1
echo "[$(date)] MLX Harness: renaming $APP after pid $PID exits"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then echo "MLX Harness is still running; not renamed"; exit 1; fi
  sleep 0.25
done
if [ ! -d "$APP" ]; then echo "app missing: $APP"; exit 1; fi
j=0
while "$PS" -axo comm= | "$GREP" -F -q -- "$APP/Contents/"; do
  j=$((j + 1))
  if [ "$j" -gt 60 ]; then echo "something still runs from $APP; not renamed"; exit 1; fi
  sleep 0.25
done
if [ -e "$DEST" ]; then echo "$DEST already exists; keeping $APP"; exit 0; fi
if ! mv "$APP" "$DEST"; then echo "could not rename $APP"; exit 1; fi
echo "[$(date)] renamed to $DEST"
exit 0
`.trim()

export interface RenameCommandInput {
  pid: number
  appPath: string
  targetPath: string
  logPath: string
  psBin?: string
  grepBin?: string
}

/** The exact argv for spawn('/bin/sh', args, { detached: true }). */
export function renameCommand(x: RenameCommandInput): { file: string; args: string[] } {
  if (!Number.isInteger(x.pid) || x.pid <= 0) throw new Error('renameCommand: bad pid')
  for (const p of [x.appPath, x.targetPath, x.logPath]) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) throw new Error('renameCommand: paths must be absolute')
  }
  if (!x.appPath.endsWith('.app') || !x.targetPath.endsWith('.app')) throw new Error('renameCommand: not an app bundle')
  if (x.appPath === x.targetPath) throw new Error('renameCommand: paths must differ')
  if (dirname(x.appPath) !== dirname(x.targetPath)) throw new Error('renameCommand: the new name must sit next to the app')
  return {
    file: '/bin/sh',
    args: [
      '-c', RENAME_SCRIPT, 'mlx-harness-rename',
      String(x.pid), x.appPath, x.targetPath, x.logPath, x.psBin ?? '/bin/ps', x.grepBin ?? '/usr/bin/grep',
    ],
  }
}
