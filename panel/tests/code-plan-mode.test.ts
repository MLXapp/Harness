import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { accessOf, modeOf } from '../src/renderer/src/components/code/AgentMode'

describe('Code session modes', () => {
  it('maps the four modes onto the permission presets and the plan flag', () => {
    expect(modeOf('read-only', false)).toBe('ask')
    expect(modeOf('workspace', false)).toBe('auto')
    expect(modeOf('full', false)).toBe('full')
    expect(modeOf('full', true)).toBe('plan')
    expect(accessOf('ask')).toBe('read-only')
    expect(accessOf('auto')).toBe('workspace')
    expect(accessOf('full')).toBe('full')
  })

  it('wires Plan mode through the chat loop: refusal gate and a request-only note', () => {
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    expect(chat).toContain('const planMode = planModeChats.has(chatId) && overrides?.builtinToolsEnabled === true;')
    expect(chat).toContain('plan: planMode,')
    expect(chat).toContain('if (planMode && mode === "send") withPlanModeNote(requestMessages);')
    expect(chat).toContain('ipcMain.handle("chat:setPlanMode"')
  })

  it('puts the mode chip and the hand-off bar in the Code composer', () => {
    const input = readFileSync('src/renderer/src/components/chat/InputBox.tsx', 'utf8')
    expect(input).toContain("{workspace === 'code' && <AgentModeChip compact={compact} />}")
    expect(input).toContain("{workspace === 'code' && <PlanHandoff")
  })
})
