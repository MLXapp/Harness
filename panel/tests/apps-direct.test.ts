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
