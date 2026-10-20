/*
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License.
 * (packages/todo/tool-todo)
 */

/**
 * todo_write: the model keeps a short task list for multi-step work. Every
 * call REPLACES the whole list (last write wins), the list is stored per chat,
 * and the tool result shows it, so the plan is visible in the chat and stays
 * in the model's own history.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']
export const MAX_TODOS = 50
const MAX_TODO_CHARS = 500

export const TODO_WRITE_DESCRIPTION =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial ' +
  'single-step tasks. Add one todo per concrete step before you start. While work remains, keep ' +
  'exactly one todo `in_progress`. Mark each todo `completed` as soon as it is done. Each call ' +
  'replaces the whole list.'

export class TodoValidationError extends Error {}

/** Validate model input into the canonical list; throws a model-readable error. */
export function parseTodoWriteArgs(args: unknown): TodoItem[] {
  const raw = (args as any)?.todos
  if (!Array.isArray(raw)) {
    throw new TodoValidationError('todos must be an array of {content, status} items (the COMPLETE list).')
  }
  if (raw.length > MAX_TODOS) {
    throw new TodoValidationError(`too many todos (${raw.length}); keep the list to at most ${MAX_TODOS} items.`)
  }
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const [index, item] of raw.entries()) {
    const content = typeof item?.content === 'string' ? item.content.trim() : ''
    if (!content) throw new TodoValidationError(`todo #${index + 1}: content must be a non-empty string.`)
    if (content.length > MAX_TODO_CHARS) {
      throw new TodoValidationError(`todo #${index + 1}: content is longer than ${MAX_TODO_CHARS} characters; keep each todo to one short line.`)
    }
    if (seen.has(content)) throw new TodoValidationError(`duplicate todo: ${JSON.stringify(content)}.`)
    seen.add(content)
    const status = item?.status
    if (!TODO_STATUSES.includes(status)) {
      throw new TodoValidationError(`todo #${index + 1}: status must be one of pending, in_progress, completed.`)
    }
    if (status === 'in_progress') active += 1
    todos.push({ content, status })
  }
  if (active > 1) {
    throw new TodoValidationError(`at most one todo may be in_progress (got ${active}).`)
  }
  return todos
}

export function parseStoredTodos(raw: string | null | undefined): TodoItem[] {
  if (!raw) return []
  try {
    return parseTodoWriteArgs({ todos: JSON.parse(raw) })
  } catch {
    return []
  }
}

const MARK: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }

export function renderTodoList(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'Todo list cleared.'
  const done = todos.filter(t => t.status === 'completed').length
  const lines = todos.map(t => `${MARK[t.status]} ${t.content}`)
  const next = todos.find(t => t.status === 'in_progress') ?? todos.find(t => t.status === 'pending')
  const tail = done === todos.length
    ? 'All todos are completed.'
    : next ? `Current: ${next.content}` : ''
  return [`Todo list updated (${done}/${todos.length} completed):`, ...lines, tail].filter(Boolean).join('\n')
}
