import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('steering a running turn', () => {
  const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
  it('joins at the next tool step, after the tool results', () => {
    const follow = chat.indexOf('const sendFollowUp = async (): Promise<boolean> => {')
    const steer = chat.indexOf('const steers = steerQueues.get(chatId);')
    const calibrate = chat.indexOf('tokenCalibrator.observe(lastSentHeuristicTokens, promptTokens);', follow)
    expect(follow).toBeGreaterThan(-1)
    expect(steer).toBeGreaterThan(follow)
    expect(steer).toBeLessThan(calibrate)
    expect(chat).toContain('requestMessages.push({ role: "user", content: `${STEER_NOTE}\\n${text}` });')
  })
  it('is stored with the turn and unused steers go back to the queue', () => {
    expect(chat).toContain('db.appendToUserMessage(userMessage.id, addition)')
    expect(chat).toContain('win.webContents.send("chat:steerUnused", { chatId, items: unused });')
    expect(chat).toContain('if (!activeRequests.has(chatId)) return { accepted: false };')
  })
  it('the composer steers with Enter and queues with ⌥Enter', () => {
    const input = readFileSync('src/renderer/src/components/chat/InputBox.tsx', 'utf8')
    expect(input).toContain('handleSend({ queue: e.altKey })')
    const ui = readFileSync('src/renderer/src/components/chat/ChatInterface.tsx', 'utf8')
    expect(ui).toContain('if (!options?.queue && window.api.chat.steer) {')
  })
})
