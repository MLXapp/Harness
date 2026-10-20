// First import of the main process (before user-data-dir and anything that
// opens the database): picks the userData folder and the Keychain item name
// so that a Mac updating from 0.1.x ("MLX Studio") keeps its chats, settings,
// models list and saved API keys. See ../shared/appIdentity.ts for the rules.
//
// Keychain, the careful part. Electron names the safeStorage item
// "<app.name> Safe Storage" from whatever app.name is when
// ElectronBrowserMainParts::PostCreateMainMessageLoop runs (Electron 44:
// after this file's top-level code, before `will-finish-launching`; the
// value is copied then and never read again). On a legacy Mac app.name is
// therefore "MLX Studio" until `will-finish-launching`, and is set back to
// "MLX Harness" by a listener prepended ahead of Electron's own default-menu
// listener, so the default menu, our menu, roles ("About/Hide/Quit …") and
// everything else built from app.name show MLX Harness. Visible names do not
// depend on app.name anyway: the bundle (CFBundleName/CFBundleDisplayName,
// Dock, menu bar title, notifications) is "MLX Harness" from electron-builder's
// productName, and our menu labels use APP_DISPLAY_NAME explicitly.
//
// userData is set explicitly (Electron would otherwise derive it lazily from
// app.name), and sessionData follows it (Electron's default).
import { app } from 'electron'
import { existsSync } from 'fs'
import { APP_DISPLAY_NAME, resolveAppIdentity, type AppIdentity } from '../shared/appIdentity'

/** The slice of Electron's `app` this needs (a stand-in in tests). */
export interface IdentityApp {
  name: string
  getPath(name: 'appData'): string
  setPath(name: 'userData', path: string): void
  prependOnceListener(event: 'will-finish-launching', listener: () => void): unknown
}

export function applyAppIdentity(target: IdentityApp, exists: (path: string) => boolean = existsSync): AppIdentity {
  const identity = resolveAppIdentity({ appDataDir: target.getPath('appData'), exists })
  target.setPath('userData', identity.userDataDir)
  if (identity.keychainName === APP_DISPLAY_NAME) {
    target.name = APP_DISPLAY_NAME
  } else {
    // Held only until Electron has named the Keychain item.
    target.name = identity.keychainName
    target.prependOnceListener('will-finish-launching', () => { target.name = APP_DISPLAY_NAME })
  }
  return identity
}

export const appIdentity = applyAppIdentity(app as unknown as IdentityApp)
if (appIdentity.legacy) {
  console.log(`[STARTUP] Keeping the 0.1.x userData folder and Keychain item: ${appIdentity.userDataDir}`)
}
