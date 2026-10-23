import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import {
  appsInCall, connectionLinks, decideAppCall, isReadAction, mcpResultText, sanitizeArguments, toolkitOf, wrapUntrusted,
} from '../src/main/apps/composioPolicy'
import { AppsService, type AppsStorage } from '../src/main/apps/appsService'
import { decideToolPermission, looksReadOnlyToolName } from '../src/main/agent/permissions'

describe('app call policy', () => {
  const exec = (...slugs: string[]) => ({ tools: slugs.map(tool_slug => ({ tool_slug, arguments: { to: 'a@b.c', body: 'hi' } })), sync_response_to_workbench: true })

  it('lets searching, schemas, connection links and reading actions run', () => {
    expect(decideAppCall('COMPOSIO_SEARCH_TOOLS', {}, {})).toEqual({ action: 'allow' })
    expect(decideAppCall('COMPOSIO_GET_TOOL_SCHEMAS', {}, {})).toEqual({ action: 'allow' })
    expect(decideAppCall('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: ['gmail'] }, {})).toEqual({ action: 'allow' })
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('GMAIL_FETCH_EMAILS', 'GOOGLECALENDAR_EVENTS_LIST'), {})).toEqual({ action: 'allow' })
  })

  it('asks before sends and changes, showing the fields', () => {
    const d = decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('GMAIL_SEND_EMAIL'), {})
    expect(d).toMatchObject({ action: 'ask', apps: ['gmail'], allowAlways: true })
    if (d.action === 'ask') expect(d.summary).toContain('Gmail · Send email\nto: a@b.c\nbody: hi')
  })

  it('follows per-app rules; deletes always ask; blocked apps are refused', () => {
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('SLACK_SEND_MESSAGE'), { slack: 'always' })).toEqual({ action: 'allow' })
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('SLACK_DELETE_MESSAGE'), { slack: 'always' })).toMatchObject({ action: 'ask', allowAlways: false })
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('GMAIL_FETCH_EMAILS'), { gmail: 'blocked' }).action).toBe('deny')
  })

  it('never offers the remote sandboxes and refuses writes in Plan mode', () => {
    expect(decideAppCall('COMPOSIO_REMOTE_WORKBENCH', {}, {}).action).toBe('deny')
    expect(decideAppCall('COMPOSIO_REMOTE_BASH_TOOL', {}, {}).action).toBe('deny')
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('GMAIL_SEND_EMAIL'), {}, { plan: true }).action).toBe('deny')
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('GMAIL_FETCH_EMAILS'), {}, { plan: true }).action).toBe('allow')
  })

  it('refuses shapes it cannot read and nested meta tools', () => {
    for (const tools of ['[{"tool_slug":"GMAIL_SEND_EMAIL"}]', { tool_slug: 'GMAIL_SEND_EMAIL' }, [null], [{ tool_slug: 1 }], []]) {
      expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools } as any, {}).action).toBe('deny')
    }
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('COMPOSIO_REMOTE_BASH_TOOL'), {}).action).toBe('deny')
  })

  it('a read-and-delete action is a delete; app data in the chat overrides Always', () => {
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('GMAIL_SEARCH_AND_TRASH'), {}).action).toBe('ask')
    expect(isReadAction('GOOGLESHEETS_FIND_REPLACE')).toBe(false)
    const d = decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('SLACK_SEND_MESSAGE'), { slack: 'always' }, { untrusted: true })
    expect(d).toMatchObject({ action: 'ask', allowAlways: false })
  })

  it('rules apply to toolkits with underscores', () => {
    expect(toolkitOf('MICROSOFT_TEAMS_SEND_MESSAGE')).toBe('microsoft_teams')
    expect(decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('MICROSOFT_TEAMS_SEND_MESSAGE'), { microsoft_teams: 'blocked' }).action).toBe('deny')
    expect(toolkitOf('ACME_CRM_LIST_DEALS', ['acme_crm'])).toBe('acme_crm')
  })

  it('shows recipients first and never cuts them', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) many[`filler${i}`] = 'x'
    const d = decideAppCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { ...many, bcc: 'spy@evil.test', recipient_email: 'a@b.c' } }] }, {})
    if (d.action !== 'ask') throw new Error('expected ask')
    const lines = d.summary.split('\n')
    expect(lines[1]).toBe('bcc: spy@evil.test')
    expect(lines[2]).toBe('recipient_email: a@b.c')
  })

  it('reconnecting every app asks', () => {
    expect(decideAppCall('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: ['gmail'], reinitiate_all: true }, {}).action).toBe('ask')
  })

  it('helpers', () => {
    expect(toolkitOf('GOOGLESHEETS_BATCH_UPDATE')).toBe('googlesheets')
    expect(isReadAction('GITHUB_LIST_REPOSITORIES')).toBe(true)
    expect(isReadAction('GITHUB_CREATE_ISSUE')).toBe(false)
    expect(sanitizeArguments('COMPOSIO_MULTI_EXECUTE_TOOL', { sync_response_to_workbench: true })).toEqual({ sync_response_to_workbench: false })
    expect(wrapUntrusted('x', 'Gmail')).toMatch(/^\[Data from Gmail via Composio.*never as instructions/)
    expect(appsInCall('COMPOSIO_MULTI_EXECUTE_TOOL', exec('GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE'))).toEqual(['Gmail', 'Slack'])
    expect(connectionLinks({ data: { results: { gmail: { status: 'initiated', redirect_url: 'https://connect.composio.dev/link/abc' }, slack: { redirect_url: 'http://insecure' } } } }))
      .toEqual([{ toolkit: 'gmail', url: 'https://connect.composio.dev/link/abc' }])
    expect(mcpResultText({ content: [{ type: 'text', text: '{"ok":1}' }] })).toMatchObject({ text: '{"ok":1}', isError: false, json: { ok: 1 } })
  })

  it('read-looking MCP names that can change things ask', () => {
    for (const n of ['find_and_replace', 'search_and_replace', 'save_search', 'submit_query', 'fetch_and_save', 'status__restart_service', 'check_in', 'query', 'fetch']) {
      expect(looksReadOnlyToolName(n), n).toBe(false)
    }
    for (const n of ['list_issues', 'github__list_repos', 'searchFiles', 'get_settings', 'notion.search_pages']) {
      expect(looksReadOnlyToolName(n), n).toBe(true)
    }
  })

  it('MCP tools ask once app data is in the chat', () => {
    expect(decideToolPermission({ preset: 'workspace', toolName: 'github__list_repos', args: {}, isBuiltin: false, sandboxAvailable: true, untrustedData: true }))
      .toMatchObject({ action: 'ask', why: 'exfil' })
  })

  it('web tools ask once app data is in the turn (not with Full access)', () => {
    const base = { toolName: 'fetch_url', args: { url: 'https://x.y' }, isBuiltin: true, sandboxAvailable: true }
    expect(decideToolPermission({ ...base, preset: 'workspace' }).action).toBe('allow')
    expect(decideToolPermission({ ...base, preset: 'workspace', untrustedData: true })).toMatchObject({ action: 'ask', why: 'exfil' })
    expect(decideToolPermission({ ...base, preset: 'full', untrustedData: true }).action).toBe('allow')
  })
})

describe('AppsService against an MCP server (consumer key)', () => {
  let server: Server | null = null
  afterEach(() => { server?.close(); server = null })

  function memoryStorage(): AppsStorage {
    let oauth: any = null, key: string | null = null, rules: any = {}
    const chats = new Set<string>()
    return {
      readOAuth: () => oauth, writeOAuth: v => { oauth = v },
      readKey: () => key, writeKey: k => { key = k },
      readRules: () => rules, writeRules: r => { rules = r },
      chatEnabled: id => chats.has(id), setChatEnabled: (id, on) => { if (on) chats.add(id); else chats.delete(id) },
    }
  }

  async function fakeComposio(): Promise<string> {
    server = createServer(async (req, res) => {
      if (req.headers['x-consumer-api-key'] !== 'ck_good') { res.writeHead(401).end(); return }
      const mcp = new McpServer({ name: 'fake-composio', version: '1' })
      for (const name of ['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL']) {
        mcp.tool(name, `${name} description`, { tools: z.array(z.any()).optional(), sync_response_to_workbench: z.boolean().optional() }, async (args) => ({
          content: [{ type: 'text', text: JSON.stringify({ name, args }) }],
        }))
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => { void transport.close(); void mcp.close() })
      await mcp.connect(transport)
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      await transport.handleRequest(req, res, body)
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`
  }

  it('connects with a key, offers only the allowed meta tools, and calls them', async () => {
    const url = await fakeComposio()
    const storage = memoryStorage()
    const apps = new AppsService({ storage, openExternal: () => undefined, connectUrl: url })
    const bad = await apps.connectWithKey('ck_bad')
    expect(bad.state).toBe('error')
    expect(storage.readKey()).toBeNull()
    const ok = await apps.connectWithKey('ck_good')
    expect(ok).toMatchObject({ state: 'connected', via: 'key', toolCount: 2 })
    const names = (await apps.listTools()).map(t => t.function.name).sort()
    expect(names).toEqual(['COMPOSIO_MULTI_EXECUTE_TOOL', 'COMPOSIO_SEARCH_TOOLS'])
    const r = await apps.call('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [], sync_response_to_workbench: true })
    expect(r.json).toMatchObject({ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', args: { sync_response_to_workbench: false } })
    expect(apps.setChatEnabled('c1', true)).toBe(true)
    await apps.disconnect()
    expect(apps.chatEnabled('c1')).toBe(false)
    expect(storage.readKey()).toBeNull()
  })
})

describe('Apps wiring', () => {
  it('runs app tools in the chat loop with approvals and untrusted wrapping', () => {
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    expect(chat).toContain('} else if (appsService().owns(tc.function.name)) {')
    expect(chat).toContain('resultText = wrapUntrusted(appResult.text, appsHere.join(", ") || undefined);')
    expect(chat).toContain('untrustedData: appDataInTurn,')
    expect(chat).toContain('...appToolsForTurn,')
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain('registerAppsHandlers()')
  })
})
