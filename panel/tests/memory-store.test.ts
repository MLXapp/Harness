import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { MemoryStore, ftsQuery, looksSecret, renderMemoryBlock } from '../src/main/memory/store'

describe('memory store', () => {
  it('adds, dedupes, searches, edits and forgets', () => {
    const store = new MemoryStore(new Database(':memory:'))
    const a = store.add('Prefers TypeScript with 2-space indents', 'chat1')
    expect(a.duplicate).toBe(false)
    expect(store.add('prefers typescript  with 2-space indents').duplicate).toBe(true)
    store.add('Deploys harness.mlx.app through Vercel')
    expect(store.search('vercel deploy').map(e => e.text)).toEqual(['Deploys harness.mlx.app through Vercel'])
    expect(store.search('typescript')[0].id).toBe(a.entry.id)
    store.update(a.entry.id, 'Prefers TypeScript, tabs')
    expect(store.search('tabs')[0].text).toBe('Prefers TypeScript, tabs')
    expect(store.search('indents')).toEqual([])
    expect(store.delete(a.entry.id)).toBe(true)
    expect(store.list()).toHaveLength(1)
    store.clear()
    expect(store.list()).toHaveLength(0)
  })

  it('quotes FTS words so user text has no operators', () => {
    expect(ftsQuery('foo OR bar" NEAR(')).toBe('"foo" OR "or" OR "bar" OR "near"')
    expect(ftsQuery('!!')).toBeNull()
  })

  it('renders a budgeted block with ids and a pointer to recall', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, text: `fact number ${i} `.repeat(4), createdAt: 0, updatedAt: 0 }))
    const block = renderMemoryBlock(entries, 400)!
    expect(block.startsWith('# Memory')).toBe(true)
    expect(block).toContain('- [m0] fact number 0')
    expect(block).toMatch(/\(\d+ older entries: use recall/)
    expect(renderMemoryBlock([])).toBeNull()
  })

  it('refuses secrets', () => {
    expect(looksSecret('my key is sk-ant-abcdefghijklmnop1234')).toBe(true)
    expect(looksSecret('card 4242 4242 4242 4242')).toBe(true)
    expect(looksSecret('password: hunter2')).toBe(true)
    expect(looksSecret('I like short answers')).toBe(false)
  })

  it('is wired into the chat loop and the system prompt', () => {
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    expect(chat).toContain('} else if (tc.function.name === "remember" || tc.function.name === "recall" || tc.function.name === "forget") {')
    expect(chat).toContain('renderMemoryBlock(db.memory.list())')
    expect(chat).toContain('if (!memoryEnabled()) ["remember", "recall", "forget"].forEach((t) => disabled.add(t));')
  })
})
