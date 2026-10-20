import { describe, expect, it } from 'vitest'
import {
  LEAN_TOOL_NAMES,
  applyToolPreset,
  normalizeToolPreset,
  orderToolsForPrefixCache,
} from '../src/main/agent/toolPresets'

describe('tool presets and canonical order', () => {
  const tools = ['ask_user', 'git', 'run_command', 'read_file', 'fetch_url', 'write_file', 'edit_file', 'list_directory', 'search_files', 'todo_write']
    .map(name => ({ type: 'function', function: { name } }))

  it('Lean keeps only the minimal set; Full keeps everything', () => {
    expect(applyToolPreset(tools, 'lean').map(t => t.function.name).sort()).toEqual([...LEAN_TOOL_NAMES].sort())
    expect(applyToolPreset(tools, 'full')).toHaveLength(tools.length)
    expect(applyToolPreset(tools, undefined)).toHaveLength(tools.length)
    expect(normalizeToolPreset('bogus')).toBe('full')
  })

  it('orders tools canonically for any input permutation', () => {
    const canonical = ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'run_command', 'git', 'fetch_url', 'ask_user', 'todo_write']
    const shuffled = [...tools].reverse()
    const mcp = [{ type: 'function', function: { name: 'zeta_mcp' } }, { type: 'function', function: { name: 'alpha_mcp' } }]
    const a = orderToolsForPrefixCache([...tools, ...mcp], canonical).map(t => t.function.name)
    const b = orderToolsForPrefixCache([...mcp, ...shuffled], canonical).map(t => t.function.name)
    expect(a).toEqual(b)
    expect(a).toEqual([...canonical, 'alpha_mcp', 'zeta_mcp'])
  })
})

describe('preset and project-instruction wiring', () => {
  it('builds the catalog from settings in canonical order and swaps the agentic prompt for Lean', async () => {
    const { readFileSync } = await import('node:fs')
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    const catalog = chat.slice(chat.indexOf('const unscopedCurrentTurnToolDefinitions ='), chat.indexOf('const exactFinalToolNames ='))
    expect(catalog).toContain('orderToolsForPrefixCache(')
    expect(catalog).toContain('applyToolPreset(')
    expect(catalog).toContain('filterTools(overrides || {}, {')
    expect(catalog).toContain('BUILTIN_TOOL_ORDER')
    expect(chat).toContain('normalizeToolPreset(overrides?.toolPreset) === "lean" &&\n        !chatUsesZayaAppleScriptToolBundle')
    expect(chat).toContain('? LEAN_AGENTIC_SYSTEM_PROMPT + directMediaAttachmentRule')
    expect(chat).toContain('// ── Prefix-cache discipline')
  })

  it('loads project instructions from the persistent toggle, not the current message', async () => {
    const { readFileSync } = await import('node:fs')
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    const block = chat.slice(chat.indexOf('const projectInstructions ='), chat.indexOf('if (toolCapabilityEpoch) {'))
    expect(block).toContain('overrides?.builtinToolsEnabled === true')
    expect(block).toContain('loadProjectInstructions(overrides.workingDirectory)')
    expect(block).not.toContain('attachBuiltinToolsForCurrentTurn')
    expect(block).not.toContain('latestUserText')
  })

  it('persists the preset like the other tool settings', async () => {
    const { sanitizeChatOverrides, buildNewChatInheritedOverrides } = await import('../src/main/chat-override-policy')
    const { buildChatSettingsResetOverrides } = await import('../src/shared/chatSettingsResetPolicy')
    expect(sanitizeChatOverrides({ chatId: 'c', toolPreset: 'lean' }).toolPreset).toBe('lean')
    expect(sanitizeChatOverrides({ chatId: 'c', toolPreset: 'tiny' as any }).toolPreset).toBeUndefined()
    expect(buildNewChatInheritedOverrides({ chatId: 'new' }, { chatId: 'old', toolPreset: 'lean' }).toolPreset).toBe('lean')
    expect(buildChatSettingsResetOverrides({ toolPreset: 'lean', temperature: 0.3 })).toEqual({ toolPreset: 'lean' })
    const { readFileSync } = await import('node:fs')
    const db = readFileSync('src/main/database.ts', 'utf8')
    expect(db).toContain('ALTER TABLE chat_overrides ADD COLUMN tool_preset TEXT')
    expect(db).toContain('overrides.toolPreset === "lean" ? "lean" : null')
    expect(db).toContain('toolPreset: row.tool_preset === "lean" ? "lean" : undefined')
  })
})
