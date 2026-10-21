/**
 * The app's name, and the 0.1.x name it must stay compatible with.
 *
 * Up to 0.1.x the app's name was "MLX Studio" (legacy; kept here only for the
 * migration below). Everything a person sees says MLX Harness. Two things on disk were named after the old app name and
 * must keep working for people who update from 0.1.x:
 *
 * - userData: Electron puts it at <appData>/<app name>
 *   (~/Library/Application Support/MLX Studio): chats.db, settings, the
 *   renderer's local storage, MCP configs, update downloads.
 * - Keychain: Electron's safeStorage key is the generic password
 *   "<app name> Safe Storage" (account "<app name>"). Electron reads the app
 *   name for it once, in ElectronBrowserMainParts::PostCreateMainMessageLoop
 *   (Electron 44), which runs after the main script's top-level code and
 *   before `will-finish-launching`. Every API key saved by 0.1.x (and the
 *   model providers' credentials) is encrypted with that key; a different
 *   item name would mean a new key and every saved secret reading as empty.
 *
 * So a Mac that already has 0.1.x data keeps that folder and that Keychain
 * item ("legacy" identity); a fresh install uses the new name for both.
 * Pure: the Electron side is src/main/app-identity.ts.
 */

/** The product name everywhere a person sees it. */
export const APP_DISPLAY_NAME = 'MLX Harness'
/** The name up to 0.1.x: only for the userData folder and the Keychain item of existing installs. */
export const LEGACY_APP_NAME = 'MLX Studio'

/** The database every launch creates in userData (src/main/database.ts). */
export const USER_DATA_MARKER = 'chats.db'

export interface AppIdentity {
  /** userData folder to use. */
  userDataDir: string
  /** App name Electron must hold while it names the Keychain item ("<name> Safe Storage"). */
  keychainName: string
  /** True when this Mac carries 0.1.x data under the old name. */
  legacy: boolean
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/**
 * Pick the identity for this launch.
 *
 *   1. <appData>/MLX Harness holds a database → the new identity (this Mac
 *      started on 0.2.0 or later). Checked first so an old 0.1.x copy run
 *      later can't pull a newer install back to the old folder.
 *   2. <appData>/MLX Studio exists → legacy: keep the 0.1.x folder and
 *      Keychain item. Any folder counts (not just one with a database), so
 *      nothing an earlier version wrote is ever left behind.
 *   3. Neither → a fresh install under the new name.
 */
export function resolveAppIdentity(x: {
  appDataDir: string
  exists: (path: string) => boolean
}): AppIdentity {
  const current = joinPath(x.appDataDir, APP_DISPLAY_NAME)
  const legacy = joinPath(x.appDataDir, LEGACY_APP_NAME)
  if (x.exists(joinPath(current, USER_DATA_MARKER))) {
    return { userDataDir: current, keychainName: APP_DISPLAY_NAME, legacy: false }
  }
  if (x.exists(legacy)) {
    return { userDataDir: legacy, keychainName: LEGACY_APP_NAME, legacy: true }
  }
  return { userDataDir: current, keychainName: APP_DISPLAY_NAME, legacy: false }
}
