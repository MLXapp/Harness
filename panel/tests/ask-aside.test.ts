import { describe, expect, it } from 'vitest'
import { ASIDE_NOTE, asideMessages } from '../src/main/agent/aside'

describe('Ask aside request', () => {
  it('sends the question last, after the chat as it is', () => {
    const chat = [{ role: 'system', content: 's' }, { role: 'user', content: 'Fix the header' }, { role: 'assistant', content: 'Done.' }]
    const out = asideMessages(chat, 'What does foo() return?')
    expect(out.slice(0, 3)).toEqual(chat)
    expect(out[3]).toEqual({ role: 'user', content: `${ASIDE_NOTE}\n\nQuestion: What does foo() return?` })
    expect(chat).toHaveLength(3) // the chat itself is untouched
  })

  it('joins a user turn still waiting for its reply, so roles keep alternating', () => {
    const running = [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Build the page' }]
    const out = asideMessages(running, 'Which file is it in?')
    expect(out).toHaveLength(2)
    expect(out[1].content).toBe(`Build the page\n\n${ASIDE_NOTE}\n\nQuestion: Which file is it in?`)
    const parts = asideMessages([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:' } }] }], 'What colour?')
    expect(parts[0].content.at(-1)).toEqual({ type: 'text', text: `${ASIDE_NOTE}\n\nQuestion: What colour?` })
  })
})
