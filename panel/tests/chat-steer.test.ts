import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { joinSteer } from '../src/main/agent/steer'

describe('steering a running turn', () => {
  const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
  it('joins at the next tool step, after the tool results', () => {
    const follow = chat.indexOf('const sendFollowUp = async (): Promise<boolean> => {')
    const steer = chat.indexOf('const steers = steerQueues.get(chatId);')
    const calibrate = chat.indexOf('tokenCalibrator.observe(lastSentHeuristicTokens, promptTokens);', follow)
    expect(follow).toBeGreaterThan(-1)
    expect(steer).toBeGreaterThan(follow)
    expect(steer).toBeLessThan(calibrate)
    expect(chat).toContain('joinSteer(requestMessages, `${STEER_NOTE}\\n${text}`, isRemote);')
  })
  it('is stored with the turn and unused steers go back to the queue, stale locks too', () => {
    expect(chat).toContain('db.appendToUserMessage(userMessage.id, addition)')
    expect(chat).toContain('win.webContents.send("chat:steerUnused", { chatId, items: unused });')
    expect(chat).toContain('if (!activeRequests.has(chatId)) return { accepted: false };')
    const start = chat.indexOf('repeatCallTracker.newTurn(chatId);')
    expect(chat.slice(start, start + 200)).toContain('returnUnusedSteers(chatId, getWindow);')
  })
  it('the composer steers with Enter and queues with ⌥Enter; other chats keep theirs', () => {
    const input = readFileSync('src/renderer/src/components/chat/InputBox.tsx', 'utf8')
    expect(input).toContain('handleSend({ queue: e.altKey })')
    const ui = readFileSync('src/renderer/src/components/chat/ChatInterface.tsx', 'utf8')
    expect(ui).toContain('if (!options?.queue && window.api.chat.steer) {')
    expect(ui).toContain('writeQueue(data.chatId, [...data.items, ...readQueue(data.chatId)])')
  })
})

describe('joinSteer', () => {
  const note = '[The user added this]\nuse metric units'
  it('local models: appended to the last tool result, no new turn', () => {
    const m: any[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', tool_call_id: 'a', content: 'result' }]
    joinSteer(m, note, false)
    expect(m).toHaveLength(3)
    expect(m[2].content).toBe(`result\n\n${note}`)
  })
  it('local Responses items: appended to the function output', () => {
    const m: any[] = [{ type: 'function_call_output', call_id: 'a', output: 'r' }]
    joinSteer(m, note, false)
    expect(m).toHaveLength(1)
    expect(m[0].output).toBe(`r\n\n${note}`)
  })
  it('cloud models get a real user message', () => {
    const m: any[] = [{ role: 'tool', tool_call_id: 'a', content: 'result' }]
    joinSteer(m, note, true)
    expect(m[1]).toEqual({ role: 'user', content: note })
    expect(m[0].content).toBe('result')
  })
  it('joins a trailing user message (e.g. screenshots) either way', () => {
    const m: any[] = [{ role: 'tool', content: 'x' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }]
    joinSteer(m, note, true)
    expect(m).toHaveLength(2)
    expect(m[1].content.at(-1)).toEqual({ type: 'text', text: note })
  })
})
