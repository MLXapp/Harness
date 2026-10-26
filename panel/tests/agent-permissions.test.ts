import { describe, expect, it } from 'vitest'
import {
  alwaysAllowKey,
  applyPermissionPresetToTools,
  approvalRefusalMessage,
  classifyGitCommand,
  decideToolPermission,
  hardenedGitArgv,
  isDestructiveGitArgv,
  parseGitCommand,
  isGitDirPath,
  isProtectedGitPath,
  normalizePermissionPreset,
  PLAN_MODE_REFUSAL,
  readEscalation,
  sandboxEscalationMarker,
  type PermissionInput,
} from '../src/main/agent/permissions'
import { BUILTIN_TOOLS } from '../src/main/tools/registry'

const decide = (over: Partial<PermissionInput> & Pick<PermissionInput, 'toolName'>) =>
  decideToolPermission({ preset: 'workspace', args: {}, isBuiltin: true, sandboxAvailable: true, ...over })

describe('permission preset resolution', () => {
  it('defaults to Workspace for anything unknown', () => {
    expect(normalizePermissionPreset(undefined)).toBe('workspace')
    expect(normalizePermissionPreset('lean')).toBe('workspace')
    expect(normalizePermissionPreset('read-only')).toBe('read-only')
    expect(normalizePermissionPreset('full')).toBe('full')
  })

  it('Full access never asks and never sandboxes', () => {
    for (const toolName of ['run_command', 'spawn_process', 'run_applescript', 'write_file', 'git', 'mystery_tool']) {
      expect(decide({ preset: 'full', toolName, args: { command: 'push origin main' } })).toEqual({ action: 'allow', sandbox: false })
    }
    expect(decide({ preset: 'full', toolName: 'mcp_x', isBuiltin: false })).toEqual({ action: 'allow', sandbox: false })
  })

  it('Read only allows reads and asks for writes, shell, AppleScript, MCP and non-read git', () => {
    const ro = (toolName: string, args: Record<string, unknown> = {}, isBuiltin = true) =>
      decide({ preset: 'read-only', toolName, args, isBuiltin })
    expect(ro('read_file', { path: 'a' })).toEqual({ action: 'allow', sandbox: false })
    expect(ro('fetch_url', { url: 'https://x' }).action).toBe('allow')
    expect(ro('todo_write').action).toBe('allow')
    expect(ro('write_file', { path: 'a.txt' })).toMatchObject({ action: 'ask', kind: 'write', subject: 'a.txt' })
    expect(ro('move_file', { source: 'a', destination: 'b' })).toMatchObject({ action: 'ask', subject: 'a → b' })
    expect(ro('run_command', { command: 'ls' })).toMatchObject({ action: 'ask', kind: 'shell', allowAlways: true, subject: 'ls' })
    expect(ro('run_applescript', { script: 'beep' })).toMatchObject({ action: 'ask', kind: 'applescript', allowAlways: false })
    expect(ro('git', { command: 'status' }).action).toBe('allow')
    expect(ro('git', { command: 'commit -m "x"' })).toMatchObject({ action: 'ask', kind: 'git' })
    expect(ro('some_mcp_tool', { a: 1 }, false)).toMatchObject({ action: 'ask', kind: 'mcp', subject: '{"a":1}' })
  })

  it('Workspace sandboxes shell, allows workspace writes and asks for AppleScript and git network', () => {
    expect(decide({ toolName: 'run_command', args: { command: 'npm test' } })).toEqual({ action: 'allow', sandbox: true })
    expect(decide({ toolName: 'spawn_process', args: { command: 'npm run dev' } })).toEqual({ action: 'allow', sandbox: true })
    expect(decide({ toolName: 'write_file', args: { path: 'src/a.ts' } })).toEqual({ action: 'allow', sandbox: false })
    expect(decide({ toolName: 'run_applescript', args: { script: 'beep' } })).toMatchObject({ action: 'ask', kind: 'applescript' })
    expect(decide({ toolName: 'git', args: { command: 'commit -m "x"' } })).toEqual({ action: 'allow', sandbox: false })
    expect(decide({ toolName: 'git', args: { command: 'config core.hooksPath h' } })).toMatchObject({ action: 'ask', why: 'outside' })
    expect(decide({ toolName: 'git', args: { command: 'push origin main' } })).toMatchObject({ action: 'ask', why: 'network' })
    expect(decide({ toolName: 'git', args: { command: '-C /etc status' } })).toMatchObject({ action: 'ask', why: 'outside' })
    expect(decide({ toolName: 'github__list_repos', isBuiltin: false }).action).toBe('allow')
    expect(decide({ toolName: 'searchFiles', isBuiltin: false }).action).toBe('allow')
    expect(decide({ toolName: 'get_settings', isBuiltin: false }).action).toBe('allow')
    expect(decide({ toolName: 'mcp_tool', isBuiltin: false })).toMatchObject({ action: 'ask', kind: 'mcp', why: 'mcp-write', allowAlways: true })
    expect(decide({ toolName: 'gmail_send_email', isBuiltin: false })).toMatchObject({ action: 'ask', kind: 'mcp' })
    expect(decide({ toolName: 'get_and_delete_item', isBuiltin: false })).toMatchObject({ action: 'ask', kind: 'mcp' })
    expect(decide({ toolName: 'gmail_send_email', isBuiltin: false, alwaysAllowed: new Set(['gmail_send_email\u0000']) }).action).toBe('allow')
    expect(decide({ toolName: 'unknown_builtin' })).toMatchObject({ action: 'ask', kind: 'tool' })
  })

  it('Workspace asks for every shell command when the sandbox is unavailable', () => {
    expect(decide({ toolName: 'run_command', args: { command: 'ls' }, sandboxAvailable: false })).toMatchObject({
      action: 'ask', kind: 'shell', why: 'no-sandbox', allowAlways: true,
    })
  })

  it('Workspace asks before writing git hooks or config', () => {
    expect(isProtectedGitPath('.git/hooks/pre-commit')).toBe(true)
    expect(isProtectedGitPath('./sub/.git/config')).toBe(true)
    expect(isProtectedGitPath('.git/HEAD')).toBe(false)
    expect(isProtectedGitPath('src/git/config.ts')).toBe(false)
    expect(decide({ toolName: 'write_file', args: { path: '.git/hooks/pre-push' } })).toMatchObject({ action: 'ask', why: 'git-internals' })
    expect(decide({ toolName: 'copy_file', args: { source: 'x', destination: '.git/config' } })).toMatchObject({ action: 'ask' })
  })

  it('treats any .git folder or .git file, in any letter case, as git internals', () => {
    expect(isGitDirPath('.git')).toBe(true)
    expect(isGitDirPath('.git/HEAD')).toBe(true)
    expect(isGitDirPath('.GIT/hooks/pre-commit')).toBe(true)
    expect(isGitDirPath('vendor/lib/.Git/config')).toBe(true)
    expect(isGitDirPath('sub/.git')).toBe(true)
    expect(isGitDirPath('sub\\.git\\config')).toBe(true)
    expect(isGitDirPath('.github/workflows/ci.yml')).toBe(false)
    expect(isGitDirPath('.gitignore')).toBe(false)
    expect(isGitDirPath('src/git/config.ts')).toBe(false)
    expect(decide({ toolName: 'write_file', args: { path: '.GIT/hooks/pre-commit' } })).toMatchObject({ action: 'ask', why: 'git-internals' })
    expect(decide({ toolName: 'move_file', args: { source: 'x', destination: 'sub/.git' } })).toMatchObject({ action: 'ask', why: 'git-internals' })
    expect(decide({ toolName: 'delete_file', args: { path: '.git' } })).toMatchObject({ action: 'ask', why: 'git-internals' })
    expect(decide({ toolName: 'write_file', args: { path: '.gitignore' } })).toEqual({ action: 'allow', sandbox: false })
  })

  it('"Always allow" is an exact command match per tool', () => {
    const alwaysAllowed = new Set([alwaysAllowKey('run_command', 'npm ci')])
    expect(decide({ preset: 'read-only', toolName: 'run_command', args: { command: 'npm ci' }, alwaysAllowed })).toEqual({ action: 'allow', sandbox: false })
    expect(decide({ preset: 'read-only', toolName: 'run_command', args: { command: 'npm ci ' }, alwaysAllowed }).action).toBe('ask')
    expect(decide({ preset: 'read-only', toolName: 'spawn_process', args: { command: 'npm ci' }, alwaysAllowed }).action).toBe('ask')
    // In Workspace a remembered command runs as approved: outside the sandbox.
    expect(decide({ toolName: 'run_command', args: { command: 'npm ci' }, alwaysAllowed })).toEqual({ action: 'allow', sandbox: false })
  })
})

describe('sandbox escalation', () => {
  it('pairs sandbox_permissions with a justification', () => {
    expect(readEscalation({ command: 'x' })).toEqual({ requested: false })
    expect(readEscalation({ sandbox_permissions: 'full_access' })).toMatchObject({ error: expect.stringContaining('justification') })
    expect(readEscalation({ justification: 'because' })).toMatchObject({ error: expect.stringContaining('only valid') })
    expect(readEscalation({ sandbox_permissions: 'root', justification: 'x' })).toMatchObject({ error: expect.stringContaining('full_access') })
    expect(readEscalation({ sandbox_permissions: 'full_access', justification: ' needs npm registry \nsecond line' })).toEqual({
      requested: true, justification: 'needs npm registry',
    })
  })

  it('asks with the justification, refuses malformed and repeated escalations', () => {
    const args = { command: 'npm ci', sandbox_permissions: 'full_access', justification: 'Install deps from the registry.' }
    expect(decide({ toolName: 'run_command', args })).toMatchObject({
      action: 'ask', kind: 'escalation', justification: 'Install deps from the registry.', subject: 'npm ci', allowAlways: false,
    })
    expect(decide({ toolName: 'run_command', args: { command: 'npm ci', sandbox_permissions: 'full_access' } }).action).toBe('deny')
    const refused = new Set([alwaysAllowKey('run_command', 'npm ci')])
    const again = decide({ toolName: 'run_command', args, refusedEscalations: refused })
    expect(again.action).toBe('deny')
    if (again.action === 'deny') expect(again.message).toMatch(/already refused/)
  })

  it('the marker tells the model it may retry once with a justification', () => {
    const marker = sandboxEscalationMarker(true)
    expect(marker).toContain('ONCE')
    expect(marker).toContain('"sandbox_permissions": "full_access"')
    expect(marker).toContain('"justification"')
    expect(marker).toContain('outbound network')
    expect(sandboxEscalationMarker(false)).not.toContain('network')
  })

  it('refusal messages are model-directed and say the call did not run', () => {
    for (const outcome of ['deny', 'timeout', 'unavailable'] as const) {
      const msg = approvalRefusalMessage(outcome, 'run_command')
      expect(msg).toMatch(/not run/)
      expect(msg).toMatch(/Do not retry/)
    }
  })
})

describe('git command classes', () => {
  it.each([
    ['status', 'read'], ['log --oneline -5', 'read'], ['diff HEAD', 'read'], ['branch', 'read'], ['branch -a', 'read'],
    ['branch -D x', 'local'], ['commit -m "fix: a thing"', 'local'], ['checkout -b x', 'local'], ['stash list', 'read'],
    ['stash', 'local'], ['push', 'network'], ['pull --rebase', 'network'], ['fetch origin', 'network'],
    ['remote -v', 'read'], ['remote update', 'network'], ['--no-pager log', 'read'], ['-c core.pager=x log', 'outside'],
    ['-C ../other status', 'outside'], ['--git-dir=/x status', 'outside'], ['config --get user.name', 'read'],
    ['config user.name x', 'outside'], ['archive --remote=x HEAD', 'network'],
    ['grep -O x', 'outside'], ['grep --open-files-in-pager=x y', 'outside'], ['grep -n foo', 'read'],
    ['log --output=/tmp/x', 'outside'], ['diff --ext-diff', 'outside'], ['show --textconv HEAD:a', 'outside'],
    ['cat-file --filters HEAD:a', 'outside'], ['help -w log', 'outside'], ['help log', 'read'],
  ])('git %s → %s', (cmd, cls) => {
    expect(classifyGitCommand(cmd)).toBe(cls)
  })

  it.each([
    ['pu"sh" origin main'], ['"pu"sh origin main'], ["pu'sh'"], ['"-"c core.pager=x log'], ["'-c'x log"],
    ['st\\atus'], ['status \\'], ['commit -m "a"b'], ['log "unclosed'], ['status\nlog'], ['status; ls'],
  ])('a word assembled from quoted pieces or escapes never comes back local or read: %s', cmd => {
    expect(parseGitCommand(cmd).ok).toBe(false)
    expect(classifyGitCommand(cmd)).toBe('outside')
    expect(decideToolPermission({ preset: 'workspace', toolName: 'git', args: { command: cmd }, isBuiltin: true, sandboxAvailable: true }))
      .toMatchObject({ action: 'ask', why: 'outside' })
  })

  it('parses plain and wholly quoted words into argv', () => {
    expect(parseGitCommand('commit -m "fix: a thing"')).toEqual({ ok: true, argv: ['commit', '-m', 'fix: a thing'] })
    expect(parseGitCommand(`commit -m "it's done"`)).toEqual({ ok: true, argv: ['commit', '-m', "it's done"] })
    expect(parseGitCommand("log  --format='%h %s'  -3")).toEqual({ ok: false, error: expect.any(String) })
    expect(parseGitCommand("log --format '%h %s' -3")).toEqual({ ok: true, argv: ['log', '--format', '%h %s', '-3'] })
    expect(parseGitCommand('add ""')).toEqual({ ok: true, argv: ['add', ''] })
    expect(parseGitCommand('   ').ok).toBe(false)
  })

  it.each([
    ['frobnicate', 'outside'], ['co main', 'outside'], ['filter-branch --tree-filter x', 'outside'],
    ['mergetool', 'outside'], ['difftool HEAD', 'outside'], ['rebase -x make main', 'outside'],
    ['rebase --exec=make main', 'outside'], ['rebase -i main', 'local'], ['bisect run make', 'outside'],
    ['bisect start', 'local'], ['merge -s ort feature', 'local'], ['merge -s custom feature', 'outside'],
    ['merge --strategy=custom feature', 'outside'], ['cherry-pick -s abc123', 'local'],
    ['add /etc/hosts', 'outside'], ['add ../x', 'outside'], ['add src/a..b.ts', 'local'], ['diff main..feature', 'read'],
    ['log -- ~/x', 'outside'], ['commit -m "../ is fine in a message"', 'local'], ['commit -F /tmp/msg', 'outside'],
    ['format-patch -o ../out HEAD~1', 'outside'], ['init --template=t', 'outside'], ['init', 'local'],
    ['worktree list', 'read'], ['worktree add ../wt', 'outside'], ['config --global --get user.name', 'outside'],
    ['config --file=x --list', 'outside'], ['stash show -p', 'read'], ['help -a', 'read'], ['', 'outside'],
  ])('git %s → %s (allowlist, programs and paths)', (cmd, cls) => {
    expect(classifyGitCommand(cmd)).toBe(cls)
  })

  it('blocks the destructive forms on argv', () => {
    const d = (c: string) => isDestructiveGitArgv((parseGitCommand(c) as { argv: string[] }).argv)
    expect(d('push --force origin main')).toBe(true)
    expect(d('push --force-with-lease')).toBe(true)
    expect(d('push -uf origin x')).toBe(true)
    expect(d('push origin +main')).toBe(true)
    expect(d('reset --hard HEAD~1')).toBe(true)
    expect(d('clean -fd')).toBe(true)
    expect(d('clean -n')).toBe(false)
    expect(d('branch -D x')).toBe(true)
    expect(d('branch -d x')).toBe(false)
    expect(d('push origin main')).toBe(false)
  })

  it('runs with safe options first and no external diff or textconv', () => {
    const argv = hardenedGitArgv(['--no-pager', 'diff', '--stat'], { 'gpg.program': '/opt/homebrew/bin/gpg' })
    expect(argv.slice(0, 2)).toEqual(['-c', 'core.hooksPath=/dev/null'])
    for (const o of ['core.fsmonitor=false', 'core.pager=cat', 'protocol.ext.allow=never', 'core.sshCommand=ssh', 'gpg.program=/opt/homebrew/bin/gpg']) {
      expect(argv[argv.indexOf(o) - 1]).toBe('-c')
    }
    expect(argv.slice(-5)).toEqual(['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--stat'])
    expect(hardenedGitArgv(['commit', '-m', 'x']).slice(-3)).toEqual(['commit', '-m', 'x'])
  })
})

describe('tool catalog under Workspace', () => {
  it('adds the escalation fields to the shell tools only, deterministically', () => {
    const a = applyPermissionPresetToTools(BUILTIN_TOOLS as any[], 'workspace')
    const b = applyPermissionPresetToTools(BUILTIN_TOOLS as any[], undefined)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const run = a.find(t => t.function.name === 'run_command')
    expect(run.function.parameters.properties.sandbox_permissions.enum).toEqual(['full_access'])
    expect(run.function.parameters.required).toEqual(['command'])
    expect(run.function.description).toMatch(/sandbox/)
    const read = a.find(t => t.function.name === 'read_file')
    expect(read).toBe((BUILTIN_TOOLS as any[]).find(t => t.function.name === 'read_file'))
    // The registry itself is untouched.
    expect((BUILTIN_TOOLS as any[]).find(t => t.function.name === 'run_command').function.parameters.properties.sandbox_permissions).toBeUndefined()
  })

  it('leaves the catalog unchanged for Read only and Full access', () => {
    for (const preset of ['read-only', 'full']) {
      expect(JSON.stringify(applyPermissionPresetToTools(BUILTIN_TOOLS as any[], preset))).toBe(JSON.stringify(BUILTIN_TOOLS))
    }
  })
})

describe('Plan mode', () => {
  const plan = (toolName: string, args: Record<string, unknown> = {}, isBuiltin = true) =>
    decideToolPermission({ preset: 'full', toolName, args, isBuiltin, sandboxAvailable: true, plan: true })
  it('lets reading tools run under any preset', () => {
    expect(plan('read_file', { path: 'a' })).toEqual({ action: 'allow', sandbox: false })
    expect(plan('search_files', { pattern: 'x' })).toEqual({ action: 'allow', sandbox: false })
    expect(plan('git', { command: 'log --oneline' })).toEqual({ action: 'allow', sandbox: false })
    expect(plan('github__list_issues', {}, false)).toEqual({ action: 'allow', sandbox: false })
  })
  it('refuses every change without asking, even with Full access', () => {
    for (const [tool, args] of [
      ['write_file', { path: 'a' }], ['edit_file', { path: 'a' }], ['delete_file', { path: 'a' }],
      ['run_command', { command: 'ls' }], ['git', { command: 'commit -m x' }], ['run_applescript', { script: 'beep' }],
    ] as const) {
      const d = plan(tool, args as Record<string, unknown>)
      expect(d.action).toBe('deny')
      if (d.action === 'deny') expect(d.message).toBe(PLAN_MODE_REFUSAL)
    }
    expect(plan('gmail_send_email', {}, false).action).toBe('deny')
  })
})


describe('browser tool permissions', () => {
  const d = (preset: string, args: Record<string, unknown>, extra: Partial<PermissionInput> = {}) =>
    decideToolPermission({ preset, toolName: 'browser', args, isBuiltin: true, sandboxAvailable: true, ...extra })
  it('looking runs, acting asks (not with Full access), Plan refuses acting', () => {
    expect(d('workspace', { action: 'open', url: 'https://example.com' }).action).toBe('allow')
    expect(d('workspace', { action: 'click', ref: 'e3' })).toMatchObject({ action: 'ask', why: 'browser-act' })
    expect(d('full', { action: 'type', ref: 'e3', text: 'x' }).action).toBe('allow')
    expect(d('workspace', { action: 'click', ref: 'e3' }, { plan: true }).action).toBe('deny')
    expect(d('workspace', { action: 'snapshot' }, { plan: true }).action).toBe('allow')
    expect(d('workspace', { action: 'open', url: 'https://x.y' }, { untrustedData: true })).toMatchObject({ action: 'ask', why: 'exfil' })
  })
})

describe('lasting tools: schedule_task and memory', () => {
  const d = (toolName: string, preset: string, extra: Partial<PermissionInput> = {}, args: Record<string, unknown> = {}) =>
    decideToolPermission({ preset, toolName, args, isBuiltin: true, sandboxAvailable: true, ...extra })
  it('schedule_task always asks, Full access too, and Plan refuses it', () => {
    for (const p of ['read-only', 'workspace', 'full']) expect(d('schedule_task', p)).toMatchObject({ action: 'ask', why: 'schedule', allowAlways: false })
    expect(d('schedule_task', 'full', { plan: true }).action).toBe('deny')
  })
  it('remember and forget run, but ask once web or app data is in the chat (Full too); recall always runs', () => {
    expect(d('remember', 'workspace', {}, { text: 'x' }).action).toBe('allow')
    expect(d('remember', 'full', { externalData: true }, { text: 'x' })).toMatchObject({ action: 'ask', why: 'memory-untrusted' })
    expect(d('forget', 'read-only', { untrustedData: true }, { id: 'm1' })).toMatchObject({ action: 'ask', why: 'memory-untrusted' })
    expect(d('recall', 'workspace', { externalData: true }, { query: 'x' }).action).toBe('allow')
    expect(d('remember', 'full', { plan: true }, { text: 'x' }).action).toBe('deny')
  })
})
