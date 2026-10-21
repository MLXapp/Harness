// A Mac updating from 0.1.x (legacy app name "MLX Studio") must keep its
// userData folder (chats.db, settings, local storage) and its Keychain item
// ("MLX Studio Safe Storage", which encrypts every saved API key).
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ appData: '' }))
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const app = Object.assign(new Emitter(), {
    name: 'MLX Harness',
    paths: {} as Record<string, string>,
    getPath: (name: string) => (name === 'appData' ? fake.appData : app.paths[name]),
    setPath: (name: string, value: string) => { app.paths[name] = value },
  })
  return { app }
})

import { APP_DISPLAY_NAME, LEGACY_APP_NAME, resolveAppIdentity } from '../src/shared/appIdentity'
import { applyAppIdentity, type IdentityApp } from '../src/main/app-identity'

function appData(setup: (dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'app-identity-'))
  setup(dir)
  return dir
}

/** Electron's app as far as identity goes: an emitter with a name and paths. */
function fakeApp(dir: string) {
  const app = Object.assign(new EventEmitter(), {
    name: APP_DISPLAY_NAME, // what Electron's init sets from package.json productName
    paths: {} as Record<string, string>,
    getPath: (name: 'appData') => (name === 'appData' ? dir : ''),
    setPath: (name: 'userData', value: string) => { app.paths[name] = value },
  })
  return app
}

describe('app identity (0.1.x compatibility)', () => {
  it('names the product MLX Harness and remembers the 0.1.x name', () => {
    expect(APP_DISPLAY_NAME).toBe('MLX Harness')
    expect(LEGACY_APP_NAME).toBe('MLX Studio')
  })

  it('keeps the 0.1.x userData folder and Keychain item on a Mac that has them', () => {
    const dir = appData(d => { mkdirSync(join(d, 'MLX Studio')); writeFileSync(join(d, 'MLX Studio', 'chats.db'), '') })
    expect(resolveAppIdentity({ appDataDir: dir, exists: existsSync }))
      .toEqual({ userDataDir: join(dir, 'MLX Studio'), keychainName: 'MLX Studio', legacy: true })
  })

  it('treats any 0.1.x folder as legacy, even without a database', () => {
    const exists = (p: string) => p === '/A/MLX Studio'
    expect(resolveAppIdentity({ appDataDir: '/A', exists })).toEqual({ userDataDir: '/A/MLX Studio', keychainName: 'MLX Studio', legacy: true })
  })

  it('uses the new name on a fresh Mac', () => {
    expect(resolveAppIdentity({ appDataDir: '/A', exists: () => false }))
      .toEqual({ userDataDir: '/A/MLX Harness', keychainName: 'MLX Harness', legacy: false })
  })

  it('stays on the new folder once it holds a database, even if an old copy later creates the 0.1.x folder', () => {
    const exists = (p: string) => p === '/A/MLX Harness/chats.db' || p === '/A/MLX Studio'
    expect(resolveAppIdentity({ appDataDir: '/A', exists })).toMatchObject({ userDataDir: '/A/MLX Harness', legacy: false })
  })

  it('does not switch to an empty new folder that something created early', () => {
    const exists = (p: string) => p === '/A/MLX Harness' || p === '/A/MLX Studio'
    expect(resolveAppIdentity({ appDataDir: '/A', exists })).toMatchObject({ userDataDir: '/A/MLX Studio', legacy: true })
  })

  it('legacy: holds the old name while Electron names the Keychain item, then shows MLX Harness from will-finish-launching on', () => {
    const dir = appData(d => mkdirSync(join(d, 'MLX Studio')))
    const app = fakeApp(dir)
    // Electron's init registers the default menu on will-finish-launching before our code runs.
    const seenByDefaultMenu: string[] = []
    app.once('will-finish-launching', () => seenByDefaultMenu.push(app.name))
    const identity = applyAppIdentity(app as unknown as IdentityApp, existsSync)
    expect(identity.legacy).toBe(true)
    expect(app.paths.userData).toBe(join(dir, 'MLX Studio'))
    // PostCreateMainMessageLoop runs here: "<app.name> Safe Storage".
    expect(`${app.name} Safe Storage`).toBe('MLX Studio Safe Storage')
    app.emit('will-finish-launching')
    expect(app.name).toBe('MLX Harness')
    expect(seenByDefaultMenu).toEqual(['MLX Harness']) // our listener ran first
    app.emit('ready')
    expect(app.name).toBe('MLX Harness')
  })

  it('fresh install: MLX Harness for the folder, the Keychain item and everything visible', () => {
    const dir = appData()
    const app = fakeApp(dir)
    applyAppIdentity(app as unknown as IdentityApp, existsSync)
    expect(app.paths.userData).toBe(join(dir, 'MLX Harness'))
    expect(`${app.name} Safe Storage`).toBe('MLX Harness Safe Storage')
    expect(app.listenerCount('will-finish-launching')).toBe(0)
  })

  it('applies itself on import against Electron', async () => {
    fake.appData = appData(d => mkdirSync(join(d, 'MLX Studio')))
    vi.resetModules()
    const mod = await import('../src/main/app-identity')
    const { app } = (await import('electron')) as unknown as { app: EventEmitter & { name: string; paths: Record<string, string> } }
    expect(mod.appIdentity.legacy).toBe(true)
    expect(app.paths.userData).toBe(join(fake.appData, 'MLX Studio'))
    expect(app.name).toBe('MLX Studio')
    app.emit('will-finish-launching')
    expect(app.name).toBe('MLX Harness')
  })

  it('runs first in the main process: before the userData override, the database and the single-instance lock', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const firstImport = main.indexOf('import ')
    expect(main.indexOf("import './app-identity'")).toBe(firstImport)
    expect(main.indexOf("import './app-identity'")).toBeLessThan(main.indexOf("import './user-data-dir'"))
    expect(main.indexOf("import './app-identity'")).toBeLessThan(main.indexOf("from './database'"))
    expect(main.indexOf("import './app-identity'")).toBeLessThan(main.indexOf('app.requestSingleInstanceLock()'))
  })
})

describe('packaging under the new name (0.2.0)', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8'))
  const ci = readFileSync(resolve(process.cwd(), '../.github/workflows/harness.yml'), 'utf8')

  it('ships "MLX Harness.app" (CFBundleName/DisplayName come from productName) with the same bundle id', () => {
    expect(pkg.productName).toBe('MLX Harness')
    expect(pkg.build.productName).toBe('MLX Harness')
    expect(pkg.build.appId).toBe('app.mlx.studio')
    expect(pkg.build.mac.notarize.teamId).toBe('CCKXS9W488')
    expect(pkg.build.mac.extendInfo?.CFBundleName).toBeUndefined()
    expect(pkg.build.dmg.contents[0].name).toBe('MLX Harness.app')
    expect(pkg.build.dmg.title).toBe('MLX Harness ${version}')
    expect(pkg.build.artifactName).toBe('MLX-Harness-${version}-${arch}.${ext}')
    expect(pkg.description).toContain('Built on vMLX by JANGQ AI')
    expect(JSON.stringify(pkg.build)).not.toContain('MLX Studio')
  })

  it('is 0.2.0 or later, the same in package.json and the lock file', () => {
    const [major, minor] = String(pkg.version).split('.').map(Number)
    expect(major > 0 || minor >= 2).toBe(true)
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
  })

  it('publishes MLX-Harness DMGs under MLXapp/harness releases, a URL every installed copy accepts', async () => {
    expect(ci).toMatch(/^name: MLX Harness$/m)
    expect(ci).toContain('dist/MLX-Harness-*.dmg')
    expect(ci).toContain('--title "MLX Harness $VERSION"')
    expect(ci).toContain('URL="https://github.com/$REPO/releases/download/$TAG/$DMG"')
    expect(ci).toContain('./scripts/build-harness-dmg.sh')
    expect(ci).not.toMatch(/studio/i)
    // 0.1.x and 0.2.0 check the host only (github.com or *.mlx.app), never the path.
    const { isValidUpdateUrl } = await import('../src/main/update-manifest')
    expect(isValidUpdateUrl('https://github.com/MLXapp/harness/releases/download/v0.2.1/MLX-Harness-0.2.1-arm64.dmg')).toBe(true)
  })
})
