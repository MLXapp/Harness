// MLX Harness — Coding Tool Integration IPC
// Non-destructive config management for Claude Code, Codex CLI, OpenCode,
// OpenClaw, and Hermes Agent
import { ipcMain } from 'electron'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dump as dumpYAML, load as loadYAML } from 'js-yaml'

// Tag to identify our entries in other tools' configs. New entries are written
// as '_mlxharness' (provider keys 'mlxharness', API-key placeholder
// 'mlxharness', Codex providers 'MLXHARNESS_*'). Up to 0.2.x they were written
// as '_mlxstudio' / 'mlxstudio' / 'MLXSTUDIO_*' (upstream vMLX's spelling):
// those legacy ids are kept on purpose so entries saved by earlier versions are
// still found, migrated on the next write and removed. Both are recognised.
const HARNESS_TAG = '_mlxharness'
const LEGACY_TAG = '_mlxstudio'
const HARNESS_ID = 'mlxharness'
const LEGACY_ID = 'mlxstudio'
/** Non-empty API key the local server ignores. */
const API_KEY_PLACEHOLDER = HARNESS_ID

/** An entry we wrote (current or legacy tag). */
function isOurs(entry: any): boolean {
  return !!(entry?.[HARNESS_TAG] || entry?.[LEGACY_TAG])
}

interface ToolConfig {
  detect: () => boolean
  installCmd: string
  installArgs: string[]
  configPath: string
  getEntries: () => Array<{ label: string; baseUrl: string }>
  addEntry: (baseUrl: string, modelName: string, port: number | null, limits: CodingToolModelLimits) => void
  removeEntry: (label: string) => void
}

interface CodingToolModelLimits {
  context: number
  output: number
}

const FALLBACK_CODING_TOOL_LIMITS: CodingToolModelLimits = {
  context: 32768,
  output: 4096,
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

async function getCodingToolModelLimits(baseUrl: string, modelName: string): Promise<CodingToolModelLimits> {
  const limits: CodingToolModelLimits = { ...FALLBACK_CODING_TOOL_LIMITS }
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
    if (health.ok) {
      const body = await health.json()
      limits.context = normalizePositiveInt(body?.max_prompt_tokens) ?? limits.context
    }
  } catch {}

  try {
    const encoded = encodeURIComponent(modelName)
    const caps = await fetch(`${baseUrl}/v1/models/${encoded}/capabilities`, {
      signal: AbortSignal.timeout(1500),
    })
    if (caps.ok) {
      const body = await caps.json()
      limits.output =
        normalizePositiveInt(body?.sampling_defaults?.max_new_tokens) ??
        normalizePositiveInt(body?.sampling_defaults?.max_tokens) ??
        limits.output
    }
  } catch {}

  return limits
}

/**
 * Thrown when a user's config file exists but cannot be parsed.
 *
 * This distinction is load-bearing. `safeReadJSON` used to collapse "absent"
 * and "unparseable" into the same `null`, and every addEntry does
 * `safeReadJSON(path) || {}` before `safeWriteJSON` — so an existing config we
 * merely failed to PARSE was overwritten by our single entry. That destroys
 * real user data, and it is reachable without any corruption: openclaw.json is
 * documented as JSON5, so comments or a trailing comma are perfectly legal
 * there and JSON.parse rejects them.
 *
 * Absent is safe to create. Unparseable must REFUSE and say so.
 */
export class UnreadableConfigError extends Error {
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(
      `Config file exists but could not be parsed: ${path} — ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Refusing to overwrite it. Fix or move the file, then retry.`,
    )
    this.name = 'UnreadableConfigError'
  }
}

/** Read a JSON config. Returns null ONLY when the file does not exist. */
function safeReadJSON(path: string): any {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    throw new UnreadableConfigError(path, err)
  }
  // An empty/whitespace-only file is treated as absent: nothing to preserve,
  // and JSON.parse would reject it.
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new UnreadableConfigError(path, err)
  }
}

/**
 * Read a JSON config for DISPLAY only — never for a read-modify-write.
 *
 * getEntries must not explode the settings panel just because one unrelated
 * tool has a malformed file, so it degrades to "no entries". Writers must use
 * safeReadJSON so they refuse instead.
 */
function readJSONForDisplay(path: string): any {
  try {
    return safeReadJSON(path)
  } catch {
    return null
  }
}

function safeReadTOML(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf-8')
  } catch { return null }
}

function safeWriteTOML(path: string, content: string): void {
  if (existsSync(path)) {
    try { copyFileSync(path, path + '.bak') } catch {}
  }
  const dir = path.substring(0, path.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

function safeWriteJSON(path: string, data: any): void {
  // Backup before writing
  if (existsSync(path)) {
    try { copyFileSync(path, path + '.bak') } catch {}
  }
  const dir = path.substring(0, path.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

// Electron strips the user's shell PATH, so `npm` / `pip` must be resolved
// against the same install locations `commandExists` accepts (user report
// 2026-09-04: "Install" for Hermes failed with `spawnSync npm ENOENT`).
function resolveCommand(cmd: string): { file: string; env: NodeJS.ProcessEnv } {
  const dirs = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/node@20/bin',
    '/opt/homebrew/opt/node@22/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(homedir(), '.cargo', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.volta', 'bin'),
    join(homedir(), '.yarn', 'bin'),
  ]
  const env = { ...process.env, PATH: `${process.env.PATH || ''}:${dirs.join(':')}` }
  for (const dir of dirs) {
    const candidate = join(dir, cmd)
    if (existsSync(candidate)) return { file: candidate, env }
  }
  return { file: cmd, env }
}

function commandExists(cmd: string): boolean {
  // Check common install locations (Electron strips user PATH)
  const paths = [
    join(homedir(), '.local', 'bin', cmd),
    join(homedir(), '.npm-global', 'bin', cmd),
    '/usr/local/bin/' + cmd,
    '/usr/bin/' + cmd,
    '/opt/homebrew/bin/' + cmd,
    join(homedir(), '.cargo', 'bin', cmd),
    join(homedir(), '.bun', 'bin', cmd),
    join(homedir(), '.volta', 'bin', cmd),
  ]
  if (paths.some(p => existsSync(p))) return true
  // Fallback: try which with augmented PATH (includes nvm, pnpm, yarn)
  try {
    const extraPaths = [
      `${homedir()}/.local/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${homedir()}/.cargo/bin`,
      `${homedir()}/.bun/bin`,
      `${homedir()}/.volta/bin`,
      `${homedir()}/.yarn/bin`,
    ].join(':')
    const env = { ...process.env, PATH: `${process.env.PATH}:${extraPaths}` }
    execFileSync('which', [cmd], { stdio: 'pipe', env })
    return true
  } catch { return false }
}

// ═══ Claude Code ═══
// Config: ~/.claude/settings.json — env vars (ANTHROPIC_BASE_URL, ANTHROPIC_MODEL)
// Claude Code requires Anthropic Messages API format (/v1/messages) — vMLX supports this
const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')
/** env keys we overwrite, and therefore must be able to hand back. */
const CLAUDE_MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
] as const
/** Where the user's pre-vMLX values are parked so remove can restore them. */
const CLAUDE_PREV_KEY = `${HARNESS_TAG}_prev`
/** The same, as written up to 0.2.x (legacy). */
const CLAUDE_LEGACY_PREV_KEY = `${LEGACY_TAG}_prev`
const claudeCode: ToolConfig = {
  detect: () => commandExists('claude'),
  installCmd: 'npm',
  installArgs: ['install', '-g', '@anthropic-ai/claude-code'],
  configPath: CLAUDE_SETTINGS,
  getEntries: () => {
    const cfg = readJSONForDisplay(CLAUDE_SETTINGS)
    if (!cfg?.env?.ANTHROPIC_BASE_URL || !isOurs(cfg?.env)) return []
    return [{ label: cfg.env.ANTHROPIC_MODEL || 'default', baseUrl: cfg.env.ANTHROPIC_BASE_URL }]
  },
  addEntry: (baseUrl, modelName) => {
    const cfg = safeReadJSON(CLAUDE_SETTINGS) || {}
    if (!cfg.env) cfg.env = {}

    // A snapshot saved up to 0.2.x moves to the current key (it holds the
    // user's originals, which a new snapshot would otherwise overwrite).
    if (cfg.env[CLAUDE_PREV_KEY] === undefined && cfg.env[CLAUDE_LEGACY_PREV_KEY] !== undefined) {
      cfg.env[CLAUDE_PREV_KEY] = cfg.env[CLAUDE_LEGACY_PREV_KEY]
    }
    delete cfg.env[CLAUDE_LEGACY_PREV_KEY]
    delete cfg.env[LEGACY_TAG]

    // Snapshot whatever the user already had, ONCE, before we clobber it.
    // Without this, a user with a real ANTHROPIC_API_KEY (or their own
    // BASE_URL/MODEL) lost it permanently: addEntry overwrote the key with
    // the placeholder and removeEntry then DELETED it. Toggling vMLX on and off
    // must leave the user exactly where they started.
    //
    // Guarded by absence so a second add (e.g. switching model) does not
    // snapshot our OWN values over the user's originals.
    if (cfg.env[CLAUDE_PREV_KEY] === undefined) {
      const prev: Record<string, string | null> = {}
      for (const key of CLAUDE_MANAGED_ENV_KEYS) {
        prev[key] = Object.prototype.hasOwnProperty.call(cfg.env, key)
          ? cfg.env[key]
          : null // null = "the user did not have this key at all"
      }
      cfg.env[CLAUDE_PREV_KEY] = prev
    }

    // Claude Code appends /v1/messages itself — base URL should NOT include /v1
    cfg.env.ANTHROPIC_BASE_URL = baseUrl
    cfg.env.ANTHROPIC_MODEL = modelName
    cfg.env.ANTHROPIC_API_KEY = API_KEY_PLACEHOLDER  // Required non-empty value
    cfg.env[HARNESS_TAG] = 'true'
    safeWriteJSON(CLAUDE_SETTINGS, cfg)
  },
  removeEntry: () => {
    const cfg = safeReadJSON(CLAUDE_SETTINGS)
    if (!cfg?.env) return

    const prev = cfg.env[CLAUDE_PREV_KEY] ?? cfg.env[CLAUDE_LEGACY_PREV_KEY]
    if (prev && typeof prev === 'object') {
      // Restore the user's originals rather than deleting blindly.
      for (const key of CLAUDE_MANAGED_ENV_KEYS) {
        const value = prev[key]
        if (value === null || value === undefined) delete cfg.env[key]
        else cfg.env[key] = value
      }
      delete cfg.env[CLAUDE_PREV_KEY]
      delete cfg.env[CLAUDE_LEGACY_PREV_KEY]
    } else {
      // No snapshot (config predates this fix): fall back to the old
      // delete-only behaviour, which is still correct when the user had
      // nothing of their own here.
      for (const key of CLAUDE_MANAGED_ENV_KEYS) delete cfg.env[key]
    }

    delete cfg.env[HARNESS_TAG]
    delete cfg.env[LEGACY_TAG]
    // Clean up empty env object
    if (Object.keys(cfg.env).length === 0) delete cfg.env
    safeWriteJSON(CLAUDE_SETTINGS, cfg)
  },
}

// ═══ Codex CLI ═══
// Config: ~/.codex/config.toml — TOML format with [model_providers.NAME] sections
const CODEX_TOML = join(homedir(), '.codex', 'config.toml')
const CODEX_DEFAULTS_BEGIN = '# >>> MLX Harness managed Codex defaults'
const CODEX_DEFAULTS_END = '# <<< MLX Harness managed Codex defaults'
/** The same block as written by 0.1.x (legacy marker): still recognised, replaced on the next write. */
const CODEX_LEGACY_DEFAULTS_BEGIN = '# >>> MLX Studio managed Codex defaults'
const CODEX_LEGACY_DEFAULTS_END = '# <<< MLX Studio managed Codex defaults'
const CODEX_PREVIOUS_DEFAULTS = '# previous-defaults-base64: '

const CODEX_PROVIDER_PREFIX = 'MLXHARNESS_'
/** Prefix of the providers written up to 0.2.x (legacy): still listed and removed. */
const CODEX_LEGACY_PROVIDER_PREFIX = 'MLXSTUDIO_'

function codexProviderKey(modelName: string, prefix = CODEX_PROVIDER_PREFIX): string {
  return `${prefix}${modelName.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`
}

function tomlString(value: string): string {
  // TOML basic strings accept the same escapes JSON.stringify emits for the
  // model names and localhost URLs written here.
  return JSON.stringify(value)
}

function removeCodexManagedDefaults(toml: string): {
  toml: string
  previousDefaults: string
  activeProvider: string | null
} {
  const markers = [[CODEX_DEFAULTS_BEGIN, CODEX_DEFAULTS_END], [CODEX_LEGACY_DEFAULTS_BEGIN, CODEX_LEGACY_DEFAULTS_END]]
  const found = markers.map(([b, e]) => ({ b, e, start: toml.indexOf(b) })).find(m => m.start >= 0)
  if (!found) return { toml, previousDefaults: '', activeProvider: null }
  const start = found.start
  const endMarker = toml.indexOf(found.e, start)
  if (endMarker < 0) return { toml, previousDefaults: '', activeProvider: null }
  const end = endMarker + found.e.length
  const block = toml.slice(start, end)
  const previousMatch = block.match(/^# previous-defaults-base64: ([A-Za-z0-9+/=]*)$/m)
  const providerMatch = block.match(/^model_provider\s*=\s*"([^"]+)"\s*$/m)
  let previousDefaults = ''
  if (previousMatch?.[1]) {
    try { previousDefaults = Buffer.from(previousMatch[1], 'base64').toString('utf8') } catch {}
  }
  return {
    toml: (toml.slice(0, start) + toml.slice(end)).replace(/^\s+/, ''),
    previousDefaults,
    activeProvider: providerMatch?.[1] || null,
  }
}

function extractCodexTopLevelDefaults(toml: string): { toml: string; previousDefaults: string } {
  const lines = toml.split('\n')
  const kept: string[] = []
  const previous: string[] = []
  let inTopLevel = true
  for (const line of lines) {
    if (inTopLevel && /^\s*\[/.test(line)) inTopLevel = false
    if (inTopLevel && /^\s*(model|model_provider|model_context_window)\s*=/.test(line)) {
      previous.push(line)
    } else {
      kept.push(line)
    }
  }
  return {
    toml: kept.join('\n').replace(/^\s+/, ''),
    previousDefaults: previous.join('\n'),
  }
}

function codexManagedDefaults(
  modelName: string,
  providerKey: string,
  contextWindow: number,
  previousDefaults: string,
): string {
  const encodedPrevious = Buffer.from(previousDefaults, 'utf8').toString('base64')
  return [
    CODEX_DEFAULTS_BEGIN,
    `${CODEX_PREVIOUS_DEFAULTS}${encodedPrevious}`,
    `model = ${tomlString(modelName)}`,
    `model_provider = ${tomlString(providerKey)}`,
    `model_context_window = ${contextWindow}`,
    CODEX_DEFAULTS_END,
  ].join('\n')
}

function codexProviderSection(baseUrl: string, modelName: string, providerKey: string): string {
  return [
    `[model_providers.${providerKey}]`,
    `name = ${tomlString(`MLX Harness (${modelName})`)}`,
    `base_url = ${tomlString(`${baseUrl}/v1`)}`,
    'wire_api = "responses"',
  ].join('\n')
}

const codexCli: ToolConfig = {
  detect: () => commandExists('codex'),
  installCmd: 'npm',
  installArgs: ['install', '-g', '@openai/codex'],
  configPath: CODEX_TOML,
  getEntries: () => {
    const toml = safeReadTOML(CODEX_TOML)
    if (!toml) return []
    // Parse TOML: find our [model_providers.MLXHARNESS_*] (or legacy MLXSTUDIO_*) sections
    const entries: Array<{ label: string; baseUrl: string }> = []
    const sectionRegex = /\[model_providers\.([^\]]+)\]/g
    let match
    while ((match = sectionRegex.exec(toml)) !== null) {
      const name = match[1]
      if (!name.startsWith(CODEX_PROVIDER_PREFIX) && !name.startsWith(CODEX_LEGACY_PROVIDER_PREFIX)) continue
      // Extract base_url from this section
      const sectionStart = match.index + match[0].length
      const nextSection = toml.indexOf('\n[', sectionStart)
      const sectionBody = nextSection >= 0 ? toml.slice(sectionStart, nextSection) : toml.slice(sectionStart)
      const urlMatch = sectionBody.match(/base_url\s*=\s*"([^"]+)"/)
      entries.push({ label: name, baseUrl: urlMatch ? urlMatch[1] : '' })
    }
    return entries
  },
  addEntry: (baseUrl, modelName, _port, limits) => {
    let toml = safeReadTOML(CODEX_TOML) || ''
    const providerKey = codexProviderKey(modelName)
    const managed = removeCodexManagedDefaults(toml)
    const extracted = managed.previousDefaults
      ? { toml: managed.toml, previousDefaults: managed.previousDefaults }
      : extractCodexTopLevelDefaults(managed.toml)
    toml = extracted.toml
    // Remove existing section if present (and the same model's legacy one)
    for (const key of [providerKey, codexProviderKey(modelName, CODEX_LEGACY_PROVIDER_PREFIX)]) {
      const sectionPattern = new RegExp(`\\[model_providers\\.${key}\\][\\s\\S]*?(?=\\n\\[|$)`, 'g')
      toml = toml.replace(sectionPattern, '')
    }
    toml = toml.replace(/\n{3,}/g, '\n\n').trim()
    // Codex requires model/model_provider/model_context_window at top level.
    // The old integration wrote an unsupported max_context inside the
    // provider table and never selected the provider, so a healthy vMLX curl
    // could coexist with a Codex session that never contacted vMLX.
    const defaults = codexManagedDefaults(
      modelName,
      providerKey,
      limits.context,
      extracted.previousDefaults,
    )
    const section = codexProviderSection(baseUrl, modelName, providerKey)
    safeWriteTOML(CODEX_TOML, `${defaults}\n\n${toml ? `${toml}\n\n` : ''}${section}\n`)
  },
  removeEntry: (label) => {
    let toml = safeReadTOML(CODEX_TOML)
    if (!toml) return
    // Remove the [model_providers.LABEL] section
    const sectionPattern = new RegExp(`\\[model_providers\\.${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*?(?=\\n\\[|$)`, 'g')
    toml = toml.replace(sectionPattern, '').replace(/\n{3,}/g, '\n\n').trim()
    const managed = removeCodexManagedDefaults(toml)
    if (managed.activeProvider === label) {
      toml = `${managed.previousDefaults}${managed.previousDefaults && managed.toml ? '\n' : ''}${managed.toml}`
    }
    safeWriteTOML(CODEX_TOML, toml.trim() + '\n')
  },
}

// ═══ OpenCode ═══
// Config: ~/.config/opencode/opencode.json — we add provider entries tagged with HARNESS_TAG
const openCode: ToolConfig = {
  detect: () => commandExists('opencode'),
  installCmd: 'npm',
  installArgs: ['install', '-g', 'opencode'],
  configPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
  getEntries: () => {
    const cfg = readJSONForDisplay(join(homedir(), '.config', 'opencode', 'opencode.json'))
    if (!cfg?.provider) return []
    return Object.entries(cfg.provider)
      .filter(([_, v]: any) => isOurs(v))
      .map(([k, v]: any) => ({ label: k, baseUrl: (v as any)?.options?.baseURL || '' }))
  },
  addEntry: (baseUrl, modelName, _port, limits) => {
    const path = join(homedir(), '.config', 'opencode', 'opencode.json')
    const cfg = safeReadJSON(path) || { '$schema': 'https://opencode.ai/config.json' }
    if (!cfg.provider) cfg.provider = {}
    const slug = modelName.replace(/[^a-zA-Z0-9-]/g, '-')
    const key = `${HARNESS_ID}-${slug}`
    // The same model's entry as written up to 0.2.x is replaced by this one.
    const legacyKey = `${LEGACY_ID}-${slug}`
    if (isOurs(cfg.provider[legacyKey])) delete cfg.provider[legacyKey]
    cfg.provider[key] = {
      npm: '@ai-sdk/openai-compatible',
      name: `MLX Harness (${modelName})`,
      options: { baseURL: `${baseUrl}/v1` },
      models: {
        [modelName]: {
          name: modelName,
          limit: { context: limits.context, output: limits.output },
          modalities: { input: ['text'], output: ['text'] },
        },
      },
      [HARNESS_TAG]: true,
    }
    safeWriteJSON(path, cfg)
  },
  removeEntry: (label) => {
    const path = join(homedir(), '.config', 'opencode', 'opencode.json')
    const cfg = safeReadJSON(path)
    if (!cfg?.provider?.[label]) return
    delete cfg.provider[label]
    safeWriteJSON(path, cfg)
  },
}

// ═══ OpenClaw ═══
// Config: ~/.openclaw/openclaw.json (JSON5) — models.providers + agents.defaults.models allowlist
// OpenClaw uses OpenAI-compatible API via "openai-completions" wire format
const OPENCLAW_JSON = join(homedir(), '.openclaw', 'openclaw.json')
const openClaw: ToolConfig = {
  detect: () => commandExists('openclaw'),
  installCmd: 'npm',
  installArgs: ['install', '-g', 'openclaw@latest'],
  configPath: OPENCLAW_JSON,
  getEntries: () => {
    const cfg = readJSONForDisplay(OPENCLAW_JSON)
    if (!cfg?.models?.providers) return []
    const entries: Array<{ label: string; baseUrl: string }> = []
    for (const [name, provider] of Object.entries(cfg.models.providers)) {
      const p = provider as any
      if (!isOurs(p)) continue
      entries.push({ label: name, baseUrl: p.baseUrl || '' })
    }
    return entries
  },
  addEntry: (baseUrl, modelName, _port, limits) => {
    const cfg = safeReadJSON(OPENCLAW_JSON) || {}
    if (!cfg.models) cfg.models = {}
    if (!cfg.models.mode) cfg.models.mode = 'merge'
    if (!cfg.models.providers) cfg.models.providers = {}
    if (!cfg.agents) cfg.agents = {}
    if (!cfg.agents.defaults) cfg.agents.defaults = {}
    if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {}
    const providerKey = HARNESS_ID
    const fqModel = `${providerKey}/${modelName}`
    // Move a provider written up to 0.2.x ('mlxstudio') into ours, keeping its
    // models and their allowlist entries.
    const legacy = cfg.models.providers[LEGACY_ID]
    if (isOurs(legacy)) {
      const current = cfg.models.providers[providerKey]
      const merged: any[] = Array.isArray(current?.models) ? [...current.models] : []
      for (const m of Array.isArray(legacy.models) ? legacy.models : []) {
        if (!merged.some(x => x?.id === m?.id)) merged.push(m)
      }
      cfg.models.providers[providerKey] = { ...legacy, ...(current || {}), models: merged }
      delete cfg.models.providers[providerKey][LEGACY_TAG]
      delete cfg.models.providers[LEGACY_ID]
      for (const k of Object.keys(cfg.agents.defaults.models)) {
        if (!k.startsWith(`${LEGACY_ID}/`)) continue
        const moved = `${providerKey}/${k.slice(LEGACY_ID.length + 1)}`
        if (cfg.agents.defaults.models[moved] === undefined) cfg.agents.defaults.models[moved] = cfg.agents.defaults.models[k]
        delete cfg.agents.defaults.models[k]
      }
    }
    const model = {
      id: modelName,
      name: modelName,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: limits.context,
      maxTokens: limits.output,
    }

    // OpenClaw keeps ONE provider holding a LIST of models, so configuring a
    // second model must APPEND to that list. Replacing the whole provider
    // (the previous behaviour) silently dropped model A when model B was
    // added, while the allowlist below kept BOTH — leaving an allowlist entry
    // pointing at a model the provider no longer declared.
    const existing = cfg.models.providers[providerKey]
    const models: any[] = Array.isArray(existing?.models) ? [...existing.models] : []
    const at = models.findIndex(m => m?.id === modelName)
    if (at >= 0) models[at] = model
    else models.push(model)

    cfg.models.providers[providerKey] = {
      baseUrl: `${baseUrl}/v1`,
      apiKey: API_KEY_PLACEHOLDER,
      api: 'openai-completions',
      models,
      [HARNESS_TAG]: true,
    }
    cfg.agents.defaults.models[fqModel] = { alias: modelName }
    safeWriteJSON(OPENCLAW_JSON, cfg)
  },
  removeEntry: () => {
    const cfg = safeReadJSON(OPENCLAW_JSON)
    if (!cfg) return
    for (const id of [HARNESS_ID, LEGACY_ID]) {
      if (cfg.models?.providers?.[id]) delete cfg.models.providers[id]
    }
    // Remove all mlxharness/ (and legacy mlxstudio/) entries from allowlist
    if (cfg.agents?.defaults?.models) {
      for (const key of Object.keys(cfg.agents.defaults.models)) {
        if (key.startsWith(`${HARNESS_ID}/`) || key.startsWith(`${LEGACY_ID}/`)) delete cfg.agents.defaults.models[key]
      }
    }
    safeWriteJSON(OPENCLAW_JSON, cfg)
  },
}

// ═══ Hermes Agent (NousResearch) ═══
// Config: ~/.hermes/config.yaml — a `providers` MAP (not a list). Verified
// against the official docs, not guessed:
//   providers:
//     <id>:
//       base_url: "https://host/v1"
//       api_key: "..."
//       models: { <model>: { timeout_seconds: N } }
// Hermes appends /chat/completions itself, so base_url must END at /v1 — a URL
// that already includes the path (or a trailing slash) 404s. Setting base_url
// makes Hermes call that endpoint directly instead of a built-in provider.
//
// Parsed with a real YAML library rather than regex: this file belongs to the
// user and may hold arbitrary unrelated settings, and the regex-edited TOML
// path in this same module is exactly the fragility worth not repeating.
const HERMES_YAML = join(homedir(), '.hermes', 'config.yaml')
const HERMES_PROVIDER_KEY = HARNESS_ID
/** The provider as written up to 0.2.x (legacy): still listed, merged on add, removed. */
const HERMES_LEGACY_PROVIDER_KEY = LEGACY_ID

function readHermesConfig(path: string, forDisplay: boolean): any {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    if (forDisplay) return null
    throw new UnreadableConfigError(path, err)
  }
  if (!raw.trim()) return null
  try {
    const doc = loadYAML(raw)
    // A YAML scalar/list at the root is not a config we can safely merge into.
    if (doc === null || doc === undefined) return null
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('expected a YAML mapping at the document root')
    }
    return doc
  } catch (err) {
    if (forDisplay) return null
    throw new UnreadableConfigError(path, err)
  }
}

function writeHermesConfig(path: string, doc: any): void {
  if (existsSync(path)) {
    try { copyFileSync(path, path + '.bak') } catch {}
  }
  const dir = path.substring(0, path.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, dumpYAML(doc, { lineWidth: 120, noRefs: true }), {
    encoding: 'utf-8',
    mode: 0o600,
  })
  try { chmodSync(path, 0o600) } catch {}
}

const hermesAgent: ToolConfig = {
  detect: () => commandExists('hermes'),
  installCmd: 'npm',
  installArgs: ['install', '-g', '@nousresearch/hermes-agent'],
  configPath: HERMES_YAML,
  getEntries: () => {
    const doc = readHermesConfig(HERMES_YAML, true)
    const entries: Array<{ label: string; baseUrl: string }> = []
    for (const key of [HERMES_PROVIDER_KEY, HERMES_LEGACY_PROVIDER_KEY]) {
      const provider = doc?.providers?.[key]
      if (!isOurs(provider)) continue
      const models = provider.models && typeof provider.models === 'object'
        ? Object.keys(provider.models)
        : []
      const baseUrl = typeof provider.base_url === 'string' ? provider.base_url : ''
      for (const e of models.length ? models.map(m => ({ label: m, baseUrl })) : [{ label: key, baseUrl }]) {
        if (!entries.some(x => x.label === e.label)) entries.push(e)
      }
    }
    return entries
  },
  addEntry: (baseUrl, modelName) => {
    const doc = readHermesConfig(HERMES_YAML, false) || {}
    if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) {
      doc.providers = {}
    }
    const existing = doc.providers[HERMES_PROVIDER_KEY]
    const legacy = doc.providers[HERMES_LEGACY_PROVIDER_KEY]
    const modelsOf = (p: any) =>
      p?.models && typeof p.models === 'object' && !Array.isArray(p.models) ? p.models : {}
    // Keep sibling models: like OpenClaw, one provider holds many models, so
    // adding a second must not silently drop the first. A provider written
    // up to 0.2.x is merged into ours and removed.
    const models = { ...(isOurs(legacy) ? modelsOf(legacy) : {}), ...modelsOf(existing) }
    if (isOurs(legacy)) delete doc.providers[HERMES_LEGACY_PROVIDER_KEY]
    models[modelName] = { ...(models[modelName] || {}) }
    doc.providers[HERMES_PROVIDER_KEY] = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      // Hermes appends /chat/completions — end at /v1.
      base_url: `${baseUrl}/v1`,
      api_key: API_KEY_PLACEHOLDER,
      models,
      [HARNESS_TAG]: true,
    }
    delete doc.providers[HERMES_PROVIDER_KEY][LEGACY_TAG]
    writeHermesConfig(HERMES_YAML, doc)
  },
  removeEntry: (label) => {
    const doc = readHermesConfig(HERMES_YAML, false)
    let changed = false
    for (const key of [HERMES_PROVIDER_KEY, HERMES_LEGACY_PROVIDER_KEY]) {
      const provider = doc?.providers?.[key]
      if (!provider) continue
      // The legacy key is only ours when it carries our tag.
      if (key === HERMES_LEGACY_PROVIDER_KEY && !isOurs(provider)) continue
      changed = true
      // Drop just this model when others remain; drop the provider when it was
      // the last one, so no empty shell is left referencing our endpoint.
      if (provider.models && typeof provider.models === 'object' && label in provider.models) {
        delete provider.models[label]
      }
      if (!provider.models || Object.keys(provider.models).length === 0) {
        delete doc.providers[key]
      }
    }
    if (!changed) return
    if (doc.providers && Object.keys(doc.providers).length === 0) delete doc.providers
    writeHermesConfig(HERMES_YAML, doc)
  },
}

const TOOLS: Record<string, ToolConfig> = {
  'claude-code': claudeCode,
  'codex': codexCli,
  'hermes': hermesAgent,
  'opencode': openCode,
  'openclaw': openClaw,
}

let registered = false

export function registerCodingToolHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle('tools:getCodingToolStatus', async () => {
    const result: Record<string, any> = {}
    for (const [id, tool] of Object.entries(TOOLS)) {
      const installed = tool.detect()
      const entries = installed ? tool.getEntries() : []
      result[id] = {
        installed,
        configured: entries.length > 0,
        configPath: tool.configPath,
        entries,
      }
    }
    return result
  })

  ipcMain.handle('tools:installCodingTool', async (_, toolId: string) => {
    const tool = TOOLS[toolId]
    if (!tool) return { success: false, error: 'Unknown tool' }
    try {
      const resolved = resolveCommand(tool.installCmd)
      execFileSync(resolved.file, tool.installArgs, { stdio: 'pipe', timeout: 120000, env: resolved.env })
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('tools:addCodingToolConfig', async (_, toolId: string, baseUrl: string, modelName: string, port: number | null) => {
    const tool = TOOLS[toolId]
    if (!tool) return { success: false, error: 'Unknown tool' }
    if (!tool.detect()) return { success: false, error: 'Tool not installed' }
    try {
      const limits = await getCodingToolModelLimits(baseUrl, modelName)
      tool.addEntry(baseUrl, modelName, port, limits)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('tools:removeCodingToolConfig', async (_, toolId: string, label: string) => {
    const tool = TOOLS[toolId]
    if (!tool) return { success: false, error: 'Unknown tool' }
    try {
      tool.removeEntry(label)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // Returns tailored config snippets for manual setup instructions
  ipcMain.handle('tools:getConfigSnippets', async (_, baseUrl: string, modelName: string) => {
    const home = homedir()
    const limits = await getCodingToolModelLimits(baseUrl, modelName)
    return {
      'claude-code': {
        filePath: `${home}/.claude/settings.json`,
        language: 'json',
        snippet: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_MODEL: modelName,
            ANTHROPIC_API_KEY: API_KEY_PLACEHOLDER,
          }
        }, null, 2),
        notes: 'Claude Code appends /v1/messages automatically. Merge the "env" key into your existing settings.json — do not replace the whole file. Verify: claude --version && claude /status',
      },
      'codex': {
        filePath: `${home}/.codex/config.toml`,
        language: 'toml',
        snippet: (() => {
          const providerKey = codexProviderKey(modelName)
          return `model = ${tomlString(modelName)}\nmodel_provider = ${tomlString(providerKey)}\nmodel_context_window = ${limits.context}\n\n${codexProviderSection(baseUrl, modelName, providerKey)}`
        })(),
        notes: 'Merge the three top-level keys and provider section into config.toml; do not create duplicate top-level keys. Then run: codex. Verify first with: codex --strict-config doctor --json',
      },
      'opencode': {
        filePath: `${home}/.config/opencode/opencode.json`,
        language: 'json',
        snippet: JSON.stringify({
          provider: {
            [`${HARNESS_ID}-${modelName.replace(/[^a-zA-Z0-9-]/g, '-')}`]: {
              npm: '@ai-sdk/openai-compatible',
              name: `MLX Harness (${modelName})`,
              options: { baseURL: `${baseUrl}/v1` },
              models: {
                [modelName]: {
                  name: modelName,
                  limit: { context: limits.context, output: limits.output },
                  modalities: { input: ['text'], output: ['text'] },
                },
              },
            },
          },
        }, null, 2),
        notes: 'Merge the "provider" key into your existing opencode.json. If the file doesn\'t exist, create it with { "$schema": "https://opencode.ai/config.json", "provider": { ... } }. Verify: opencode --version',
      },
      'hermes': {
        filePath: `${home}/.hermes/config.yaml`,
        language: 'yaml',
        snippet: [
          'providers:',
          `  ${HERMES_PROVIDER_KEY}:`,
          `    base_url: ${baseUrl}/v1`,
          `    api_key: ${API_KEY_PLACEHOLDER}`,
          '    models:',
          `      ${modelName}: {}`,
          `    ${HARNESS_TAG}: true`,
        ].join('\n'),
        notes: 'Merge the provider under your existing "providers" mapping in ~/.hermes/config.yaml (do not replace the file). Hermes appends /chat/completions, so base_url must end at /v1. Select the model in Hermes with: hermes --model ' + modelName,
      },
      'openclaw': {
        filePath: `${home}/.openclaw/openclaw.json`,
        language: 'json',
        snippet: JSON.stringify({
          models: {
            mode: 'merge',
            providers: {
              [HARNESS_ID]: {
                baseUrl: `${baseUrl}/v1`,
                apiKey: API_KEY_PLACEHOLDER,
                api: 'openai-completions',
                models: [{
                  id: modelName,
                  name: modelName,
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: limits.context,
                  maxTokens: limits.output,
                }],
              },
            },
          },
          agents: {
            defaults: {
              models: {
                [`${HARNESS_ID}/${modelName}`]: { alias: modelName },
              },
            },
          },
        }, null, 2),
        notes: 'Merge into your existing openclaw.json (JSON5 format). "mode": "merge" ensures your existing providers are kept. Both the provider AND the agents.defaults.models allowlist entry are required. Verify: openclaw --version && openclaw doctor',
      },
    }
  })
}
