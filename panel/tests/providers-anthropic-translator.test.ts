import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AnthropicStreamTranslator,
  SseParser,
  ThinkingCache,
  anthropicMessagesUrl,
  createAnthropicFetch,
  toAnthropicRequest,
  translateAnthropicStream,
  type OpenAIChatBody,
  type PipelineFetch,
} from '../src/main/providers/anthropic'

const sse = (name: string) => readFileSync(join(__dirname, 'fixtures/providers', name), 'utf8')

/** Byte stream from text, split at awkward offsets to exercise buffering. */
function streamOf(text: string, sizes = [7, 31, 3, 64, 1]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  const parts: Uint8Array[] = []
  let at = 0
  let i = 0
  while (at < bytes.length) {
    const size = sizes[i++ % sizes.length]
    parts.push(bytes.slice(at, at + size))
    at += size
  }
  return new ReadableStream({
    pull(controller) {
      const next = parts.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * Assemble OpenAI chunks the way the chat pipeline does: content and
 * reasoning concatenate, tool_calls accumulate by index.
 */
function assemble(openaiSse: string) {
  const lines = openaiSse.split('\n').filter(l => l.startsWith('data: '))
  expect(lines[lines.length - 1]).toBe('data: [DONE]')
  let content = ''
  let reasoning = ''
  let finish: string | null = null
  let usage: any
  let id = ''
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  for (const line of lines.slice(0, -1)) {
    const chunk = JSON.parse(line.slice(6))
    if (chunk.id) id = chunk.id
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finish = choice.finish_reason
    const delta = choice.delta ?? {}
    if (delta.content) content += delta.content
    if (delta.reasoning_content) reasoning += delta.reasoning_content
    for (const tc of delta.tool_calls ?? []) {
      const slot = (calls[tc.index] ??= { id: '', name: '', arguments: '' })
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.arguments += tc.function.arguments
    }
  }
  return { id, content, reasoning, finish, usage, calls }
}

const TOOLS: OpenAIChatBody['tools'] = [{
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
}]

describe('Anthropic request translation', () => {
  it('maps system, user media, assistant tool calls, tool results and tools', () => {
    const request = toAnthropicRequest({
      model: 'ignored',
      messages: [
        { role: 'system', content: 'You are MLX Harness.' },
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is in this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call:1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
          { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: 'not json' } },
        ] },
        { role: 'tool', tool_call_id: 'call:1', content: 'alpha' },
        { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'beta' }] },
        { role: 'user', content: 'Thanks' },
        { role: 'system', content: 'Reminder: todo list.' },
      ],
      tools: TOOLS,
      tool_choice: 'required',
      temperature: 0.4,
      top_p: 0.9,
      stop: ['END', '  '],
      max_tokens: 2048,
    }, { model: 'claude-sonnet-4-5', thinkingCache: new ThinkingCache() })

    expect(request.model).toBe('claude-sonnet-4-5')
    expect(request.system).toBe('You are MLX Harness.\n\nBe brief.')
    expect(request.stream).toBe(true)
    expect(request.max_tokens).toBe(2048)
    expect(request.temperature).toBe(0.4)
    expect(request.top_p).toBe(0.9)
    expect(request.stop_sequences).toEqual(['END'])
    expect(request.tools).toEqual([{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }])
    expect(request.tool_choice).toEqual({ type: 'any' })
    expect(request.thinking).toBeUndefined()
    expect(request.messages).toEqual([
      { role: 'user', content: [
        { type: 'text', text: 'What is in this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'call_2', name: 'read_file', input: { _raw_arguments: 'not json' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'alpha' }] },
        { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'beta' }] },
        { type: 'text', text: 'Thanks' },
        { type: 'text', text: '<system>\nReminder: todo list.\n</system>' },
      ] },
    ])
  })

  it('turns reasoning effort into a thinking budget and drops sampling knobs', () => {
    const request = toAnthropicRequest({
      messages: [{ role: 'user', content: 'Think hard' }],
      reasoning_effort: 'high',
      temperature: 0.2,
      top_k: 20,
    }, { model: 'claude-opus-4-1', maxTokens: 32000 })
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
    expect(request.max_tokens).toBeGreaterThan(16384)
    expect(request.max_tokens).toBeLessThanOrEqual(32000)
    expect(request.temperature).toBeUndefined()
    expect(request.top_k).toBeUndefined()

    const capped = toAnthropicRequest({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'max' }, { model: 'm', maxTokens: 8192 })
    expect(capped.max_tokens).toBe(8192)
    expect(capped.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 - 1024 })

    expect(toAnthropicRequest({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'none' }, { model: 'm' }).thinking).toBeUndefined()
    expect(toAnthropicRequest({ messages: [{ role: 'assistant', content: 'hi' }] }, { model: 'm' }).messages[0])
      .toEqual({ role: 'user', content: [{ type: 'text', text: '(continue)' }] })
  })

  it('builds the Messages URL from a base with or without /v1', () => {
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropicMessagesUrl('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropicMessagesUrl('https://api.minimax.io/anthropic')).toBe('https://api.minimax.io/anthropic/v1/messages')
  })
})

describe('Anthropic stream translation', () => {
  it('parses SSE records split across arbitrary chunks', () => {
    const parser = new SseParser()
    const text = 'event: a\ndata: {"x":1}\n\n: comment\n\nevent: b\r\ndata: {"y":\r\ndata: 2}\r\n\r\n'
    const records = [...parser.feed(text.slice(0, 9)), ...parser.feed(text.slice(9)), ...parser.flush()]
    expect(records).toEqual([{ event: 'a', data: '{"x":1}' }, { event: 'b', data: '{"y":\n2}' }])
  })

  it('turns a thinking + text + tool_use stream into Chat Completions chunks', async () => {
    const cache = new ThinkingCache()
    const out = await readAll(translateAnthropicStream(streamOf(sse('anthropic-tool-stream.sse')), 'claude-sonnet-4-5', cache))
    const turn = assemble(out)
    expect(turn.id).toBe('msg_01ToolTurn')
    expect(turn.reasoning).toBe('The user wants the file. I should read it.')
    expect(turn.content).toBe('Let me read README.md.')
    expect(turn.finish).toBe('tool_calls')
    expect(turn.calls).toEqual([{ id: 'toolu_01A09q90qw90lq917835lq9', name: 'read_file', arguments: '{"path": "README.md", "limit": 40}' }])
    expect(JSON.parse(turn.calls[0].arguments)).toEqual({ path: 'README.md', limit: 40 })
    expect(turn.usage).toEqual({ prompt_tokens: 2000, completion_tokens: 87, total_tokens: 2087, prompt_tokens_details: { cached_tokens: 800 } })
    expect(cache.get('toolu_01A09q90qw90lq917835lq9')).toEqual([
      { type: 'thinking', thinking: 'The user wants the file. I should read it.', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds' },
    ])
  })

  it('maps stop reasons and passes stream errors as error chunks', () => {
    const t = new AnthropicStreamTranslator('m', new ThinkingCache())
    t.push('message_start', { type: 'message_start', message: { id: 'msg_x', usage: { input_tokens: 5 } } })
    expect(t.push('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }))
      .toEqual([expect.objectContaining({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })])
    expect(t.push('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
      .toEqual([{ error: { message: 'Overloaded', type: 'overloaded_error', code: 'overloaded_error' } }])
    expect(t.push('ping', { type: 'ping' })).toEqual([])
  })
})

describe('tool-call round trip through the translator', () => {
  it('replays the assistant tool turn with its signed thinking and the tool result', async () => {
    const cache = new ThinkingCache()
    const requests: any[] = []
    const replies = [sse('anthropic-tool-stream.sse'), sse('anthropic-text-stream.sse')]
    const upstream: PipelineFetch = async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return { ok: true, status: 200, statusText: 'OK', body: streamOf(replies.shift()!), text: async () => '' }
    }
    const fetch = createAnthropicFetch({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-xyz', model: 'claude-sonnet-4-5', maxTokens: 64000, upstream, thinkingCache: cache })

    // Pass 1: the pipeline's first request (URL is the pipeline's; ignored).
    const history: any[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Read the README' }]
    const first = await fetch('https://api.anthropic.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: history, tools: TOOLS, stream: true, reasoning_effort: 'medium' }),
    })
    const turn = assemble(await readAll(first.body!))
    expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0].headers['x-api-key']).toBe('sk-ant-xyz')
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(requests[0].headers.authorization).toBeUndefined()
    expect(requests[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })

    // The pipeline appends the assistant tool turn and the tool result (OpenAI shape).
    history.push({ role: 'assistant', content: turn.content, reasoning_content: turn.reasoning,
      tool_calls: turn.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) })
    history.push({ role: 'tool', tool_call_id: turn.calls[0].id, content: '# Hello' })

    // Pass 2: the follow-up request carries the thinking signature back.
    const second = await fetch('https://api.anthropic.com/v1/chat/completions', {
      method: 'POST', headers: {}, body: JSON.stringify({ messages: history, tools: TOOLS, stream: true, reasoning_effort: 'medium' }),
    })
    const answer = assemble(await readAll(second.body!))
    expect(answer.content).toBe('The README says hello.')
    expect(answer.finish).toBe('stop')

    const replay = requests[1].body
    expect(replay.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(replay.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Read the README' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'The user wants the file. I should read it.', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds' },
        { type: 'text', text: 'Let me read README.md.' },
        { type: 'tool_use', id: 'toolu_01A09q90qw90lq917835lq9', name: 'read_file', input: { path: 'README.md', limit: 40 } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01A09q90qw90lq917835lq9', content: [{ type: 'text', text: '# Hello' }] }] },
    ])
  })

  it('leaves thinking off when a replayed tool turn has no signed thinking', () => {
    const request = toAnthropicRequest({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_unknown1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'toolu_unknown1', content: 'ok' },
      ],
      reasoning_effort: 'high',
    }, { model: 'm', thinkingCache: new ThinkingCache() })
    expect(request.thinking).toBeUndefined()
  })

  it('passes upstream errors through untouched for the pipeline to report', async () => {
    const upstream: PipelineFetch = async () => ({
      ok: false, status: 401, statusText: 'Unauthorized', body: null,
      text: async () => JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    })
    const fetch = createAnthropicFetch({ baseURL: 'https://api.anthropic.com', apiKey: 'bad', model: 'm', upstream })
    const res = await fetch('x', { method: 'POST', headers: {}, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
    expect(JSON.parse(await res.text()).error.message).toBe('invalid x-api-key')
  })
})
