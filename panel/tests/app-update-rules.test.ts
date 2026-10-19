import { describe, expect, it } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STUDIO_REQUIREMENT,
  SWAP_SCRIPT,
  appBundlePath,
  backupPathFor,
  bannerVisible,
  checkCandidate,
  checkDownload,
  codesignVerifyArgs,
  compareAppVersions,
  hdiutilAttachArgs,
  hdiutilDetachArgs,
  isNewerVersion,
  isOnMountedImage,
  isSha256,
  isTranslocated,
  notificationBody,
  planInPlaceInstall,
  progressPercent,
  shouldNotify,
  spctlAccepted,
  spctlArgs,
  stagingPathFor,
  swapCommand,
  type InstallFacts,
} from '../src/shared/appUpdate'

const APP = '/Applications/MLX Studio.app'
const SHA = 'a'.repeat(64)

describe('version comparison', () => {
  it('orders versions numerically, segment by segment', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true)
    expect(isNewerVersion('1.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
    expect(compareAppVersions('1.0.0', '1.0')).toBe(0)
    expect(compareAppVersions('v0.3.0', '0.2.9')).toBe(1)
  })
  it('ignores pre-release and build suffixes and never calls garbage newer', () => {
    expect(isNewerVersion('0.2.0-beta.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.2.0-beta.1', '0.2.0')).toBe(false)
    expect(isNewerVersion('abc', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.2.0', 'garbage')).toBe(false)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
  })
})

describe('where the running app lives', () => {
  it('finds the bundle around the executable', () => {
    expect(appBundlePath('/Applications/MLX Studio.app/Contents/MacOS/MLX Studio')).toBe(APP)
    expect(appBundlePath('/Users/a/Downloads/MLX Studio 2.app/Contents/MacOS/MLX Studio')).toBe('/Users/a/Downloads/MLX Studio 2.app')
    expect(appBundlePath('/Users/a/dev/studio/panel/node_modules/electron/dist/electron')).toBeNull()
    expect(appBundlePath('')).toBeNull()
  })
  it('recognises translocated and disk-image copies, but not Applications on another disk', () => {
    expect(isTranslocated('/private/var/folders/x/AppTranslocation/1234/d/MLX Studio.app')).toBe(true)
    expect(isOnMountedImage('/Volumes/MLX Studio/MLX Studio.app')).toBe(true)
    expect(isOnMountedImage('/Volumes/Fast SSD/Applications/MLX Studio.app')).toBe(false)
    expect(isOnMountedImage('/Volumes/Fast SSD/Users/alex/Applications/MLX Studio.app')).toBe(false)
    expect(isOnMountedImage(APP)).toBe(false)
  })
  it('stages and backs up next to the app (same folder, so the swap is a rename)', () => {
    expect(stagingPathFor(APP)).toBe('/Applications/.MLX Studio.update.app')
    expect(backupPathFor(APP, 4242)).toBe('/Applications/.MLX Studio.old-4242.app')
    expect(backupPathFor(APP, '../../x y')).toBe('/Applications/.MLX Studio.old-xy.app')
    expect(stagingPathFor('/Users/a/Applications/MLX Studio 2.app')).toBe('/Users/a/Applications/.MLX Studio 2.update.app')
  })
})

describe('in-place install decision', () => {
  const mac: InstallFacts = { platform: 'darwin', packaged: true, appPath: APP, parentWritable: true, appWritable: true, hasChecksum: true }

  it('installs a released copy in a writable folder', () => {
    expect(planInPlaceInstall(mac)).toEqual({ ok: true, appPath: APP, stagingPath: '/Applications/.MLX Studio.update.app' })
    expect(planInPlaceInstall({ ...mac, appPath: '/Users/a/Downloads/MLX Studio.app' }).ok).toBe(true)
    expect(planInPlaceInstall({ ...mac, appPath: '/Volumes/Fast SSD/Applications/MLX Studio.app' }).ok).toBe(true)
  })
  it('development builds only report', () => {
    expect(planInPlaceInstall({ ...mac, packaged: false })).toEqual({ ok: false, reason: 'development' })
  })
  it('falls back to downloading by hand where replacing itself is wrong or impossible', () => {
    expect(planInPlaceInstall({ ...mac, platform: 'linux' })).toEqual({ ok: false, reason: 'unsupported' })
    expect(planInPlaceInstall({ ...mac, appPath: null })).toEqual({ ok: false, reason: 'notApp' })
    expect(planInPlaceInstall({ ...mac, appPath: '/Volumes/MLX Studio/MLX Studio.app' })).toEqual({ ok: false, reason: 'mountedDmg' })
    expect(planInPlaceInstall({ ...mac, appPath: '/private/var/folders/q/AppTranslocation/5/d/MLX Studio.app' })).toEqual({ ok: false, reason: 'translocated' })
    expect(planInPlaceInstall({ ...mac, parentWritable: false })).toEqual({ ok: false, reason: 'notWritable' })
    expect(planInPlaceInstall({ ...mac, appWritable: false })).toEqual({ ok: false, reason: 'notWritable' })
    expect(planInPlaceInstall({ ...mac, hasChecksum: false })).toEqual({ ok: false, reason: 'noChecksum' })
  })
})

describe('verification rules', () => {
  it('requires a Developer ID signature from our team for our bundle id', () => {
    expect(STUDIO_REQUIREMENT).toContain('anchor apple generic')
    expect(STUDIO_REQUIREMENT).toContain('certificate leaf[subject.OU] = "CCKXS9W488"')
    expect(STUDIO_REQUIREMENT).toContain('identifier "app.mlx.studio"')
    expect(STUDIO_REQUIREMENT).toContain('certificate 1[field.1.2.840.113635.100.6.2.6] exists') // Developer ID CA
    expect(STUDIO_REQUIREMENT).toContain('certificate leaf[field.1.2.840.113635.100.6.1.13] exists') // Developer ID Application
    expect(codesignVerifyArgs('/tmp/m/MLX Studio.app')).toEqual(['--verify', '--deep', '--strict', '-R', `=${STUDIO_REQUIREMENT}`, '/tmp/m/MLX Studio.app'])
    expect(codesignVerifyArgs(APP, false)).toEqual(['--verify', '--strict', '-R', `=${STUDIO_REQUIREMENT}`, APP])
  })
  it('accepts only a notarized Developer ID app in Gatekeeper', () => {
    expect(spctlArgs(APP)).toEqual(['-a', '-t', 'exec', '-vv', APP])
    const good = `${APP}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Flex UK Limited (CCKXS9W488)`
    expect(spctlAccepted(true, good)).toBe(true)
    expect(spctlAccepted(false, good)).toBe(false)
    expect(spctlAccepted(true, `${APP}: accepted\nsource=Developer ID`)).toBe(false)
    expect(spctlAccepted(true, `${APP}: rejected\nsource=Unnotarized Developer ID`)).toBe(false)
  })
  it('mounts read-only, hidden, without opening windows, at our own mount point', () => {
    expect(hdiutilAttachArgs('/u/updates/MLX-Studio-0.2.0.dmg', '/tmp/mlx-studio-update-x'))
      .toEqual(['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', '/tmp/mlx-studio-update-x', '/u/updates/MLX-Studio-0.2.0.dmg'])
    expect(hdiutilDetachArgs('/tmp/m')).toEqual(['detach', '/tmp/m'])
    expect(hdiutilDetachArgs('/tmp/m', true)).toEqual(['detach', '/tmp/m', '-force'])
  })
  it('checks the downloaded bytes against size and SHA-256', () => {
    expect(isSha256(SHA)).toBe(true)
    expect(isSha256('xyz')).toBe(false)
    expect(checkDownload({ expectedSize: 10, expectedSha256: SHA, size: 10, sha256: SHA })).toBeNull()
    expect(checkDownload({ expectedSize: 10, expectedSha256: SHA, size: 10, sha256: SHA.toUpperCase() })).toBeNull()
    expect(checkDownload({ expectedSize: undefined, expectedSha256: SHA, size: 99, sha256: SHA })).toBeNull()
    expect(checkDownload({ expectedSize: 10, expectedSha256: SHA, size: 9, sha256: SHA })).toBe('size')
    expect(checkDownload({ expectedSize: 10, expectedSha256: SHA, size: 10, sha256: 'b'.repeat(64) })).toBe('checksum')
    expect(checkDownload({ expectedSize: 10, expectedSha256: '', size: 10, sha256: '' })).toBe('checksum')
  })
  it('accepts only our app, and only a newer version', () => {
    expect(checkCandidate({ bundleId: 'app.mlx.studio', version: '0.2.0', runningVersion: '0.1.0' })).toBeNull()
    expect(checkCandidate({ bundleId: 'app.mlx.mac', version: '0.2.0', runningVersion: '0.1.0' })).toBe('notOurs')
    expect(checkCandidate({ bundleId: undefined, version: '0.2.0', runningVersion: '0.1.0' })).toBe('notOurs')
    expect(checkCandidate({ bundleId: 'app.mlx.studio', version: '0.1.0', runningVersion: '0.1.0' })).toBe('notNewer')
    expect(checkCandidate({ bundleId: 'app.mlx.studio', version: '0.0.9', runningVersion: '0.1.0' })).toBe('notNewer')
    expect(checkCandidate({ bundleId: 'app.mlx.studio', version: 7, runningVersion: '0.1.0' })).toBe('notNewer')
  })
})

describe('notifications and the banner', () => {
  const base = { version: '0.2.0', notifiedVersion: null, windowFocused: false, supported: true }
  it('notifies once per version, only when no window has focus', () => {
    expect(shouldNotify(base)).toBe(true)
    expect(shouldNotify({ ...base, notifiedVersion: '0.2.0' })).toBe(false)
    expect(shouldNotify({ ...base, notifiedVersion: '0.1.5' })).toBe(true)
    expect(shouldNotify({ ...base, windowFocused: true })).toBe(false)
    expect(shouldNotify({ ...base, supported: false })).toBe(false)
  })
  it('uses the first line of the notes as the body', () => {
    expect(notificationBody('Faster loading.\nMore fixes.', 'fallback')).toBe('Faster loading.')
    expect(notificationBody('', 'fallback')).toBe('fallback')
    expect(notificationBody(undefined, 'fallback')).toBe('fallback')
    expect(notificationBody('x'.repeat(300), 'f')).toHaveLength(180)
  })
  it('computes a clamped whole percent', () => {
    expect(progressPercent(0, 100)).toBe(0)
    expect(progressPercent(42.9, 100)).toBe(42)
    expect(progressPercent(200, 100)).toBe(100)
    expect(progressPercent(5, 0)).toBe(0)
  })
  it('hides the offer after Later but never hides work in progress', () => {
    const s = { currentVersion: '0.1.0', version: '0.2.0' }
    expect(bannerVisible(null)).toBe(false)
    expect(bannerVisible({ ...s, phase: 'idle' })).toBe(false)
    expect(bannerVisible({ ...s, phase: 'available' })).toBe(true)
    expect(bannerVisible({ ...s, phase: 'available', dismissed: true })).toBe(false)
    expect(bannerVisible({ ...s, phase: 'ready', dismissed: true })).toBe(false)
    expect(bannerVisible({ ...s, phase: 'downloading', dismissed: true })).toBe(true)
    expect(bannerVisible({ ...s, phase: 'verifying' })).toBe(true)
  })
})

describe('swap script', () => {
  it('passes every path as an argument, never inside the script text', () => {
    const cmd = swapCommand({
      pid: 123, appPath: APP, stagedPath: stagingPathFor(APP), backupPath: backupPathFor(APP, 123),
      relaunch: true, logPath: '/Users/a/Library/Application Support/MLX Studio/updates/swap.log',
    })
    expect(cmd.file).toBe('/bin/sh')
    expect(cmd.args.slice(0, 3)).toEqual(['-c', SWAP_SCRIPT, 'mlx-studio-update'])
    expect(cmd.args.slice(3)).toEqual([
      '123', APP, '/Applications/.MLX Studio.update.app', '/Applications/.MLX Studio.old-123.app', '1',
      '/usr/bin/open', '/usr/bin/xattr', '/Users/a/Library/Application Support/MLX Studio/updates/swap.log',
    ])
    expect(SWAP_SCRIPT).not.toContain('/Applications')
    // Every use of a variable is inside double quotes: with the quoted strings removed, none is left.
    const unquoted = SWAP_SCRIPT.replace(/"[^"]*"/g, '""')
    expect(unquoted.match(/\$[A-Z0-9]/g) ?? []).toEqual([])
    const syntax = spawnSync('/bin/sh', ['-n', '-c', SWAP_SCRIPT])
    expect(syntax.status).toBe(0)
  })
  it('refuses bad input', () => {
    const ok = { pid: 1, appPath: APP, stagedPath: stagingPathFor(APP), backupPath: backupPathFor(APP, 1), relaunch: false, logPath: '/tmp/l' }
    expect(() => swapCommand({ ...ok, pid: 0 })).toThrow()
    expect(() => swapCommand({ ...ok, appPath: 'Applications/MLX Studio.app' })).toThrow()
    expect(() => swapCommand({ ...ok, stagedPath: APP })).toThrow()
    expect(() => swapCommand({ ...ok, stagedPath: '/Users/a/.MLX Studio.update.app' })).toThrow() // other folder → maybe other volume
  })

  // The script itself, run for real with /bin/sh on throwaway folders (stand-ins for open/xattr).
  function fixture(dirName = 'Apps') {
    const root = mkdtempSync(join(tmpdir(), 'swap-test-'))
    const dir = join(root, dirName)
    mkdirSync(dir, { recursive: true })
    const app = join(dir, 'MLX Studio.app')
    const staged = stagingPathFor(app)
    mkdirSync(app); writeFileSync(join(app, 'version'), 'old')
    mkdirSync(staged); writeFileSync(join(staged, 'version'), 'new')
    const calls = join(root, 'calls.log')
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const fake = (name: string, body: string) => {
      const p = join(bin, name)
      writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`)
      chmodSync(p, 0o755)
      return p
    }
    return { root, dir, app, staged, calls, bin, fake, backup: backupPathFor(app, 99), log: join(root, 'swap.log') }
  }

  function runSwap(f: ReturnType<typeof fixture>, opts: { pid: number; relaunch: boolean; quarantined?: boolean; env?: NodeJS.ProcessEnv }) {
    const open = f.fake('open', 'exit 0')
    const xattr = f.fake('xattr', `if [ "$1" = "-p" ]; then exit ${opts.quarantined ? 0 : 1}; fi; exit 0`)
    const { file, args } = swapCommand({
      pid: opts.pid, appPath: f.app, stagedPath: f.staged, backupPath: f.backup, relaunch: opts.relaunch,
      logPath: f.log, openBin: open, xattrBin: xattr,
    })
    return new Promise<number>((resolve) => {
      const child = spawn(file, args, { env: opts.env ?? process.env, stdio: 'ignore' })
      child.on('exit', code => resolve(code ?? -1))
    })
  }
  const calls = (f: ReturnType<typeof fixture>) => existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n') : []

  it('waits for the app to exit, swaps, relaunches and deletes the old copy', async () => {
    const f = fixture()
    const app = spawn('sleep', ['0.8'])
    const done = runSwap(f, { pid: app.pid!, relaunch: true })
    await new Promise(r => setTimeout(r, 300))
    expect(readFileSync(join(f.app, 'version'), 'utf8')).toBe('old') // still waiting
    expect(await done).toBe(0)
    expect(readFileSync(join(f.app, 'version'), 'utf8')).toBe('new')
    expect(existsSync(f.staged)).toBe(false)
    expect(existsSync(f.backup)).toBe(false)
    expect(calls(f)).toEqual([`xattr -p com.apple.quarantine ${f.app}`, `open ${f.app}`])
  })

  it('removes the quarantine flag only when present, and does not relaunch after a plain quit', async () => {
    const f = fixture()
    expect(await runSwap(f, { pid: 999_999, relaunch: false, quarantined: true })).toBe(0)
    expect(readFileSync(join(f.app, 'version'), 'utf8')).toBe('new')
    expect(calls(f)).toEqual([`xattr -p com.apple.quarantine ${f.app}`, `xattr -dr com.apple.quarantine ${f.app}`])
  })

  it('treats hostile folder names as plain text', async () => {
    const f = fixture(`it's "$(touch PWNED)" ; rm -rf x \`id\``)
    expect(await runSwap(f, { pid: 999_999, relaunch: true })).toBe(0)
    expect(readFileSync(join(f.app, 'version'), 'utf8')).toBe('new')
    expect(existsSync('PWNED')).toBe(false)
    expect(existsSync(join(f.root, 'PWNED'))).toBe(false)
    expect(existsSync(join(f.dir, 'PWNED'))).toBe(false)
  })

  it('restores the current app when the new one cannot be moved into place', async () => {
    const f = fixture()
    // mv that fails only for the staged copy
    f.fake('mv', `case "$1" in *.update.app) exit 1;; esac; exec /bin/mv "$@"`)
    const env = { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }
    expect(await runSwap(f, { pid: 999_999, relaunch: true, env })).toBe(1)
    expect(readFileSync(join(f.app, 'version'), 'utf8')).toBe('old')
    expect(existsSync(f.backup)).toBe(false)
    expect(calls(f).at(-1)).toBe(`open ${f.app}`) // the old one comes back up
  })

  it('touches nothing when the staged copy is missing', async () => {
    const f = fixture()
    spawnSync('rm', ['-rf', f.staged])
    expect(await runSwap(f, { pid: 999_999, relaunch: true })).toBe(1)
    expect(readFileSync(join(f.app, 'version'), 'utf8')).toBe('old')
    expect(calls(f)).toEqual([])
  })

  it('never moves the app into an existing backup path', async () => {
    const f = fixture()
    mkdirSync(f.backup)
    expect(await runSwap(f, { pid: 999_999, relaunch: false })).toBe(1)
    expect(readFileSync(join(f.app, 'version'), 'utf8')).toBe('old')
    expect(existsSync(join(f.backup, 'MLX Studio.app'))).toBe(false)
  })
})
