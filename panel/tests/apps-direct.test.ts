import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { DIRECT_MAX_TOOLS, parseToolSchemas, pickDirectSlugs, toDirectTools, trimSchema } from '../src/main/apps/composioDirect'
import { AppsService, type AppsStorage } from '../src/main/apps/appsService'

describe('direct app tools', () => {
  it('picks reads and writes round-robin, at most 12', () => {
    expect(pickDirectSlugs(['gmail', 'slack']).slice(0, 4)).toEqual(['GMAIL_FETCH_EMAILS', 'SLACK_FETCH_CONVERSATION_HISTORY', 'GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE'])
    expect(pickDirectSlugs(['gmail', 'googlecalendar', 'slack', 'notion', 'googledrive']).length).toBe(DIRECT_MAX_TOOLS)
    expect(pickDirectSlugs(['unknownapp'])).toEqual([])
  })
  it('parses schemas leniently and trims them', () => {
    const s = parseToolSchemas({ data: { tool_schemas: { GMAIL_SEND_EMAIL: { description: 'Send', input_schema: { type: 'object', properties: { to: { type: 'string', description: 'x'.repeat(500), examples: ['a'] } } } }, bad: {} } } })
    expect(Object.keys(s)).toEqual(['GMAIL_SEND_EMAIL'])
    const to = (s.GMAIL_SEND_EMAIL.parameters as any).properties.to
    expect(to.examples).toBeUndefined()
    expect(to.description.length).toBeLessThanOrEqual(240)
    expect(toDirectTools(['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'], s).map(t => t.function.name)).toEqual(['gmail_send_email'])
    expect(trimSchema({ title: 'x', type: 'string' })).toEqual({ type: 'string' })
  })
})

describe('AppsService direct mode against an MCP server', () => {
  let server: Server | null = null
  afterEach(() => { server?.close(); server = null })
  it('fetches schemas once for connected apps and maps calls to multi-execute', async () => {
    let schemaCalls = 0
    server = createServer(async (req, res) => {
      const mcp = new McpServer({ name: 'fake', version: '1' })
      mcp.tool('COMPOSIO_GET_TOOL_SCHEMAS', 'schemas', { tool_slugs: z.array(z.string()) }, async ({ tool_slugs }) => {
        schemaCalls++
        const tool_schemas: Record<string, unknown> = {}
        for (const slug of tool_slugs) tool_schemas[slug] = { description: `${slug} tool`, input_schema: { type: 'object', properties: {} } }
        return { content: [{ type: 'text', text: JSON.stringify({ data: { tool_schemas }, successful: true }) }] }
      })
      mcp.tool('COMPOSIO_MULTI_EXECUTE_TOOL', 'exec', { tools: z.array(z.any()), sync_response_to_workbench: z.boolean().optional() }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }))
      mcp.tool('COMPOSIO_MANAGE_CONNECTIONS', 'conn', { toolkits: z.array(z.string()) }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ data: { results: { gmail: { status: 'active' } } } }) }] }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => { void transport.close(); void mcp.close() })
      await mcp.connect(transport)
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`
    let connected: string[] = []
    let cache: Record<string, any> = {}
    const storage: AppsStorage = {
      readOAuth: () => null, writeOAuth: () => {}, readKey: () => 'ck', writeKey: () => {},
      readRules: () => ({}), writeRules: () => {}, chatEnabled: () => true, setChatEnabled: () => {},
      readConnected: () => connected, writeConnected: v => { connected = v },
      readSchemaCache: () => cache, writeSchemaCache: v => { cache = v },
    }
    const apps = new AppsService({ storage, openExternal: () => undefined, connectUrl: url })
    expect(await apps.directTools()).toEqual([])
    await apps.connectApp('gmail')
    expect(connected).toEqual(['gmail'])
    const tools = await apps.directTools()
    expect(tools.map(t => t.function.name)).toEqual(['gmail_fetch_emails', 'gmail_send_email', 'gmail_create_email_draft', 'gmail_reply_to_thread'])
    await apps.directTools()
    expect(schemaCalls).toBe(1)
    expect(apps.owns('gmail_send_email')).toBe(true)
    expect(apps.asExecute('gmail_send_email', { to: 'a' })).toEqual({ tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a' } }] })
    expect(apps.asExecute('nope', {})).toBeNull()
  })
})

describe('connectionState', () => {
  it('says connected only on a positive signal', async () => {
    const { connectionState } = await import('../src/main/apps/composioPolicy')
    expect(connectionState({ data: { results: { gmail: { status: 'active' } } } }, '', 'gmail')).toBe('yes')
    expect(connectionState({ gmail: { is_connected: true } }, '', 'gmail')).toBe('yes')
    expect(connectionState({ data: { results: { gmail: { status: 'INITIATED', redirect_url: 'https://connect.composio.dev/x' } } } }, '', 'gmail')).toBe('no')
    expect(connectionState({ gmail: { connection_status: 'EXPIRED' } }, '', 'gmail')).toBe('no')
    expect(connectionState(undefined, 'Something went wrong', 'gmail')).toBe('unknown')
    expect(connectionState({ data: {} }, '', 'gmail')).toBe('unknown')
    expect(connectionState(undefined, 'Gmail is already connected.', 'gmail')).toBe('yes')
    // Review cases: negatives in text, and nested non-account flags.
    expect(connectionState(undefined, 'No active connection for gmail yet.', 'gmail')).toBe('no')
    expect(connectionState({ gmail: { status: 'initiated', auth_config: { status: 'ENABLED' }, redirect_url: 'https://x.dev/a' } }, '', 'gmail')).toBe('no')
    expect(connectionState({ gmail: { toolkit: { slug: 'gmail', is_active: true }, status: 'initiated' } }, '', 'gmail')).toBe('no')
    expect(connectionState({ results: { gmail: { status: 'timeout' } } }, '', 'gmail')).toBe('no')
    expect(connectionState(undefined, 'Gmail: 1 active, 0 expired', 'gmail')).toBe('yes')
    expect(connectionState(undefined, 'The Gmail connection has expired.', 'gmail')).toBe('no')
  })
})

describe('connection replies Composio sends', () => {
  it('reads the app entry first; an active connection beats an older pending one', async () => {
    const { connectionState } = await import('../src/main/apps/composioPolicy')
    // A second attempt leaves an initiated account beside the active one.
    expect(connectionState({ data: { results: { gmail: { toolkit: 'gmail', status: 'active', has_active_connection: true, connected_accounts: [{ status: 'INITIATED' }] } } } }, '', 'gmail')).toBe('yes')
    // Summary counts: zero failures are not a failure.
    expect(connectionState({ data: { message: '1 active, 0 initiated, 0 failed', results: {}, summary: { total_toolkits: 1, active_connections: 1, initiated_connections: 0, failed_connections: 0 } } }, '', 'gmail')).toBe('yes')
    expect(connectionState(undefined, 'Checked 1 toolkit: 1 active, 0 failed', 'gmail')).toBe('yes')
    expect(connectionState({ data: { results: { gmail: { status: 'initiated', redirect_url: 'https://connect.composio.dev/link/x' } }, summary: { total_toolkits: 1, active_connections: 0, initiated_connections: 1 } } }, '', 'gmail')).toBe('no')
    // Results as a list naming the toolkit.
    expect(connectionState({ data: { results: [{ toolkit: 'slack', status: 'ACTIVE' }, { toolkit: 'gmail', status: 'INITIATED' }] } }, '', 'slack')).toBe('yes')
    expect(connectionState({ data: { results: [{ toolkit: 'slack', status: 'ACTIVE' }, { toolkit: 'gmail', status: 'INITIATED' }] } }, '', 'gmail')).toBe('no')
    // An active account in the entry's account list counts.
    expect(connectionState({ data: { results: { gmail: { status: 'initiated', connected_accounts: [{ status: 'ACTIVE' }] } } } }, '', 'gmail')).toBe('yes')
    // The user's own profile data is never read as a status.
    expect(connectionState({ data: { results: { gmail: { has_active_connection: true, current_user_info: { status: 'disabled' } } } } }, '', 'gmail')).toBe('yes')
  })
})

describe('connecting an app through the browser', () => {
  let server: Server | null = null
  afterEach(() => { server?.close(); server = null })

  it('stays pending across a reopen, turns connected by itself, and stays until removed', async () => {
    let signedIn = false
    let manageCalls = 0
    server = createServer(async (req, res) => {
      const mcp = new McpServer({ name: 'fake', version: '1' })
      mcp.tool('COMPOSIO_MANAGE_CONNECTIONS', 'conn', { toolkits: z.array(z.string()) }, async ({ toolkits }) => {
        manageCalls++
        const tk = toolkits[0]
        const results = signedIn
          ? { [tk]: { toolkit: tk, status: 'ACTIVE', has_active_connection: true } }
          : { [tk]: { toolkit: tk, status: 'INITIATED', redirect_url: 'https://connect.composio.dev/link/abc' } }
        return { content: [{ type: 'text', text: JSON.stringify({ data: { message: 'ok', results }, successful: true }) }] }
      })
      mcp.tool('COMPOSIO_WAIT_FOR_CONNECTIONS', 'wait', { toolkits: z.array(z.string()), timeout_seconds: z.number().min(1).max(60).optional() }, async ({ toolkits }) => ({
        content: [{ type: 'text', text: JSON.stringify({ data: { results: { [toolkits[0]]: { status: signedIn ? 'active' : 'initiated' } } } }) }],
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => { void transport.close(); void mcp.close() })
      await mcp.connect(transport)
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`
    let connected: string[] = []
    let pending: Record<string, number> = {}
    let changes = 0
    const opened: string[] = []
    let rules: Record<string, any> = {}
    const storage: AppsStorage = {
      readOAuth: () => null, writeOAuth: () => {}, readKey: () => 'ck', writeKey: () => {},
      readRules: () => rules, writeRules: v => { rules = v }, chatEnabled: () => true, setChatEnabled: () => {},
      readConnected: () => connected, writeConnected: v => { connected = v },
      readPending: () => pending, writePending: v => { pending = v },
    }
    const make = () => new AppsService({ storage, openExternal: u => { opened.push(u) }, connectUrl: url, onAppsChanged: () => { changes++ }, watchEveryMs: 50 })
    const apps = make()
    const r = await apps.connectApp('gmail')
    expect(r).toMatchObject({ ok: true, opened: 1, connected: false })
    expect(opened).toEqual(['https://connect.composio.dev/link/abc'])
    expect(Object.keys(pending)).toEqual(['gmail'])
    expect(await apps.checkApp('gmail')).toMatchObject({ ok: true, connected: false, pending: true })

    // Preferences closed and reopened (a new service, as after a restart): still pending.
    const again = make()
    expect(again.pendingApps()).toEqual(['gmail'])
    again.resumePending()
    signedIn = true // the user finishes in the browser
    await new Promise(r => setTimeout(r, 400))
    expect(connected).toEqual(['gmail'])
    expect(pending).toEqual({})
    expect(changes).toBeGreaterThan(0)

    // Stays connected; Connect on an app already active opens nothing.
    expect(make().connectedApps()).toEqual(['gmail'])
    const before = opened.length
    expect(await again.connectApp('gmail')).toMatchObject({ ok: true, opened: 0, connected: true })
    expect(opened.length).toBe(before)

    again.removeApp('gmail')
    expect(connected).toEqual([])
    expect(rules).toEqual({ gmail: 'blocked' })
    expect(manageCalls).toBeGreaterThan(0)
    apps.removeApp('gmail')
  })
})
