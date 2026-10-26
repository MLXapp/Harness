/**
 * IPC channels that write files, change settings or start processes answer
 * only the app's own pages. The preload is the only way in, and only the main
 * frame of an app window has it, but a frame that ever ended up on another
 * page (a bug, a redirect the navigation guard missed) must not be able to
 * use these.
 */

import { ipcMain } from 'electron'

/** Channels that change something: settings, files, sessions, processes. */
const GUARDED: readonly RegExp[] = [
  /^settings:set$/,
  /^workspace:/,
  /^sessions:(create|update)$/,
  /^chat:setOverrides$/,
  /^chat:answerUser$/,
  /^models:(addDirectory|deleteLocal)$/,
  /^image:/,
  /^tools:/,
  /^gateway:/,
]

export function isGuardedChannel(channel: string): boolean {
  return GUARDED.some(re => re.test(channel))
}

interface SenderEvent {
  senderFrame?: { url?: string } | null
}

/** The frame that sent the event shows one of the app's own pages. */
export function senderIsAppPage(event: SenderEvent, isAppPageUrl: (url: string) => boolean): boolean {
  let url: unknown
  try {
    url = event?.senderFrame?.url
  } catch {
    return false // the frame is gone
  }
  return typeof url === 'string' && isAppPageUrl(url)
}

let installed = false

/**
 * Wrap ipcMain.handle / ipcMain.on so every guarded channel registered after
 * this call checks its sender first. Call once, before the handlers register.
 */
export function installIpcSenderGuard(isAppPageUrl: (url: string) => boolean): void {
  if (installed) return
  installed = true
  const handle = ipcMain.handle.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (event: any, ...args: any[]) => any) => {
    if (!isGuardedChannel(channel)) return handle(channel, listener)
    return handle(channel, (event: any, ...args: any[]) => {
      if (!senderIsAppPage(event, isAppPageUrl)) {
        console.warn(`[IPC] Refused ${channel} from a page that is not the app's own`)
        throw new Error('Not allowed from this page')
      }
      return listener(event, ...args)
    })
  }) as typeof ipcMain.handle
  ipcMain.on = ((channel: string, listener: (event: any, ...args: any[]) => void) => {
    if (!isGuardedChannel(channel)) return on(channel, listener)
    return on(channel, (event: any, ...args: any[]) => {
      if (!senderIsAppPage(event, isAppPageUrl)) {
        console.warn(`[IPC] Ignored ${channel} from a page that is not the app's own`)
        return
      }
      listener(event, ...args)
    })
  }) as typeof ipcMain.on
}
