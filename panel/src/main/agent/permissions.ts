import { browserActionKind } from '../browser/toolDefinition'

/**
 * Permission presets for the coding agent, per chat.
 *
 *  - "read-only": reading tools run; anything that writes files, runs a shell
 *    command, runs AppleScript or calls an MCP tool asks the user first.
 *  - "workspace" (default): file tools may write inside the working directory
 *    (the executor already refuses paths outside it); shell commands run
 *    inside a macOS Seatbelt sandbox that only allows writes to the working
 *    directory, the spill folder and the temp folders and blocks outbound
 *    network. AppleScript, git network/outside-folder commands, writes to
 *    `.git/hooks` / `.git/config`, and any command when the sandbox is
 *    unavailable ask first. A sandboxed command the sandbox refused may be
 *    retried ONCE with `sandbox_permissions: "full_access"` + a one-line
 *    justification, which asks the user and runs unsandboxed if allowed
 *    (DeepSeek Harness escalation flow).
 *  - "full": no prompts, no sandbox (the behaviour before presets existed).
 *
 * Everything here is pure (no Electron, no I/O) so the decision table is
 * unit-tested; chat.ts wires it to the approval broker and the executor.
 *
 * Escalation vocabulary adapted from DeepSeek Harness
 * (packages/sandbox/sandbox/src/escalation.ts), MIT License, Copyright (c) 2026 DeepSeek.
 */

export type PermissionPreset = 'read-only' | 'workspace' | 'full'

export const DEFAULT_PERMISSION_PRESET: PermissionPreset = 'workspace'

export function normalizePermissionPreset(value: unknown): PermissionPreset {
  return value === 'read-only' || value === 'full' ? value : DEFAULT_PERMISSION_PRESET
}

/** Tools that only read (or are the agent's own bookkeeping). */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'find_files',
  'file_info',
  'get_tree',
  'read_image',
  'read_video',
  'diff_files',
  'count_tokens',
  'get_current_datetime',
  'get_diagnostics',
  'get_process_output',
  'clipboard_read',
  'web_search',
  'ddg_search',
  'fetch_url',
  'ask_user',
  'todo_write',
  'use_skill',
  // Reading memory is the app's own store. remember and forget are decided
  // in decideToolPermission: memory outlives the chat.
  'recall',
])

/** File-writing tools; the executor confines their paths to the working directory. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'patch_file',
  'batch_edit',
  'insert_text',
  'replace_lines',
  'apply_regex',
  'create_directory',
  'delete_file',
  'restore_file',
  'move_file',
  'copy_file',
  'clipboard_write',
])

/** Shell tools: the ones the sandbox wraps and "Always allow" may remember. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['run_command', 'spawn_process'])

/** The one escalation target the shell tools accept. */
export const ESCALATION_TARGET = 'full_access'

export type GitCommandClass = 'read' | 'local' | 'network' | 'outside'

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree',
  'describe', 'shortlog', 'grep', 'cat-file', 'rev-list', 'merge-base',
  'show-ref', 'whatchanged', 'count-objects', 'help', 'version', '--version',
  'check-ignore', 'check-attr', 'name-rev', 'for-each-ref', 'range-diff', 'annotate',
])
const GIT_NETWORK_SUBCOMMANDS = new Set([
  'push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule', 'send-email', 'request-pull',
])
/**
 * Subcommands that change the repository in the working directory and run no
 * program of their own. Anything not named in one of these lists (aliases,
 * `git-<name>` programs on PATH, plumbing) asks.
 */
const GIT_LOCAL_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'branch', 'tag',
  'merge', 'rebase', 'cherry-pick', 'revert', 'mv', 'rm', 'init', 'notes', 'apply', 'am',
  'clean', 'reflog', 'remote', 'config', 'bisect', 'worktree', 'format-patch', 'stage',
  'sparse-checkout',
])
/** Subcommands whose -m / --message takes the commit message (its text is not a path). */
const GIT_MESSAGE_SUBCOMMANDS = new Set(['commit', 'tag', 'notes', 'stash', 'merge'])
/** Merge strategies git ships; any other name runs a `git-merge-<name>` program. */
const GIT_BUILTIN_STRATEGIES = new Set(['ort', 'recursive', 'resolve', 'octopus', 'ours', 'subtree'])

export type GitParse = { ok: true; argv: string[] } | { ok: false; error: string }

/**
 * Split the `git` tool's argument string into argv, once. The executor runs
 * exactly this argv with no shell, so what is classified is what runs.
 *
 * Accepted: plain words, and words wholly inside one pair of quotes ('…' or
 * "…"). Refused: shell characters, backslashes, control characters, and a
 * quote anywhere else in a word (so a word cannot be assembled from pieces
 * that read differently than they run).
 */
export function parseGitCommand(command: unknown): GitParse {
  if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'Missing required parameter: command' }
  // eslint-disable-next-line no-control-regex
  if (/[;|&`$(){}<>\\\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) {
    return { ok: false, error: 'contains shell characters, a backslash or a control character' }
  }
  const argv: string[] = []
  let i = 0
  const n = command.length
  const space = (c: string) => c === ' ' || c === '\t'
  while (i < n) {
    while (i < n && space(command[i])) i++
    if (i >= n) break
    const c = command[i]
    if (c === '"' || c === "'") {
      const close = command.indexOf(c, i + 1)
      if (close < 0) return { ok: false, error: 'has an unmatched quote' }
      if (close + 1 < n && !space(command[close + 1])) return { ok: false, error: 'joins a quoted part to other text in one word' }
      argv.push(command.slice(i + 1, close))
      i = close + 1
      continue
    }
    let j = i
    while (j < n && !space(command[j])) j++
    const word = command.slice(i, j)
    if (/["']/.test(word)) return { ok: false, error: 'has a quote inside a word' }
    argv.push(word)
    i = j
  }
  if (argv.length === 0) return { ok: false, error: 'Missing required parameter: command' }
  return { ok: true, argv }
}

/** An option that makes a reading git subcommand run another program or write a file. */
function isGitRunOrWriteOption(word: string): boolean {
  return (
    /^-[A-Za-z]*O/.test(word) ||
    /^--open-files-in-pager(=|$)/.test(word) ||
    /^--output(=|$)/.test(word) ||
    /^--ext-diff$/.test(word) ||
    /^--textconv$/.test(word) ||
    /^--filters$/.test(word) ||
    /^--exec(=|$)/.test(word) ||
    /^--upload-pack(=|$)/.test(word)
  )
}

/** A word that names a place outside the working directory: an absolute path, `~`, or a `..` path segment. */
function namesOutsidePath(word: string): boolean {
  const value = word.startsWith('-') && word.includes('=') ? word.slice(word.indexOf('=') + 1) : word
  if (!value) return false
  if (value.startsWith('/') || value.startsWith('~')) return true
  return value.split('/').includes('..')
}

/** A short-option cluster (`-ix`) or long option that contains the given letter / name. */
const hasShort = (w: string, letter: string) => /^-[A-Za-z]+$/.test(w) && w.slice(1).includes(letter)

/**
 * Classify the `git` tool's arguments (without the leading "git").
 *  - outside: a global option before the subcommand (-C, -c, --git-dir,
 *    --work-tree, --exec-path …), a config write, an unknown subcommand or
 *    alias, a path outside the working directory, or a form that runs another
 *    program (rebase --exec, bisect run, a custom merge strategy …);
 *  - network: talks to a remote;
 *  - read: only reads the repository;
 *  - local: changes the repository in the working directory.
 * A command that does not parse cleanly counts as outside (the executor
 * refuses it anyway).
 */
export function classifyGitCommand(command: string): GitCommandClass {
  const parsed = parseGitCommand(command)
  if (!parsed.ok) return 'outside'
  return classifyGitArgv(parsed.argv)
}

export function classifyGitArgv(words: readonly string[]): GitCommandClass {
  let i = 0
  while (i < words.length && words[i].startsWith('-') && words[i] !== '--version') {
    if (words[i] !== '--no-pager' && words[i] !== '-P') return 'outside'
    i++
  }
  const sub = words[i] ?? ''
  const rest = words.slice(i + 1)
  if (!sub) return 'outside'
  if (GIT_NETWORK_SUBCOMMANDS.has(sub)) return 'network'
  if (sub === 'remote' && rest.some(w => w === 'update' || w === 'prune' || w === 'show' || w === 'set-head')) return 'network'
  if (sub === 'archive' && rest.some(w => w.startsWith('--remote'))) return 'network'
  if (!GIT_READ_SUBCOMMANDS.has(sub) && !GIT_LOCAL_SUBCOMMANDS.has(sub)) return 'outside'
  // Out of the working directory: absolute paths, ~ and .. segments anywhere in the arguments.
  if (pathWords(sub, rest).some(namesOutsidePath)) return 'outside'
  // a "reading" subcommand stops being one with options that run a program or write a file: grep -O opens matches
  // in a program it names, --output writes anywhere, --ext-diff/--textconv/--filters run configured commands, and
  // help -w/-m/-i starts a viewer
  if (GIT_READ_SUBCOMMANDS.has(sub) && rest.some(isGitRunOrWriteOption)) return 'outside'
  if (sub === 'help' && rest.some(w => w.startsWith('-') && w !== '-a' && w !== '--all' && w !== '-g' && w !== '--guides')) return 'outside'
  if (GIT_READ_SUBCOMMANDS.has(sub)) return 'read'
  // Local subcommands with forms that run another program.
  if (sub === 'rebase' && rest.some(w => /^--exec(=|$)/.test(w) || hasShort(w, 'x'))) return 'outside'
  if (sub === 'bisect' && rest[0] === 'run') return 'outside'
  if ((sub === 'merge' || sub === 'rebase') && strategyNotBuiltin(rest, true)) return 'outside'
  if ((sub === 'revert' || sub === 'cherry-pick') && strategyNotBuiltin(rest, false)) return 'outside'
  // A template directory is copied into .git (hooks included); a separate git dir can live anywhere.
  if (sub === 'init' && rest.some(w => /^--(template|separate-git-dir)(=|$)/.test(w))) return 'outside'
  if (sub === 'format-patch' && rest.some(isGitRunOrWriteOption)) return 'outside'
  if (sub === 'am' && rest.some(w => /^--exec(=|$)/.test(w))) return 'outside'
  const listOnly = (flags: string[]) => rest.every(w => flags.includes(w))
  if (sub === 'branch' && listOnly(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes', '--merged', '--no-merged'])) return 'read'
  if (sub === 'tag' && listOnly(['-l', '--list', '-n'])) return 'read'
  if (sub === 'remote' && listOnly(['-v', '--verbose'])) return 'read'
  if (sub === 'stash' && (rest[0] === 'list' || rest[0] === 'show')) {
    return rest.some(isGitRunOrWriteOption) ? 'outside' : 'read'
  }
  if (sub === 'worktree' && rest[0] === 'list') return 'read'
  if (sub === 'config' && rest.some(w => w === '--get' || w === '--list' || w === '-l' || w === '--get-all' || w === '--get-regexp')) {
    return rest.some(w => /^--(file|blob|global|system)(=|$)/.test(w) || w === '-f') ? 'outside' : 'read'
  }
  // core.hooksPath, aliases, pagers, sshCommand …: config can make later git runs execute code.
  if (sub === 'config') return 'outside'
  if (sub === 'reflog' && (rest.length === 0 || rest[0] === 'show')) return 'read'
  return 'local'
}

/** The words to check for outside paths: everything except a commit message given with -m. */
function pathWords(sub: string, rest: readonly string[]): string[] {
  if (!GIT_MESSAGE_SUBCOMMANDS.has(sub)) return [...rest]
  const out: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]
    if (w === '-m' || w === '--message' || /^-[A-Za-z]+m$/.test(w)) { k++; continue }
    if (w.startsWith('--message=') || /^-m./.test(w)) continue
    out.push(w)
  }
  return out
}

function strategyNotBuiltin(rest: readonly string[], shortS: boolean): boolean {
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]
    let name: string | undefined
    if (w === '--strategy' || (shortS && w === '-s')) name = rest[k + 1]
    else if (w.startsWith('--strategy=')) name = w.slice('--strategy='.length)
    else if (shortS && /^-s.+/.test(w)) name = w.slice(2)
    if (name !== undefined && !GIT_BUILTIN_STRATEGIES.has(name)) return true
  }
  return false
}

/** A destructive git form the tool never runs (run_command is there for those). */
export function isDestructiveGitArgv(words: readonly string[]): boolean {
  let i = 0
  while (i < words.length && words[i].startsWith('-') && words[i] !== '--version') i++
  const sub = words[i] ?? ''
  const rest = words.slice(i + 1)
  if (sub === 'push') return rest.some(w => w.startsWith('--force') || hasShort(w, 'f') || (w.startsWith('+') && w.length > 1))
  if (sub === 'reset') return rest.includes('--hard')
  if (sub === 'clean') return rest.some(w => w === '--force' || hasShort(w, 'f'))
  if (sub === 'branch') return rest.some(w => hasShort(w, 'D'))
  return false
}

const GIT_DIFF_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'whatchanged'])

/**
 * The argv the executor runs for an accepted git command: options that keep
 * the repository's own config from naming programs (hooks, pager, fsmonitor,
 * ssh, signing) go first, and diff-producing subcommands get
 * --no-ext-diff --no-textconv unless the user's command asked otherwise
 * (those forms already need approval). `pinned` carries the user's own
 * global values for the program settings (or git's defaults).
 */
export function hardenedGitArgv(argv: readonly string[], pinned: Readonly<Record<string, string>> = {}): string[] {
  const opts: string[] = [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.pager=cat',
    'core.askPass=',
    'protocol.ext.allow=never',
    `core.sshCommand=${pinned['core.sshCommand'] || 'ssh'}`,
    `gpg.program=${pinned['gpg.program'] || 'gpg'}`,
    `gpg.ssh.program=${pinned['gpg.ssh.program'] || 'ssh-keygen'}`,
    `gpg.x509.program=${pinned['gpg.x509.program'] || 'gpgsm'}`,
  ]
  const out: string[] = []
  for (const o of opts) out.push('-c', o)
  let i = 0
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--version') out.push(argv[i++])
  const sub = argv[i]
  if (sub === undefined) return out
  out.push(sub)
  const rest = argv.slice(i + 1)
  if (GIT_DIFF_SUBCOMMANDS.has(sub)) {
    // Inserted before the user's words so an approved --ext-diff/--textconv still wins.
    out.push('--no-ext-diff', '--no-textconv')
  }
  out.push(...rest)
  return out
}

/** The program settings hardenedGitArgv pins to the user's own (global) values. */
export const GIT_PINNED_PROGRAM_KEYS = ['core.sshCommand', 'gpg.program', 'gpg.ssh.program', 'gpg.x509.program'] as const

/** Environment for every git run: no pager, no editor, no terminal prompt. */
export const GIT_SAFE_ENV: Readonly<Record<string, string>> = {
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EDITOR: 'false',
  GIT_SEQUENCE_EDITOR: 'false',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

/** A path inside `.git/hooks` or `.git/config`: code that runs later, unconfined. */
export function isProtectedGitPath(path: unknown): boolean {
  if (typeof path !== 'string' || !path) return false
  const parts = path.replace(/\\/g, '/').split('/').filter(p => p && p !== '.')
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === '.git' && (parts[i + 1] === 'hooks' || parts[i + 1] === 'config')) return true
  }
  return false
}

/**
 * A path inside a `.git` folder, or a `.git` file/folder itself, at any depth
 * and in any letter case (APFS is case-insensitive). The executor checks the
 * resolved real path with this; the permission decision checks the name given.
 */
export function isGitDirPath(path: unknown): boolean {
  if (typeof path !== 'string' || !path) return false
  return path.replace(/\\/g, '/').split('/').some(p => p.toLowerCase() === '.git')
}

function writeTargets(args: Record<string, unknown>): string[] {
  return ['path', 'source', 'destination']
    .map(k => args[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** The shown target of a call: command, script, path(s) or arguments. */
export function describeToolSubject(toolName: string, args: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(toolName)) return String(args.command ?? '')
  if (toolName === 'run_applescript') return String(args.script ?? '')
  if (toolName === 'git') return `git ${String(args.command ?? '')}`.trim()
  if (toolName === 'move_file' || toolName === 'copy_file') {
    return `${String(args.source ?? '')} → ${String(args.destination ?? '')}`
  }
  if (typeof args.path === 'string') return args.path
  if (toolName === 'clipboard_write') return String(args.text ?? '')
  try {
    const json = JSON.stringify(args)
    return json === '{}' ? '' : json
  } catch {
    return ''
  }
}

export type ApprovalKind = 'shell' | 'escalation' | 'write' | 'applescript' | 'git' | 'mcp' | 'tool' | 'app'

export type PermissionDecision =
  | { action: 'allow'; sandbox: boolean }
  | { action: 'ask'; kind: ApprovalKind; subject: string; justification?: string; allowAlways: boolean; why: string }
  | { action: 'deny'; message: string }

export interface PermissionInput {
  preset: unknown
  toolName: string
  args: Record<string, unknown>
  isBuiltin: boolean
  /** Seatbelt usable on this Mac. */
  sandboxAvailable: boolean
  /** Exact shell commands the user chose "Always allow" for in this chat. */
  alwaysAllowed?: ReadonlySet<string>
  /** Escalations the user already refused in this turn (keys from alwaysAllowKey). */
  refusedEscalations?: ReadonlySet<string>
  /** Plan mode: only reading tools run; everything else is refused, never asked. */
  plan?: boolean
  /** App data (email, messages, documents) is already in this turn. */
  untrustedData?: boolean
  /** Web pages or MCP tool results are in this turn (memory writes ask). */
  externalData?: boolean
}

/** Tools that send something to the web: they ask once app data is in the turn. */
export const EGRESS_TOOLS: ReadonlySet<string> = new Set(['fetch_url', 'web_search', 'ddg_search', 'browser'])

/** The tool result for a call Plan mode refused. */
export const PLAN_MODE_REFUSAL =
  'Not run: Plan mode is on, so nothing may be changed or run yet. Keep reading what you need, then reply with a short numbered plan (files to change, commands to run, how to check). The user switches to Auto to carry it out.'

/** Appended to the user's message for a Plan mode turn (request only, never saved). */
export const PLAN_MODE_NOTE =
  '[Plan mode: read and search as much as you need, but do not change files or run commands; those tools are refused. Finish with a short numbered plan: what you would change and where, what you would run, and how to check it worked. Note open questions.]'

/** A call Plan mode lets through: reading built-ins, read-only git, read-named MCP tools. */
export function planModeAllows(toolName: string, args: Record<string, unknown>, isBuiltin: boolean): boolean {
  if (!isBuiltin) return looksReadOnlyToolName(toolName)
  if (toolName === 'browser') return browserActionKind(args) === 'read'
  if (READ_TOOLS.has(toolName)) return true
  if (toolName === 'git') return classifyGitCommand(String(args.command ?? '')) === 'read'
  return false
}

export function alwaysAllowKey(toolName: string, command: unknown): string {
  return `${toolName}\u0000${typeof command === 'string' ? command : ''}`
}

/** `sandbox_permissions` and `justification` travel together (DSH rule). */
export function readEscalation(args: Record<string, unknown>):
  | { requested: false }
  | { requested: true; justification: string }
  | { requested: true; error: string } {
  const perm = args.sandbox_permissions
  const just = args.justification
  if (perm === undefined || perm === null || perm === '') {
    if (typeof just === 'string' && just.trim()) {
      return { requested: true, error: 'invalid escalation: justification is only valid together with sandbox_permissions' }
    }
    return { requested: false }
  }
  if (perm !== ESCALATION_TARGET) {
    return { requested: true, error: `invalid escalation: sandbox_permissions must be "${ESCALATION_TARGET}"` }
  }
  if (typeof just !== 'string' || !just.trim()) {
    return { requested: true, error: 'invalid escalation: sandbox_permissions requires a one-line justification' }
  }
  return { requested: true, justification: just.trim().split('\n')[0].trim().slice(0, 300) }
}

const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'find', 'describe', 'show', 'view', 'lookup', 'count', 'retrieve', 'browse', 'inspect'])
const WRITE_WORDS = new RegExp('^(' + [
  'create', 'update', 'delete', 'remove', 'send', 'post', 'write', 'edit', 'set', 'put', 'patch', 'insert', 'upsert', 'upload',
  'move', 'rename', 'add', 'archive', 'unarchive', 'publish', 'unpublish', 'reply', 'forward', 'execute', 'run', 'exec', 'invoke',
  'call', 'trigger', 'merge', 'close', 'reopen', 'cancel', 'approve', 'accept', 'reject', 'decline', 'pay', 'refund', 'charge',
  'transfer', 'book', 'purchase', 'order', 'install', 'uninstall', 'kill', 'drop', 'reset', 'modify', 'push', 'commit', 'share',
  'unshare', 'invite', 'subscribe', 'unsubscribe', 'mark', 'star', 'unstar', 'label', 'assign', 'unassign', 'replace', 'save',
  'submit', 'restart', 'start', 'stop', 'clear', 'apply', 'enable', 'disable', 'revoke', 'grant', 'sync', 'deploy', 'schedule',
  'toggle', 'lock', 'unlock', 'block', 'unblock', 'mute', 'unmute', 'follow', 'unfollow', 'like', 'unlike', 'comment', 'react',
  'pin', 'unpin', 'kick', 'ban', 'trash', 'purge', 'destroy', 'erase', 'wipe', 'import', 'generate', 'make', 'new', 'change',
  'configure', 'register', 'login', 'logout', 'checkin', 'check', 'join', 'leave', 'mint', 'swap', 'sign', 'approve', 'tag',
  'move', 'copy', 'duplicate', 'restore', 'revert', 'rollback', 'scale', 'resize', 'reboot', 'shutdown', 'terminate', 'suspend',
  'resume', 'query', 'fetch', 'sql', 'eval', 'script', 'shell', 'command', 'and',
].join('|') + ')(s|d|ed|ing|es)?$')

export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Words naming an action that only reads: the first is a read verb and no
 * word anywhere could mean a change ("search_and_replace", "fetch_and_save",
 * "status__restart" all fail). Ambiguous verbs (query, fetch, check, run)
 * count as changes. Single-word names ("fetch", "query") never qualify.
 */
export function wordsReadOnly(words: string[], readVerbs: ReadonlySet<string> = READ_VERBS, verbLast = false): boolean {
  if (words.length < 2) return false
  const verbAt = readVerbs.has(words[0]) ? 0 : verbLast && readVerbs.has(words[words.length - 1]) ? words.length - 1 : -1
  if (verbAt < 0) return false
  return !words.some((w, i) => i !== verbAt && WRITE_WORDS.test(w) && !readVerbs.has(w))
}

/** App actions (Composio slugs without the toolkit) also read with fetch/query, verb first or last. */
const APP_READ_VERBS: ReadonlySet<string> = new Set([...READ_VERBS, 'fetch', 'query'])
export function appActionReadOnly(words: string[]): boolean {
  return wordsReadOnly(words, APP_READ_VERBS, true)
}

/**
 * An MCP tool whose name reads ("get_issue", "searchFiles", or after a
 * server prefix "github__list_repos" / "github.list_repos"). Anything else
 * counts as possibly changing something, so it asks.
 */
export function looksReadOnlyToolName(name: string): boolean {
  const sep = name.includes('__') ? '__' : name.includes('.') ? '.' : null
  const action = sep ? name.slice(name.lastIndexOf(sep) + sep.length) : name
  if (sep && toolWords(name.slice(0, name.lastIndexOf(sep))).some(w => WRITE_WORDS.test(w))) return false
  return wordsReadOnly(toolWords(action))
}

/**
 * Decide what one tool call needs before it runs. "allow" carries whether to
 * run the shell inside the Seatbelt sandbox; "ask" means show an approval
 * card (an approved call runs unsandboxed — the user approved it as shown);
 * "deny" refuses without asking.
 */
export function decideToolPermission(input: PermissionInput): PermissionDecision {
  const preset = normalizePermissionPreset(input.preset)
  const { toolName, args } = input
  const subject = describeToolSubject(toolName, args)
  // Exfiltration guard: after an app's data entered the turn, text inside it
  // could ask the model to send that data to a URL. Web tools ask first
  // (except with Full access, where the user chose no prompts).
  if (input.untrustedData && preset !== 'full') {
    if (input.isBuiltin && EGRESS_TOOLS.has(toolName)) return { action: 'ask', kind: 'tool', subject, why: 'exfil', allowAlways: false }
    // Any MCP tool may reach the network; with app data in the chat it asks.
    if (!input.isBuiltin) return { action: 'ask', kind: 'mcp', subject, why: 'exfil', allowAlways: false }
  }
  if (input.plan) {
    return planModeAllows(toolName, args, input.isBuiltin)
      ? { action: 'allow', sandbox: false }
      : { action: 'deny', message: PLAN_MODE_REFUSAL }
  }
  // These outlive the chat, so they are decided before Full access:
  // a scheduled task runs later on its own, and memory reaches every chat.
  if (input.isBuiltin && toolName === 'schedule_task') {
    return { action: 'ask', kind: 'tool', subject, why: 'schedule', allowAlways: false }
  }
  if (input.isBuiltin && (toolName === 'remember' || toolName === 'forget')) {
    // Text from a web page, an app or an MCP tool could plant a "memory".
    if (input.untrustedData || input.externalData) return { action: 'ask', kind: 'tool', subject, why: 'memory-untrusted', allowAlways: false }
    return { action: 'allow', sandbox: false }
  }
  if (preset === 'full') return { action: 'allow', sandbox: false }

  const ask = (kind: ApprovalKind, why: string, extra: Partial<{ allowAlways: boolean; justification: string }> = {}): PermissionDecision => ({
    action: 'ask',
    kind,
    subject,
    why,
    allowAlways: extra.allowAlways ?? false,
    ...(extra.justification ? { justification: extra.justification } : {}),
  })

  if (!input.isBuiltin) {
    if (preset === 'read-only') return ask('mcp', 'read-only')
    // Workspace: an MCP tool acts outside the sandbox (mail, files, the web),
    // so only tools whose name says they read run without asking. "Always
    // allow" remembers the tool for this chat.
    if (looksReadOnlyToolName(toolName)) return { action: 'allow', sandbox: false }
    if (input.alwaysAllowed?.has(alwaysAllowKey(toolName, args.command))) return { action: 'allow', sandbox: false }
    return ask('mcp', 'mcp-write', { allowAlways: true })
  }
  if (READ_TOOLS.has(toolName)) return { action: 'allow', sandbox: false }

  if (SHELL_TOOLS.has(toolName)) {
    const key = alwaysAllowKey(toolName, args.command)
    const escalation = readEscalation(args)
    if (escalation.requested && 'error' in escalation) return { action: 'deny', message: `${escalation.error}. The command was not run.` }
    if (escalation.requested) {
      if (preset === 'workspace' && input.refusedEscalations?.has(key)) {
        return {
          action: 'deny',
          message: 'The user already refused running this exact command outside the sandbox in this turn. It was not run. Do not ask again; stop and explain what you need instead.',
        }
      }
      if (input.alwaysAllowed?.has(key)) return { action: 'allow', sandbox: false }
      return ask('escalation', 'escalation', { justification: escalation.justification })
    }
    if (input.alwaysAllowed?.has(key)) return { action: 'allow', sandbox: false }
    if (preset === 'workspace' && input.sandboxAvailable) return { action: 'allow', sandbox: true }
    return ask('shell', preset === 'read-only' ? 'read-only' : 'no-sandbox', { allowAlways: true })
  }

  if (toolName === 'run_applescript') return ask('applescript', preset)

  if (toolName === 'git') {
    const cls = classifyGitCommand(String(args.command ?? ''))
    if (preset === 'read-only') return cls === 'read' ? { action: 'allow', sandbox: false } : ask('git', 'read-only')
    if (cls === 'network') return ask('git', 'network')
    if (cls === 'outside') return ask('git', 'outside')
    // Local git work runs as before (metacharacters are refused, the
    // destructive set is blocked in the executor). Not sandboxed: the repo's
    // .git may sit above the working directory.
    return { action: 'allow', sandbox: false }
  }

  if (WRITE_TOOLS.has(toolName)) {
    if (preset === 'read-only') return ask('write', 'read-only')
    if (writeTargets(args).some(p => isProtectedGitPath(p) || isGitDirPath(p))) return ask('write', 'git-internals')
    return { action: 'allow', sandbox: false }
  }

  // Browser: looking runs; clicking, typing and choosing on a page ask.
  if (toolName === 'browser') {
    return browserActionKind(args) === 'read' ? { action: 'allow', sandbox: false } : ask('tool', 'browser-act')
  }
  // An unknown built-in: fail closed to asking.
  return ask('tool', preset)
}

// ─── Model-facing texts ─────────────────────────────────────────────────────

export type ApprovalOutcome = 'allow-once' | 'allow-always' | 'deny' | 'timeout' | 'unavailable' | 'aborted'

/** The tool result the model sees when an approval did not grant the call. */
export function approvalRefusalMessage(outcome: Exclude<ApprovalOutcome, 'allow-once' | 'allow-always'>, toolName: string, timeoutMinutes = 5): string {
  switch (outcome) {
    case 'deny':
      return `Permission denied: the user did not allow this ${toolName} call, so it was not run. Do not retry it or work around it with another tool. Continue with what you can do without it, or tell the user what you need and why.`
    case 'timeout':
      return `Permission not granted: the user did not answer the approval request within ${timeoutMinutes} minutes, so this ${toolName} call was not run. Do not retry it; tell the user what you need approved and why.`
    case 'unavailable':
      return `Permission not granted: the approval request could not be shown (the MLX Harness window is closed), so this ${toolName} call was not run. Do not retry it; tell the user what you need approved and why.`
    case 'aborted':
      return '(Generation was stopped)'
  }
}

/** Appended to a sandboxed command's failed result when the sandbox may be the cause. */
export function sandboxEscalationMarker(networkBlocked: boolean): string {
  const what = networkBlocked
    ? 'writes outside the working directory and outbound network are blocked'
    : 'writes outside the working directory are blocked'
  return (
    `\n\n[sandbox: this command ran under Workspace permissions — ${what}]\n` +
    `[sandbox: if the failure above is the sandbox, you may retry this exact command ONCE with ` +
    `"sandbox_permissions": "${ESCALATION_TARGET}" and a one-line "justification"; the user is asked to approve it. ` +
    `If they refuse, stop and explain instead of working around it.]`
  )
}

// ─── Tool catalog ───────────────────────────────────────────────────────────

interface CatalogTool {
  type?: string
  function: { name: string; description?: string; parameters?: any }
}

const SANDBOX_NOTE =
  ' Runs in a sandbox: it may write only inside the working directory and temp folders, and outbound network is blocked.'

/**
 * In Workspace, the shell tools advertise the escalation fields and say they
 * are sandboxed. A pure function of the preset, so the catalog stays
 * byte-identical across a chat's requests (prefix-cache discipline).
 */
export function applyPermissionPresetToTools<T extends CatalogTool>(tools: readonly T[], preset: unknown): T[] {
  if (normalizePermissionPreset(preset) !== 'workspace') return [...tools]
  return tools.map(tool => {
    if (!SHELL_TOOLS.has(tool.function.name)) return tool
    const params = tool.function.parameters ?? { type: 'object', properties: {} }
    return {
      ...tool,
      function: {
        ...tool.function,
        description: `${tool.function.description ?? ''}${SANDBOX_NOTE}`,
        parameters: {
          ...params,
          properties: {
            ...(params.properties ?? {}),
            sandbox_permissions: {
              type: 'string',
              enum: [ESCALATION_TARGET],
              description:
                'Only to retry, once, the exact command the sandbox just blocked: runs it outside the sandbox after the user approves.',
            },
            justification: {
              type: 'string',
              description: 'One sentence shown to the user explaining why the command needs to run outside the sandbox. Required with sandbox_permissions.',
            },
          },
        },
      },
    }
  })
}
