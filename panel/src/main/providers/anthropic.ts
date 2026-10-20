/**
 * Anthropic Messages client for the chat pipeline.
 *
 * The chat pipeline (src/main/ipc/chat.ts) speaks OpenAI Chat Completions:
 * it POSTs `{messages, tools, ...}` and parses `chat.completion.chunk` SSE.
 * This module translates that request into an Anthropic Messages request and
 * the Anthropic SSE stream back into Chat Completions chunks, so the agent
 * loop (tools, compaction, approvals) runs unchanged against Claude:
 *
 *   OpenAI request ──toAnthropicRequest──▶ POST {root}/v1/messages
 *   Anthropic SSE  ──AnthropicStreamTranslator──▶ OpenAI chunks + [DONE]
 *
 * Stream events handled: message_start (id, input usage), content_block_start
 * (text / thinking / redacted_thinking / tool_use), content_block_delta
 * (text_delta, thinking_delta, signature_delta, input_json_delta),
 * content_block_stop, message_delta (stop_reason, output usage),
 * message_stop, ping, error.
 *
 * Extended thinking with tools: Anthropic requires the assistant turn that
 * made a tool call to be replayed with its signed thinking blocks. The OpenAI
 * history has no place for signatures, so the translator remembers them per
 * tool_use id (ThinkingCache) and puts them back when that assistant turn is
 * replayed. When they are not known (e.g. after a restart), thinking is left
 * off for that request rather than failing it.
 */

import { ANTHROPIC_VERSION } from './discovery'

// ── Types (only the fields this translator reads or writes) ────────────────

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } | string }
  | { type: string; [key: string]: unknown }

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_calls?: Array<{ id: string; type?: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  reasoning_content?: string
  [key: string]: unknown
}

export interface OpenAIChatBody {
  model?: string
  messages: OpenAIMessage[]
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  parallel_tool_calls?: boolean
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop?: string | string[]
  reasoning_effort?: string
  [key: string]: unknown
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: Array<{ type: 'text'; text: string } | { type: 'image'; source: unknown }>; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string } | Record<string, unknown>
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  thinking?: { type: 'enabled'; budget_tokens: number }
  stream: true
}

export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string }

/** Signed thinking blocks by the tool_use id they preceded (bounded, oldest evicted). */
export class ThinkingCache {
  private readonly entries = new Map<string, ThinkingBlock[]>()
  constructor(private readonly limit = 256) {}
  set(toolUseId: string, blocks: ThinkingBlock[]): void {
    this.entries.delete(toolUseId)
    this.entries.set(toolUseId, blocks)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
  get(toolUseId: string): ThinkingBlock[] | undefined {
    return this.entries.get(toolUseId)
  }
}

/** Shared across requests of the main process. */
export const sharedThinkingCache = new ThinkingCache()

// ── Request translation ────────────────────────────────────────────────────

/** Thinking budgets for the pipeline's reasoning levels. */
export const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 63999,
}

const DEFAULT_MAX_TOKENS = 8192
const THINKING_MAX_TOKENS_WITHOUT_CAP = 32000

/** Anthropic tool ids must match ^[a-zA-Z0-9_-]+$; ids from other providers may not. */
export function anthropicToolId(id: string | undefined): string {
  const cleaned = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned || 'toolu_unknown'
}

function textOf(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && part.type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
}

function imageBlock(url: string): AnthropicBlock | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
  if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } }
  return undefined
}

/** User/tool content parts → Anthropic text and image blocks. */
function contentBlocks(content: OpenAIMessage['content']): Array<{ type: 'text'; text: string } | { type: 'image'; source: any }> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; source: any }> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
      const text = (part as { text: string }).text
      if (text) blocks.push({ type: 'text', text })
    } else if (part.type === 'image_url') {
      const ref = (part as { image_url: { url: string } | string }).image_url
      const url = typeof ref === 'string' ? ref : ref?.url
      const block = url ? imageBlock(url) : undefined
      if (block && block.type === 'image') blocks.push(block)
    } else if (part.type === 'input_audio' || part.type === 'video_url' || part.type === 'video') {
      blocks.push({ type: 'text', text: `[${part.type === 'input_audio' ? 'audio' : 'video'} attachment not supported by this model]` })
    }
  }
  return blocks
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
  } catch {
    return { _raw_arguments: raw }
  }
}

export interface AnthropicRequestOptions {
  /** The provider model id (wins over body.model). */
  model?: string
  /** The model's configured output cap. */
  maxTokens?: number
  thinkingCache?: ThinkingCache
}

/** OpenAI Chat Completions body → Anthropic Messages body. */
export function toAnthropicRequest(body: OpenAIChatBody, options: AnthropicRequestOptions = {}): AnthropicRequest {
  const cache = options.thinkingCache ?? sharedThinkingCache
  const systemParts: string[] = []
  const messages: AnthropicMessage[] = []
  let leading = true
  let lastAssistantToolTurnHasThinking: boolean | undefined

  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return
    const last = messages[messages.length - 1]
    // Anthropic alternates roles; merge consecutive turns of the same role.
    if (last && last.role === role) {
      if (role === 'user') {
        // tool_result blocks must come first in a user turn.
        const results = [...last.content, ...blocks].filter(b => b.type === 'tool_result')
        const others = [...last.content, ...blocks].filter(b => b.type !== 'tool_result')
        last.content = [...results, ...others]
      } else {
        last.content.push(...blocks)
      }
    } else {
      messages.push({ role, content: blocks })
    }
  }

  for (const message of body.messages ?? []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content)
      if (!text) continue
      if (leading) systemParts.push(text)
      else push('user', [{ type: 'text', text: `<system>\n${text}\n</system>` }])
      continue
    }
    leading = false
    if (message.role === 'user') {
      push('user', contentBlocks(message.content))
    } else if (message.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (calls.length > 0) {
        const thinking = cache.get(anthropicToolId(calls[0].id))
        if (thinking) blocks.push(...thinking)
        lastAssistantToolTurnHasThinking = !!thinking
      } else {
        lastAssistantToolTurnHasThinking = undefined
      }
      const text = textOf(message.content)
      if (text.trim()) blocks.push({ type: 'text', text })
      for (const call of calls) {
        blocks.push({
          type: 'tool_use',
          id: anthropicToolId(call.id),
          name: call.function?.name || 'unknown_tool',
          input: parseArguments(call.function?.arguments),
        })
      }
      push('assistant', blocks)
    } else if (message.role === 'tool') {
      const content = contentBlocks(message.content)
      push('user', [{
        type: 'tool_result',
        tool_use_id: anthropicToolId(message.tool_call_id),
        content: content.length > 0 ? content : [{ type: 'text', text: '(empty result)' }],
      }])
    }
  }

  // The conversation must open with a user turn.
  if (messages.length === 0 || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] })
  }

  const request: AnthropicRequest = {
    model: options.model || body.model || '',
    max_tokens: 0,
    messages,
    stream: true,
  }
  if (systemParts.length > 0) request.system = systemParts.join('\n\n')

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    request.tools = body.tools
      .filter(tool => tool && tool.type === 'function' && tool.function?.name)
      .map(tool => ({
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        input_schema: tool.function.parameters && typeof tool.function.parameters === 'object'
          ? { type: 'object', ...tool.function.parameters }
          : { type: 'object', properties: {} },
      }))
    const choice = body.tool_choice
    const parallelOff = body.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}
    if (choice === 'none') request.tool_choice = { type: 'none' }
    else if (choice === 'required') request.tool_choice = { type: 'any', ...parallelOff }
    else if (choice && typeof choice === 'object' && choice.function?.name) request.tool_choice = { type: 'tool', name: choice.function.name, ...parallelOff }
    else if (body.parallel_tool_calls === false) request.tool_choice = { type: 'auto', ...parallelOff }
  }

  const requestedMax = [body.max_tokens, body.max_completion_tokens].find(v => typeof v === 'number' && v > 0)
  const cap = typeof options.maxTokens === 'number' && options.maxTokens > 0 ? options.maxTokens : undefined
  let maxTokens = Math.floor(requestedMax ?? cap ?? DEFAULT_MAX_TOKENS)
  if (cap) maxTokens = Math.min(maxTokens, cap)

  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : undefined
  let budget = effort && effort !== 'none' ? THINKING_BUDGETS[effort] : undefined
  // A replayed tool turn without its signed thinking cannot continue with
  // thinking on; leave it off for this request instead of failing it.
  if (budget && lastAssistantToolTurnHasThinking === false && messages[messages.length - 1]?.role === 'user') {
    const lastUser = messages[messages.length - 1]
    if (lastUser.content.some(b => b.type === 'tool_result')) budget = undefined
  }
  if (budget) {
    // budget_tokens must be >= 1024 and < max_tokens. Leave room for the
    // answer without exceeding the model's cap (32k when unknown: the
    // smallest output cap among current Claude models with thinking).
    const ceiling = cap ?? THINKING_MAX_TOKENS_WITHOUT_CAP
    maxTokens = Math.max(maxTokens, Math.min(ceiling, budget + 4096))
    budget = Math.min(budget, maxTokens - 1024)
    if (budget >= 1024) {
      request.thinking = { type: 'enabled', budget_tokens: budget }
    }
  }
  request.max_tokens = maxTokens

  // Sampling: thinking requires the defaults, so only pass them without it.
  if (!request.thinking) {
    if (typeof body.temperature === 'number') request.temperature = Math.min(1, Math.max(0, body.temperature))
    if (typeof body.top_p === 'number') request.top_p = body.top_p
    if (typeof body.top_k === 'number' && body.top_k > 0) request.top_k = body.top_k
  }
  const stops = (Array.isArray(body.stop) ? body.stop : typeof body.stop === 'string' ? [body.stop] : [])
    .filter(s => typeof s === 'string' && s.trim().length > 0)
  if (stops.length > 0) request.stop_sequences = stops
  return request
}

// ── Stream translation ─────────────────────────────────────────────────────

const FINISH_REASONS: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
}

interface BlockState {
  kind: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'other'
  toolIndex?: number
  thinking?: string
  signature?: string
  data?: string
  toolId?: string
}

/**
 * Feed Anthropic SSE events (event name + parsed data); get back OpenAI
 * chunks to write as `data: <json>` lines. `finish()` returns the trailing
 * chunks (usage) once the stream ends.
 */
export class AnthropicStreamTranslator {
  private id = ''
  private model: string
  private blocks = new Map<number, BlockState>()
  private toolCount = 0
  private inputTokens = 0
  private cacheRead = 0
  private cacheCreation = 0
  private outputTokens = 0
  private finished = false
  private turnThinking: ThinkingBlock[] = []
  private turnToolIds: string[] = []

  constructor(model: string, private readonly cache: ThinkingCache = sharedThinkingCache) {
    this.model = model
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
    return {
      id: this.id || 'msg_unknown',
      object: 'chat.completion.chunk',
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
  }

  push(event: string, data: any): Array<Record<string, unknown>> {
    const type = typeof data?.type === 'string' ? data.type : event
    switch (type) {
      case 'message_start': {
        const message = data.message ?? {}
        this.id = message.id || this.id
        if (message.model) this.model = message.model
        const usage = message.usage ?? {}
        this.inputTokens = Number(usage.input_tokens) || 0
        this.cacheRead = Number(usage.cache_read_input_tokens) || 0
        this.cacheCreation = Number(usage.cache_creation_input_tokens) || 0
        this.outputTokens = Number(usage.output_tokens) || 0
        return [this.chunk({ role: 'assistant', content: '' })]
      }
      case 'content_block_start': {
        const block = data.content_block ?? {}
        const index = Number(data.index)
        if (block.type === 'text') {
          this.blocks.set(index, { kind: 'text' })
          return block.text ? [this.chunk({ content: block.text })] : []
        }
        if (block.type === 'thinking') {
          this.blocks.set(index, { kind: 'thinking', thinking: block.thinking || '', signature: block.signature || '' })
          return block.thinking ? [this.chunk({ reasoning_content: block.thinking })] : []
        }
        if (block.type === 'redacted_thinking') {
          this.blocks.set(index, { kind: 'redacted_thinking', data: block.data || '' })
          return []
        }
        if (block.type === 'tool_use') {
          const toolIndex = this.toolCount++
          this.blocks.set(index, { kind: 'tool_use', toolIndex, toolId: block.id })
          this.turnToolIds.push(block.id)
          const initial = block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
            ? JSON.stringify(block.input)
            : ''
          return [this.chunk({
            tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: initial } }],
          })]
        }
        this.blocks.set(index, { kind: 'other' })
        return []
      }
      case 'content_block_delta': {
        const state = this.blocks.get(Number(data.index))
        const delta = data.delta ?? {}
        if (delta.type === 'text_delta' && delta.text) return [this.chunk({ content: delta.text })]
        if (delta.type === 'thinking_delta' && delta.thinking) {
          if (state) state.thinking = (state.thinking ?? '') + delta.thinking
          return [this.chunk({ reasoning_content: delta.thinking })]
        }
        if (delta.type === 'signature_delta' && delta.signature) {
          if (state) state.signature = (state.signature ?? '') + delta.signature
          return []
        }
        if (delta.type === 'input_json_delta' && state?.kind === 'tool_use') {
          if (!delta.partial_json) return []
          return [this.chunk({ tool_calls: [{ index: state.toolIndex, function: { arguments: delta.partial_json } }] })]
        }
        return []
      }
      case 'content_block_stop': {
        const state = this.blocks.get(Number(data.index))
        if (state?.kind === 'thinking' && state.signature) {
          this.turnThinking.push({ type: 'thinking', thinking: state.thinking ?? '', signature: state.signature })
        } else if (state?.kind === 'redacted_thinking' && state.data) {
          this.turnThinking.push({ type: 'redacted_thinking', data: state.data })
        }
        return []
      }
      case 'message_delta': {
        if (data.usage?.output_tokens != null) this.outputTokens = Number(data.usage.output_tokens) || this.outputTokens
        if (data.usage?.input_tokens != null) this.inputTokens = Number(data.usage.input_tokens) || this.inputTokens
        const reason = data.delta?.stop_reason
        return reason ? [this.chunk({}, FINISH_REASONS[reason] ?? 'stop')] : []
      }
      case 'message_stop':
        return this.finish()
      case 'error': {
        const error = data.error ?? {}
        return [{ error: { message: error.message || 'Anthropic stream error', type: error.type, code: error.type } }]
      }
      default:
        return [] // ping and future event types
    }
  }

  /** Usage chunk (once). Also remembers this turn's signed thinking for its tool calls. */
  finish(): Array<Record<string, unknown>> {
    if (this.finished) return []
    this.finished = true
    if (this.turnThinking.length > 0) {
      for (const id of this.turnToolIds) this.cache.set(anthropicToolId(id), this.turnThinking)
    }
    return [{
      id: this.id || 'msg_unknown',
      object: 'chat.completion.chunk',
      model: this.model,
      choices: [],
      usage: {
        prompt_tokens: this.inputTokens + this.cacheRead + this.cacheCreation,
        completion_tokens: this.outputTokens,
        total_tokens: this.inputTokens + this.cacheRead + this.cacheCreation + this.outputTokens,
        prompt_tokens_details: { cached_tokens: this.cacheRead },
      },
    }]
  }
}

/** Incremental SSE parser: feed text, get {event, data} records. */
export class SseParser {
  private buffer = ''
  feed(text: string): Array<{ event: string; data: string }> {
    this.buffer += text.replace(/\r\n?/g, '\n')
    const out: Array<{ event: string; data: string }> = []
    let boundary: number
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const record = SseParser.parse(raw)
      if (record) out.push(record)
    }
    return out
  }
  flush(): Array<{ event: string; data: string }> {
    const rest = this.buffer
    this.buffer = ''
    const record = rest.trim() ? SseParser.parse(rest) : undefined
    return record ? [record] : []
  }
  private static parse(raw: string): { event: string; data: string } | undefined {
    let event = 'message'
    const data: string[] = []
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    return data.length > 0 ? { event, data: data.join('\n') } : undefined
  }
}

/** Anthropic SSE bytes → OpenAI Chat Completions SSE bytes. */
export function translateAnthropicStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  cache: ThinkingCache = sharedThinkingCache,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const parser = new SseParser()
  const translator = new AnthropicStreamTranslator(model, cache)
  const reader = source.getReader()
  let done = false
  const encode = (chunks: Array<Record<string, unknown>>) =>
    chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  const handle = (records: Array<{ event: string; data: string }>) => {
    let out = ''
    for (const record of records) {
      let data: unknown
      try {
        data = JSON.parse(record.data)
      } catch {
        continue
      }
      out += encode(translator.push(record.event, data))
    }
    return out
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return
      try {
        // Keep reading until something can be enqueued: a pull that enqueues
        // nothing is not called again, which would stall the reader.
        for (;;) {
          const { done: ended, value } = await reader.read()
          if (ended) {
            done = true
            const tail = handle(parser.flush()) + encode(translator.finish()) + 'data: [DONE]\n\n'
            controller.enqueue(encoder.encode(tail))
            controller.close()
            return
          }
          const text = handle(parser.feed(decoder.decode(value, { stream: true })))
          if (text) {
            controller.enqueue(encoder.encode(text))
            return
          }
        }
      } catch (error) {
        done = true
        controller.error(error)
      }
    },
    cancel(reason) {
      done = true
      return reader.cancel(reason)
    },
  })
}

// ── Fetch adapter ──────────────────────────────────────────────────────────

/** Shape the chat pipeline reads from a fetch result. */
export interface PipelineResponse {
  ok: boolean
  status: number
  statusText: string
  body: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}

export type PipelineFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<PipelineResponse>

/** The Messages URL for a base given with or without a trailing /v1. */
export function anthropicMessagesUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/messages`
}

export interface AnthropicFetchOptions {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  model: string
  maxTokens?: number
  /** Transport for the upstream request (net.fetch for internet, Node http for loopback). */
  upstream: PipelineFetch
  thinkingCache?: ThinkingCache
}

/**
 * A fetch for the chat pipeline that accepts its OpenAI Chat Completions
 * request (any URL) and answers with a Chat Completions SSE stream.
 */
export function createAnthropicFetch(options: AnthropicFetchOptions): PipelineFetch {
  const cache = options.thinkingCache ?? sharedThinkingCache
  return async (_url, init) => {
    const body = JSON.parse(init.body) as OpenAIChatBody
    const request = toAnthropicRequest(body, { model: options.model, maxTokens: options.maxTokens, thinkingCache: cache })
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (options.apiKey) headers['x-api-key'] = options.apiKey
    const response = await options.upstream(anthropicMessagesUrl(options.baseURL), {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: init.signal,
    })
    if (!response.ok || !response.body) return response
    const translated = translateAnthropicStream(response.body, options.model, cache)
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      body: translated,
      text: () => Promise.reject(new Error('Cannot read text from streaming response')),
    }
  }
}
