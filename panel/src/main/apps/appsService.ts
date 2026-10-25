/**
 * Apps (Gmail, Calendar, Slack, Notion, GitHub …) through Composio Connect,
 * run from the main process so every model, local or cloud, gets the same
 * tools and the same approvals.
 *
 * Sign-in: "Continue with Composio" is MCP OAuth 2.1 (dynamic client
 * registration, PKCE S256, the system browser, a loopback callback on
 * 127.0.0.1). Advanced: the user's own Composio consumer key, sent as
 * `x-consumer-api-key`. Either way the credentials are the user's own,
 * stored with the Keychain; MLX Harness ships no shared key and sees no one
 * else's connections.
 */

import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { pickDirectSlugs, parseToolSchemas, slugForDirect, toDirectTools, type DirectSchema } from './composioDirect'
import { COMPOSIO_CONNECT_URL, connectionLinks, connectionState, isOfferedTool, mcpResultText, replyOutline, sanitizeArguments, type AppRule } from './composioPolicy'

export const OAUTH_CALLBACK_PORT = 47391
export const OAUTH_CALLBACK_PATH = '/oauth/composio'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface AppsStorage {
  /** Encrypted JSON blob for OAuth state (client registration + tokens). */
  readOAuth(): { client?: OAuthClientInformationMixed; tokens?: OAuthTokens } | null
  writeOAuth(value: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens } | null): void
  readKey(): string | null
  writeKey(key: string | null): void
  readRules(): Record<string, AppRule>
  writeRules(rules: Record<string, AppRule>): void
  chatEnabled(chatId: string): boolean
  setChatEnabled(chatId: string, on: boolean): void
  /** Apps the user connected from Preferences → Apps (toolkit slugs). Optional for tests. */
  readConnected?(): string[]
  writeConnected?(apps: string[]): void
  /** Apps whose sign-in was opened and not yet seen finished: slug → when (ms). */
  readPending?(): Record<string, number>
  writePending?(pending: Record<string, number>): void
  /** Cached direct-tool schemas, by slug. */
  readSchemaCache?(): Record<string, DirectSchema>
  writeSchemaCache?(cache: Record<string, DirectSchema>): void
}

export interface AppsDeps {
  storage: AppsStorage
  openExternal: (url: string) => Promise<void> | void
  onStatus?: (status: AppsStatus) => void
  /** An app's connection changed (connected, pending, removed). */
  onAppsChanged?: () => void
  /** For tests. */
  connectUrl?: string
  callbackPort?: number
  /** For tests: how often a pending sign-in is checked, and for how long. */
  watchEveryMs?: number
  watchForMs?: number
}

export interface AppsStatus {
  state: 'off' | 'connecting' | 'waiting-for-browser' | 'connected' | 'error'
  via: 'oauth' | 'key' | null
  error?: string
  toolCount?: number
}

export interface AppTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

class StoredOAuthProvider implements OAuthClientProvider {
  private verifier = ''
  constructor(
    private readonly storage: AppsStorage,
    private readonly redirect: string,
    private readonly open: (url: string) => Promise<void> | void,
    private readonly onRedirect: () => void,
    private readonly stateValue?: string,
  ) {}
  state(): string { return this.stateValue ?? randomBytes(16).toString('hex') }
  get redirectUrl(): string { return this.redirect }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MLX Harness',
      client_uri: 'https://harness.mlx.app',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.storage.readOAuth()?.client as (OAuthClientInformationMixed & { redirect_uris?: string[] }) | undefined
    // A registration for another callback URL is useless: register again.
    if (client?.redirect_uris && !client.redirect_uris.includes(this.redirect)) return undefined
    return client
  }
  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.storage.writeOAuth({ ...(this.storage.readOAuth() ?? {}), client })
  }
  tokens(): OAuthTokens | undefined { return this.storage.readOAuth()?.tokens }
  saveTokens(tokens: OAuthTokens): void {
    this.storage.writeOAuth({ ...(this.storage.readOAuth() ?? {}), tokens })
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (url.protocol !== 'https:') throw new Error('Refusing a non-https sign-in page')
    this.onRedirect()
    await this.open(url.toString())
  }
  saveCodeVerifier(v: string): void { this.verifier = v }
  codeVerifier(): string { return this.verifier }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const cur = this.storage.readOAuth() ?? {}
    if (scope === 'all') this.storage.writeOAuth(null)
    else if (scope === 'client') this.storage.writeOAuth({ ...cur, client: undefined })
    else if (scope === 'tokens') this.storage.writeOAuth({ ...cur, tokens: undefined })
    else if (scope === 'verifier') this.verifier = ''
  }
}

/** One loopback request carrying ?code=…&state=…; resolves with the code. */
function waitForCallback(port: number, expectState: string | null, signal: AbortSignal): { ready: Promise<void>; code: Promise<string>; close: () => void } {
  let server: Server | null = null
  let resolveCode!: (c: string) => void
  let rejectCode!: (e: Error) => void
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej })
  const close = () => { try { server?.close() } catch { /* closed */ } server = null }
  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,system-ui;display:grid;place-items:center;height:90vh;color:#222"><div style="text-align:center"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#666;margin:0">${body}</p></div></body>`
  const ready = new Promise<void>((res, rej) => {
    server = createServer((req, resp) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== OAUTH_CALLBACK_PATH) { resp.writeHead(404).end(); return }
      const err = url.searchParams.get('error')
      const got = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (err || !got || (expectState && state !== expectState)) {
        resp.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Not connected', 'You can close this tab and try again in MLX Harness.'))
        rejectCode(new Error(err ? `Composio sign-in: ${err}` : 'The sign-in reply was not valid.'))
        return
      }
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Connected to MLX Harness', 'You can close this tab and go back to the app.'))
      resolveCode(got)
    })
    server.on('error', rej)
    server.listen(port, '127.0.0.1', () => res())
  })
  const timer = setTimeout(() => rejectCode(new Error('Sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS)
  signal.addEventListener('abort', () => rejectCode(new Error('Sign-in was cancelled.')), { once: true })
  code.finally(() => { clearTimeout(timer); close() }).catch(() => undefined)
  return { ready, code, close }
}

export class AppsService {
  private client: Client | null = null
  private tools: AppTool[] | null = null
  private status_: AppsStatus = { state: 'off', via: null }
  private signIn: AbortController | null = null
  private connecting: Promise<Client | null> | null = null

  constructor(private readonly deps: AppsDeps) {
    const via = this.via()
    if (via) this.status_ = { state: 'connected', via }
  }

  private get url(): URL { return new URL(this.deps.connectUrl ?? COMPOSIO_CONNECT_URL) }
  private get port(): number { return this.deps.callbackPort ?? OAUTH_CALLBACK_PORT }
  private get redirect(): string { return `http://127.0.0.1:${this.port}${OAUTH_CALLBACK_PATH}` }

  private via(): AppsStatus['via'] {
    if (this.deps.storage.readKey()) return 'key'
    if (this.deps.storage.readOAuth()?.tokens) return 'oauth'
    return null
  }

  private setStatus(s: AppsStatus): void {
    this.status_ = s
    this.deps.onStatus?.(s)
  }

  status(): AppsStatus { return this.status_ }
  isConnected(): boolean { return this.via() !== null }

  rules(): Record<string, AppRule> { return this.deps.storage.readRules() }
  setRule(toolkit: string, rule: AppRule): Record<string, AppRule> {
    const next = { ...this.rules(), [toolkit.toLowerCase()]: rule }
    if (rule === 'ask') delete next[toolkit.toLowerCase()]
    this.deps.storage.writeRules(next)
    return next
  }
  chatEnabled(chatId: string): boolean { return this.isConnected() && this.deps.storage.chatEnabled(chatId) }
  setChatEnabled(chatId: string, on: boolean): boolean {
    this.deps.storage.setChatEnabled(chatId, on)
    return this.chatEnabled(chatId)
  }

  private transport(provider?: OAuthClientProvider): StreamableHTTPClientTransport {
    const key = this.deps.storage.readKey()
    return new StreamableHTTPClientTransport(this.url, key
      ? { requestInit: { headers: { 'x-consumer-api-key': key } } }
      : {
          // In the background a lapsed sign-in never opens a browser by
          // itself: it surfaces as "connect again" in Preferences → Apps.
          authProvider: provider ?? new StoredOAuthProvider(this.deps.storage, this.redirect, () => {
            throw new UnauthorizedError('Composio sign-in needed')
          }, () => undefined),
        })
  }

  private async open(provider?: OAuthClientProvider): Promise<Client> {
    const client = new Client({ name: 'mlx-harness', version: '1' })
    await client.connect(this.transport(provider))
    return client
  }

  /** Connected client, reconnecting with stored credentials when needed. */
  private async ensure(): Promise<Client | null> {
    if (this.client) return this.client
    if (!this.via()) return null
    if (!this.connecting) {
      this.connecting = this.open()
        .then(c => { this.client = c; this.setStatus({ state: 'connected', via: this.via() }); this.resumePending(); return c })
        .catch(err => {
          this.client = null
          const msg = err instanceof UnauthorizedError ? 'Composio sign-in expired. Connect again in Preferences → Apps.' : String(err?.message ?? err)
          this.setStatus({ state: 'error', via: this.via(), error: msg })
          return null
        })
        .finally(() => { this.connecting = null })
    }
    return this.connecting
  }

  /** "Continue with Composio": browser sign-in, then connect. */
  async connectOAuth(): Promise<AppsStatus> {
    this.generation++
    this.stopWatching()
    this.signIn?.abort()
    const abort = new AbortController()
    this.signIn = abort
    await this.close()
    this.setStatus({ state: 'connecting', via: 'oauth' })
    const state = randomBytes(16).toString('hex')
    const callback = waitForCallback(this.port, state, abort.signal)
    try {
      await callback.ready
      const provider = new StoredOAuthProvider(this.deps.storage, this.redirect, this.deps.openExternal,
        () => this.setStatus({ state: 'waiting-for-browser', via: 'oauth' }), state)
      const transport = new StreamableHTTPClientTransport(this.url, { authProvider: provider })
      const client = new Client({ name: 'mlx-harness', version: '1' })
      try {
        await client.connect(transport)
        callback.close()
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err
        await transport.finishAuth(await callback.code)
      }
      await client.close().catch(() => undefined)
      // Signed in through the browser: that replaces a saved key. Then
      // reconnect with the background provider, so a later lapsed sign-in
      // never opens the browser by itself.
      this.deps.storage.writeKey(null)
      this.client = await this.open()
      this.tools = null
      const tools = await this.listTools()
      this.setStatus({ state: 'connected', via: 'oauth', toolCount: tools.length })
      this.resumePending()
    } catch (err: any) {
      callback.close()
      // A newer sign-in started meanwhile: leave its status alone.
      if (this.signIn !== abort) return this.status_
      // Still signed in with the earlier tokens: keep watching open sign-ins.
      if (this.isConnected()) this.resumePending()
      this.setStatus(abort.signal.aborted
        ? { state: 'off', via: null }
        : { state: 'error', via: null, error: err?.code === 'EADDRINUSE' ? 'Another app is using the sign-in port. Close it and try again.' : String(err?.message ?? err) })
    } finally {
      if (this.signIn === abort) this.signIn = null
    }
    return this.status_
  }

  cancelSignIn(): void { this.signIn?.abort() }

  /** Advanced: the user's own Composio consumer key. */
  async connectWithKey(key: string): Promise<AppsStatus> {
    const trimmed = key.trim()
    if (!trimmed) return this.setAndReturn({ state: 'error', via: null, error: 'Paste your Composio key first.' })
    this.generation++
    this.stopWatching()
    await this.close()
    this.deps.storage.writeOAuth(null)
    this.deps.storage.writeKey(trimmed)
    this.setStatus({ state: 'connecting', via: 'key' })
    try {
      this.client = await this.open()
      this.tools = null
      const tools = await this.listTools()
      this.setStatus({ state: 'connected', via: 'key', toolCount: tools.length })
      this.resumePending()
    } catch (err: any) {
      this.deps.storage.writeKey(null)
      this.client = null
      this.setStatus({ state: 'error', via: null, error: err instanceof UnauthorizedError ? 'Composio did not accept that key.' : String(err?.message ?? err) })
    }
    return this.status_
  }

  private setAndReturn(s: AppsStatus): AppsStatus { this.setStatus(s); return s }

  async disconnect(): Promise<AppsStatus> {
    this.generation++
    this.signIn?.abort()
    await this.close()
    this.deps.storage.writeOAuth(null)
    this.deps.storage.writeKey(null)
    this.deps.storage.writeConnected?.([])
    this.deps.storage.writePending?.({})
    this.stopWatching()
    this.tools = null
    this.direct = []
    return this.setAndReturn({ state: 'off', via: null })
  }

  private async close(): Promise<void> {
    const c = this.client
    this.client = null
    this.tools = null
    try { await c?.close() } catch { /* already closed */ }
  }

  /** The meta tools MLX Harness offers, as function tools (cached). */
  async listTools(): Promise<AppTool[]> {
    if (this.tools) return this.tools
    const client = await this.ensure()
    if (!client) return []
    const { tools } = await client.listTools()
    this.tools = tools
      .filter(t => isOfferedTool(t.name))
      .map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: (t.description ?? '').slice(0, 2400),
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      }))
    return this.tools
  }

  /** Cached tools only (no network): for building a request quickly. */
  cachedTools(): AppTool[] { return this.tools ?? [] }

  owns(name: string): boolean {
    return isOfferedTool(name) || name === 'COMPOSIO_REMOTE_WORKBENCH' || name === 'COMPOSIO_REMOTE_BASH_TOOL' || this.direct.some(t => t.function.name === name)
  }

  private direct: AppTool[] = []

  /** Apps connected from Preferences → Apps. */
  connectedApps(): string[] { return this.deps.storage.readConnected?.() ?? [] }

  /**
   * Direct tools for small local models: real actions of the connected apps
   * (schemas fetched once, cached). Empty when no app is known to be
   * connected, so the caller falls back to the meta tools.
   */
  private schemaFailedAt = new Map<string, number>()

  async directTools(): Promise<AppTool[]> {
    const slugs = pickDirectSlugs(this.connectedApps())
    if (slugs.length === 0) return []
    const cache = { ...(this.deps.storage.readSchemaCache?.() ?? {}) }
    const now = Date.now()
    // A slug Composio could not describe is not asked for again for 10
    // minutes, so a local turn never waits on the same failing call.
    const missing = slugs.filter(s => !cache[s] && !((this.schemaFailedAt.get(s) ?? 0) > now - 10 * 60_000))
    if (missing.length > 0 && (await this.ensure())) {
      const r = await this.call('COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: missing })
      const got = r.isError ? {} : parseToolSchemas(r.json)
      for (const s of missing) if (!got[s]) this.schemaFailedAt.set(s, now)
      if (Object.keys(got).length > 0) {
        Object.assign(cache, got)
        this.deps.storage.writeSchemaCache?.(cache)
      }
    }
    this.direct = toDirectTools(slugs, cache)
    return this.direct
  }

  /** A direct tool call as the COMPOSIO_MULTI_EXECUTE_TOOL arguments it stands for. */
  asExecute(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
    const slug = slugForDirect(name, this.direct)
    return slug ? { tools: [{ tool_slug: slug, arguments: args }] } : null
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, opts: { timeoutMs?: number; keepClient?: boolean } = {}): Promise<{ text: string; isError: boolean; json: unknown }> {
    const client = await this.ensure()
    if (!client) return { text: 'Apps are not connected. The user can connect them in Preferences → Apps.', isError: true, json: undefined }
    let result: unknown
    try {
      result = await client.callTool({ name, arguments: sanitizeArguments(name, args) }, undefined, { signal, timeout: opts.timeoutMs ?? 120_000 })
    } catch (err: any) {
      if (signal?.aborted) throw err
      // Transport or session trouble: drop the client so the next call
      // reconnects instead of failing until the app restarts. A short status
      // check that ran out of time says nothing about the connection.
      if (!opts.keepClient && this.client === client) await this.close()
      return { text: `The app call failed: ${String(err?.message ?? err)}`, isError: true, json: undefined }
    }
    return mcpResultText(result)
  }

  /** Start connecting one app (Preferences → Apps): opens its sign-in page. */
  async connectApp(toolkit: string): Promise<{ ok: boolean; opened: number; connected?: boolean; message?: string }> {
    const gen = this.generation
    // Connecting an app that was removed (blocked) lets it be used again.
    if (this.rules()[toolkit.toLowerCase()] === 'blocked') this.setRule(toolkit, 'ask')
    this.lastManage.set(toolkit, Date.now())
    const { json, text, isError } = await this.call('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [toolkit] })
    if (isError) return { ok: false, opened: 0, message: text.slice(0, 300) }
    if (gen !== this.generation) return { ok: false, opened: 0 }
    const state = connectionState(json, text, toolkit)
    console.log(`[apps] connect ${toolkit}: ${state} ${replyOutline(json)}`)
    // Already connected on Composio (an earlier sign-in): nothing to open.
    if (state === 'yes') {
      this.markConnected(toolkit, true)
      this.setPending(toolkit, false)
      return { ok: true, opened: 0, connected: true, message: 'Already connected.' }
    }
    const links = connectionLinks(json)
    if (links.length === 0) {
      // No sign-in page and not connected: Composio could not start it.
      const said = (json as any)?.data?.message ?? (json as any)?.error
      return { ok: false, opened: 0, message: typeof said === 'string' && said ? said.slice(0, 300) : 'Composio did not offer a sign-in for this app. Try again.' }
    }
    await this.deps.openExternal(links[0].url)
    // Pending until Composio reports the connection active: watched in the
    // background (also after the window or the app is closed and reopened).
    // A sign-in opened again starts the watch window again.
    this.setPending(toolkit, true, true)
    this.watch(toolkit)
    return { ok: true, opened: 1, connected: false }
  }

  /** After a sign-in in the browser: is the app connected now? Opens nothing. */
  async checkApp(toolkit: string, opts: { manage?: boolean } = {}): Promise<{ ok: boolean; connected: boolean; pending?: boolean; message?: string }> {
    // One check per app at a time (the watcher, window focus and the button).
    const running = this.checks.get(toolkit)
    if (running) return running
    const gen = this.generation
    const run = (async () => {
      const r = await this.connectionNow(toolkit, opts.manage !== false)
      if (gen !== this.generation) return { ok: false, connected: false }
      if (!r.ok) return { ok: false, connected: false, pending: this.isPending(toolkit), message: r.message }
      // 'unknown' and 'no' change nothing: a pending sign-in stays pending.
      if (r.state === 'yes') { this.markConnected(toolkit, true); this.setPending(toolkit, false) }
      return { ok: true, connected: r.state === 'yes', pending: this.isPending(toolkit) }
    })().finally(() => this.checks.delete(toolkit))
    this.checks.set(toolkit, run)
    return run
  }

  private checks = new Map<string, Promise<{ ok: boolean; connected: boolean; pending?: boolean; message?: string }>>()
  /** Bumped by every sign-in change, so a check that started before it changes nothing after it. */
  private generation = 0

  /**
   * Remove (Preferences → Apps): MLX Harness stops using the app — it is no
   * longer listed as connected and its actions are blocked. The account stays
   * in the user's Composio account until they remove it there.
   */
  removeApp(toolkit: string): void {
    this.setPending(toolkit, false)
    this.markConnected(toolkit, false)
    this.setRule(toolkit, 'blocked')
  }

  pendingApps(): string[] { return Object.keys(this.readPending()) }
  private isPending(toolkit: string): boolean { return toolkit in this.readPending() }

  /** Watch every pending sign-in again (after a restart or a new sign-in). */
  resumePending(): void { for (const tk of this.pendingApps()) this.watch(tk) }

  private lastManage = new Map<string, number>()

  /**
   * The app's connection state. COMPOSIO_WAIT_FOR_CONNECTIONS (a short,
   * read-only wait) when Composio offers it. COMPOSIO_MANAGE_CONNECTIONS can
   * start a new sign-in for an app that isn't connected, so it is used only
   * when `manage` allows it, and at most every 30 s per app.
   */
  private async connectionNow(toolkit: string, manage: boolean): Promise<{ ok: boolean; state: 'yes' | 'no' | 'unknown'; message?: string }> {
    const waitArgs = await this.waitArguments(toolkit)
    if (waitArgs) {
      const r = await this.call('COMPOSIO_WAIT_FOR_CONNECTIONS', waitArgs, undefined, { timeoutMs: 20_000, keepClient: true })
      if (!r.isError) {
        const state = connectionState(r.json, r.text, toolkit)
        console.log(`[apps] wait ${toolkit}: ${state} ${replyOutline(r.json)}`)
        if (state !== 'unknown') return { ok: true, state }
      }
    }
    const last = this.lastManage.get(toolkit) ?? 0
    if (!manage || Date.now() - last < 30_000) return { ok: true, state: 'unknown' }
    this.lastManage.set(toolkit, Date.now())
    const { json, text, isError } = await this.call('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [toolkit] })
    if (isError) return { ok: false, state: 'unknown', message: text.slice(0, 300) }
    const state = connectionState(json, text, toolkit)
    console.log(`[apps] check ${toolkit}: ${state} ${replyOutline(json)}`)
    return { ok: true, state }
  }

  /** Arguments for COMPOSIO_WAIT_FOR_CONNECTIONS built from its own schema, or null. */
  private async waitArguments(toolkit: string): Promise<Record<string, unknown> | null> {
    const tool = (await this.listTools().catch(() => [] as AppTool[])).find(t => t.function.name === 'COMPOSIO_WAIT_FOR_CONNECTIONS')
    const schema = tool?.function.parameters as { properties?: Record<string, any>; required?: string[] } | undefined
    if (!schema?.properties) return null
    const args: Record<string, unknown> = {}
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (prop?.type === 'array' && /toolkit|app/i.test(name)) args[name] = [toolkit]
      else if ((prop?.type === 'number' || prop?.type === 'integer') && /timeout|seconds|wait/i.test(name)) {
        const min = Number.isFinite(prop.minimum) ? prop.minimum : 1
        const max = Number.isFinite(prop.maximum) ? prop.maximum : 30
        args[name] = Math.min(Math.max(/ms|milli/i.test(name) ? 5000 : 5, min), max)
      } else if (Array.isArray(prop?.enum) && prop.enum.length > 0 && (schema.required ?? []).includes(name) && prop.default !== undefined) {
        args[name] = prop.default
      }
    }
    if (!Object.values(args).some(Array.isArray)) return null
    return (schema.required ?? []).every(r => r in args) ? args : null
  }

  private watchers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Check a pending sign-in now and then until it is done or stale. */
  private watch(toolkit: string): void {
    if (this.watchers.has(toolkit)) return
    const every = this.deps.watchEveryMs ?? 5000
    const forMs = this.deps.watchForMs ?? 15 * 60_000
    const tick = async () => {
      this.watchers.delete(toolkit)
      const since = this.readPending()[toolkit]
      if (since === undefined) return
      if (Date.now() - since > forMs) { this.setPending(toolkit, false); return }
      // Signed out of Composio: stop (a new sign-in watches again). A
      // passing error or a sign-in in progress just waits for the next tick.
      if (!this.isConnected()) return
      const busy = this.status_.state === 'error' || this.status_.state === 'connecting' || this.status_.state === 'waiting-for-browser'
      // Reading through MANAGE_CONNECTIONS (when WAIT isn't offered) stops after 5 minutes.
      if (!busy) { try { await this.checkApp(toolkit, { manage: Date.now() - since < 5 * 60_000 }) } catch { /* try again */ } }
      if (this.isPending(toolkit) && !this.watchers.has(toolkit)) {
        this.watchers.set(toolkit, setTimeout(() => void tick(), every))
      }
    }
    this.watchers.set(toolkit, setTimeout(() => void tick(), every))
  }

  private stopWatching(): void {
    for (const t of this.watchers.values()) clearTimeout(t)
    this.watchers.clear()
  }

  private readPending(): Record<string, number> { return { ...(this.deps.storage.readPending?.() ?? {}) } }

  private setPending(toolkit: string, on: boolean, restart = false): void {
    const pending = this.readPending()
    if (on === toolkit in pending && !(on && restart)) return
    if (on) pending[toolkit] = Date.now(); else delete pending[toolkit]
    this.deps.storage.writePending?.(pending)
    if (!on) { const t = this.watchers.get(toolkit); if (t) clearTimeout(t); this.watchers.delete(toolkit) }
    this.deps.onAppsChanged?.()
  }

  private markConnected(toolkit: string, on: boolean): void {
    const known = new Set(this.connectedApps())
    if (on === known.has(toolkit)) return
    if (on) known.add(toolkit); else known.delete(toolkit)
    this.deps.storage.writeConnected?.([...known])
    this.deps.onAppsChanged?.()
  }
}
