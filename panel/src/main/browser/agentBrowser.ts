/**
 * The agent's web browser (pure, no Electron import): one page, driven through
 * an injected PageDriver (Electron's hidden window in ./electronDriver.ts, a
 * Playwright page in tests). Every action returns what happened followed by a
 * fresh snapshot, so the model always reads the page as it is after acting.
 */

import {
  CLICK_SCRIPT,
  describeTarget,
  normalizeDirection,
  normalizeRef,
  SCROLL_SCRIPT,
  SELECT_SCRIPT,
  SETTLE_SCRIPT,
  snapshotScript,
  SNAPSHOT_MAX_CHARS,
  TYPE_SCRIPT,
  type ScriptResult,
  type SnapshotResult,
} from './snapshot'

export interface PageDriver {
  load(url: string): Promise<void>
  run<T>(js: string): Promise<T>
  back(): Promise<void>
  /** PNG data URL. */
  capture(): Promise<string>
  currentUrl(): string
  close(): void
  /** Optional: true while a navigation is in flight (Electron: webContents.isLoading()). */
  isLoading?(): boolean
  /** Optional: things the page did on its own since the last call (dialogs, blocked downloads…), one line each. */
  takeEvents?(): string[]
  /** Optional: called when the driver closed the page on its own (idle). */
  onClosedByItself?(cb: () => void): void
  /** Optional: free everything for good (the browser won't be used again). */
  dispose?(): void
}

export interface BrowserResult {
  text: string
  imageDataUrl?: string
  isError: boolean
}

export interface AgentBrowserOptions {
  /** Allow localhost and private-network addresses (default false). Read on every call. */
  allowLocal?: boolean | (() => boolean)
  /** Longest wait for a page to settle after an action (default 8000 ms). */
  settleMs?: number
  /** Longest wait for open() before reading the page anyway (default 30000 ms). */
  loadTimeoutMs?: number
  /** Snapshot size cap in characters (default 12000). */
  maxChars?: number
}

export type BrowserAction = 'open' | 'snapshot' | 'click' | 'type' | 'select' | 'scroll' | 'back' | 'screenshot' | 'close'

export const BROWSER_ACTIONS: readonly BrowserAction[] = ['open', 'snapshot', 'click', 'type', 'select', 'scroll', 'back', 'screenshot', 'close']

export interface BrowserArgs {
  action?: unknown
  url?: unknown
  ref?: unknown
  text?: unknown
  submit?: unknown
  value?: unknown
  direction?: unknown
}

// ---------------------------------------------------------------------------
// URL policy (pure)

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string }

const BLOCKED_SCHEMES = new Set(['file:', 'javascript:', 'data:', 'blob:', 'chrome:', 'chrome-extension:', 'devtools:', 'view-source:', 'filesystem:', 'about:'])

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every(n => n <= 255) ? parts : null
}

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||           // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224                                  // multicast, reserved, broadcast
}

/** IPv6 text → 8 groups, or null. Accepts an IPv4 tail ("::ffff:127.0.0.1") and a zone ("fe80::1%en0"). */
export function expandV6(text: string): number[] | null {
  let t = text.toLowerCase().split('%')[0]
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t)
  if (tail) {
    const v4 = ipv4Parts(tail[2])
    if (!v4) return null
    t = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = t.split('::')
  if (halves.length > 2) return null
  const part = (x: string) => (x === '' ? [] : x.split(':'))
  const left = part(halves[0])
  const right = halves.length === 2 ? part(halves[1]) : []
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right]
  const out: number[] = []
  for (const x of all) {
    if (!/^[0-9a-f]{1,4}$/.test(x)) return null
    out.push(parseInt(x, 16))
  }
  return out.length === 8 ? out : null
}

/** True for loopback, private, link-local and other non-public hosts (hostname as URL gives it). */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/\.$/, '')
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
      h.endsWith('.home.arpa') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':')) return true
  const v4 = ipv4Parts(h)
  if (v4) return privateV4(v4)
  if (h.includes(':')) {
    const g = expandV6(h)
    if (!g) return true // not a valid IPv6 address: refuse
    const v4At = (i: number) => [g[i] >> 8, g[i] & 255, g[i + 1] >> 8, g[i + 1] & 255]
    // ::/96 (unspecified, loopback, IPv4-compatible such as [::7f00:1])
    if (g.slice(0, 6).every(x => x === 0)) return true
    // ::ffff:0:0/96 IPv4-mapped
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return privateV4(v4At(6))
    // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local-use NAT64
    if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || privateV4(v4At(6))
    // 2002::/16 6to4 carries an IPv4 address in bits 16–47
    if (g[0] === 0x2002) return privateV4(v4At(1))
    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
    if ((g[0] & 0xff00) === 0xff00) return true // multicast
    return false
  }
  return false
}

/**
 * Checks a URL the model asked to open. Bare hosts ("example.com/x") get
 * https://. Only http(s) and about:blank pass; private and loopback hosts only
 * with allowLocal.
 */
export function checkUrl(raw: unknown, opts: { allowLocal?: boolean } = {}): UrlCheck {
  let s = String(raw ?? '').trim()
  if (!s) return { ok: false, error: 'No URL given. Pass a full address like https://example.com.' }
  if (s.length > 8192) return { ok: false, error: 'That URL is too long.' }
  if (/^about:blank$/i.test(s)) return { ok: true, url: 'about:blank' }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[^/:]+:\d+(\/|$)/.test(s)) s = `https://${s.replace(/^\/+/, '')}`
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return { ok: false, error: `Not a valid URL: ${String(raw).slice(0, 200)}` }
  }
  const scheme = url.protocol.toLowerCase()
  if (scheme !== 'http:' && scheme !== 'https:') {
    const why = BLOCKED_SCHEMES.has(scheme) ? 'is blocked' : 'is not supported'
    return { ok: false, error: `${scheme} URLs ${why}. Only http and https pages can be opened.` }
  }
  if (!url.hostname) return { ok: false, error: 'That URL has no host.' }
  if (!opts.allowLocal && isPrivateHost(url.hostname)) {
    return { ok: false, error: `${url.hostname} is a local or private address. The browser only opens public websites.` }
  }
  return { ok: true, url: url.href }
}

/**
 * For request filtering in the driver (navigations, redirects, subresources):
 * blocks file: and the like, and http(s)/ws(s) to private hosts unless allowLocal.
 * data:, blob: and about: subresources are fine inside a page.
 */
export function isRequestAllowed(rawUrl: string, opts: { allowLocal?: boolean } = {}): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const scheme = url.protocol
  if (scheme === 'data:' || scheme === 'blob:' || scheme === 'about:') return true
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'ws:' || scheme === 'wss:') {
    return !!opts.allowLocal || !isPrivateHost(url.hostname)
  }
  return false
}

/** Chrome's user agent without the Electron and app tokens (some sites refuse "Electron"). */
export function cleanUserAgent(ua: string): string {
  const m = /^(Mozilla\/5\.0 \([^)]*\)) AppleWebKit\/(\S+) \(KHTML, like Gecko\) .*?Chrome\/(\S+) .*?Safari\/(\S+)/.exec(ua)
  return m ? `${m[1]} AppleWebKit/${m[2]} (KHTML, like Gecko) Chrome/${m[3]} Safari/${m[4]}` : ua
}

// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

class Timeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Timeout(`timed out after ${ms} ms`)), ms) }),
  ]).finally(() => clearTimeout(t))
}

function message(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  return s.replace(/^Error invoking remote method '[^']+': /, '').slice(0, 300)
}

/** How the browser reads yes/no arguments (the approval card uses the same rule). */
export function truthy(v: unknown): boolean {
  if (typeof v === 'string') return /^(true|yes|1|on)$/i.test(v.trim())
  return !!v
}

function quote(s: string, n = 80): string {
  const t = s.length > n ? `${s.slice(0, n - 1)}…` : s
  return JSON.stringify(t)
}

export class AgentBrowser {
  private opened = false
  private last: SnapshotResult | null = null
  private readonly settleMs: number
  private readonly loadTimeoutMs: number
  private readonly maxChars: number
  private queue: Promise<unknown> = Promise.resolve()

  /** The page was closed after idling: the next action says so. */
  private idleClosed = false

  constructor(private readonly driver: PageDriver, private readonly opts: AgentBrowserOptions = {}) {
    this.settleMs = opts.settleMs ?? 8000
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 30_000
    this.maxChars = opts.maxChars ?? SNAPSHOT_MAX_CHARS
    driver.onClosedByItself?.(() => {
      if (!this.opened) return
      this.opened = false
      this.last = null
      this.idleClosed = true
    })
  }

  /** Free the page and its session for good. */
  dispose(): void {
    this.opened = false
    this.last = null
    try { this.driver.dispose?.() } catch { /* already gone */ }
  }

  /** The latest snapshot text ('' before the first), for approval cards. */
  get lastSnapshotText(): string {
    return this.last?.text ?? ''
  }

  get lastUrl(): string {
    return this.last?.url ?? ''
  }

  get isOpen(): boolean {
    return this.opened
  }

  /** A picture of the page for the live view (no snapshot, never throws). */
  async frame(): Promise<string | null> {
    if (!this.opened) return null
    try { return await withTimeout(this.driver.capture(), 5_000) } catch { return null }
  }

  /** Runs one tool call ({ action, url, ref, … } as the model sent it). */
  execute(args: BrowserArgs): Promise<BrowserResult> {
    const action = String(args?.action ?? '').trim().toLowerCase()
    switch (action) {
      case 'open': case 'goto': case 'navigate': return this.open(String(args.url ?? ''))
      case 'snapshot': case 'read': return this.snapshot()
      case 'click': return this.click(String(args.ref ?? ''))
      case 'type': case 'fill': return this.type(String(args.ref ?? ''), args.text == null ? '' : String(args.text), truthy(args.submit))
      case 'select': return this.select(String(args.ref ?? ''), args.value == null ? String(args.text ?? '') : String(args.value))
      case 'scroll': return this.scroll(String(args.direction ?? 'down'))
      case 'back': return this.back()
      case 'screenshot': return this.screenshot()
      case 'close': return this.close()
      default:
        return Promise.resolve({ text: `Unknown browser action ${quote(action || String(args?.action ?? ''))}. Use one of: ${BROWSER_ACTIONS.join(', ')}.`, isError: true })
    }
  }

  open(url: string): Promise<BrowserResult> {
    return this.serial(async () => {
      const check = checkUrl(url, { allowLocal: this.allowLocal() })
      if (!check.ok) return { text: check.error, isError: true }
      let note = ''
      try {
        await withTimeout(this.driver.load(check.url), this.loadTimeoutMs)
      } catch (e) {
        if (e instanceof Timeout) note = ' (still loading)'
        else {
          this.opened = this.hasPage()
          return { text: `Could not open ${check.url}: ${message(e)}`, isError: true }
        }
      }
      this.opened = true
      this.idleClosed = false
      return this.after(`Opened ${check.url}${note}.`)
    })
  }

  snapshot(): Promise<BrowserResult> {
    return this.serial(async () => {
      const closed = this.needsPage()
      if (closed) return closed
      return this.after('')
    })
  }

  click(ref: string): Promise<BrowserResult> {
    return this.serial(async () => {
      const closed = this.needsPage()
      if (closed) return closed
      const r = normalizeRef(ref)
      if (!r) return this.badRef(ref)
      const target = describeTarget(r, this.lastSnapshotText)
      const moved = await this.targetMoved(r, target)
      if (moved) return moved
      const res = await this.script(CLICK_SCRIPT(r))
      if (!res.ok) return this.after(`Could not click ${target}: ${res.error}`, true)
      return this.after(`Clicked ${target}.`, false, true)
    })
  }

  type(ref: string, text: string, submit = false): Promise<BrowserResult> {
    return this.serial(async () => {
      const closed = this.needsPage()
      if (closed) return closed
      const r = normalizeRef(ref)
      if (!r) return this.badRef(ref)
      const target = describeTarget(r, this.lastSnapshotText)
      const moved = await this.targetMoved(r, target)
      if (moved) return moved
      const res = await this.script(TYPE_SCRIPT(r, text, submit))
      if (!res.ok) return this.after(`Could not type into ${target}: ${res.error}`, true)
      const secret = /type=password/.test(target)
      let line = `Typed ${secret ? `${text.length} characters` : quote(text)} into ${target}`
      if (submit) line += res.submitted === 'none' ? ' and pressed Enter (nothing was submitted)' : ' and pressed Enter'
      line += '.'
      if (typeof res.note === 'string') line += ` ${res.note}`
      return this.after(line, false, submit)
    })
  }

  select(ref: string, value: string): Promise<BrowserResult> {
    return this.serial(async () => {
      const closed = this.needsPage()
      if (closed) return closed
      const r = normalizeRef(ref)
      if (!r) return this.badRef(ref)
      const target = describeTarget(r, this.lastSnapshotText)
      const moved = await this.targetMoved(r, target)
      if (moved) return moved
      const res = await this.script(SELECT_SCRIPT(r, value))
      if (!res.ok) return this.after(`Could not select in ${target}: ${res.error}`, true)
      return this.after(`Selected ${quote(String(res.label ?? value))} in ${target}.`, false, true)
    })
  }

  scroll(direction: string = 'down'): Promise<BrowserResult> {
    return this.serial(async () => {
      const closed = this.needsPage()
      if (closed) return closed
      const dir = normalizeDirection(direction)
      if (!dir) return { text: `Unknown scroll direction ${quote(direction)}. Use up, down, top or bottom.`, isError: true }
      const res = await this.script(SCROLL_SCRIPT(dir))
      if (!res.ok) return this.after(`Could not scroll: ${res.error}`, true)
      let line = `Scrolled ${dir === 'top' || dir === 'bottom' ? `to the ${dir}` : dir}.`
      if (!res.moved) line = dir === 'up' || dir === 'top' ? 'Already at the top.' : 'Already at the bottom.'
      else if (res.atBottom && dir === 'down') line += ' This is the bottom of the page.'
      return this.after(line)
    })
  }

  back(): Promise<BrowserResult> {
    return this.serial(async () => {
      const closed = this.needsPage()
      if (closed) return closed
      const before = this.driver.currentUrl()
      try {
        await withTimeout(this.driver.back(), this.loadTimeoutMs)
      } catch (e) {
        if (!(e instanceof Timeout)) return this.after(`Could not go back: ${message(e)}`, true)
      }
      await sleep(100)
      const moved = this.driver.currentUrl() !== before
      return this.after(moved ? 'Went back.' : 'There is no earlier page.', false, true)
    })
  }

  screenshot(): Promise<BrowserResult> {
    return this.serial(async () => {
      const closed = this.needsPage()
      if (closed) return closed
      await this.settle()
      let image: string | undefined
      try {
        image = await withTimeout(this.driver.capture(), 15_000)
      } catch (e) {
        return this.after(`Could not take a screenshot: ${message(e)}`, true)
      }
      if (!image || !image.startsWith('data:image/')) return this.after('Could not take a screenshot.', true)
      const res = await this.after('Screenshot of the visible part of the page.', false, false, true)
      return { ...res, imageDataUrl: image }
    })
  }

  close(): Promise<BrowserResult> {
    return this.serial(async () => {
      const was = this.opened
      this.opened = false
      this.last = null
      try { this.driver.close() } catch { /* already gone */ }
      return { text: was ? 'Browser closed.' : 'The browser was not open.', isError: false }
    })
  }

  // -------------------------------------------------------------------------

  private allowLocal(): boolean {
    const a = this.opts.allowLocal
    return typeof a === 'function' ? !!a() : !!a
  }

  /** One action at a time: a second call waits for the first. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private hasPage(): boolean {
    try {
      const u = this.driver.currentUrl()
      return !!u && u !== 'about:blank'
    } catch {
      return false
    }
  }

  private needsPage(): BrowserResult | null {
    if (this.opened) return null
    if (this.idleClosed) {
      return { text: 'The browser closed after 10 idle minutes. Open the page again with action "open" (sign-ins are kept).', isError: true }
    }
    return { text: 'No page is open. Use action "open" with a url first.', isError: true }
  }

  /**
   * The model (and the approval card) chose a ref by what the last snapshot
   * showed. If the page has changed that element since, nothing is done: a
   * page must not turn an approved "Cancel" into "Pay now".
   */
  private async targetMoved(ref: string, target: string): Promise<BrowserResult | null> {
    if (target === `[${ref}]`) return null // never shown: the script reports a bad ref
    let now: string
    try { now = describeTarget(ref, (await this.take()).text) } catch { return null }
    const plain = (t: string) => t.replace(/\s+value=("(?:[^"\\]|\\.)*"|\S+)/g, '').replace(/…$/, '')
    if (now === `[${ref}]` || plain(now) === plain(target)) return null
    return this.after(`Nothing was done: the page changed ${ref} since the last look (it was ${target}, now ${now}). Check the page and try again.`, true)
  }

  private badRef(ref: string): Promise<BrowserResult> {
    return this.after(`${quote(ref, 30)} is not a ref. Use a ref like e12 from the latest snapshot.`, true)
  }

  private async script(js: string): Promise<ScriptResult> {
    try {
      const res = await withTimeout(this.driver.run<ScriptResult>(js), 10_000)
      if (res && typeof res === 'object' && typeof res.ok === 'boolean') return res
      return { ok: false, error: 'the page did not answer' }
    } catch (e) {
      // A click that navigates can tear down the page mid-script: that's a success.
      if (/destroyed|navigat|context|detached|closed/i.test(message(e))) return { ok: true }
      return { ok: false, error: message(e) }
    }
  }

  /** Waits until the page is loaded and the DOM is quiet, at most settleMs. */
  private async settle(actionStarted = false): Promise<void> {
    const deadline = Date.now() + this.settleMs
    // Give a click or Enter a moment to start a navigation before we look.
    if (actionStarted) await sleep(150)
    while (Date.now() < deadline) {
      if (this.driver.isLoading?.()) { await sleep(100); continue }
      const left = deadline - Date.now()
      try {
        await withTimeout(this.driver.run(SETTLE_SCRIPT(300, Math.min(4000, left))), left + 500)
        if (!this.driver.isLoading?.()) return
      } catch {
        await sleep(150)
      }
    }
  }

  private async take(): Promise<SnapshotResult> {
    let lastError: unknown
    for (let i = 0; i < 3; i++) {
      try {
        const res = await withTimeout(this.driver.run<SnapshotResult>(snapshotScript(this.maxChars)), 10_000)
        if (res && typeof res.text === 'string') {
          this.last = { url: String(res.url ?? ''), title: String(res.title ?? ''), text: res.text }
          return this.last
        }
        lastError = new Error('the page did not answer')
      } catch (e) {
        lastError = e
        await this.settle()
      }
    }
    throw lastError
  }

  /** The action line, page events, then a fresh snapshot. */
  private async after(line: string, isError = false, actionStarted = false, settled = false): Promise<BrowserResult> {
    if (!settled) await this.settle(actionStarted)
    const url = this.driver.currentUrl()
    if (url && url !== 'about:blank' && !isRequestAllowed(url, { allowLocal: this.allowLocal() })) {
      try { await this.driver.load('about:blank') } catch { /* ignore */ }
      return { text: `${line ? `${line}\n` : ''}The page went to a blocked address (${url.slice(0, 120)}), so the browser stopped there.`, isError: true }
    }
    const events = this.driver.takeEvents?.() ?? []
    const head = [line, ...events].filter(Boolean).join('\n')
    let snap: SnapshotResult
    try {
      snap = await this.take()
    } catch (e) {
      return { text: `${head ? `${head}\n` : ''}Could not read the page: ${message(e)}`, isError: true }
    }
    const page = `Page: ${snap.title || '(no title)'}\nURL: ${snap.url}\n\n${snap.text}`
    return { text: head ? `${head}\n\n${page}` : page, isError }
  }
}
