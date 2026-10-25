import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  INSTALLER_OPT_OUT_ARG,
  INSTALLER_OPT_OUT_ENV,
  RELAUNCH_SCRIPT,
  bytesNeeded,
  checkCopy,
  diskImageMountPoints,
  ejectTarget,
  installBackupPath,
  installProgress,
  installStagingPath,
  installerLocale,
  installerSource,
  isInstallerAction,
  isInstallerCopy,
  knownInstallPaths,
  parseRunningCopies,
  planInstall,
  relaunchCommand,
  translocationOrigin,
  volumeRoot,
  type FoundCopy,
  type InstallerFacts,
  type InstallerLaunchFacts,
} from '../src/shared/appInstall'
import { HARNESS_APP_NAME, HARNESS_BUNDLE_ID } from '../src/shared/appUpdate'
import { installerPage } from '../src/main/app-installer-page'

const DMG_APP = '/Volumes/MLX Harness 0.5.5/MLX Harness.app'
const TRANSLOCATED = '/private/var/folders/xy/abc123/T/AppTranslocation/0A1B2C3D-4E5F-6789-ABCD-EF0123456789/d/MLX Harness.app'
const HOME_APPS = '/Users/a/Applications'

describe('is this launch the installer?', () => {
  const base: InstallerLaunchFacts = {
    platform: 'darwin', packaged: true, appPath: DMG_APP, argv: ['/x/MLX Harness'], env: {}, selfTest: false, secondaryInstance: false,
  }
  it('runs from a disk image or a translocated copy', () => {
    expect(installerSource(base)).toBe('dmg')
    expect(installerSource({ ...base, appPath: TRANSLOCATED })).toBe('translocated')
  })
  it('never for an installed copy, including an Applications folder on another disk', () => {
    expect(installerSource({ ...base, appPath: '/Applications/MLX Harness.app' })).toBeNull()
    expect(installerSource({ ...base, appPath: `${HOME_APPS}/MLX Harness.app` })).toBeNull()
    expect(installerSource({ ...base, appPath: '/Volumes/Data/Applications/MLX Harness.app' })).toBeNull()
    expect(installerSource({ ...base, appPath: '/Volumes/Data/Users/a/Applications/MLX Harness.app' })).toBeNull()
  })
  it('never in development, off macOS, in the self-test, for proof instances or with the opt-out', () => {
    expect(installerSource({ ...base, packaged: false })).toBeNull()
    expect(installerSource({ ...base, platform: 'linux' })).toBeNull()
    expect(installerSource({ ...base, appPath: null })).toBeNull()
    expect(installerSource({ ...base, selfTest: true })).toBeNull()
    expect(installerSource({ ...base, secondaryInstance: true })).toBeNull()
    expect(installerSource({ ...base, argv: ['/x', INSTALLER_OPT_OUT_ARG] })).toBeNull()
    expect(installerSource({ ...base, env: { [INSTALLER_OPT_OUT_ENV]: '1' } })).toBeNull()
  })
})

describe('the disk image to eject', () => {
  const HDIUTIL = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>images</key><array>
    <dict><key>image-path</key><string>/Users/a/Downloads/MLX-Harness-0.5.5-arm64.dmg</string>
      <key>system-entities</key><array>
        <dict><key>content-hint</key><string>GUID_partition_scheme</string><key>dev-entry</key><string>/dev/disk4</string></dict>
        <dict><key>content-hint</key><string>Apple_APFS</string><key>dev-entry</key><string>/dev/disk4s1</string></dict>
        <dict><key>dev-entry</key><string>/dev/disk5s1</string><key>mount-point</key><string>/Volumes/MLX Harness 0.5.5</string></dict>
      </array></dict>
    <dict><key>system-entities</key><array><dict><key>mount-point</key><string>/Volumes/Tom &amp; Jerry</string></dict></array></dict>
  </array></dict></plist>`

  it('reads mount points from hdiutil info -plist', () => {
    expect(diskImageMountPoints(HDIUTIL)).toEqual(['/Volumes/MLX Harness 0.5.5', '/Volumes/Tom & Jerry'])
    expect(diskImageMountPoints('')).toEqual([])
  })
  it('finds the volume root', () => {
    expect(volumeRoot(DMG_APP)).toBe('/Volumes/MLX Harness 0.5.5')
    expect(volumeRoot('/Volumes/X')).toBe('/Volumes/X')
    expect(volumeRoot('/Applications/MLX Harness.app')).toBeNull()
  })
  it('finds where a translocated copy came from', () => {
    const mount = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk5s1 on /Volumes/MLX Harness 0.5.5 (apfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by a)',
      '/Volumes/MLX Harness 0.5.5 on /private/var/folders/xy/abc123/T/AppTranslocation/0A1B2C3D-4E5F-6789-ABCD-EF0123456789 (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by a)',
    ].join('\n')
    expect(translocationOrigin(mount, TRANSLOCATED)).toBe('/Volumes/MLX Harness 0.5.5')
    // mount may print the folder without /private
    expect(translocationOrigin(mount.replace(' on /private/var/', ' on /var/'), TRANSLOCATED)).toBe('/Volumes/MLX Harness 0.5.5')
    expect(translocationOrigin(mount, DMG_APP)).toBeNull()
    expect(translocationOrigin('', TRANSLOCATED)).toBeNull()
  })
  it('ejects only an attached disk image', () => {
    const imageMounts = ['/Volumes/MLX Harness 0.5.5']
    expect(ejectTarget({ source: 'dmg', appPath: DMG_APP, origin: null, imageMounts })).toBe('/Volumes/MLX Harness 0.5.5')
    expect(ejectTarget({ source: 'translocated', appPath: TRANSLOCATED, origin: '/Volumes/MLX Harness 0.5.5', imageMounts })).toBe('/Volumes/MLX Harness 0.5.5')
    // Translocated from Downloads (an unzipped copy), or a drive that isn't an image: nothing to eject.
    expect(ejectTarget({ source: 'translocated', appPath: TRANSLOCATED, origin: '/Users/a/Downloads', imageMounts })).toBeNull()
    expect(ejectTarget({ source: 'translocated', appPath: TRANSLOCATED, origin: null, imageMounts })).toBeNull()
    expect(ejectTarget({ source: 'dmg', appPath: '/Volumes/SSD/Apps/MLX Harness.app', origin: null, imageMounts })).toBeNull()
  })
})

describe('running copies', () => {
  const PS = [
    '    1 /sbin/launchd',
    '  501 /Applications/MLX Harness.app/Contents/MacOS/MLX Harness',
    '  502 /Applications/MLX Harness.app/Contents/Frameworks/MLX Harness Helper (Renderer).app/Contents/MacOS/MLX Harness Helper (Renderer)',
    '  503 /Applications/MLX Harness.app/Contents/Resources/bundled-python/python/bin/python3',
    '  600 /Volumes/MLX Harness 0.5.5/MLX Harness.app/Contents/MacOS/MLX Harness',
    '  700 /Users/a/Applications/MLX Studio.app/Contents/MacOS/MLX Studio',
    '  701 /Applications/Other.app/Contents/Resources/MLX Harness.app/Contents/MacOS/MLX Harness',
    '  800 /Applications/MLX Node.app/Contents/MacOS/MLX',
    'garbage',
  ].join('\n')
  it('lists main processes only, never this one, helpers, engines or nested copies', () => {
    expect(parseRunningCopies(PS, 600)).toEqual([
      { pid: 501, appPath: '/Applications/MLX Harness.app' },
      { pid: 700, appPath: '/Users/a/Applications/MLX Studio.app' },
    ])
    expect(parseRunningCopies(PS, 1).map(r => r.pid)).toEqual([501, 600, 700])
  })
  it('tells installer copies from installed ones', () => {
    expect(isInstallerCopy(DMG_APP)).toBe(true)
    expect(isInstallerCopy(TRANSLOCATED)).toBe(true)
    expect(isInstallerCopy('/Applications/MLX Harness.app')).toBe(false)
  })
})

describe('what Install does (never a downgrade)', () => {
  const SYS = '/Applications/MLX Harness.app'
  const USER = `${HOME_APPS}/MLX Harness.app`
  const copy = (path: string, version: unknown, extra: Partial<FoundCopy> = {}): FoundCopy =>
    ({ path, bundleId: HARNESS_BUNDLE_ID, version, running: false, writable: true, ...extra })
  const facts = (copies: FoundCopy[], extra: Partial<InstallerFacts> = {}): InstallerFacts => ({
    runningVersion: '0.5.5', copies, systemAppsDir: '/Applications', userAppsDir: HOME_APPS,
    systemAppsWritable: true, userAppsWritable: true, ...extra,
  })

  it('looks in both Applications folders under the current and the 0.1.x name', () => {
    expect(knownInstallPaths('/Applications', HOME_APPS)).toEqual([
      SYS, '/Applications/MLX Studio.app', USER, `${HOME_APPS}/MLX Studio.app`,
    ])
  })

  it('installs into /Applications when nothing is there', () => {
    expect(planInstall(facts([]))).toEqual({ action: 'install', dir: '/Applications', dest: SYS, replaces: null, quitFirst: [], trash: [] })
  })

  it('replaces an older copy', () => {
    const old = copy(SYS, '0.5.4')
    expect(planInstall(facts([old]))).toEqual({ action: 'install', dir: '/Applications', dest: SYS, replaces: old, quitFirst: [], trash: [] })
  })

  it('opens the same version instead of reinstalling it', () => {
    expect(planInstall(facts([copy(SYS, '0.5.5')]))).toEqual({ action: 'open', path: SYS, version: '0.5.5', newer: false })
  })

  it('opens a newer copy, wherever it is installed, and never downgrades it', () => {
    expect(planInstall(facts([copy(SYS, '0.5.4'), copy(USER, '0.6.0')]))).toEqual({ action: 'open', path: USER, version: '0.6.0', newer: true })
    expect(planInstall(facts([copy(SYS, '0.5.10')]))).toMatchObject({ action: 'open', newer: true })
    // the newest of several
    expect(planInstall(facts([copy(SYS, '0.5.6'), copy(USER, '0.7.0'), copy('/Applications/MLX Studio.app', '0.6.0')]))).toMatchObject({ action: 'open', path: USER })
  })

  it('treats a copy whose version cannot be read as not older (it is opened, never replaced)', () => {
    expect(planInstall(facts([copy(SYS, undefined)]))).toMatchObject({ action: 'open', path: SYS })
    expect(planInstall(facts([copy(SYS, 'garbage')]))).toMatchObject({ action: 'open', path: SYS })
  })

  it('quits running older copies first (one MLX Harness at a time)', () => {
    const running = copy(SYS, '0.5.4', { running: true })
    const elsewhere = copy('/Volumes/MLX Harness 0.5.3/MLX Harness.app', '0.5.3', { running: true, writable: false })
    const p = planInstall(facts([running, elsewhere]))
    expect(p).toMatchObject({ action: 'install', dest: SYS, replaces: running, quitFirst: [running, elsewhere] })
    // a running copy on a disk image is never moved to the Trash
    expect(p.action === 'install' && p.trash).toEqual([])
  })

  it('moves other older copies in the Applications folders to the Trash', () => {
    const legacy = copy('/Applications/MLX Studio.app', '0.1.9')
    const user = copy(USER, '0.5.0')
    expect(planInstall(facts([legacy, user]))).toMatchObject({ action: 'install', dest: SYS, trash: ['/Applications/MLX Studio.app', USER] })
  })

  it('falls back to ~/Applications when /Applications cannot be written', () => {
    expect(planInstall(facts([], { systemAppsWritable: false }))).toMatchObject({ action: 'install', dir: HOME_APPS, dest: USER })
    // an older copy in /Applications that this user can't move: install for this user instead
    const locked = copy(SYS, '0.5.4', { writable: false })
    expect(planInstall(facts([locked]))).toMatchObject({ action: 'install', dest: USER, trash: [] })
  })

  it('never touches an app that is not MLX Harness', () => {
    const foreign = { path: SYS, bundleId: 'com.example.other', version: '9.9', running: false, writable: true }
    expect(planInstall(facts([foreign]))).toMatchObject({ action: 'install', dest: USER, replaces: null })
    expect(planInstall(facts([foreign], { userAppsWritable: false }))).toEqual({ action: 'blocked', reason: 'occupied' })
    // a newer foreign app is not "a newer MLX Harness"
    expect(planInstall(facts([foreign])).action).toBe('install')
  })

  it('is blocked when neither folder can be written', () => {
    expect(planInstall(facts([], { systemAppsWritable: false, userAppsWritable: false }))).toEqual({ action: 'blocked', reason: 'notWritable' })
  })
})

describe('copy, check, progress', () => {
  it('stages next to the destination (same volume) under names of our own', () => {
    expect(installStagingPath('/Applications/MLX Harness.app')).toBe('/Applications/.MLX Harness.install.app')
    expect(installBackupPath('/Applications/MLX Harness.app', 4242)).toBe('/Applications/.MLX Harness.replaced-4242.app')
    expect(installBackupPath('/Applications/MLX Harness.app', '../x')).toBe('/Applications/.MLX Harness.replaced-x.app')
  })
  it('wants room for the copy and some to spare', () => {
    expect(bytesNeeded(1_000_000_000)).toBe(1_050_000_000 + 256 * 1024 * 1024)
    expect(bytesNeeded(-5)).toBe(256 * 1024 * 1024)
  })
  it('accepts only our bundle at exactly this version', () => {
    expect(checkCopy({ bundleId: HARNESS_BUNDLE_ID, version: '0.5.5', runningVersion: '0.5.5' })).toBeNull()
    expect(checkCopy({ bundleId: 'com.example', version: '0.5.5', runningVersion: '0.5.5' })).toBe('notOurs')
    expect(checkCopy({ bundleId: HARNESS_BUNDLE_ID, version: '0.5.4', runningVersion: '0.5.5' })).toBe('version')
    expect(checkCopy({ bundleId: HARNESS_BUNDLE_ID, version: undefined, runningVersion: '0.5.5' })).toBe('version')
  })
  it('moves one bar forward through the steps, never back', () => {
    const seq: Array<[Parameters<typeof installProgress>[0], number]> = [
      ['quitting', 0], ['quitting', 1], ['copying', 0], ['copying', 0.5], ['copying', 1], ['checking', 0], ['checking', 1], ['finishing', 0], ['finishing', 1], ['opening', 1],
    ]
    const values = seq.map(([s, f]) => installProgress(s, f))
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(1)
    expect(installProgress('copying', Number.NaN)).toBe(installProgress('copying', 0))
    expect(installProgress('copying', 7)).toBe(installProgress('copying', 1))
  })
  it('speaks the language chosen in the app, else the system language', () => {
    const langs = ['en', 'zh', 'ko', 'ja', 'es']
    expect(installerLocale('ko', ['ja-JP'], langs)).toBe('ko')
    expect(installerLocale(undefined, ['zh-Hans-CN', 'en-US'], langs)).toBe('zh')
    expect(installerLocale(null, ['de-DE', 'es-419'], langs)).toBe('es')
    expect(installerLocale('xx', ['de-DE'], langs)).toBe('en')
  })
  it('accepts only known button actions from the page', () => {
    for (const a of ['install', 'open', 'quit', 'retry']) expect(isInstallerAction(a)).toBe(true)
    for (const a of ['delete', '', null, 1]) expect(isInstallerAction(a)).toBe(false)
  })
})

describe('after the installer quits: open the app, eject the image', () => {
  it('passes every path as an argument, never inside the script text', () => {
    const cmd = relaunchCommand({ pid: 77, appPath: '/Applications/MLX Harness.app', volume: '/Volumes/MLX Harness 0.5.5', logPath: '/Users/a/Library/Application Support/MLX Harness/updates/install.log' })
    expect(cmd.file).toBe('/bin/sh')
    expect(cmd.args).toEqual([
      '-c', RELAUNCH_SCRIPT, 'mlx-harness-install', '77', '/Applications/MLX Harness.app', '/Volumes/MLX Harness 0.5.5',
      '/usr/bin/open', '/usr/bin/hdiutil', '/Users/a/Library/Application Support/MLX Harness/updates/install.log',
    ])
    const unquoted = RELAUNCH_SCRIPT.replace(/"[^"]*"/g, '""')
    expect(unquoted.match(/\$[A-Z0-9]/g) ?? []).toEqual([])
    expect(RELAUNCH_SCRIPT).not.toContain('-force')
    expect(spawnSync('/bin/sh', ['-n', '-c', RELAUNCH_SCRIPT]).status).toBe(0)
  })
  it('refuses bad input', () => {
    const ok = { pid: 1, appPath: '/Applications/MLX Harness.app', volume: '/Volumes/X', logPath: '/tmp/l' }
    expect(() => relaunchCommand({ ...ok, pid: 0 })).toThrow()
    expect(() => relaunchCommand({ ...ok, appPath: 'Applications/MLX Harness.app' })).toThrow()
    expect(() => relaunchCommand({ ...ok, appPath: '/Applications/evil' })).toThrow()
    expect(() => relaunchCommand({ ...ok, volume: '/' })).toThrow()
    expect(() => relaunchCommand({ ...ok, volume: '/Volumes/X/sub' })).toThrow()
    expect(() => relaunchCommand({ ...ok, logPath: 'log' })).toThrow()
    expect(relaunchCommand({ ...ok, appPath: null, volume: null }).args.slice(4, 6)).toEqual(['', ''])
  })

  // The script itself, run with /bin/sh on throwaway folders (stand-ins for open and hdiutil).
  function fixture(hdiutilBody: string) {
    const root = mkdtempSync(join(tmpdir(), 'install-test-'))
    const vol = join(root, 'Volumes', 'MLX Harness 0.5.5')
    mkdirSync(vol, { recursive: true })
    const calls = join(root, 'calls.log')
    const fake = (name: string, body: string) => {
      const p = join(root, name)
      writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`)
      chmodSync(p, 0o755)
      return p
    }
    return { root, vol, calls, open: fake('open', 'exit 0'), hdiutil: fake('hdiutil', hdiutilBody), log: join(root, 'install.log') }
  }
  const runScript = (f: ReturnType<typeof fixture>, pid: number, app: string, vol: string) =>
    new Promise<number>((done) => {
      const child = spawn('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'mlx-harness-install', String(pid), app, vol, f.open, f.hdiutil, f.log], { stdio: 'ignore' })
      child.on('exit', code => done(code ?? -1))
    })
  const calls = (f: ReturnType<typeof fixture>) => existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n') : []

  it('waits for the installer to exit, opens the app, then ejects the image', async () => {
    const f = fixture(`rmdir "$2" 2>/dev/null; exit 0`)
    const installer = spawn('sleep', ['0.6'])
    const done = runScript(f, installer.pid!, '/Applications/MLX Harness.app', f.vol)
    await new Promise(r => setTimeout(r, 250))
    expect(calls(f)).toEqual([]) // still waiting
    expect(await done).toBe(0)
    expect(calls(f)).toEqual([`open /Applications/MLX Harness.app`, `hdiutil detach ${f.vol} -quiet`])
    rmSync(f.root, { recursive: true, force: true })
  }, 15_000)

  it('retries while the image is busy, without force', async () => {
    const f = fixture('exit 0')
    // first two detaches fail (busy), the third works
    writeFileSync(f.hdiutil, `#!/bin/sh\necho "hdiutil $*" >> "${f.calls}"\nn=$(grep -c '^hdiutil' "${f.calls}")\nif [ "$n" -lt 3 ]; then exit 16; fi\nexit 0\n`)
    expect(await runScript(f, 999_999, '', f.vol)).toBe(0)
    expect(calls(f)).toEqual(Array(3).fill(`hdiutil detach ${f.vol} -quiet`))
    rmSync(f.root, { recursive: true, force: true })
  }, 20_000)

  it('opens nothing and ejects nothing when given nothing', async () => {
    const f = fixture('exit 0')
    expect(await runScript(f, 999_999, '', '')).toBe(0)
    expect(calls(f)).toEqual([])
    rmSync(f.root, { recursive: true, force: true })
  })
})

describe('the install window page', () => {
  const html = installerPage({ lang: 'en', title: 'Install <MLX> "Harness"', iconDataUrl: 'data:image/png;base64,AAAA', footer: 'Version 0.5.5 · Built on vMLX by JANGQ AI' })
  it('is self-contained behind a strict policy', () => {
    expect(html).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"`)
    expect(html).not.toMatch(/(src|href)="https?:/)
    expect(html).toContain('Install &lt;MLX&gt; &quot;Harness&quot;')
    expect(html).toContain('Built on vMLX by JANGQ AI')
  })
  it('animates instead of cutting: cross-faded screens, a gliding bar, reduced motion respected', () => {
    expect(html).toMatch(/\.screen \{[^}]*transition: opacity/)
    expect(html).toContain('requestAnimationFrame(glide)')
    expect(html).toContain('prefers-reduced-motion')
  })
})

describe('the DMG holds just the app (the updater finds it at the root)', () => {
  const panel = resolve(__dirname, '..')
  const pkg = JSON.parse(readFileSync(join(panel, 'package.json'), 'utf8'))
  it('has one entry: the app, under the name and bundle id the updater looks for', () => {
    expect(pkg.build.dmg.contents).toHaveLength(1)
    expect(pkg.build.dmg.contents[0].name).toBe(HARNESS_APP_NAME)
    expect(pkg.build.dmg.contents.some((c: { type?: string }) => c.type === 'link')).toBe(false)
    expect(pkg.build.appId).toBe(HARNESS_BUNDLE_ID)
    expect(JSON.stringify(pkg.build.dmg)).not.toContain('/Applications')
  })
  it('asks to open the app in its background, at the window size', () => {
    const svg = readFileSync(join(panel, 'build/dmg-background.svg'), 'utf8')
    expect(svg).toContain('Open MLX Harness to install')
    expect(svg).toContain(`width="${pkg.build.dmg.window.width}" height="${pkg.build.dmg.window.height}"`)
    const png = readFileSync(join(panel, 'build/dmg-background.png'))
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([pkg.build.dmg.window.width, pkg.build.dmg.window.height])
    const png2 = readFileSync(join(panel, 'build/dmg-background@2x.png'))
    expect([png2.readUInt32BE(16), png2.readUInt32BE(20)]).toEqual([pkg.build.dmg.window.width * 2, pkg.build.dmg.window.height * 2])
  })
  it('builds the install window preload and runs the installer before anything else starts', () => {
    expect(readFileSync(join(panel, 'electron.vite.config.ts'), 'utf8')).toContain("installer: resolve(__dirname, 'src/preload/installer.ts')")
    const index = readFileSync(join(panel, 'src/main/index.ts'), 'utf8')
    const installer = index.indexOf('await runInstaller(')
    expect(installer).toBeGreaterThan(0)
    for (const later of ['checkEngineVersion()', 'startPreviewServer(', 'createWindow()\n', 'installApplicationMenu(() => mainWindow)\n']) {
      expect(index.indexOf(later, installer), later).toBeGreaterThan(installer)
    }
  })
})
