/**
 * Agent browser: page scripts (snapshot, click, type, select, scroll) run in
 * real Chromium through Playwright, AgentBrowser on a Playwright-backed
 * PageDriver, and the pure URL policy. No network: pages come from
 * setContent() or routes fulfilled in the test.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentBrowser,
  checkUrl,
  cleanUserAgent,
  isPrivateHost,
  isRequestAllowed,
  type PageDriver,
} from '../src/main/browser/agentBrowser'
import {
  CLICK_SCRIPT,
  describeTarget,
  MORE_BELOW,
  normalizeRef,
  SCROLL_SCRIPT,
  SELECT_SCRIPT,
  SETTLE_SCRIPT,
  SNAPSHOT_SCRIPT,
  snapshotScript,
  TYPE_SCRIPT,
  type SnapshotResult,
} from '../src/main/browser/snapshot'
import { BROWSER_TOOL, browserActionKind, describeBrowserAction } from '../src/main/browser/toolDefinition'

// --- Playwright (same lookup as scripts/preview-shot.mjs) -------------------

async function loadPlaywright(): Promise<any | null> {
  const panel = join(__dirname, '..')
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    join(panel, 'node_modules/playwright-core/index.mjs'),
    join(panel, 'node_modules/playwright/index.mjs'),
    '/opt/node-tools/node_modules/playwright-core/index.mjs',
  ].filter(Boolean) as string[]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try { return await import(pathToFileURL(path).href) } catch { /* next */ }
  }
  return null
}

function chromiumExecutables(): string[] {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean) as string[]
  const found: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(root, dir, sub)
        if (existsSync(p)) found.push(p)
      }
    }
  }
  return found
}

async function launch(): Promise<any | null> {
  const pw = await loadPlaywright()
  if (!pw?.chromium) return null
  try { return await pw.chromium.launch() } catch { /* try a bundled build */ }
  for (const executablePath of chromiumExecutables()) {
    try { return await pw.chromium.launch({ executablePath }) } catch { /* next */ }
  }
  return null
}

const browser = await launch()
const noBrowser = !browser
let page: any

afterAll(async () => { await browser?.close() })

beforeEach(async () => {
  if (!browser) return
  if (page) await page.close().catch(() => {})
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  // Fixtures get a real origin (links resolve against it) without any network.
  await page.route('https://fixture.test/**', (route: any) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' }))
  await page.goto('https://fixture.test/')
})

const snap = async (max?: number): Promise<SnapshotResult> => page.evaluate(max ? snapshotScript(max) : SNAPSHOT_SCRIPT)
const refOf = (text: string, needle: string): string => {
  const line = text.split('\n').find(l => l.includes(needle))
  const m = line && /\[[a-z]+ (e\d+)/.exec(line)
  if (!m) throw new Error(`no ref for ${needle} in:\n${text}`)
  return m[1]
}

// --- Snapshot ----------------------------------------------------------------

describe.skipIf(noBrowser)('snapshot script', () => {
  it('outlines headings, links, fields and buttons with refs', async () => {
    await page.setContent(`
      <title>Pricing — Acme</title>
      <nav><a href="/login">Sign in</a></nav>
      <main>
        <h1>Pricing</h1>
        <p>Plans for   every
           team.</p>
        <label for="email">Email</label><input id="email" type="email">
        <input type="password" aria-label="Password" value="hunter22">
        <label><input type="checkbox" checked> Remember me</label>
        <select aria-label="Country"><option>Norway</option><option selected>Sweden</option></select>
        <button>Continue</button>
        <div role="button" aria-label="Close banner"></div>
        <img src="data:," alt="Team photo" width="40" height="40">
      </main>`)
    const s = await snap()
    expect(s.title).toBe('Pricing — Acme')
    expect(s.url).toBe('https://fixture.test/')
    const t = s.text
    expect(t).toMatch(/^\[navigation\]\n {2}\[link e\d+\] Sign in → \/login$/m)
    expect(t).toMatch(/\[heading\] Pricing/)
    expect(t).toContain('Plans for every team.')
    expect(t).toMatch(/\[textbox e\d+ "Email"\] type=email value=""/)
    expect(t).toMatch(/\[textbox e\d+ "Password"\] type=password value=\(8 chars, hidden\)/)
    expect(t).not.toContain('hunter22')
    expect(t).toMatch(/\[checkbox e\d+ "Remember me"\] checked/)
    expect(t).toMatch(/\[combobox e\d+ "Country"\] value="Sweden" options: "Norway", "Sweden"/)
    expect(t).toMatch(/\[button e\d+\] Continue/)
    expect(t).toMatch(/\[button e\d+\] Close banner/)
    expect(t).toContain('[img "Team photo"]')
    // The label text isn't repeated as plain text next to its field.
    expect(t.split('\n').filter(l => l.trim() === 'Email')).toHaveLength(0)
    // Every ref is unique and stored on the element.
    const refs = [...t.matchAll(/\[[a-z]+ (e\d+)/g)].map(m => m[1])
    expect(new Set(refs).size).toBe(refs.length)
    expect(await page.locator(`[data-mlx-ref="${refOf(t, 'Continue')}"]`).textContent()).toBe('Continue')
  })

  it('keeps refs stable across snapshots and gives new elements new refs', async () => {
    await page.setContent(`<button id="a">One</button><button id="b">Two</button><div id="slot"></div>`)
    const first = (await snap()).text
    const one = refOf(first, 'One'), two = refOf(first, 'Two')
    await page.evaluate(() => {
      const b = document.createElement('button')
      b.textContent = 'Zero'
      document.body.prepend(b)
      document.getElementById('slot')!.innerHTML = '<a href="https://example.com/x">Three</a>'
    })
    const second = (await snap()).text
    expect(refOf(second, 'One')).toBe(one)
    expect(refOf(second, 'Two')).toBe(two)
    const zero = refOf(second, 'Zero'), three = refOf(second, 'Three')
    expect(new Set([one, two, zero, three]).size).toBe(4)
    expect(second).toMatch(/\[link e\d+\] Three → example\.com\/x/)
    // A cloned element (same data-mlx-ref) gets a fresh ref instead of a duplicate.
    await page.evaluate(() => document.body.append(document.getElementById('a')!.cloneNode(true)))
    const third = (await snap()).text
    const refs = [...third.matchAll(/\[button (e\d+)\] One/g)].map(m => m[1])
    expect(refs).toHaveLength(2)
    expect(refs[0]).toBe(one)
    expect(refs[1]).not.toBe(one)
  })

  it('skips hidden elements', async () => {
    await page.setContent(`
      <p>Visible text</p>
      <p style="display:none">Gone by display</p>
      <p style="visibility:hidden">Gone by visibility</p>
      <div aria-hidden="true"><button>Aria hidden button</button></div>
      <div hidden><a href="/x">Hidden link</a></div>
      <input type="hidden" name="csrf" value="secret">
      <a href="#main" style="position:absolute;left:-9999px">Skip to content</a>
      <details><summary>More</summary><button>Inside closed details</button></details>
      <button style="width:0;height:0;padding:0;border:0;overflow:hidden"></button>
      <script>var hiddenScript = 1</script><style>.x{}</style>
      <button>Shown button</button>`)
    const t = (await snap()).text
    expect(t).toContain('Visible text')
    expect(t).toMatch(/\[button e\d+\] Shown button/)
    expect(t).toMatch(/\[summary e\d+\] More collapsed/)
    for (const gone of ['Gone by display', 'Gone by visibility', 'Aria hidden', 'Hidden link', 'csrf', 'secret', 'Skip to content', 'Inside closed details', 'hiddenScript', '.x{}']) {
      expect(t).not.toContain(gone)
    }
  })

  it('reads lists, tables, landmarks, open shadow roots and same-origin iframes', async () => {
    await page.setContent(`
      <ul><li>Alpha</li><li>Beta <a href="/b">more</a></li></ul>
      <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$10</td></tr></table>
      <div role="alert">Card declined</div>
      <h2><a href="/docs">Docs</a></h2>
      <x-card></x-card>
      <iframe srcdoc="<button>In frame</button>" width="300" height="100"></iframe>
      <script>
        customElements.define('x-card', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow button</button>' }
        })
      </script>`)
    await page.waitForFunction(() => (document.querySelector('iframe') as HTMLIFrameElement).contentDocument?.querySelector('button'))
    const t = (await snap()).text
    expect(t).toContain('- Alpha')
    expect(t).toMatch(/- Beta\n {0}- ?\[link e\d+\] more|- Beta\n\[link e\d+\] more/)
    expect(t).toContain('Plan | Price')
    expect(t).toContain('Pro | $10')
    expect(t).toMatch(/\[alert\]\n {2}Card declined/)
    expect(t).toMatch(/\[heading\] \[link e\d+\] Docs → \/docs/)
    expect(t).toMatch(/\[button e\d+\] Shadow button/)
    expect(t).toMatch(/\[iframe\]\n {2}\[button e\d+\] In frame/)
    // Refs inside shadow roots and iframes are clickable.
    await page.evaluate(() => {
      const w = window as any
      w.clicks = []
      const host = document.querySelector('x-card')!.shadowRoot!.querySelector('button')!
      host.addEventListener('click', () => w.clicks.push('shadow'))
      const fb = (document.querySelector('iframe') as HTMLIFrameElement).contentDocument!.querySelector('button')!
      fb.addEventListener('click', () => w.clicks.push('frame'))
    })
    expect(await page.evaluate(CLICK_SCRIPT(refOf(t, 'Shadow button')))).toEqual({ ok: true })
    expect(await page.evaluate(CLICK_SCRIPT(refOf(t, 'In frame')))).toEqual({ ok: true })
    expect(await page.evaluate(() => (window as any).clicks)).toEqual(['shadow', 'frame'])
  })

  it('caps long pages and windows from the viewport after scrolling', async () => {
    const paras = Array.from({ length: 1500 }, (_, i) => `<p>Paragraph number ${i} with some filler words to take space.</p>`).join('')
    await page.setContent(`<h1>Top heading</h1>${paras}`)
    const first = await snap()
    expect(first.text.length).toBeLessThanOrEqual(12_000 + MORE_BELOW.length + 1)
    expect(first.text.endsWith(MORE_BELOW)).toBe(true)
    expect(first.text).toContain('Top heading')
    expect(first.text).not.toContain('Paragraph number 1499')

    const small = await snap(1000)
    expect(small.text.length).toBeLessThanOrEqual(1000 + MORE_BELOW.length + 1)

    const scrolled = await page.evaluate(SCROLL_SCRIPT('bottom'))
    expect(scrolled).toMatchObject({ ok: true, moved: true, atBottom: true })
    const last = await snap()
    expect(last.text).toMatch(/^…\(\d+ lines above, scroll up to see them\)/)
    expect(last.text).toContain('Paragraph number 1499')
    expect(last.text).not.toContain('Top heading')

    const up = await page.evaluate(SCROLL_SCRIPT('top'))
    expect(up).toMatchObject({ ok: true, moved: true, atTop: true })
    expect(await page.evaluate(SCROLL_SCRIPT('up'))).toMatchObject({ ok: true, moved: false })
  })

  it('scrolls the main scrollable area when the document itself does not scroll', async () => {
    await page.setContent(`<style>html,body{margin:0;height:100%;overflow:hidden}</style>
      <div id="app" style="height:100%;overflow-y:auto"><div style="height:5000px">tall</div></div>`)
    expect(await page.evaluate(SCROLL_SCRIPT('down'))).toMatchObject({ ok: true, moved: true, atBottom: false })
    expect(await page.evaluate(() => document.getElementById('app')!.scrollTop)).toBeGreaterThan(500)
  })

  it('settles once the DOM is quiet', async () => {
    await page.setContent('<div id="x"></div>')
    const started = Date.now()
    const res = await page.evaluate(SETTLE_SCRIPT(100, 2000))
    expect(res).toEqual({ readyState: 'complete', quiet: true })
    expect(Date.now() - started).toBeLessThan(1500)
    await page.evaluate(() => { setInterval(() => { document.getElementById('x')!.textContent = String(Math.random()) }, 20) })
    const busy = await page.evaluate(SETTLE_SCRIPT(100, 400))
    expect(busy.quiet).toBe(false)
  })
})

// --- Actions -----------------------------------------------------------------

describe.skipIf(noBrowser)('action scripts', () => {
  it('click runs the page handlers and toggles checkboxes', async () => {
    await page.setContent(`
      <button id="b">Count</button><output id="n">0</output>
      <input type="checkbox" id="c" aria-label="Agree">
      <button disabled>Nope</button>
      <input type="file" aria-label="Upload">`)
    await page.evaluate(() => {
      const w = window as any
      w.events = []
      const b = document.getElementById('b')!
      for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) b.addEventListener(t, () => w.events.push(t))
      b.addEventListener('click', () => { const n = document.getElementById('n')!; n.textContent = String(Number(n.textContent) + 1) })
    })
    const t = (await snap()).text
    expect(await page.evaluate(CLICK_SCRIPT(refOf(t, 'Count')))).toEqual({ ok: true })
    expect(await page.textContent('#n')).toBe('1')
    expect(await page.evaluate(() => (window as any).events)).toEqual(['pointerdown', 'mousedown', 'mouseup', 'click'])
    expect(await page.evaluate(CLICK_SCRIPT(refOf(t, 'Agree')))).toEqual({ ok: true })
    expect(await page.isChecked('#c')).toBe(true)
    expect((await snap()).text).toMatch(/\[checkbox e\d+ "Agree"\] checked/)
    expect(await page.evaluate(CLICK_SCRIPT(refOf(t, 'Nope')))).toMatchObject({ ok: false, error: expect.stringContaining('disabled') })
    expect(await page.evaluate(CLICK_SCRIPT(refOf(t, 'Upload')))).toMatchObject({ ok: false, error: expect.stringContaining('File uploads') })
    expect(await page.evaluate(CLICK_SCRIPT('e999'))).toMatchObject({ ok: false, error: expect.stringContaining('No element e999') })
  })

  it('a page cannot point a ref at another element by moving the attribute', async () => {
    await page.setContent(`<button id="cancel" onclick="window.hit='cancel'">Cancel</button><button id="pay" onclick="window.hit='pay'">Pay now</button>`)
    const t = (await snap()).text
    const cancel = refOf(t, 'Cancel')
    await page.evaluate((ref: string) => {
      document.getElementById('cancel')!.removeAttribute('data-mlx-ref')
      document.getElementById('pay')!.setAttribute('data-mlx-ref', ref)
    }, cancel)
    expect(await page.evaluate(CLICK_SCRIPT(cancel))).toEqual({ ok: true })
    expect(await page.evaluate(() => (window as any).hit)).toBe('cancel')
    // A removed element is gone, not replaced by an impostor.
    await page.evaluate(() => document.getElementById('cancel')!.remove())
    expect(await page.evaluate(CLICK_SCRIPT(cancel))).toMatchObject({ ok: false })
    expect(await page.evaluate(() => (window as any).hit)).toBe('cancel')
  })

  it('type sets the value through the native setter and fires input/change', async () => {
    await page.setContent(`<form id="f"><input id="q" aria-label="Search"><textarea id="ta" aria-label="Notes"></textarea></form>
      <div contenteditable="true" aria-label="Editor" id="ed">old</div>`)
    await page.evaluate(() => {
      const w = window as any
      w.log = []
      const q = document.getElementById('q') as HTMLInputElement
      // Like React: an instance-level value property that ignores plain assignment tracking.
      let tracked = ''
      Object.defineProperty(q, 'value', {
        configurable: true,
        get() { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(this) },
        set(v) { tracked = v; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(this, v) },
      })
      w.tracked = () => tracked
      for (const t of ['input', 'change']) q.addEventListener(t, (e: any) => w.log.push(`${t}:${e.target.value}`))
      document.getElementById('ed')!.addEventListener('input', () => w.log.push('ed-input'))
      document.getElementById('f')!.addEventListener('submit', e => { e.preventDefault(); w.log.push('submit') })
    })
    const t = (await snap()).text
    expect(await page.evaluate(TYPE_SCRIPT(refOf(t, '"Search"'), 'mlx "node"', false))).toEqual({ ok: true, submitted: 'none' })
    expect(await page.inputValue('#q')).toBe('mlx "node"')
    // The native setter was used, not the instance one (so React would see a change).
    expect(await page.evaluate(() => (window as any).tracked())).toBe('')
    expect(await page.evaluate(() => (window as any).log)).toEqual(['input:mlx "node"', 'change:mlx "node"'])

    expect(await page.evaluate(TYPE_SCRIPT(refOf(t, '"Search"'), 'again', true))).toEqual({ ok: true, submitted: 'form' })
    expect(await page.evaluate(() => (window as any).log.slice(-1))).toEqual(['submit'])

    expect(await page.evaluate(TYPE_SCRIPT(refOf(t, '"Editor"'), 'new text', false))).toMatchObject({ ok: true })
    expect(await page.textContent('#ed')).toBe('new text')
    expect(await page.evaluate(() => (window as any).log)).toContain('ed-input')
    expect((await snap()).text).toMatch(/\[textbox e\d+ "Search"\] value="again"/)
  })

  it('type + submit leaves Enter to the page when it handles the key', async () => {
    await page.setContent(`<textarea aria-label="Message"></textarea><ul id="sent"></ul>`)
    await page.evaluate(() => {
      const ta = document.querySelector('textarea')!
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.keyCode === 13) {
          e.preventDefault()
          document.getElementById('sent')!.insertAdjacentHTML('beforeend', `<li>${ta.value}</li>`)
          ta.value = ''
        }
      })
    })
    const t = (await snap()).text
    expect(await page.evaluate(TYPE_SCRIPT(refOf(t, 'Message'), 'hello', true))).toMatchObject({ ok: true, submitted: 'handled' })
    expect(await page.textContent('#sent')).toBe('hello')
  })

  it('type refuses non-text fields', async () => {
    await page.setContent(`<input type="checkbox" aria-label="Box"><button>Btn</button>`)
    const t = (await snap()).text
    expect(await page.evaluate(TYPE_SCRIPT(refOf(t, 'Box'), 'x', false))).toMatchObject({ ok: false, error: expect.stringContaining('Use click') })
    expect(await page.evaluate(TYPE_SCRIPT(refOf(t, 'Btn'), 'x', false))).toMatchObject({ ok: false, error: expect.stringContaining('not a text field') })
  })

  it('select chooses by label or value and fires change', async () => {
    await page.setContent(`<select id="s" aria-label="Country"><option value="no">Norway</option><option value="se">Sweden</option><option value="dk" disabled>Denmark</option></select>`)
    await page.evaluate(() => { (window as any).changes = 0; document.getElementById('s')!.addEventListener('change', () => (window as any).changes++) })
    const ref = refOf((await snap()).text, 'Country')
    expect(await page.evaluate(SELECT_SCRIPT(ref, 'sweden'))).toEqual({ ok: true, label: 'Sweden', value: 'se' })
    expect(await page.inputValue('#s')).toBe('se')
    expect(await page.evaluate(SELECT_SCRIPT(ref, 'no'))).toMatchObject({ ok: true, label: 'Norway' })
    expect(await page.evaluate(() => (window as any).changes)).toBe(2)
    expect(await page.evaluate(SELECT_SCRIPT(ref, 'Denmark'))).toMatchObject({ ok: false, error: expect.stringContaining('disabled') })
    expect(await page.evaluate(SELECT_SCRIPT(ref, 'Finland'))).toMatchObject({ ok: false, error: expect.stringContaining('"Norway", "Sweden"') })
  })

  it('embeds arguments safely', async () => {
    await page.setContent(`<input aria-label="Field">`)
    const ref = refOf((await snap()).text, 'Field')
    const nasty = `'); window.pwned = 1; ('\` \${1} </script> \\ "`
    expect(await page.evaluate(TYPE_SCRIPT(ref, nasty, false))).toMatchObject({ ok: true })
    expect(await page.inputValue('input')).toBe(nasty)
    expect(await page.evaluate(CLICK_SCRIPT(`e1"]'); window.pwned = 1; //`))).toMatchObject({ ok: false })
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined()
  })
})

// --- Pure helpers --------------------------------------------------------------

describe('url policy', () => {
  it('accepts http(s) and about:blank, adds https:// to bare hosts', () => {
    expect(checkUrl('https://example.com/a?b=1')).toEqual({ ok: true, url: 'https://example.com/a?b=1' })
    expect(checkUrl('http://example.com')).toEqual({ ok: true, url: 'http://example.com/' })
    expect(checkUrl('example.com/pricing')).toEqual({ ok: true, url: 'https://example.com/pricing' })
    expect(checkUrl('  about:blank ')).toEqual({ ok: true, url: 'about:blank' })
  })

  it('refuses other schemes', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'devtools://devtools', 'about:config', 'ftp://example.com', 'view-source:https://x.com']) {
      expect(checkUrl(u).ok, u).toBe(false)
    }
    expect(checkUrl('')).toMatchObject({ ok: false })
    expect(checkUrl('https://')).toMatchObject({ ok: false })
  })

  it('refuses loopback and private hosts unless allowLocal', () => {
    const local = [
      'http://localhost:8080', 'localhost:3000', 'http://app.localhost', 'http://127.0.0.1', 'http://127.1.2.3:9',
      'http://2130706433/', 'http://0x7f000001/', 'http://10.0.0.5', 'http://172.16.0.1', 'http://172.31.255.1',
      'http://192.168.1.1', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1', 'http://0.0.0.0',
      'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://printer.local', 'http://router',
      // IPv4 inside IPv6: compatible, NAT64 and 6to4 forms of 127.0.0.1.
      'http://[::7f00:1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/',
    ]
    for (const u of local) {
      expect(checkUrl(u).ok, u).toBe(false)
      expect(checkUrl(u, { allowLocal: true }).ok, u).toBe(true)
    }
    for (const u of ['http://172.32.0.1', 'http://8.8.8.8', 'http://[2606:4700::1111]/', 'https://mlx.app']) {
      expect(checkUrl(u).ok, u).toBe(true)
    }
  })

  it('isPrivateHost and isRequestAllowed', () => {
    expect(isPrivateHost('LOCALHOST')).toBe(true)
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isRequestAllowed('https://example.com/a.js')).toBe(true)
    expect(isRequestAllowed('data:image/png;base64,AAAA')).toBe(true)
    expect(isRequestAllowed('blob:https://example.com/1')).toBe(true)
    expect(isRequestAllowed('ws://127.0.0.1:8080/socket')).toBe(false)
    expect(isRequestAllowed('http://127.0.0.1:8080/v1/models')).toBe(false)
    expect(isRequestAllowed('http://127.0.0.1:8080/v1/models', { allowLocal: true })).toBe(true)
    expect(isRequestAllowed('file:///Users/me/.ssh/id_rsa', { allowLocal: true })).toBe(false)
    expect(isRequestAllowed('mailto:a@b.c')).toBe(false)
  })

  it('cleanUserAgent drops the Electron and app tokens', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) mlx-harness/0.2.1 Chrome/140.0.7339.41 Electron/44.3.0 Safari/537.36'
    expect(cleanUserAgent(ua)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36')
    expect(cleanUserAgent('weird')).toBe('weird')
  })
})

describe('refs and descriptions', () => {
  const text = [
    '[navigation]',
    '  [link e3] Sign in → /login',
    '[textbox e7 "Email"] value=""',
    '[textbox e9 "Password"] type=password value=""',
    '- [button e8] Continue',
    '[button e80] Other',
  ].join('\n')

  it('normalizeRef accepts what small models send', () => {
    expect(normalizeRef('e8')).toBe('e8')
    expect(normalizeRef(' E8 ')).toBe('e8')
    expect(normalizeRef('[e8]')).toBe('e8')
    expect(normalizeRef('8')).toBe('e8')
    expect(normalizeRef(8)).toBe('e8')
    expect(normalizeRef('button')).toBeNull()
    expect(normalizeRef('e8; alert(1)')).toBeNull()
  })

  it('describeTarget finds the line for a ref', () => {
    expect(describeTarget('e8', text)).toBe('[button e8] Continue')
    expect(describeTarget('e3', text)).toBe('[link e3] Sign in → /login')
    expect(describeTarget('e7', text)).toBe('[textbox e7 "Email"] value=""')
    expect(describeTarget('e1', text)).toBe('[e1]')
  })

  it('describeBrowserAction writes approval lines and masks passwords', () => {
    expect(describeBrowserAction({ action: 'click', ref: 'e8' }, text)).toBe('Click [button e8] Continue')
    expect(describeBrowserAction({ action: 'type', ref: 'e7', text: 'a@b.c', submit: true }, text)).toBe('Type "a@b.c" into [textbox e7 "Email"] value="" and press Enter')
    expect(describeBrowserAction(JSON.stringify({ action: 'type', ref: 'e9', text: 'secret' }), text)).toBe('Type •••••• into [textbox e9 "Password"] type=password value=""')
    expect(describeBrowserAction({ action: 'select', ref: 'e5', value: 'Sweden' }, text)).toBe('Choose "Sweden" in [e5]')
    expect(describeBrowserAction({ action: 'open', url: 'https://mlx.app' })).toBe('Open https://mlx.app')
  })

  it('browserActionKind and the tool definition', () => {
    for (const a of ['open', 'snapshot', 'scroll', 'back', 'screenshot', 'close']) expect(browserActionKind({ action: a })).toBe('read')
    for (const a of ['click', 'type', 'select', 'whatever', undefined]) expect(browserActionKind({ action: a })).toBe('act')
    expect(browserActionKind('{"action":"open"}')).toBe('read')
    expect(BROWSER_TOOL.type).toBe('function')
    expect(BROWSER_TOOL.function.name).toBe('browser')
    expect(BROWSER_TOOL.function.parameters.required).toEqual(['action'])
    expect(BROWSER_TOOL.function.parameters.properties.action.enum).toEqual(['open', 'snapshot', 'click', 'type', 'select', 'scroll', 'back', 'screenshot', 'close'])
    expect(BROWSER_TOOL.function.description).toContain('Use the ref ids from the latest snapshot')
  })
})

// --- AgentBrowser on a Playwright page ---------------------------------------

describe.skipIf(noBrowser)('AgentBrowser', () => {
  const SITE: Record<string, string> = {
    '/': `<title>Home</title><h1>Welcome</h1><a href="/pricing">Pricing</a>
      <form action="/search"><input name="q" aria-label="Search"><button>Go</button></form>
      <button onclick="this.textContent='Clicked!'">Press me</button>
      <a href="http://127.0.0.1:8080/v1/models">Local API</a>`,
    '/pricing': `<title>Pricing</title><h1>Plans</h1><select aria-label="Plan"><option>Core</option><option>Pro</option></select>`,
  }

  let ab: AgentBrowser
  let driver: PageDriver

  beforeAll(() => { /* page is created per test in the top-level beforeEach */ })

  beforeEach(async () => {
    await page.route('https://site.test/**', (route: any) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/search') {
        return route.fulfill({ contentType: 'text/html', body: `<title>Results</title><h1>Results for ${url.searchParams.get('q')}</h1>` })
      }
      const body = SITE[url.pathname]
      return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404, body: 'nope' })
    })
    await page.route(/127\.0\.0\.1/, (route: any) => route.fulfill({ contentType: 'text/plain', body: 'local secrets' }))
    driver = {
      load: async (url: string) => { await page.goto(url) },
      run: <T>(js: string) => page.evaluate(js) as Promise<T>,
      back: async () => { await page.goBack() },
      capture: async () => `data:image/png;base64,${(await page.screenshot()).toString('base64')}`,
      currentUrl: () => page.url(),
      close: () => {},
    }
    ab = new AgentBrowser(driver, { settleMs: 3000 })
  })

  it('does nothing when the page changed the chosen element since the last look', async () => {
    await page.route('https://swap.test/**', (route: any) => route.fulfill({ contentType: 'text/html', body: `<title>Swap</title><button id="b" onclick="window.hit=1">Cancel</button>` }))
    const opened = await ab.open('https://swap.test/')
    const ref = refOf(opened.text, 'Cancel')
    await page.evaluate(() => { document.getElementById('b')!.textContent = 'Pay now' })
    const r = await ab.click(ref)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(`Nothing was done: the page changed ${ref}`)
    expect(r.text).toContain('Pay now')
    expect(await page.evaluate(() => (window as any).hit)).toBeUndefined()
    // After a fresh look the same ref clicks (the model saw "Pay now").
    expect((await ab.click(ref)).isError).toBe(false)
    expect(await page.evaluate(() => (window as any).hit)).toBe(1)
  })

  it('needs a page before acting', async () => {
    const r = await ab.click('e1')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('No page is open')
  })

  it('opens, clicks, types, selects, goes back and screenshots, always returning the fresh page', async () => {
    const opened = await ab.open('site.test/')
    expect(opened.isError).toBe(false)
    expect(opened.text).toMatch(/^Opened https:\/\/site\.test\/\.\n\nPage: Home\nURL: https:\/\/site\.test\/\n\n\[heading\] Welcome/)

    const press = refOf(opened.text, 'Press me')
    const clicked = await ab.click(press)
    expect(clicked.isError).toBe(false)
    expect(clicked.text).toMatch(new RegExp(`^Clicked \\[button ${press}\\] Press me\\.`))
    expect(clicked.text).toMatch(new RegExp(`\\[button ${press}\\] Clicked!`))

    const search = refOf(clicked.text, '"Search"')
    const typed = await ab.execute({ action: 'type', ref: search, text: 'mac mini', submit: 'true' })
    expect(typed.isError).toBe(false)
    expect(typed.text).toMatch(/^Typed "mac mini" into \[textbox e\d+ "Search"\] value="" and pressed Enter\./)
    expect(typed.text).toContain('Page: Results')
    expect(typed.text).toContain('[heading] Results for mac mini')

    const back = await ab.back()
    expect(back.text).toMatch(/^Went back\./)
    expect(back.text).toContain('Page: Home')

    const toPricing = await ab.click(refOf(back.text, 'Pricing'))
    expect(toPricing.text).toContain('Page: Pricing')
    const sel = await ab.execute({ action: 'select', ref: refOf(toPricing.text, '"Plan"'), value: 'pro' })
    expect(sel.isError).toBe(false)
    expect(sel.text).toMatch(/^Selected "Pro" in \[combobox e\d+ "Plan"\]/)
    expect(sel.text).toMatch(/\[combobox e\d+ "Plan"\] value="Pro"/)

    const shot = await ab.screenshot()
    expect(shot.isError).toBe(false)
    expect(shot.imageDataUrl).toMatch(/^data:image\/png;base64,iVBOR/)
    expect(shot.text).toContain('Page: Pricing')

    expect(ab.lastSnapshotText).toContain('[heading] Plans')
    const closed = await ab.close()
    expect(closed).toEqual({ text: 'Browser closed.', isError: false })
    expect((await ab.snapshot()).isError).toBe(true)
  })

  it('reports bad refs with the page so the model can retry', async () => {
    await ab.open('https://site.test/')
    const r = await ab.click('e999')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^Could not click \[e999\]: No element e999/)
    expect(r.text).toContain('Page: Home')
    const bad = await ab.execute({ action: 'type', ref: 'the search box', text: 'x' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('is not a ref')
  })

  it('refuses blocked URLs and stops on a page that lands on one', async () => {
    for (const u of ['file:///etc/hosts', 'http://localhost:8080', 'javascript:alert(1)']) {
      const r = await ab.open(u)
      expect(r.isError, u).toBe(true)
    }
    const home = await ab.open('https://site.test/')
    const r = await ab.click(refOf(home.text, 'Local API'))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('blocked address')
    expect(r.text).not.toContain('local secrets')
    expect(page.url()).toBe('about:blank')

    const allowed = new AgentBrowser(driver, { allowLocal: () => true, settleMs: 2000 })
    const ok = await allowed.open('http://127.0.0.1:8080/v1/models')
    expect(ok.isError).toBe(false)
    expect(ok.text).toContain('local secrets')
  })

  it('scrolls and reports the bottom', async () => {
    await page.route('https://site.test/long', (route: any) => route.fulfill({
      contentType: 'text/html',
      body: `<title>Long</title>${Array.from({ length: 300 }, (_, i) => `<p>Row ${i}</p>`).join('')}`,
    }))
    await ab.open('https://site.test/long')
    const down = await ab.scroll('down')
    expect(down.text).toMatch(/^Scrolled down\./)
    const bottom = await ab.execute({ action: 'scroll', direction: 'bottom' })
    expect(bottom.text).toMatch(/^Scrolled to the bottom\./)
    expect(bottom.text).toContain('Row 299')
    expect((await ab.scroll('down')).text).toMatch(/^Already at the bottom\./)
    expect((await ab.scroll('sideways')).isError).toBe(true)
  })

  it('rejects unknown actions', async () => {
    const r = await ab.execute({ action: 'hover' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Use one of: open, snapshot')
  })
})
