/**
 * Launch self-test of the packaged app (CI runs it on every DMG build):
 *   "MLX Harness.app/Contents/MacOS/MLX Harness" --mlx-self-test=/tmp/result.json
 *
 * The app starts as usual (database, IPC, main window), skips anything that
 * would wait for a person (first-run offers, update checks), then checks the
 * features that only run inside Electron: the window renders and its preload
 * API answers over IPC, memory and scheduled-task stores, the agent browser
 * (own session, isolated-world scripts, refs, clicks, local-address blocking)
 * and the MLX Node yield watcher. It writes a JSON report and exits 0 (all
 * passed), 1 (a check failed) or 2 (timed out). Nothing is left behind: the
 * memory entry it writes is deleted again.
 */

import { app, BrowserWindow } from 'electron'
import { createServer, type Server } from 'http'
import { writeFileSync } from 'fs'
import type { AddressInfo } from 'net'

export function selfTestOutput(argv = process.argv): string | null {
  for (const a of argv) if (a.startsWith('--mlx-self-test=')) return a.slice('--mlx-self-test='.length) || null
  return argv.includes('--mlx-self-test') ? '/tmp/mlx-harness-self-test.json' : null
}

type Check = { name: string; ok: boolean; detail?: string; ms: number }

const PAGE = `<!doctype html><title>Self test</title>
<h1>Self test page</h1>
<button id="b" onclick="this.textContent='Clicked once'">Press me</button>
<script>window.__mlxRefMap = 'the page tried to take this name';</script>`

function serve(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }))
  })
}

export async function runSelfTest(out: string, getWindow: () => BrowserWindow | null, rendererErrors: string[]): Promise<never> {
  const checks: Check[] = []
  const started = Date.now()
  const check = async (name: string, fn: () => Promise<string | void> | string | void) => {
    const t = Date.now()
    try {
      const detail = await fn()
      checks.push({ name, ok: true, ...(detail ? { detail } : {}), ms: Date.now() - t })
    } catch (e: any) {
      checks.push({ name, ok: false, detail: String(e?.stack ?? e?.message ?? e).slice(0, 800), ms: Date.now() - t })
    }
  }
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg) }
  const finish = (code: number) => {
    const report = { ok: code === 0, code, version: app.getVersion(), electron: process.versions.electron, ms: Date.now() - started, checks, rendererErrors }
    try { writeFileSync(out, JSON.stringify(report, null, 2)) } catch (e) { console.error('[SELFTEST] could not write', out, e) }
    console.log(`[SELFTEST] ${code === 0 ? 'passed' : 'FAILED'}: ${checks.filter(c => c.ok).length}/${checks.length} checks`)
    for (const c of checks) console.log(`[SELFTEST] ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail.split('\n')[0]}` : ''}`)
    app.exit(code)
  }
  const deadline = setTimeout(() => {
    checks.push({ name: 'finished within 150 s', ok: false, ms: Date.now() - started })
    finish(2)
  }, 150_000)

  await check('window rendered the app', async () => {
    const win = getWindow()
    assert(win && !win.isDestroyed(), 'no main window')
    const info = await win!.webContents.executeJavaScript(
      `({ nodes: document.getElementById('root')?.querySelectorAll('*').length ?? 0, title: document.title, text: (document.body?.innerText || '').slice(0, 200) })`,
    )
    assert(info.nodes > 8 && info.text.trim().length > 0, `the app did not render (${info.nodes} elements): ${JSON.stringify(info.text)}`)
    return `${info.nodes} elements: ${JSON.stringify(info.text.slice(0, 80))}`
  })

  await check('preload API answers over IPC (tasks, memory, apps)', async () => {
    const r = await getWindow()!.webContents.executeJavaScript(`(async () => {
      const api = window.api
      const out = {}
      out.tasks = Array.isArray(await api.tasks.list())
      out.memory = Array.isArray(await api.memory.list())
      out.memoryEnabled = typeof (await api.memory.enabled()) === 'boolean'
      out.apps = typeof (await api.apps.status()) === 'object'
      out.steer = typeof api.chat.steer === 'function'
      return out
    })()`)
    for (const [k, v] of Object.entries(r)) assert(v === true, `${k} did not answer`)
  })

  await check('memory store: save, search, forget', async () => {
    const { db } = await import('./database')
    const store = db.memory
    const text = `MLX Harness self-test note ${Date.now()}`
    const { entry } = store.add(text)
    try {
      assert(store.search('self-test note').some(e => e.id === entry.id), 'search did not find the new note')
    } finally {
      store.delete(entry.id)
    }
    assert(!store.get(entry.id), 'the note was not deleted')
  })

  await check('scheduled tasks store and scheduler load', async () => {
    const { taskScheduler } = await import('./ipc/tasks')
    const s = taskScheduler()
    assert(s, 'no scheduler')
  })

  const { server, url } = await serve()
  try {
    const { AgentBrowser } = await import('./browser/agentBrowser')
    const { createElectronDriver, isAgentBrowserWindow, appWindows, resolvesPrivate } = await import('./browser/electronDriver')

    await check('agent browser: open, read, click (isolated world)', async () => {
      const ab = new AgentBrowser(createElectronDriver(undefined, { allowLocal: true }), { allowLocal: true, settleMs: 4000 })
      try {
        const opened = await ab.open(url)
        assert(!opened.isError, opened.text.slice(0, 300))
        assert(opened.text.includes('Self test page'), `page text missing: ${opened.text.slice(0, 300)}`)
        const ref = /\[button (e\d+)\] Press me/.exec(opened.text)?.[1]
        assert(ref, `no button ref in: ${opened.text.slice(0, 300)}`)
        const clicked = await ab.click(ref!)
        assert(!clicked.isError && clicked.text.includes('Clicked once'), `click did not land: ${clicked.text.slice(0, 300)}`)
        const shot = await ab.screenshot()
        assert(!shot.isError && shot.imageDataUrl?.startsWith('data:image/'), 'no screenshot')
        const w = BrowserWindow.getAllWindows().find(x => isAgentBrowserWindow(x))
        assert(w, 'the agent window is not tagged')
        assert(!appWindows().includes(w!), 'the agent window counts as an app window')
      } finally {
        await ab.close()
      }
    })

    await check('agent browser: refuses this Mac and the local network', async () => {
      const ab = new AgentBrowser(createElectronDriver(undefined, { allowLocal: false }), { allowLocal: false })
      try {
        for (const u of [url, 'http://localhost:8080/', 'http://[::7f00:1]/', 'http://169.254.169.254/']) {
          const r = await ab.open(u)
          assert(r.isError, `${u} was not refused`)
        }
      } finally {
        await ab.close()
      }
    })

    await check('agent browser: names that resolve to private addresses', async () => {
      // localtest.me resolves to 127.0.0.1 (public DNS). Offline runners skip.
      const { lookup } = await import('dns/promises')
      try { await lookup('localtest.me') } catch { return 'DNS unavailable, skipped' }
      assert(await resolvesPrivate('localtest.me'), 'localtest.me was not seen as private')
      assert(!(await resolvesPrivate('example.com')), 'example.com was seen as private')
      return undefined
    })
  } finally {
    server.close()
  }

  await check('MLX Node yield watcher runs', async () => {
    const { evaluateYield } = await import('./mlxNodeYield')
    await evaluateYield()
  })

  await check('no uncaught errors in the window', () => {
    const fatal = rendererErrors.filter(e => /Uncaught|is not a function|Cannot read propert|is not defined|crashed|preload/i.test(e))
    assert(fatal.length === 0, fatal.slice(0, 3).join(' | '))
    return rendererErrors.length ? `${rendererErrors.length} console error line(s), none fatal` : undefined
  })

  clearTimeout(deadline)
  finish(checks.every(c => c.ok) ? 0 : 1)
  return new Promise<never>(() => {})
}
