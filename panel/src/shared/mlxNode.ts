/**
 * MLX Node (bundle id app.mlx.mac, team CCKXS9W488): the separate menu bar
 * app that lends a Mac's idle time to MLX Network. MLX Studio carries a
 * signed, notarized copy as a zip in Contents/Resources/bundled-node/ and
 * offers to install it on first run. Pure helpers here (shared with the
 * renderer and the tests); file system and processes live in
 * src/main/mlx-node.ts.
 *
 * Why a zip and not "MLX Node.app" in Resources: macOS registers apps it finds
 * inside other bundles with Launch Services and Spotlight. A live copy inside
 * MLX Studio could then answer mlx:// links or `open -b app.mlx.mac`, run from
 * inside our bundle and let its self-updater rewrite files there, breaking
 * MLX Studio's signature. A zip is never launched; ditto unpacks it with the
 * signature, entitlements and provisioning profile untouched.
 */

export const MLX_NODE_BUNDLE_ID = 'app.mlx.mac'
export const MLX_NODE_TEAM_ID = 'CCKXS9W488'
/** Installed name, whatever the DMG called it ("MLX.app" before 0.9.0). */
export const MLX_NODE_APP_NAME = 'MLX Node.app'
/** Names an installed copy may have. */
export const MLX_NODE_APP_NAMES = ['MLX Node.app', 'MLX.app'] as const
/** Inside the packaged app: Contents/Resources/<dir>/<zip>. */
export const MLX_NODE_BUNDLED_DIR = 'bundled-node'
export const MLX_NODE_BUNDLED_ZIP = 'MLX Node.zip'
export const MLX_NODE_BUNDLED_META = 'MLX Node.json'
export const MLX_NODE_DOWNLOAD_URL = 'https://mlx.app/download'
/** Settings-store flag: the first-run offer was made (or wasn't needed). */
export const MLX_NODE_OFFER_SETTING = 'mlx_node_first_run_offer_v1'

/**
 * Designated requirement every copy we install must satisfy: Apple-anchored
 * Developer ID chain, our team, MLX Node's bundle id.
 */
export const MLX_NODE_REQUIREMENT =
  `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists ` +
  `and certificate leaf[field.1.2.840.113635.100.6.1.13] exists ` +
  `and certificate leaf[subject.OU] = "${MLX_NODE_TEAM_ID}" and identifier "${MLX_NODE_BUNDLE_ID}"`

export type MlxNodeInstallError =
  | 'unsupported' // not macOS
  | 'notBundled' // this build carries no MLX Node
  | 'notWritable' // neither /Applications nor ~/Applications can be written
  | 'occupied' // something that isn't MLX Node already has the name
  | 'signature' // the unpacked copy failed the signature check
  | 'failed' // anything else (unzip, move, open)

export type MlxNodeInstallResult =
  | { ok: true; path: string; installed: boolean }
  | { ok: false; error: MlxNodeInstallError }

/** What this Mac looks like when deciding. */
export interface MlxNodeInstallFacts {
  platform: string
  /** Path of an installed MLX Node (bundle id app.mlx.mac), if any. */
  installedPath: string | null
  /** The bundled zip is present in this build. */
  bundled: boolean
  /** /Applications can be written by this user. */
  systemAppsWritable: boolean
  /** ~/Applications exists and can be written, or can be created. */
  userAppsWritable: boolean
  systemAppsDir?: string
  userAppsDir: string
}

export type MlxNodeInstallPlan =
  | { action: 'open'; path: string }
  | { action: 'install'; dir: string; dest: string }
  | { action: 'download'; reason: MlxNodeInstallError }

/**
 * Decide what "Install MLX Node" does. Never overwrites: an installed copy is
 * opened instead; /Applications is preferred, ~/Applications the fallback;
 * without a bundled copy or a writable folder the answer is the download page.
 */
export function planMlxNodeInstall(f: MlxNodeInstallFacts): MlxNodeInstallPlan {
  if (f.platform !== 'darwin') return { action: 'download', reason: 'unsupported' }
  if (f.installedPath) return { action: 'open', path: f.installedPath }
  if (!f.bundled) return { action: 'download', reason: 'notBundled' }
  const dir = f.systemAppsWritable ? (f.systemAppsDir ?? '/Applications')
    : f.userAppsWritable ? f.userAppsDir : null
  if (!dir) return { action: 'download', reason: 'notWritable' }
  return { action: 'install', dir, dest: joinPath(dir, MLX_NODE_APP_NAME) }
}

/** First-run offer: once, on macOS, only when we carry a copy and none is installed. */
export function shouldOfferMlxNode(f: { platform: string; offered: boolean; installed: boolean; bundled: boolean }): boolean {
  return f.platform === 'darwin' && !f.offered && !f.installed && f.bundled
}

/**
 * Whether the first-run flag should be stored now. Not when this build has
 * no copy (a later build that carries one may still offer it), not off macOS.
 */
export function shouldMarkMlxNodeOffered(f: { platform: string; installed: boolean; bundled: boolean }): boolean {
  return f.platform === 'darwin' && (f.installed || f.bundled)
}

/**
 * A found app counts as installed MLX Node only when it is a top-level app:
 * not nested in another bundle (MLX Studio's own Resources, Xcode archives),
 * not a translocated or mounted-DMG copy.
 */
export function isInstalledLocation(path: string): boolean {
  if (!path.endsWith('.app')) return false
  const inner = path.slice(0, -'.app'.length)
  if (inner.includes('.app/')) return false
  if (path.includes('/AppTranslocation/')) return false
  if (path.startsWith('/Volumes/') && !isRealVolumeAppsDir(path)) return false
  if (path.includes('/.Trash/')) return false
  return true
}

/** An Applications folder on another disk is a real install; a DMG mount is not. */
function isRealVolumeAppsDir(path: string): boolean {
  return /^\/Volumes\/[^/]+\/(Users\/[^/]+\/)?Applications\//.test(path)
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}
