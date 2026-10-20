import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSeatbeltProfile,
  looksLikeSandboxDenial,
  resetSeatbeltProbeForTests,
  sbplString,
  seatbeltArgv,
  seatbeltSupport,
  workspaceSandboxProfile,
  workspaceWritableRoots,
} from '../src/main/agent/seatbelt'
import { executeBuiltinTool, shellInvocation } from '../src/main/tools/executor'

vi.mock('electron', () => ({ clipboard: { readText: () => '', writeText: () => {} } }))
vi.mock('../src/main/database', () => ({ db: {} }))

afterEach(() => resetSeatbeltProbeForTests(undefined))

describe('Seatbelt profile generation', () => {
  it('denies writes, then re-allows devices and the roots, then guards git hooks/config', () => {
    const profile = buildSeatbeltProfile({ writableRoots: ['/Users/a/proj', '/Users/a/proj'], denyNetwork: false })
    expect(profile.startsWith('(version 1) (allow default) (deny file-write*)')).toBe(true)
    expect(profile).toContain('(literal "/dev/null")')
    expect(profile).toContain('(subpath "/dev/fd")')
    expect(profile.match(/\(subpath "\/Users\/a\/proj"\)/g)).toHaveLength(1)
    expect(profile).toContain('(deny file-write* (subpath "/Users/a/proj/.git/hooks") (literal "/Users/a/proj/.git/config"))')
    // Last match wins in SBPL: the git guard must come after the allow.
    expect(profile.indexOf('(allow file-write* (subpath "/Users/a/proj")')).toBeLessThan(profile.indexOf('.git/hooks'))
    expect(profile).not.toContain('network')
  })

  it('blocks outbound network except localhost and Unix sockets when asked', () => {
    const profile = buildSeatbeltProfile({ writableRoots: ['/w'], denyNetwork: true })
    expect(profile.endsWith(
      '(deny network-outbound) (allow network-outbound (remote unix-socket)) (allow network-outbound (remote ip "localhost:*"))',
    )).toBe(true)
  })

  it('with no roots allows only device writes', () => {
    const profile = buildSeatbeltProfile({ writableRoots: [], denyNetwork: false })
    expect(profile).not.toMatch(/\(allow file-write\* \(subpath/)
    expect(profile).not.toContain('.git')
  })

  it('quotes paths as SBPL strings', () => {
    expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"')
    const profile = buildSeatbeltProfile({ writableRoots: ['/x/My "Proj"'], denyNetwork: false })
    expect(profile).toContain('(subpath "/x/My \\"Proj\\"")')
  })

  it('writable roots are canonical: working dir, spill dir and temp folders', () => {
    const work = mkdtempSync(join(tmpdir(), 'mlx-sb-'))
    const roots = workspaceWritableRoots(work, '/nonexistent/spill')
    expect(roots).toContain(realpathSync(work))
    expect(roots).toContain('/nonexistent/spill')
    expect(roots).toContain(realpathSync(tmpdir()))
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('wraps a command as sandbox-exec -p <profile> /bin/bash -c <command>', () => {
    expect(seatbeltArgv('(version 1)', 'echo hi')).toEqual(['/usr/bin/sandbox-exec', '-p', '(version 1)', '/bin/bash', '-c', 'echo hi'])
    expect(shellInvocation('echo hi', '(version 1)')).toEqual({ file: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)', '/bin/bash', '-c', 'echo hi'] })
    expect(shellInvocation('echo hi', null)).toEqual({ file: '/bin/bash', args: ['-c', 'echo hi'] })
  })
})

describe('Seatbelt availability', () => {
  it.skipIf(process.platform === 'darwin')('is unavailable off macOS, so Workspace falls back to approval', () => {
    resetSeatbeltProbeForTests(undefined)
    expect(seatbeltSupport()).toEqual({ available: false, network: false })
    expect(workspaceSandboxProfile('/tmp')).toBeNull()
  })

  it('an injected probe result drives the Workspace profile', () => {
    resetSeatbeltProbeForTests({ available: true, network: false })
    const profile = workspaceSandboxProfile('/w')
    expect(profile).toContain('(subpath "/w")')
    expect(profile).not.toContain('network-outbound')
  })
})

describe('sandbox denial heuristics', () => {
  it.each([
    'touch: /Users/a/x: Operation not permitted',
    'npm ERR! code EPERM',
    'curl: (7) Failed to connect to example.com port 443 after 2 ms: Couldn\'t connect to server',
    "pip: Failed to establish a new connection: [Errno 1] Operation not permitted",
    'Error: connect EPERM 1.2.3.4:443',
  ])('recognizes %s', (line) => expect(looksLikeSandboxDenial(line)).toBe(true))

  it('ignores ordinary failures', () => {
    expect(looksLikeSandboxDenial('FAIL tests/a.test.ts > expected 1 to be 2')).toBe(false)
    expect(looksLikeSandboxDenial('bash: foo: command not found')).toBe(false)
  })
})

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.skipIf(!onMac)('sandbox-exec on macOS', () => {
  it('the profile compiles and runs true', () => {
    const profile = buildSeatbeltProfile({ writableRoots: [tmpdir()], denyNetwork: true })
    expect(spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true']).status).toBe(0)
  })

  it('run_command may write in the working dir but not outside it', async () => {
    const work = mkdtempSync(join(tmpdir(), 'mlx-sb-work-'))
    const profile = workspaceSandboxProfile(work)!
    expect(profile).toBeTruthy()
    const inside = await executeBuiltinTool('run_command', { command: 'echo ok > inside.txt && cat inside.txt' }, work, undefined, { sandboxProfile: profile })
    expect(inside.is_error).toBe(false)
    expect(inside.sandboxed).toBe(true)
    const home = process.env.HOME!
    const outside = await executeBuiltinTool('run_command', { command: `touch ${JSON.stringify(join(home, '.mlx-sandbox-probe'))}` }, work, undefined, { sandboxProfile: profile })
    expect(outside.is_error).toBe(true)
    expect(looksLikeSandboxDenial(outside.content)).toBe(true)
    const hook = await executeBuiltinTool('run_command', { command: 'mkdir -p .git/hooks && echo x > .git/hooks/pre-commit' }, work, undefined, { sandboxProfile: profile })
    expect(hook.is_error).toBe(true)
  })

  it('blocks outbound network but not localhost', async () => {
    const work = mkdtempSync(join(tmpdir(), 'mlx-sb-net-'))
    const profile = workspaceSandboxProfile(work)!
    const res = await executeBuiltinTool('run_command', { command: 'curl -sS -m 5 https://example.com -o /dev/null' }, work, undefined, { sandboxProfile: profile })
    expect(res.is_error).toBe(true)
    expect(looksLikeSandboxDenial(res.content)).toBe(true)
  })
})
