import { describe, expect, it } from 'vitest'
import { parseStoredTodos, parseTodoWriteArgs, renderTodoList } from '../src/main/agent/todos'

describe('todo_write', () => {
  it('validates and renders the whole-list replacement', () => {
    const todos = parseTodoWriteArgs({
      todos: [
        { content: ' Read the code ', status: 'completed' },
        { content: 'Fix the bug', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' },
      ],
    })
    expect(todos[0].content).toBe('Read the code')
    const text = renderTodoList(todos)
    expect(text).toContain('(1/3 completed)')
    expect(text).toContain('[x] Read the code')
    expect(text).toContain('[~] Fix the bug')
    expect(text).toContain('Current: Fix the bug')
    expect(renderTodoList([])).toBe('Todo list cleared.')
  })

  it('rejects bad input with model-readable errors', () => {
    expect(() => parseTodoWriteArgs({})).toThrow(/array/)
    expect(() => parseTodoWriteArgs({ todos: [{ content: '', status: 'pending' }] })).toThrow(/non-empty/)
    expect(() => parseTodoWriteArgs({ todos: [{ content: 'a', status: 'done' }] })).toThrow(/status/)
    expect(() => parseTodoWriteArgs({ todos: [{ content: 'a', status: 'pending' }, { content: 'a', status: 'pending' }] })).toThrow(/duplicate/)
    expect(() => parseTodoWriteArgs({ todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] })).toThrow(/at most one/)
    expect(parseStoredTodos('garbage')).toEqual([])
    expect(parseStoredTodos(JSON.stringify([{ content: 'a', status: 'pending' }]))).toEqual([{ content: 'a', status: 'pending' }])
  })
})

describe('todo_write wiring', () => {
  it('is registered last (stable prefix), handled per chat in the tool loop, and summarized in the UI', async () => {
    const { readFileSync } = await import('node:fs')
    const { BUILTIN_TOOLS, isBuiltinTool } = await import('../src/main/tools/registry')
    expect(BUILTIN_TOOLS.slice(-7).map(t => t.function.name)).toEqual(['todo_write', 'use_skill', 'remember', 'recall', 'forget', 'schedule_task', 'browser'])
    expect(isBuiltinTool('todo_write')).toBe(true)
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    const branch = chat.slice(chat.indexOf('} else if (tc.function.name === "todo_write") {'), chat.indexOf('} else if (isBuiltinTool(tc.function.name)) {'))
    expect(branch).toContain('parseTodoWriteArgs(toolArgs)')
    expect(branch).toContain('db.setChatTodos(chatId, JSON.stringify(todos))')
    expect(branch).toContain('resultText = renderTodoList(todos)')
    expect(chat).toContain('ipcMain.handle("chat:getTodos"')
    const { getToolSummary } = await import('../src/renderer/src/components/chat/chat-utils')
    expect(getToolSummary('todo_write', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }))
      .toEqual({ label: 'Todos', context: '1/2 done' })
  })
})
