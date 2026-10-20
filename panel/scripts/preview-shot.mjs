#!/usr/bin/env node
/**
 * Screenshot the renderer in a browser, no Electron (see preview/bootstrap.ts).
 *
 *   node scripts/preview-shot.mjs [options]
 *
 * Options
 *   --out <dir>          where PNGs go (default: $PREVIEW_SHOTS_DIR or the scratch shots dir)
 *   --shots '<json>'     array of shots (see below); default: chat light/dark, preferences, models
 *   --shots-file <path>  same, read from a JSON file
 *   --only <a,b>         take only the named shots
 *   --url <base>         use a running server (e.g. http://127.0.0.1:5199/ from `npm run preview:ui`)
 *   --no-build           serve the existing preview/dist instead of building first
 *   --scale <n>          deviceScaleFactor (default 2)
 *
 * A shot: { "name": "chat-dark", "query": "theme=dark&mode=chat", "width": 1280, "height": 820,
 *           "fullPage": false, "actions": [ ... ] }
 * Actions run in order after the page is ready:
 *   { "click": "<selector>" }  { "hover": "<selector>" }  { "fill": ["<selector>", "text"] }
 *   { "type": ["<selector>", "text"] }  { "press": "Enter" }  { "wait": 300 }
 *   { "waitFor": "<selector>" }  { "eval": "window.__PREVIEW__.emit('session:ready', {sessionId:'x'})" }
 * Selectors are Playwright selectors (CSS, text=..., role=...).
 *
 * Exit code 1 when a page threw or logged console errors, after all shots are taken.
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const panel = resolve(new URL('..', import.meta.url).pathname)
const distDir = join(panel, 'preview', 'dist')
const DEFAULT_OUT = '/tmp/claude-0/-home-claude/cb9f56c7-ab65-54b1-8f97-94234a5e1d54/scratchpad/shots'

const DEFAULT_SHOTS = [
  { name: 'chat-light', query: 'theme=light&mode=chat' },
  { name: 'chat-dark', query: 'theme=dark&mode=chat' },
  { name: 'preferences-light', query: 'theme=light&mode=server&panel=about' },
  { name: 'preferences-dark', query: 'theme=dark&mode=server&panel=about' },
  { name: 'models-light', query: 'theme=light&mode=models' },
  { name: 'models-dark', query: 'theme=dark&mode=models' },
]

function parseArgs(argv) {
  const args = { build: true, scale: 2 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--out') args.out = next()
    else if (a === '--shots') args.shots = JSON.parse(next())
    else if (a === '--shots-file') args.shots = JSON.parse(readFileSync(next(), 'utf8'))
    else if (a === '--only') args.only = next().split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--url') args.url = next()
    else if (a === '--no-build') args.build = false
    else if (a === '--scale') args.scale = Number(next())
    else if (a === '-h' || a === '--help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0) }
    else throw new Error(`Unknown argument: ${a}`)
  }
  return args
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    join(panel, 'node_modules/playwright-core/index.mjs'),
    join(panel, 'node_modules/playwright/index.mjs'),
    '/opt/node-tools/node_modules/playwright-core/index.mjs',
  ].filter(Boolean)
  for (const path of candidates) {
    if (existsSync(path)) return import(pathToFileURL(path).href)
  }
  throw new Error('playwright-core not found. Set PLAYWRIGHT_CORE to its index.mjs.')
}

function chromiumExecutables() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean)
  const found = []
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

async function launch(chromium) {
  try {
    return await chromium.launch()
  } catch (error) {
    for (const executablePath of chromiumExecutables()) {
      try { return await chromium.launch({ executablePath }) } catch { /* try the next */ }
    }
    throw error
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
}

function serveDist() {
  if (!existsSync(join(distDir, 'index.html'))) throw new Error('preview/dist is missing: run without --no-build')
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = normalize(join(distDir, pathname))
    if (!file.startsWith(distDir)) { res.writeHead(403).end(); return }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  })
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` })))
}

async function runActions(page, actions = []) {
  for (const step of actions) {
    if (step.click) await page.click(step.click)
    else if (step.hover) await page.hover(step.hover)
    else if (step.fill) await page.fill(step.fill[0], step.fill[1])
    else if (step.type) await page.locator(step.type[0]).pressSequentially(step.type[1])
    else if (step.press) await page.keyboard.press(step.press)
    else if (step.wait) await page.waitForTimeout(step.wait)
    else if (step.waitFor) await page.waitForSelector(step.waitFor)
    else if (step.eval) await page.evaluate(step.eval)
    else throw new Error(`Unknown action: ${JSON.stringify(step)}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const out = resolve(args.out || process.env.PREVIEW_SHOTS_DIR || DEFAULT_OUT)
  mkdirSync(out, { recursive: true })
  let shots = args.shots || DEFAULT_SHOTS
  if (args.only) shots = shots.filter(s => args.only.includes(s.name))
  if (!shots.length) throw new Error('No shots to take')

  let base = args.url
  let server
  if (!base) {
    if (args.build) {
      console.log('Building the preview…')
      const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--config', 'preview/vite.config.ts', '--logLevel', 'warn'], { cwd: panel, stdio: 'inherit' })
      if (build.status !== 0) process.exit(build.status || 1)
    }
    ;({ server, url: base } = await serveDist())
  }

  const { chromium } = await loadPlaywright()
  const browser = await launch(chromium)
  let problems = 0
  try {
    for (const shot of shots) {
      const query = new URLSearchParams(shot.query || '')
      const theme = query.get('theme')
      const context = await browser.newContext({
        viewport: { width: shot.width || 1280, height: shot.height || 820 },
        deviceScaleFactor: shot.scale || args.scale,
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        reducedMotion: shot.reducedMotion ? 'reduce' : 'no-preference',
        locale: 'en-US',
        timezoneId: 'Asia/Seoul',
      })
      const page = await context.newPage()
      const errors = []
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
        else if (msg.type() === 'warning' && msg.text().startsWith('[preview]')) errors.push(`mock gap: ${msg.text()}`)
      })
      page.on('pageerror', err => errors.push(`page error: ${err.message}`))
      page.on('requestfailed', req => {
        const url = req.url()
        if (!url.startsWith(base)) return // outside requests (fonts, HF) are not the preview's concern
        errors.push(`request failed: ${url} (${req.failure()?.errorText})`)
      })

      const url = new URL(base)
      url.search = query.toString()
      await page.goto(url.toString(), { waitUntil: 'load' })
      await page.waitForSelector('html[data-preview-ready="1"]', { timeout: 15000 })
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(500)
      await runActions(page, shot.actions)
      if (shot.actions?.length) await page.waitForTimeout(500)

      const file = join(out, `${shot.name}.png`)
      await page.screenshot({ path: file, fullPage: !!shot.fullPage })
      const realErrors = errors.filter(e => !e.startsWith('mock gap'))
      problems += realErrors.length
      console.log(`${realErrors.length ? '!' : '✓'} ${file}`)
      for (const e of errors) console.log(`    ${e}`)
      await context.close()
    }
  } finally {
    await browser.close()
    server?.close()
  }
  if (problems) {
    console.error(`\n${problems} page error(s) logged; see above.`)
    process.exit(1)
  }
}

main().catch(error => { console.error(error); process.exit(1) })
