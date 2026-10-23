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
import { COMPOSIO_CONNECT_URL, connectionLinks, isOfferedTool, mcpResultText, sanitizeArguments, type AppRule } from './composioPolicy'

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
}

export interface AppsDeps {
  storage: AppsStorage
  openExternal: (url: string) => Promise<void> | void
  onStatus?: (status: AppsStatus) => void
  /** For tests. */
  connectUrl?: string
  callbackPort?: number
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
        .then(c => { this.client = c; this.setStatus({ state: 'connected', via: this.via() }); return c })
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
    this.signIn?.abort()
    const abort = new AbortController()
    this.signIn = abort
    this.deps.storage.writeKey(null)
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
        this.client = client
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err
        const code = await callback.code
        await transport.finishAuth(code)
        this.client = await this.open(provider)
      }
      this.tools = null
      const tools = await this.listTools()
      this.setStatus({ state: 'connected', via: 'oauth', toolCount: tools.length })
    } catch (err: any) {
      callback.close()
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
    await this.close()
    this.deps.storage.writeOAuth(null)
    this.deps.storage.writeKey(trimmed)
    this.setStatus({ state: 'connecting', via: 'key' })
    try {
      this.client = await this.open()
      this.tools = null
      const tools = await this.listTools()
      this.setStatus({ state: 'connected', via: 'key', toolCount: tools.length })
    } catch (err: any) {
      this.deps.storage.writeKey(null)
      this.client = null
      this.setStatus({ state: 'error', via: null, error: err instanceof UnauthorizedError ? 'Composio did not accept that key.' : String(err?.message ?? err) })
    }
    return this.status_
  }

  private setAndReturn(s: AppsStatus): AppsStatus { this.setStatus(s); return s }

  async disconnect(): Promise<AppsStatus> {
    this.signIn?.abort()
    await this.close()
    this.deps.storage.writeOAuth(null)
    this.deps.storage.writeKey(null)
    this.tools = null
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

  owns(name: string): boolean { return isOfferedTool(name) || name === 'COMPOSIO_REMOTE_WORKBENCH' || name === 'COMPOSIO_REMOTE_BASH_TOOL' }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean; json: unknown }> {
    const client = await this.ensure()
    if (!client) return { text: 'Apps are not connected. The user can connect them in Preferences → Apps.', isError: true, json: undefined }
    const result = await client.callTool({ name, arguments: sanitizeArguments(name, args) }, undefined, { signal, timeout: 120_000 })
    return mcpResultText(result)
  }

  /** Start connecting one app (Preferences → Apps): opens its sign-in page. */
  async connectApp(toolkit: string): Promise<{ ok: boolean; opened: number; message?: string }> {
    const { json, text, isError } = await this.call('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [toolkit] })
    if (isError) return { ok: false, opened: 0, message: text.slice(0, 300) }
    const links = connectionLinks(json)
    for (const l of links.slice(0, 1)) await this.deps.openExternal(l.url)
    return { ok: true, opened: Math.min(1, links.length), message: links.length ? undefined : 'Already connected.' }
  }
}
