/**
 * The Workspace sandbox on a real Mac (CI: the "Seatbelt probe" step sets
 * MLX_SEATBELT_PROBE=1 on macOS). Builds the profile the app builds and
 * proves that ordinary commands still run under it and that everything it
 * promises to refuse is refused: writes outside the roots, credential
 * folders and the app's own data, git hooks and config (nested repositories
 * too), the app's own local ports, LaunchServices and Apple Events. Skipped everywhere else.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildSeatbeltProfile,
  defaultSecretPaths,
  resetSeatbeltProbeForTests,
  seatbeltSupport,
  workspaceWritableRoots,
} from '../src/main/agent/seatbelt'

const enabled = process.env.MLX_SEATBELT_PROBE === '1'

interface Run { code: number | null; out: string }

function run(argv: string[], cwd: string, timeoutMs = 30_000): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, out: String(err) }) })
  })
}

function listen(): Promise<Server> {
  return new Promise(resolve => {
    const server = createServer(socket => socket.end())
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}
const portOf = (s: Server) => (s.address() as { port: number }).port

describe.runIf(enabled)('Workspace Seatbelt profile on this Mac', () => {
  let root = ''
  let work = ''
  let home = ''
  let userData = ''
  let spill = ''
  let denied: Server
  let allowed: Server
  let profile = ''
  let homeProfile = ''
  const sb = (cmd: string, p = profile) => run(['/usr/bin/sandbox-exec', '-p', p, '/bin/bash', '-c', cmd], work)
  const plain = (cmd: string) => run(['/bin/bash', '-c', cmd], work)

  beforeAll(async () => {
    expect(process.platform).toBe('darwin')
    resetSeatbeltProbeForTests(undefined)
    // The app's own probe must pick the hardened profile on this macOS.
    expect(seatbeltSupport()).toEqual({ available: true, network: true, hardened: true })
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mlx-sb-probe-')))
    work = join(root, 'work')
    home = join(root, 'home')
    userData = join(home, 'Library', 'Application Support', 'MLX Probe')
    spill = join(userData, 'agent-spill', 'c1')
    for (const d of [work, join(home, '.ssh'), join(home, '.aws'), spill]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_probe'), 'SECRET-MARKER-SSH\n')
    writeFileSync(join(home, '.aws', 'credentials'), 'SECRET-MARKER-AWS\n')
    writeFileSync(join(home, 'notes.txt'), 'plain notes\n')
    writeFileSync(join(userData, 'chats.db'), 'SECRET-MARKER-APPDATA\n')
    writeFileSync(join(spill, 'result.txt'), 'spill ok\n')
    denied = await listen()
    allowed = await listen()
    const hardening = { secretPaths: defaultSecretPaths(home, userData), allowPaths: [spill], deniedLocalPorts: [portOf(denied)] }
    profile = buildSeatbeltProfile({ writableRoots: workspaceWritableRoots(work, spill), denyNetwork: true, hardening })
    // A working folder that holds the credential folders (e.g. the home folder itself).
    homeProfile = buildSeatbeltProfile({ writableRoots: [home], denyNetwork: true, hardening })
  })

  afterAll(() => {
    denied?.close()
    allowed?.close()
    resetSeatbeltProbeForTests(undefined)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('ordinary commands still run', async () => {
    const write = await sb('echo ok > out.txt && cat out.txt')
    expect(write).toEqual({ code: 0, out: 'ok\n' })
    expect((await sb('git --version')).code).toBe(0)
    const node = await sb(`"${process.execPath}" -e "console.log(1 + 1)"`)
    expect(node.code).toBe(0)
    expect(node.out.trim()).toBe('2')
    const py = await sb('python3 -c "print(3)"')
    expect(py.code).toBe(0)
    expect(py.out.trim()).toBe('3')
    expect((await sb(`cat "${join(home, 'notes.txt')}"`)).out).toBe('plain notes\n')
    expect((await sb('ls / > /dev/null && uname -s')).out.trim()).toBe('Darwin')
  })

  it('writes outside the roots are refused', async () => {
    // the probe's own folders live under the temp folder, which is a writable root (commands need scratch space),
    // so the outside target is the runner's real home folder
    const outside = join(homedir(), `mlx-sb-outside-${process.pid}.txt`)
    try {
      expect((await sb(`touch "${outside}"`)).code).not.toBe(0)
      expect(existsSync(outside)).toBe(false)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('git hooks and config are refused in nested repositories too, in any letter case', async () => {
    expect((await sb('mkdir -p sub/.git && echo ref > sub/.git/HEAD')).code).toBe(0)
    expect((await sb('echo x > sub/.git/config')).code).not.toBe(0)
    expect((await sb('mkdir -p sub/.git/hooks')).code).not.toBe(0)
    expect((await sb('mkdir -p deep/er/.GIT && echo x > deep/er/.GIT/Config')).code).not.toBe(0)
    expect((await sb('mkdir -p .git/hooks')).code).not.toBe(0)
  })

  it('credential folders and the app data are refused; the spill folder is not', async () => {
    for (const cmd of [`cat "${join(home, '.ssh', 'id_probe')}"`, `ls "${join(home, '.ssh')}"`, `cat "${join(home, '.aws', 'credentials')}"`, `cat "${join(userData, 'chats.db')}"`]) {
      const r = await sb(cmd)
      expect(r.code, cmd).not.toBe(0)
      expect(r.out).not.toContain('SECRET-MARKER')
    }
    expect((await sb(`cat "${join(spill, 'result.txt')}"`)).out).toBe('spill ok\n')
    expect((await sb(`echo x > "${join(spill, 'new.txt')}" && cat "${join(spill, 'new.txt')}"`)).code).toBe(0)
    // Even when the working folder contains them, credential folders stay closed.
    expect((await sb(`echo x > "${join(home, 'ok.txt')}"`, homeProfile)).code).toBe(0)
    expect((await sb(`echo x > "${join(home, '.ssh', 'authorized_keys')}"`, homeProfile)).code).not.toBe(0)
    expect((await sb(`cat "${join(home, '.ssh', 'id_probe')}"`, homeProfile)).out).not.toContain('SECRET-MARKER')
  })

  it("the app's own local ports are refused; other local ports are not", async () => {
    const d = portOf(denied)
    const a = portOf(allowed)
    expect((await plain(`nc -z -G 3 127.0.0.1 ${d}`)).code).toBe(0) // control: the port is open
    expect((await sb(`nc -z -G 3 127.0.0.1 ${d}`)).code).not.toBe(0)
    expect((await sb(`nc -z -G 3 localhost ${d}`)).code).not.toBe(0)
    expect((await sb(`nc -z -G 3 127.0.0.1 ${a}`)).code).toBe(0)
  })

  it('LaunchServices is refused: open cannot start an app', { timeout: 60_000 }, async () => {
    const control = await plain('open -g -j -a Calculator')
    await plain('killall Calculator 2>/dev/null; true')
    expect(control.code, `control: ${control.out}`).toBe(0)
    const r = await sb('open -g -j -a Calculator')
    await plain('killall Calculator 2>/dev/null; true')
    expect(r.code, r.out).not.toBe(0)
  })

  it('Apple Events are refused', { timeout: 60_000 }, async () => {
    // a refused Apple Event can hang instead of failing: a command killed at the timeout counts as refused too
    const r = await run(['/usr/bin/sandbox-exec', '-p', profile, '/bin/bash', '-c', `osascript -e 'tell application "Finder" to get name'`], work, 15_000)
    expect(r.code).not.toBe(0)
    const control = await run(['/bin/bash', '-c', `osascript -e 'tell application "Finder" to get name'`], work, 20_000)
    if (control.code === 0) {
      // Apple Events reach Finder from this runner, so the refusal above is the sandbox's.
      expect(r.out).not.toContain('Finder')
    } else {
      console.warn(`[seatbelt probe] Apple Events to Finder are not allowed on this runner (${control.out.trim()}); only the sandboxed refusal was checked`)
    }
  })
})
