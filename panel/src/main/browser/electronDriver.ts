/**
 * PageDriver on one hidden Electron BrowserWindow, created on first use and
 * again after close(). Each driver gets its own in-memory session (a chat's
 * browser never shares cookies with another chat, a scheduled task or the
 * app), gone when the app quits. The session refuses every permission,
 * downloads, file pickers and requests to local/private addresses (unless
 * allowLocal), names included: a host is resolved first and refused when it
 * points at a private address (127.0.0.1.nip.io, localtest.me …). New windows
 * load in place. The window closes itself after 10 idle minutes. The page
 * logic lives in ./agentBrowser.ts and ./snapshot.ts (pure); its scripts run
 * in an isolated world, out of the page's reach.
 */

import { BrowserWindow, session as electronSession, type Session, type WebContents } from 'electron'
import { lookup } from 'dns/promises'
import { randomBytes } from 'crypto'
import { cleanUserAgent, isPrivateHost, isRequestAllowed, type PageDriver } from './agentBrowser'

/** Isolated world for the agent's page scripts (any id ≥ 1000 is ours). */
const AGENT_WORLD = 1999
export const AGENT_BROWSER_IDLE_MS = 10 * 60_000

const agentWindows = new WeakSet<BrowserWindow>()
/** The agent browser's hidden windows (to leave out of "the app's window" lookups). */
export function isAgentBrowserWindow(w: BrowserWindow | null | undefined): boolean {
  return !!w && agentWindows.has(w)
}
/** The app's own windows (agent browser windows left out). */
export function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && !agentWindows.has(w))
}
const closers = new Set<() => void>()
/** Close every agent browser window (e.g. when the app's last window closes on Windows/Linux). */
export function closeAllAgentBrowserWindows(): void {
  for (const c of [...closers]) c()
}

export interface ElectronDriverOptions {
  /** Allow localhost and private-network addresses (default false). Read on every request. */
  allowLocal?: boolean | (() => boolean)
  /** Session partition (default: a fresh in-memory one per driver). */
  partition?: string
}

export interface ElectronPageDriver extends PageDriver {
  /** The hidden window, if one is open (e.g. to show the agent's page later). */
  window(): BrowserWindow | null
}

const ERR_ABORTED = -3

/** host → { private?, until } for 60 s, so a page's many requests resolve once. */
const dnsCache = new Map<string, { bad: boolean; until: number }>()
const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')

/** True when a host name resolves to any private, loopback or link-local address. */
export async function resolvesPrivate(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h || isIpLiteral(h)) return false // literals are judged by isPrivateHost
  const hit = dnsCache.get(h)
  if (hit && hit.until > Date.now()) return hit.bad
  let bad = false
  try {
    const all = await lookup(h, { all: true, verbatim: true })
    bad = all.some(a => isPrivateHost(a.address))
  } catch {
    bad = false // unresolvable: Chromium fails the request by itself
  }
  if (dnsCache.size > 500) dnsCache.clear()
  dnsCache.set(h, { bad, until: Date.now() + 60_000 })
  return bad
}

function prepareSession(ses: Session, allowLocal: () => boolean, note: (line: string) => void): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  try { ses.setDevicePermissionHandler(() => false) } catch { /* older Electron */ }
  ses.on('will-download', (event, item) => {
    note(`Blocked a download (${item.getFilename() || 'file'}): the browser does not download files.`)
    event.preventDefault()
    try { item.cancel() } catch { /* already cancelled */ }
  })
  ses.webRequest.onBeforeRequest((details, callback) => {
    const local = allowLocal()
    const blocked = () => {
      if (details.resourceType === 'mainFrame') note(`Blocked ${details.url.slice(0, 120)}: local, private and non-web addresses are off limits.`)
      callback({ cancel: true })
    }
    if (!isRequestAllowed(details.url, { allowLocal: local })) return blocked()
    let host = ''
    try { host = new URL(details.url).hostname } catch { /* data:, blob: … */ }
    if (local || !host || !/^(https?|wss?):/i.test(details.url)) return callback({ cancel: false })
    resolvesPrivate(host).then(bad => (bad ? blocked() : callback({ cancel: false })), () => callback({ cancel: false }))
  })
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
}

export function createElectronDriver(
  getParent?: () => BrowserWindow | null,
  opts: ElectronDriverOptions = {},
): ElectronPageDriver {
  void getParent // no parent window: a child would show, hide and close with the app's window
  let win: BrowserWindow | null = null
  let events: string[] = []
  let idle: ReturnType<typeof setTimeout> | null = null
  const partition = opts.partition ?? `mlx-agent-${randomBytes(6).toString('hex')}`
  let prepared = false
  const allowLocal = () => (typeof opts.allowLocal === 'function' ? !!opts.allowLocal() : !!opts.allowLocal)
  const note = (line: string) => {
    events.push(line)
    if (events.length > 20) events = events.slice(-20)
  }
  let closedByItself: (() => void) | null = null
  const closeWindow = () => {
    if (idle) clearTimeout(idle)
    idle = null
    const w = win
    win = null
    if (w && !w.isDestroyed()) {
      try { if (w.webContents.debugger.isAttached()) w.webContents.debugger.detach() } catch { /* gone */ }
      w.destroy()
    }
  }
  closers.add(closeWindow)
  /** Each use pushes the idle close back. */
  const touch = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => { closeWindow(); closedByItself?.() }, AGENT_BROWSER_IDLE_MS)
    ;(idle as any).unref?.()
  }

  function attachDebugger(wc: WebContents): void {
    // JS dialogs would block the page (and every script we run) in a hidden
    // window; file pickers would open on screen. CDP answers both.
    try {
      wc.debugger.attach('1.3')
      wc.debugger.on('message', (_e, method, params: any) => {
        if (method === 'Page.javascriptDialogOpening') {
          const type = String(params?.type ?? 'alert')
          const accept = type === 'alert' || type === 'beforeunload'
          note(`The page showed a ${type} dialog${params?.message ? `: ${JSON.stringify(String(params.message).slice(0, 200))}` : ''} (${accept ? 'closed' : 'cancelled'}).`)
          wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept }).catch(() => {})
        } else if (method === 'Page.fileChooserOpened') {
          note('The page asked for a file: file uploads are not supported.')
        }
      })
      wc.debugger.sendCommand('Page.enable').catch(() => {})
      wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {})
    } catch {
      // Without CDP, fall back to replacing the dialog functions on each page.
      wc.on('dom-ready', () => {
        wc.executeJavaScript('window.alert=function(){};window.confirm=function(){return false};window.prompt=function(){return null};void 0').catch(() => {})
      })
    }
  }

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win
    const ses = electronSession.fromPartition(partition)
    if (!prepared) { prepareSession(ses, allowLocal, note); prepared = true }
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        webSecurity: true,
        backgroundThrottling: false, // a hidden window would otherwise slow timers and never "settle"
        spellcheck: false,
        safeDialogs: true,
      },
    })
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && isRequestAllowed(url, { allowLocal: allowLocal() })) {
        setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}) })
      }
      return { action: 'deny' }
    })
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (!isRequestAllowed(url, { allowLocal: allowLocal() }) || !/^(https?:|about:blank)/i.test(url)) {
        event.preventDefault()
        note(`Blocked navigation to ${url.slice(0, 120)}.`)
      }
    }
    wc.on('will-navigate', (e, url) => guard(e, url))
    wc.on('will-redirect', (e, url) => guard(e, url))
    wc.on('will-attach-webview', e => e.preventDefault())
    wc.on('render-process-gone', () => note('The page crashed and was closed.'))
    attachDebugger(wc)
    agentWindows.add(win)
    const created = win
    win.on('closed', () => { if (win === created) win = null })
    return win
  }

  const wc = () => { const c = ensure().webContents; touch(); return c }

  function loaded(c: WebContents, timeoutMs = 30_000): Promise<void> {
    if (!c.isLoading()) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); c.removeListener('did-stop-loading', done); resolve() }
      const t = setTimeout(done, timeoutMs)
      c.once('did-stop-loading', done)
    })
  }

  return {
    async load(url: string): Promise<void> {
      const c = wc()
      try {
        await c.loadURL(url)
      } catch (e: any) {
        // Aborted loads are usually client-side redirects or a blocked download: the page is still there.
        if (e?.errno === ERR_ABORTED || e?.code === 'ERR_ABORTED') return
        throw new Error(String(e?.code ?? e?.message ?? e))
      }
    },

    run<T>(js: string): Promise<T> {
      // Own world: the page cannot see the ref registry or patch what the
      // scripts call. The DOM is shared, so clicks and typing still land.
      return wc().executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: js }], true) as Promise<T>
    },

    async back(): Promise<void> {
      const c = wc()
      const history = c.navigationHistory
      if (!history.canGoBack()) return
      history.goBack()
      await new Promise(r => setTimeout(r, 50))
      await loaded(c)
    },

    async capture(): Promise<string> {
      const image = await wc().capturePage()
      if (image.isEmpty()) throw new Error('the page has not been drawn yet')
      const { width } = image.getSize()
      // Retina captures are twice the window size: send the model 1280 px.
      return (width > 1280 ? image.resize({ width: 1280, quality: 'good' }) : image).toDataURL()
    },

    currentUrl(): string {
      if (!win || win.isDestroyed()) return ''
      return win.webContents.getURL()
    },

    isLoading(): boolean {
      return !!win && !win.isDestroyed() && win.webContents.isLoading()
    },

    takeEvents(): string[] {
      const out = events
      events = []
      return out
    },

    close(): void {
      closeWindow()
      events = []
    },

    onClosedByItself(cb: () => void): void {
      closedByItself = cb
    },

    dispose(): void {
      closeWindow()
      events = []
      closers.delete(closeWindow)
      closedByItself = null
      // The in-memory session can't be destroyed in Electron; empty it.
      if (prepared) {
        try { void electronSession.fromPartition(partition).clearStorageData() } catch { /* gone */ }
        try { void electronSession.fromPartition(partition).clearCache() } catch { /* gone */ }
      }
    },

    window(): BrowserWindow | null {
      return win && !win.isDestroyed() ? win : null
    },
  }
}
