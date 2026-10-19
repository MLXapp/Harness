// The in-app updater's install flow end to end, with Electron and the macOS
// tools (plutil, codesign, spctl, hdiutil, ditto) replaced by stand-ins that
// act on real temporary folders. Checks every outcome lands in the right
// state, falls back where it must, and leaves no DMG, mount or staged copy.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as electron from 'electron'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  sent: [] as any[],
  notifications: [] as any[],
  settings: new Map<string, string>(),
  opened: [] as string[],
  spawned: [] as any[],
  calls: [] as string[],
  quit: 0,
  paths: { exe: '', userData: '' },
  packaged: true,
  focused: false,
  manifest: {} as any,
  dmg: Buffer.alloc(0),
  dmgInfo: {} as Record<string, unknown>,
  ok: { runningSig: true, candidateSig: true, stagedSig: true, spctl: true, attach: true },
  mounts: new Set<string>(),
}))

vi.mock('electron', () => {
  const win = {
    isDestroyed: () => false, isFocused: () => h.focused, isMinimized: () => false,
    restore() {}, show() {}, focus() {},
    webContents: { send: (ch: string, s: unknown) => { if (ch === 'app:updateState') h.sent.push(s) } },
  }
  class Notification {
    static isSupported() { return true }
    constructor(public opts: any) { h.notifications.push(opts) }
    on() { return this }
    show() {}
  }
  return {
    app: {
      getPath: (k: 'exe' | 'userData') => h.paths[k],
      get isPackaged() { return h.packaged },
      quit: () => { h.quit++ },
      emit: () => {},
    },
    BrowserWindow: { getAllWindows: () => [win] },
    Menu: { buildFromTemplate: (x: unknown) => x, setApplicationMenu: () => {} },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    ipcMain: { handle: (ch: string, fn: any) => h.handlers.set(ch, fn) },
    net: {
      fetch: async (url: string) => url.endsWith('latest.json')
        ? new Response(JSON.stringify(h.manifest))
        : new Response(h.dmg, { headers: { 'content-length': String(h.dmg.length) } }),
    },
    Notification,
    shell: { openExternal: async (u: string) => { h.opened.push(u) } },
    __win: win,
  }
})

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    h.calls.push(`${cmd.split('/').pop()} ${args[0]}`)
    const done = (ok: boolean, out = '') => setTimeout(() => cb(ok ? null : new Error('failed'), ok ? out : '', ok ? '' : out || 'failed'), 1)
    const target = args[args.length - 1]
    switch (cmd) {
      case '/usr/bin/plutil': return existsSync(target) ? done(true, readFileSync(target, 'utf8')) : done(false)
      case '/usr/bin/codesign': {
        if (target.includes('mlx-studio-update-')) return done(h.ok.candidateSig, 'codesign says no')
        if (target.endsWith('.update.app')) return done(h.ok.stagedSig)
        return done(h.ok.runningSig)
      }
      case '/usr/sbin/spctl':
        return h.ok.spctl ? done(true, `${target}: accepted\nsource=Notarized Developer ID`) : done(false, `${target}: rejected`)
      case '/usr/bin/hdiutil': {
        if (args[0] === 'attach') {
          if (!h.ok.attach) return done(false, 'hdiutil: attach failed')
          const mp = args[args.indexOf('-mountpoint') + 1]
          const app = join(mp, 'MLX Studio.app', 'Contents')
          mkdirSync(app, { recursive: true })
          writeFileSync(join(app, 'Info.plist'), JSON.stringify(h.dmgInfo))
          h.mounts.add(mp)
          return done(true)
        }
        const mp = args[1]
        for (const n of readdirSync(mp)) rmSync(join(mp, n), { recursive: true, force: true })
        h.mounts.delete(mp)
        return done(true)
      }
      case '/usr/bin/ditto': cpSync(args[0], args[1], { recursive: true }); return done(true)
    }
    return done(false)
  },
  spawn: (file: string, args: string[], opts: unknown) => { h.spawned.push({ file, args, opts }); return { unref() {} } },
}))

vi.mock('../src/main/database', () => ({
  db: { getSetting: (k: string) => h.settings.get(k), setSetting: (k: string, v: string) => { h.settings.set(k, v) } },
}))

const realPlatform = process.platform
let root = ''
let appPath = ''

function makeApp(path: string, info: Record<string, unknown>) {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(path, 'Contents', 'Info.plist'), JSON.stringify(info))
}

async function freshUpdater() {
  vi.resetModules()
  h.handlers.clear()
  const mod = await import('../src/main/app-updater')
  mod.startAppUpdater({ getWindow: () => (electron as any).__win, currentVersion: '0.1.0', autoCheck: false })
  return mod
}

const state = () => h.sent[h.sent.length - 1]
const updatesDir = () => join(h.paths.userData, 'updates')
const leftovers = () => ({
  dmgs: existsSync(updatesDir()) ? readdirSync(updatesDir()).filter(n => /\.(dmg|part)$/.test(n)) : [],
  mounts: [...h.mounts],
  staged: existsSync(join(root, 'Applications', '.MLX Studio.update.app')),
})

beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'darwin' }) })
afterAll(() => { Object.defineProperty(process, 'platform', { value: realPlatform }) })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-updater-'))
  appPath = join(root, 'Applications', 'MLX Studio.app')
  makeApp(appPath, { CFBundleIdentifier: 'app.mlx.studio', CFBundleShortVersionString: '0.1.0' })
  h.paths = { exe: join(appPath, 'Contents', 'MacOS', 'MLX Studio'), userData: join(root, 'userData') }
  h.dmg = Buffer.from('pretend this is a disk image')
  h.dmgInfo = { CFBundleIdentifier: 'app.mlx.studio', CFBundleShortVersionString: '0.2.0' }
  h.manifest = {
    version: '0.2.0',
    url: 'https://github.com/MLXapp/studio/releases/download/v0.2.0/MLX-Studio-0.2.0-arm64.dmg',
    sha256: createHash('sha256').update(h.dmg).digest('hex'),
    size: h.dmg.length,
    notes: 'Faster model loading.',
  }
  h.ok = { runningSig: true, candidateSig: true, stagedSig: true, spctl: true, attach: true }
  h.sent.length = 0; h.notifications.length = 0; h.opened.length = 0; h.spawned.length = 0; h.calls.length = 0
  h.settings.clear(); h.mounts.clear(); h.quit = 0; h.packaged = true; h.focused = false
})

describe('in-app updater flow', () => {
  it('announces, downloads with progress, verifies, stages, and swaps on restart', async () => {
    const mod = await freshUpdater()
    expect(await mod.checkNow()).toEqual({ kind: 'available', version: '0.2.0' })
    expect(state()).toMatchObject({ phase: 'available', version: '0.2.0', blocked: null, notes: 'Faster model loading.' })
    expect(await h.handlers.get('app:updateState')!()).toMatchObject({ phase: 'available' })

    await h.handlers.get('app:updateInstall')!()
    const phases = h.sent.map(s => s.phase)
    expect(phases).toContain('downloading')
    expect(phases.indexOf('verifying')).toBeGreaterThan(phases.indexOf('downloading'))
    expect(state()).toMatchObject({ phase: 'ready', version: '0.2.0' })
    const lastProgress = h.sent.filter(s => s.phase === 'downloading').at(-1)
    expect(lastProgress).toMatchObject({ received: h.dmg.length, total: h.dmg.length })
    // order of checks: own app, mount, signature, Gatekeeper, copy, the copy's signature, detach
    expect(h.calls.filter(c => !c.startsWith('plutil')).map(c => c.replace(/^ditto .*/, 'ditto'))).toEqual([
      'codesign --verify', 'hdiutil attach', 'codesign --verify', 'spctl -a', 'ditto', 'codesign --verify', 'hdiutil detach',
    ])
    expect(leftovers()).toEqual({ dmgs: [], mounts: [], staged: true })

    await h.handlers.get('app:updateRestart')!()
    expect(h.quit).toBe(1)
    mod.runPendingUpdateSwap()
    expect(h.spawned).toHaveLength(1)
    const { file, args, opts } = h.spawned[0]
    expect(file).toBe('/bin/sh')
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(args.slice(3)).toEqual([
      String(process.pid), appPath, join(root, 'Applications', '.MLX Studio.update.app'),
      join(root, 'Applications', `.MLX Studio.old-${process.pid}.app`), '1', '/usr/bin/open', '/usr/bin/xattr',
      join(updatesDir(), 'swap.log'),
    ])
  })

  it('installs on a plain quit without relaunching, and a cancelled restart does not relaunch later', async () => {
    const mod = await freshUpdater()
    await mod.checkNow()
    await h.handlers.get('app:updateInstall')!()
    await h.handlers.get('app:updateRestart')!()
    mod.cancelUpdateRelaunch()
    mod.runPendingUpdateSwap()
    expect(h.spawned[0].args[7]).toBe('0')
    mod.runPendingUpdateSwap() // only once
    expect(h.spawned).toHaveLength(1)
  })

  it.each([
    ['checksum', () => { h.manifest.sha256 = 'f'.repeat(64) }],
    ['size', () => { h.manifest.size = h.dmg.length + 1 }],
    ['mount', () => { h.ok.attach = false }],
    ['notOurs', () => { h.dmgInfo = { CFBundleIdentifier: 'com.example.other', CFBundleShortVersionString: '9.0.0' } }],
    ['notNewer', () => { h.dmgInfo = { CFBundleIdentifier: 'app.mlx.studio', CFBundleShortVersionString: '0.1.0' } }],
    ['signature', () => { h.ok.candidateSig = false }],
    ['notarization', () => { h.ok.spctl = false }],
    ['signature', () => { h.ok.stagedSig = false }],
    ['currentApp', () => { h.ok.runningSig = false }],
  ] as const)('stops at %s, cleans up, and offers the manual download', async (code, arrange) => {
    arrange()
    const mod = await freshUpdater()
    await mod.checkNow()
    await h.handlers.get('app:updateInstall')!()
    expect(state()).toMatchObject({ phase: 'error', error: code, version: '0.2.0' })
    expect(leftovers()).toEqual({ dmgs: [], mounts: [], staged: false })
    if (['checksum', 'size', 'currentApp'].includes(code)) expect(h.calls.some(c => c.startsWith('hdiutil attach'))).toBe(false)
    mod.runPendingUpdateSwap()
    expect(h.spawned).toHaveLength(0) // nothing unverified is ever swapped in
    await h.handlers.get('app:updateOpenDownload')!()
    expect(h.opened).toEqual(['https://github.com/MLXapp/studio/releases/latest'])
    expect(readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')).toContain('0.1.0') // running app untouched
  })

  it('falls back to the DMG when running from a disk image', async () => {
    // isOnMountedImage looks at the absolute path
    h.paths.exe = '/Volumes/MLX Studio/MLX Studio.app/Contents/MacOS/MLX Studio'
    const mod = await freshUpdater()
    await mod.checkNow()
    expect(state()).toMatchObject({ phase: 'available', blocked: 'mountedDmg' })
    await h.handlers.get('app:updateInstall')!()
    expect(h.opened).toEqual([h.manifest.url])
    expect(h.calls).toEqual([])
  })

  it('development builds only report', async () => {
    h.packaged = false
    const mod = await freshUpdater()
    await mod.checkNow()
    expect(state()).toMatchObject({ phase: 'available', blocked: 'development' })
    await h.handlers.get('app:updateInstall')!()
    expect(h.calls).toEqual([])
    expect(h.opened).toEqual([h.manifest.url])
  })

  it('a manifest without a checksum is never installed in place', async () => {
    delete h.manifest.sha256
    const mod = await freshUpdater()
    await mod.checkNow()
    expect(state()).toMatchObject({ phase: 'available', blocked: 'noChecksum' })
  })

  it('stays quiet when up to date', async () => {
    h.manifest.version = '0.1.0'
    const mod = await freshUpdater()
    expect(await mod.checkNow()).toEqual({ kind: 'current' })
    expect(h.sent).toEqual([])
  })

  it('notifies once per version, only while no window has focus', async () => {
    h.focused = true
    let mod = await freshUpdater()
    await mod.checkNow()
    expect(h.notifications).toHaveLength(0)
    h.focused = false
    mod = await freshUpdater()
    await mod.checkNow()
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]).toMatchObject({ title: 'MLX Studio 0.2.0 is available', body: 'Faster model loading.' })
    expect(h.settings.get('studio_update_notified_version')).toBe('0.2.0')
    mod = await freshUpdater() // next launch
    await mod.checkNow()
    expect(h.notifications).toHaveLength(1)
    h.manifest.version = '0.3.0'
    await mod.checkNow()
    expect(h.notifications).toHaveLength(2)
  })

  it('Later hides this version for this launch; a newer version shows again', async () => {
    const mod = await freshUpdater()
    await mod.checkNow()
    await h.handlers.get('app:updateLater')!()
    expect(state()).toMatchObject({ phase: 'available', dismissed: true })
    await mod.checkNow()
    expect(state()).toMatchObject({ phase: 'available', version: '0.2.0', dismissed: true })
    h.manifest.version = '0.3.0'
    await mod.checkNow()
    expect(state()).toMatchObject({ phase: 'available', version: '0.3.0', dismissed: false })
  })

  it('removes leftovers of earlier attempts (all ours) before checking', async () => {
    mkdirSync(join(root, 'Applications', '.MLX Studio.update.app'))
    mkdirSync(join(root, 'Applications', '.MLX Studio.old-123.app'))
    mkdirSync(join(root, 'Applications', 'Other.app'))
    mkdirSync(updatesDir(), { recursive: true })
    writeFileSync(join(updatesDir(), 'MLX-Studio-0.2.0.dmg.part'), 'x')
    writeFileSync(join(updatesDir(), 'swap.log'), 'kept')
    const mod = await freshUpdater()
    h.manifest.version = '0.1.0'
    await mod.checkNow()
    expect(readdirSync(join(root, 'Applications')).sort()).toEqual(['MLX Studio.app', 'Other.app'])
    expect(readdirSync(updatesDir())).toEqual(['swap.log'])
  })
})
