/**
 * PageDriver on one hidden Electron BrowserWindow, created on first use and
 * again after close(). Its own persistent session (partition
 * persist:mlx-agent-browser), so the agent's cookies never mix with the app's.
 * The session refuses every permission, downloads, file pickers and requests
 * to local/private addresses (unless allowLocal); new windows load in place.
 * The page logic lives in ./agentBrowser.ts and ./snapshot.ts (pure).
 */

import { BrowserWindow, session as electronSession, type Session, type WebContents } from 'electron'
import { cleanUserAgent, isRequestAllowed, type PageDriver } from './agentBrowser'

export const AGENT_BROWSER_PARTITION = 'persist:mlx-agent-browser'

export interface ElectronDriverOptions {
  /** Allow localhost and private-network addresses (default false). Read on every request. */
  allowLocal?: boolean | (() => boolean)
}

export interface ElectronPageDriver extends PageDriver {
  /** The hidden window, if one is open (e.g. to show the agent's page later). */
  window(): BrowserWindow | null
}

const prepared = new WeakSet<Session>()
const ERR_ABORTED = -3

// The session outlives a driver: its handlers report to the driver that used it last.
let sessionAllowLocal: () => boolean = () => false
let sessionNote: (line: string) => void = () => {}
const allowLocal = () => sessionAllowLocal()
const note = (line: string) => sessionNote(line)

function prepareSession(ses: Session): void {
  if (prepared.has(ses)) return
  prepared.add(ses)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  try { ses.setDevicePermissionHandler(() => false) } catch { /* older Electron */ }
  ses.on('will-download', (event, item) => {
    note(`Blocked a download (${item.getFilename() || 'file'}): the browser does not download files.`)
    event.preventDefault()
    try { item.cancel() } catch { /* already cancelled */ }
  })
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = isRequestAllowed(details.url, { allowLocal: allowLocal() })
    if (!ok && details.resourceType === 'mainFrame') note(`Blocked ${details.url.slice(0, 120)}: local, private and non-web addresses are off limits.`)
    callback({ cancel: !ok })
  })
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
}

export function createElectronDriver(
  getParent?: () => BrowserWindow | null,
  opts: ElectronDriverOptions = {},
): ElectronPageDriver {
  let win: BrowserWindow | null = null
  let events: string[] = []
  const allowLocal = () => (typeof opts.allowLocal === 'function' ? !!opts.allowLocal() : !!opts.allowLocal)
  const note = (line: string) => {
    events.push(line)
    if (events.length > 20) events = events.slice(-20)
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
    const ses = electronSession.fromPartition(AGENT_BROWSER_PARTITION)
    sessionAllowLocal = allowLocal
    sessionNote = note
    prepareSession(ses)
    const parent = getParent?.() ?? null
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: {
        partition: AGENT_BROWSER_PARTITION,
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
    win.on('closed', () => { win = null })
    return win
  }

  const wc = () => ensure().webContents

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
      return wc().executeJavaScript(js, true) as Promise<T>
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
      const w = win
      win = null
      events = []
      if (w && !w.isDestroyed()) {
        try { if (w.webContents.debugger.isAttached()) w.webContents.debugger.detach() } catch { /* gone */ }
        w.destroy()
      }
    },

    window(): BrowserWindow | null {
      return win && !win.isDestroyed() ? win : null
    },
  }
}
