/**
 * Scheduled tasks: IPC for Preferences → Tasks and the scheduler itself.
 *   tasks:list · tasks:create · tasks:setEnabled · tasks:runNow · tasks:delete
 *   event tasks:changed
 * Each task has its own chat; a finished run notifies (click opens the chat).
 */
import { Notification, ipcMain, powerMonitor } from 'electron'
import { randomUUID } from 'crypto'
import { db } from '../database'
import { runChatTurnFromMain } from './chat'
import { TaskScheduler } from '../tasks/scheduler'
import { parseSchedule, type ScheduledTask } from '../../shared/schedule'
import { t } from '../i18n'
import { appWindows } from '../browser/electronDriver'
import { revealMainWindow } from '../mainWindowRef'

let scheduler: TaskScheduler | null = null
export const MAX_TASKS = 50

const hhmm = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
function noteParams(task: ScheduledTask): Record<string, string> {
  return { ran: hhmm(task.note?.ran), due: hhmm(task.note?.due) }
}

function broadcast(): void {
  for (const w of appWindows()) w.webContents.send('tasks:changed')
}

export function taskScheduler(): TaskScheduler {
  if (scheduler) return scheduler
  scheduler = new TaskScheduler({
    store: () => db.tasks,
    runTurn: (chatId, prompt) => runChatTurnFromMain(chatId, prompt),
    onChange: broadcast,
    onFinished: (task: ScheduledTask) => {
      try {
        if (!Notification.isSupported()) return
        const reason = task.lastStatus === 'ok' ? '' : task.note ? t(`tasks.note.${task.note.code}`, noteParams(task)) : (task.lastNote ?? '')
        const n = new Notification({
          title: task.lastStatus === 'ok' ? t('main.notify.taskDone') : t('main.notify.taskFailed'),
          body: (reason ? `${task.title} · ${reason}` : task.title).slice(0, 200),
        })
        n.on('click', () => revealMainWindow('chat:openFromNotification', { chatId: task.chatId }))
        n.show()
      } catch { /* notifications unavailable */ }
    },
  })
  return scheduler
}

/** Create a task with its own chat on the given chat's model (and settings). */
export function createTaskFromChat(sourceChatId: string, input: { title: string; prompt: string; schedule: unknown }):
  { ok: true; task: ScheduledTask } | { ok: false; error: string; code?: string } {
  const parsed = parseSchedule(input.schedule)
  if (!parsed.ok) return { ...parsed, code: 'schedule' }
  if (parsed.schedule.kind === 'once' && parsed.schedule.at <= Date.now()) return { ok: false, code: 'past', error: 'That time has already passed.' }
  const all = db.tasks.list()
  if (all.length >= MAX_TASKS) return { ok: false, code: 'max', error: `There are already ${MAX_TASKS} tasks. Delete some in Preferences → Tasks first.` }
  // A task's own run never makes more tasks.
  if (all.some(t => t.chatId === sourceChatId)) return { ok: false, code: 'nested', error: 'A scheduled task cannot schedule more tasks.' }
  if (!input.prompt?.trim()) return { ok: false, code: 'no-prompt', error: 'The task needs a prompt.' }
  const source = db.getChat(sourceChatId)
  if (!source) return { ok: false, code: 'no-chat', error: 'Open a chat with the model the task should use first.' }
  const now = Date.now()
  const chat = { id: randomUUID(), title: (input.title || input.prompt).replace(/\s+/g, ' ').trim().slice(0, 60), createdAt: now, updatedAt: now, modelId: source.modelId, modelPath: source.modelPath }
  db.createChat(chat)
  // Same model and settings (tools, folder, permissions) as the chat it came from.
  // Runs are unattended: at most Workspace access (sandboxed commands, writes
  // only in the project folder), never Full access.
  const overrides = db.getChatOverrides(sourceChatId)
  if (overrides) {
    const preset = overrides.permissionPreset === 'read-only' ? 'read-only' : undefined
    try { db.setChatOverrides({ ...overrides, chatId: chat.id, permissionPreset: preset }) } catch { /* keep defaults */ }
  }
  // A cloud-model chat keeps its provider binding, so the task runs on the same model.
  try {
    const binding = db.providers.getChatBinding(sourceChatId)
    if (binding) db.providers.setChatBinding({ ...binding, chatId: chat.id })
  } catch { /* no binding */ }
  const task = taskScheduler().create({ title: input.title || input.prompt.slice(0, 60), prompt: input.prompt, chatId: chat.id, schedule: parsed.schedule })
  return { ok: true, task }
}

export function registerTaskHandlers(): void {
  const s = taskScheduler()
  ipcMain.handle('tasks:list', () => db.tasks.list().map(task => ({ ...task, running: s.isRunning(task.id) })))
  ipcMain.handle('tasks:create', (_e, sourceChatId: string, input: { title: string; prompt: string; schedule: unknown }) =>
    createTaskFromChat(String(sourceChatId || ''), { title: String(input?.title ?? ''), prompt: String(input?.prompt ?? ''), schedule: input?.schedule }))
  ipcMain.handle('tasks:setEnabled', (_e, id: string, on: boolean) => s.setEnabled(String(id), !!on))
  ipcMain.handle('tasks:runNow', (_e, id: string) => { void s.run(String(id)); return true })
  ipcMain.handle('tasks:delete', (_e, id: string) => s.delete(String(id)))
  s.recoverInterrupted()
  // Start a little after launch, so local models have a chance to come up.
  setTimeout(() => s.start(), 90_000)
  // After sleep: run what came due while the Mac slept (once, with a note).
  try { powerMonitor.on('resume', () => setTimeout(() => { void s.tick() }, 15_000)) } catch { /* not in tests */ }
}
