/**
 * Drives the real chat:sendMessage handler for chats bound to a provider
 * model, against fake provider servers on 127.0.0.1 (no internet):
 *  - Anthropic Messages: the agent loop runs a tool through the translator
 *    and replays the signed thinking on the follow-up;
 *  - OpenAI-compatible endpoints: URL rewrite onto the provider base, bearer
 *    credential added in the main process, model id pinned;
 *  - HTTP failures map to readable messages.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const state = {
    userData: '',
    port: 0,
    overrides: {} as Record<string, any>,
    messages: [] as any[],
    agentState: new Map<string, { compactionJson: string | null; todosJson: string | null }>(),
    events: [] as Array<[string, any]>,
    binding: undefined as any,
    providers: new Map<string, any>(),
    keys: new Map<string, string>(),
    sessionLookups: 0,
  }
  return { handlers, state }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn),
    on: () => undefined,
  },
  BrowserWindow: class {},
  net: { fetch: () => { throw new Error('net.fetch must not be used for loopback providers') } },
  app: { getPath: () => h.state.userData },
  clipboard: { readText: () => '', writeText: () => undefined },
}))

vi.mock('../src/main/database', () => {
  const chat = { id: 'chat-1', title: 't', modelPath: '/models/local-model', modelId: 'local-model', createdAt: 0, updatedAt: 0 }
  const agent = (id: string) => h.state.agentState.get(id) ?? { compactionJson: null, todosJson: null }
  return {
    db: {
      getChat: (id: string) => (id === chat.id ? chat : undefined),
      getMessages: () => [...h.state.messages].sort((a, b) => a.timestamp - b.timestamp).map(m => ({ ...m })),
      addMessage: (m: any) => {
        const i = h.state.messages.findIndex(x => x.id === m.id)
        if (i >= 0) h.state.messages[i] = { ...m }
        else h.state.messages.push({ ...m })
      },
      deleteMessage: (id: string) => { h.state.messages = h.state.messages.filter(m => m.id !== id) },
      updateMessageContent: () => undefined,
      updateMessageGenerationRecord: () => undefined,
      getChatOverrides: () => ({ ...h.state.overrides }),
      getSetting: () => undefined,
      getSession: () => { h.state.sessionLookups++; return undefined },
      getChatAgentState: (id: string) => agent(id),
      setChatCompactionState: (id: string, json: string | null) => h.state.agentState.set(id, { ...agent(id), compactionJson: json }),
      setChatTodos: (id: string, json: string | null) => h.state.agentState.set(id, { ...agent(id), todosJson: json }),
      deleteChat: () => undefined,
      providers: {
        getChatBinding: () => h.state.binding,
        get: (id: string) => h.state.providers.get(id),
        resolveCredential: (id: string) => h.state.keys.get(id),
      },
    },
  }
})

vi.mock('../src/main/sessions', () => ({
  sessionManager: {
    // The provider route must not depend on any MLX session.
    getSessionByModelPath: () => { h.state.sessionLookups++; return undefined },
    getSessions: () => [],
    detect: async () => { h.state.sessionLookups++; return [] },
    touchSession: () => { throw new Error('touchSession must not run for provider chats') },
    getLastHealthyAt: () => 0,
    pushLog: () => undefined,
    emit: () => undefined,
    wakeSession: async () => ({ success: true }),
    waitForSessionLifecycleSettled: async () => 'running',
  },
  resolveUrl: async (url: string) => url,
  connectHost: (host: string) => host,
}))

vi.mock('../src/main/ipc/models', () => ({
  readDetectedModelConfig: async () => { throw new Error('no local model detection for provider chats') },
  readGenerationDefaults: async () => ({}),
}))
vi.mock('../src/main/ipc/utils', () => ({ getAuthHeaders: () => { throw new Error('session auth must not be used') } }))

// ── Fake provider server ────────────────────────────────────────────────────

const requests: Array<{ url: string; headers: IncomingMessage['headers']; body: any }> = []
let replies: Array<(res: ServerResponse) => void> = []

function anthropicSse(res: ServerResponse, events: Array<Record<string, unknown>>) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}

function openaiSse(res: ServerResponse, text: string) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const SIGNATURE = 'EqQBCgIYAhIMsig'

const toolTurn = (res: ServerResponse) => anthropicSse(res, [
  { type: 'message_start', message: { id: 'msg_tool', model: 'claude-test', usage: { input_tokens: 50, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Run it.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_run1', name: 'run_command', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "echo provider' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '-ok"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
  { type: 'message_stop' },
])

const textTurn = (text: string) => (res: ServerResponse) => anthropicSse(res, [
  { type: 'message_start', message: { id: 'msg_text', model: 'claude-test', usage: { input_tokens: 80, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
])

const errorReply = (status: number, message: string) => (res: ServerResponse) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'x', message } }))
}

function handle(req: IncomingMessage, res: ServerResponse) {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    requests.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined })
    const next = replies.shift()
    if (!next) {
      res.writeHead(500)
      res.end('no scripted reply')
      return
    }
    next(res)
  })
}

let server: Server
let send: (content: string) => Promise<any>

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, data: any) => h.state.events.push([channel, data]) },
}

beforeAll(async () => {
  h.state.userData = mkdtempSync(join(tmpdir(), 'mlx-userdata-'))
  server = createServer(handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  h.state.port = (server.address() as any).port
  const { registerChatHandlers } = await import('../src/main/ipc/chat')
  registerChatHandlers(() => fakeWindow as any)
  // The renderer still passes the old session endpoint: the binding must win.
  send = (content: string) => h.handlers.get('chat:sendMessage')!({}, 'chat-1', content, { host: '127.0.0.1', port: 1 })
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

beforeEach(() => {
  requests.length = 0
  replies = []
  h.state.events = []
  h.state.messages = []
  h.state.agentState.clear()
  h.state.providers.clear()
  h.state.keys.clear()
  h.state.sessionLookups = 0
  h.state.overrides = {
    builtinToolsEnabled: true,
    workingDirectory: mkdtempSync(join(tmpdir(), 'mlx-provider-work-')),
    permissionPreset: 'full',
    // A stale local-chat setting the provider route must override.
    wireApi: 'responses',
  }
})

describe('Anthropic provider through the agent loop', () => {
  beforeEach(() => {
    h.state.providers.set('anthropic', {
      id: 'anthropic', kind: 'catalog', displayName: 'Anthropic', api: 'anthropic-messages',
      baseURL: `http://127.0.0.1:${h.state.port}`, headers: {}, createdAt: 0,
      models: [{ id: 'claude-test', name: 'Claude Test', contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: ['off', 'low', 'medium', 'high'] }],
    })
    h.state.keys.set('anthropic', 'sk-ant-integration')
    h.state.binding = { chatId: 'chat-1', providerId: 'anthropic', modelId: 'claude-test', reasoningEffort: 'medium' }
  })

  it('runs a tool call and replays the signed thinking on the follow-up', async () => {
    replies = [toolTurn, textTurn('The command printed provider-ok.')]
    const result = await send('run echo for me')
    expect(result.content).toBe('The command printed provider-ok.')
    expect(requests).toHaveLength(2)

    const [first, second] = requests
    expect(first.url).toBe('/v1/messages')
    expect(first.headers['x-api-key']).toBe('sk-ant-integration')
    expect(first.headers['anthropic-version']).toBe('2023-06-01')
    expect(first.headers.authorization).toBeUndefined()
    expect(first.body.model).toBe('claude-test')
    expect(first.body.stream).toBe(true)
    expect(first.body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(typeof first.body.system).toBe('string')
    expect(first.body.tools.some((t: any) => t.name === 'run_command' && t.input_schema.type === 'object')).toBe(true)
    expect(first.body.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'run echo for me' }] })

    const assistant = second.body.messages.find((m: any) => m.role === 'assistant')
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'Run it.', signature: SIGNATURE })
    expect(assistant.content.at(-1)).toEqual({ type: 'tool_use', id: 'toolu_run1', name: 'run_command', input: { command: 'echo provider-ok' } })
    const toolResult = second.body.messages.at(-1).content.find((b: any) => b.type === 'tool_result')
    expect(toolResult.tool_use_id).toBe('toolu_run1')
    expect(JSON.stringify(toolResult.content)).toContain('provider-ok')
    expect(second.body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })

    // The persisted assistant row records the tool exchange and the reasoning.
    const row = h.state.messages.find(m => m.id === result.id)
    expect(JSON.parse(row.toolCallsOaiJson).map((c: any) => c.id)).toEqual(['toolu_run1'])
    expect(h.state.sessionLookups).toBe(0)
  })

  it('maps 401 to a key problem and 429 quota to a clear message', async () => {
    replies = [errorReply(401, 'invalid x-api-key')]
    await expect(send('hi')).rejects.toThrow(/Anthropic did not accept the API key: check the API key/)
    replies = [errorReply(429, 'Your credit balance is too low to access the Anthropic API.')]
    await expect(send('hi')).rejects.toThrow(/out of quota or credit/)
    replies = [errorReply(429, 'Number of request tokens has exceeded your per-minute rate limit')]
    await expect(send('hi')).rejects.toThrow(/rate limit reached/)
  })

  it('turns thinking off when the picker says Off', async () => {
    h.state.binding = { ...h.state.binding, reasoningEffort: 'off' }
    replies = [textTurn('ok')]
    await send('hi')
    expect(requests[0].body.thinking).toBeUndefined()
  })

  it('refuses image attachments for a text-only model before sending', async () => {
    h.state.providers.get('anthropic').models[0].input = ['text']
    await expect(h.handlers.get('chat:sendMessage')!({}, 'chat-1', 'what is this', undefined, [
      { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'a.png', kind: 'image' },
    ])).rejects.toThrow(/text input only/)
    expect(requests).toHaveLength(0)
  })

  it('asks for a key when none is stored', async () => {
    h.state.keys.clear()
    await expect(send('hi')).rejects.toThrow(/has no API key/)
    expect(requests).toHaveLength(0)
  })
})

describe('OpenAI-compatible provider', () => {
  it('rewrites the pipeline URL onto a non-/v1 base, adds the bearer key and pins the model', async () => {
    h.state.providers.set('google', {
      id: 'google', kind: 'catalog', displayName: 'Google Gemini', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${h.state.port}/v1beta/openai`, headers: { 'X-Title': 'MLX Studio' }, createdAt: 0,
      models: [{ id: 'gemini-test', input: ['text'] }],
    })
    h.state.keys.set('google', 'AIza-integration')
    h.state.binding = { chatId: 'chat-1', providerId: 'google', modelId: 'gemini-test' }
    replies = [res => openaiSse(res, 'Hello from Gemini.')]
    const result = await send('hi')
    expect(result.content).toBe('Hello from Gemini.')
    expect(requests[0].url).toBe('/v1beta/openai/chat/completions')
    expect(requests[0].headers.authorization).toBe('Bearer AIza-integration')
    expect(requests[0].headers['x-title']).toBe('MLX Studio')
    expect(requests[0].body.model).toBe('gemini-test')
    expect(requests[0].body.messages.at(-1)).toEqual({ role: 'user', content: 'hi' })
  })

  it('talks to a local server with its placeholder key', async () => {
    // LM Studio's real port is 1234; point the built-in definition at the fake.
    const catalog = await import('../src/shared/providers/catalog')
    const lmstudio = catalog.LOCAL_SERVERS.find(s => s.id === 'lmstudio')! as { baseURL: string }
    const original = lmstudio.baseURL
    lmstudio.baseURL = `http://127.0.0.1:${h.state.port}/v1`
    try {
      h.state.binding = { chatId: 'chat-1', providerId: 'lmstudio', modelId: 'qwen2.5-7b-instruct-mlx' }
      replies = [res => openaiSse(res, 'Local answer.')]
      const result = await send('hi')
      expect(result.content).toBe('Local answer.')
      expect(requests[0].url).toBe('/v1/chat/completions')
      expect(requests[0].headers.authorization).toBe('Bearer lm-studio')
      expect(requests[0].body.model).toBe('qwen2.5-7b-instruct-mlx')
    } finally {
      lmstudio.baseURL = original
    }
  })
})
