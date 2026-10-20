/**
 * macOS Seatbelt (sandbox-exec) confinement for the agent's shell tools.
 *
 * Adapted from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness),
 * packages/sandbox/sandbox-local/src/profiles.ts and packages/sandbox/sandbox/src/roots.ts.
 * Copyright (c) 2026 DeepSeek. Licensed under the MIT License:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Changes for MLX Studio: the writable roots also include the agent's spill
 * folder and the per-user Darwin cache folder; `.git/hooks` and `.git/config`
 * inside a writable root stay read-only (a hook written by a sandboxed command
 * would later run unsandboxed); outbound network is denied except to
 * localhost and Unix sockets (Workspace treats network effects as needing
 * approval); a functional probe falls back to a writes-only profile, then to
 * "unavailable" (every command then asks for approval).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

let sandboxExecPath = SANDBOX_EXEC

/** The sandbox-exec binary the shell tools invoke. */
export function sandboxExec(): string {
  return sandboxExecPath
}

/** Test hook: a fake sandbox-exec (Linux CI cannot run the real one). */
export function setSandboxExecForTests(path?: string): void {
  sandboxExecPath = path ?? SANDBOX_EXEC
}

export interface SeatbeltPolicy {
  /** Folders (and everything under them) the confined command may write. */
  writableRoots: readonly string[]
  /** Deny outbound network except to localhost and Unix sockets. */
  denyNetwork: boolean
}

/**
 * Resolve a granted root to the path Seatbelt compares: canonical, because
 * its filters match resolved paths (`/tmp` IS `/private/tmp` on macOS and an
 * as-spelled grant would match nothing). A missing root keeps its spelling
 * and simply matches nothing until it exists.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Quote one path as an SBPL string literal. */
export function sbplString(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Device nodes ordinary tools open for writing. */
const DEVICE_WRITES = ['/dev/null', '/dev/zero', '/dev/tty', '/dev/dtracehelper']

/**
 * Build the SBPL profile. Seatbelt applies the LAST matching rule, so each
 * form narrows or widens what came before: allow everything, deny every
 * write, re-allow writes under the roots, then re-deny the git files that
 * would let a confined command plant code that later runs unconfined.
 */
export function buildSeatbeltProfile(policy: SeatbeltPolicy): string {
  const roots = [...new Set(policy.writableRoots.filter(Boolean).map(canonicalPath))]
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${DEVICE_WRITES.map(p => `(literal ${sbplString(p)})`).join(' ')} (subpath "/dev/fd"))`,
  ]
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
    const gitGuards = roots.flatMap(root => [
      `(subpath ${sbplString(join(root, '.git', 'hooks'))})`,
      `(literal ${sbplString(join(root, '.git', 'config'))})`,
    ])
    forms.push(`(deny file-write* ${gitGuards.join(' ')})`)
  }
  if (policy.denyNetwork) {
    forms.push(
      '(deny network-outbound)',
      '(allow network-outbound (remote unix-socket))',
      '(allow network-outbound (remote ip "localhost:*"))',
    )
  }
  return forms.join(' ')
}

/** argv that runs one shell command under the profile. */
export function seatbeltArgv(profile: string, command: string, shell = '/bin/bash'): string[] {
  return [sandboxExec(), '-p', profile, shell, '-c', command]
}

let darwinCacheDir: string | null | undefined

/** The per-user Darwin cache folder (clang module caches, xcrun), or null. */
function darwinUserCacheDir(): string | null {
  if (darwinCacheDir !== undefined) return darwinCacheDir
  darwinCacheDir = null
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf-8', timeout: 2000 }).trim()
    if (out) darwinCacheDir = out
  } catch { /* optional */ }
  return darwinCacheDir
}

/**
 * The roots a Workspace command may write: the working directory, the
 * agent's spill folder, `/tmp`, the per-user temp folder and the per-user
 * Darwin cache folder. Canonical and deduplicated.
 */
export function workspaceWritableRoots(workingDir: string, spillDir?: string): string[] {
  const roots = [workingDir, spillDir, '/tmp', tmpdir(), darwinUserCacheDir()]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  return [...new Set(roots.map(canonicalPath))]
}

export interface SeatbeltSupport {
  available: boolean
  /** Whether the network rules compiled; false means writes-only confinement. */
  network: boolean
}

let probed: SeatbeltSupport | undefined

/** Probe hook for tests. */
export function resetSeatbeltProbeForTests(value?: SeatbeltSupport): void {
  probed = value
}

/**
 * Functional probe, cached: apply a real profile and run `true` under it.
 * Exit 0 means the kernel accepted and enforced it. A missing sandbox-exec
 * (every non-macOS host), or one that refuses the profile, probes unusable.
 */
export function seatbeltSupport(): SeatbeltSupport {
  if (probed) return probed
  probed = { available: false, network: false }
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return probed
  const run = (denyNetwork: boolean): boolean => {
    try {
      const profile = buildSeatbeltProfile({ writableRoots: [tmpdir()], denyNetwork })
      return spawnSync(SANDBOX_EXEC, ['-p', profile, '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' }).status === 0
    } catch {
      return false
    }
  }
  if (run(true)) probed = { available: true, network: true }
  else if (run(false)) probed = { available: true, network: false }
  if (!probed.available) console.warn('[SANDBOX] sandbox-exec is not usable; Workspace shell commands will ask for approval')
  else if (!probed.network) console.warn('[SANDBOX] network rules were refused; Workspace confines writes only')
  return probed
}

/**
 * The profile for a Workspace command in `workingDir`, or null when Seatbelt
 * is unavailable (the caller then asks for approval instead).
 */
export function workspaceSandboxProfile(workingDir: string, spillDir?: string): string | null {
  const support = seatbeltSupport()
  if (!support.available) return null
  return buildSeatbeltProfile({
    writableRoots: workspaceWritableRoots(workingDir, spillDir),
    denyNetwork: support.network,
  })
}

/**
 * Whether a failed confined command looks like the sandbox refused it: a
 * write outside the roots (EPERM, "Operation not permitted", a read-only
 * protected path) or a blocked outbound connection.
 */
export function looksLikeSandboxDenial(output: string): boolean {
  return /operation not permitted|\bEPERM\b|sandbox[- ]?(exec|deny|denied)|deny\(1\)|read-only file system|permission denied|couldn'?t connect to server|failed to connect to|failed to establish a new connection|network is unreachable|connect EPERM|could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(output)
}
