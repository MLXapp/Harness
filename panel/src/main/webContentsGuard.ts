/**
 * Rules for every window in the app's default session (main, downloads,
 * installer): no <webview>, no navigating away from the app's own pages, no
 * new windows, and browser permissions only for the app's own pages. The
 * agent browser has its own session with its own, stricter rules.
 */

import { app, session, shell, type WebContents } from 'electron'

/** Browser permissions the app's own pages use: the microphone for voice input, copy buttons, video full screen. */
const APP_PERMISSIONS: ReadonlySet<string> = new Set(['media', 'clipboard-sanitized-write', 'fullscreen'])

/** A permission request: granted only to the app's own page in a window's main frame, and only for what it uses. */
export function permissionRequestAllowed(permission: string, requestingUrl: string | undefined, isMainFrame: boolean | undefined, isAppPageUrl: (url: string) => boolean): boolean {
  if (!requestingUrl || isMainFrame === false || !isAppPageUrl(requestingUrl)) return false
  return APP_PERMISSIONS.has(permission)
}

/** A permission check: the app's own main-frame page as before; anything else (preview frames, other pages) no. */
export function permissionCheckAllowed(requestingUrl: string | undefined, isMainFrame: boolean | undefined, isAppPageUrl: (url: string) => boolean): boolean {
  return !!requestingUrl && isMainFrame !== false && isAppPageUrl(requestingUrl)
}

function frameUrl(contents: WebContents | null, details: { requestingUrl?: string; isMainFrame?: boolean } | undefined): string | undefined {
  // A file:// page reports an opaque origin; the main frame's URL is the page itself.
  const url = details?.requestingUrl
  if (url && url !== 'file:///' && url !== 'file://') return url
  if (details?.isMainFrame !== false && contents && !contents.isDestroyed()) return contents.getURL()
  return url
}

export function installWebContentsGuard(isAppPageUrl: (url: string) => boolean): void {
  app.on('web-contents-created', (_e, contents) => {
    // The agent browser uses its own session (and allows ordinary web pages there).
    if (contents.session !== session.defaultSession) return
    contents.on('will-attach-webview', e => e.preventDefault())
    // Opening a followed link in the browser is up to each window's own handler; this only stops the navigation.
    contents.on('will-navigate', (e, url) => { if (!isAppPageUrl(url)) e.preventDefault() })
    // Web links asking for a new window open in the browser (a window may set its own handler instead).
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permissionRequestAllowed(permission, frameUrl(contents, details as any), (details as any)?.isMainFrame, isAppPageUrl))
  })
  ses.setPermissionCheckHandler((contents, _permission, _origin, details) =>
    permissionCheckAllowed(frameUrl(contents, details as any), (details as any)?.isMainFrame, isAppPageUrl))
  // USB, serial and HID devices: the app uses none.
  try { ses.setDevicePermissionHandler(() => false) } catch { /* older Electron */ }
}
