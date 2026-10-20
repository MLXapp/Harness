import { describe, expect, it } from 'vitest'
import { RepeatCallTracker, appendReminder, canonicalArguments } from '../src/main/agent/repeatCallReminder'

describe('repeat-call reminder', () => {
  it('notes the 3rd, 5th and 8th identical call and never blocks', () => {
    const tracker = new RepeatCallTracker()
    const notes = Array.from({ length: 9 }, () => tracker.record('s', 'run_command', { command: 'ls' }))
    expect(notes.map(n => (n ? 1 : 0))).toEqual([0, 0, 1, 0, 1, 0, 0, 1, 0])
    expect(notes[2]).toContain('call #3')
    expect(notes[4]).toContain('identical calls this session: 5')
    expect(notes[7]).toContain('identical calls this session: 8')
  })

  it('treats argument key order as the same call and other args as different', () => {
    const tracker = new RepeatCallTracker()
    tracker.record('s', 'read_file', { path: 'a', limit: 5 })
    tracker.record('s', 'read_file', '{"limit":5,"path":"a"}')
    expect(tracker.record('s', 'read_file', { limit: 5, path: 'a' })).toContain('call #3')
    expect(tracker.record('s', 'read_file', { path: 'b' })).toBeNull()
    expect(tracker.record('other', 'read_file', { path: 'a', limit: 5 })).toBeNull()
    expect(canonicalArguments({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}')
  })

  it('appends the note after the result', () => {
    expect(appendReminder('result', '[note]')).toBe('result\n\n[note]')
    expect(appendReminder('result', null)).toBe('result')
  })
})

describe('repeat reminder wiring in the chat tool loop', () => {
  it('appends the note after pruning, to the newest tool result only', async () => {
    const { readFileSync } = await import('node:fs')
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    const prune = chat.indexOf('resultText = prepareToolResultForModel(tc.function.name, resultText);')
    const remind = chat.indexOf('repeatCallTracker.record(chatId, tc.function.name, tc.function.arguments)', prune)
    const push = chat.indexOf('requestMessages.push(', remind)
    expect(prune).toBeGreaterThan(-1)
    expect(remind).toBeGreaterThan(prune)
    expect(push).toBeGreaterThan(remind)
    expect(chat).toContain('repeatCallTracker.clear(chatId);')
  })
})
