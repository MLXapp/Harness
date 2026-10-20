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
])
const GIT_NETWORK_SUBCOMMANDS = new Set([
  'push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule', 'send-email', 'request-pull',
])

function splitWords(command: string): string[] {
  // gitCommand already refuses shell metacharacters; quotes are the only
  // structure left, and a quoted word never changes the subcommand.
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, ''))
}

/**
 * Classify the argument string of the `git` tool (without the leading "git").
 *  - outside: a global option before the subcommand (-C, -c, --git-dir,
 *    --work-tree, --exec-path …) can point git elsewhere or run code;
 *  - network: talks to a remote;
 *  - read: only reads the repository;
 *  - local: changes the repository in the working directory.
 */
export function classifyGitCommand(command: string): GitCommandClass {
  const words = splitWords(command.trim())
  let i = 0
  while (i < words.length && words[i].startsWith('-') && words[i] !== '--version') {
    if (words[i] !== '--no-pager' && words[i] !== '-P') return 'outside'
    i++
  }
  const sub = words[i] ?? ''
  const rest = words.slice(i + 1)
  if (GIT_NETWORK_SUBCOMMANDS.has(sub)) return 'network'
  if (sub === 'remote' && rest.some(w => w === 'update' || w === 'prune' || w === 'show' || w === 'set-head')) return 'network'
  if (sub === 'archive' && rest.some(w => w.startsWith('--remote'))) return 'network'
  if (GIT_READ_SUBCOMMANDS.has(sub)) return 'read'
  const listOnly = (flags: string[]) => rest.every(w => flags.includes(w))
  if (sub === 'branch' && listOnly(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes', '--merged', '--no-merged'])) return 'read'
  if (sub === 'tag' && listOnly(['-l', '--list', '-n'])) return 'read'
  if (sub === 'remote' && listOnly(['-v', '--verbose'])) return 'read'
  if (sub === 'stash' && (rest[0] === 'list' || rest[0] === 'show')) return 'read'
  if (sub === 'config' && rest.some(w => w === '--get' || w === '--list' || w === '-l' || w === '--get-all' || w === '--get-regexp')) return 'read'
  if (sub === 'reflog' && (rest.length === 0 || rest[0] === 'show')) return 'read'
  return 'local'
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

export type ApprovalKind = 'shell' | 'escalation' | 'write' | 'applescript' | 'git' | 'mcp' | 'tool'

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
    return preset === 'read-only' ? ask('mcp', 'read-only') : { action: 'allow', sandbox: false }
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
    return { action: 'allow', sandbox: input.sandboxAvailable }
  }

  if (WRITE_TOOLS.has(toolName)) {
    if (preset === 'read-only') return ask('write', 'read-only')
    if (writeTargets(args).some(isProtectedGitPath)) return ask('write', 'git-internals')
    return { action: 'allow', sandbox: false }
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
      return `Permission not granted: the approval request could not be shown (the MLX Studio window is closed), so this ${toolName} call was not run. Do not retry it; tell the user what you need approved and why.`
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
