/**
 * Scheduled tasks: IPC for Preferences → Tasks and the scheduler itself.
 *   tasks:list · tasks:create · tasks:setEnabled · tasks:runNow · tasks:delete
 *   event tasks:changed
 * Each task has its own chat; a finished run notifies (click opens the chat).
 */
import { BrowserWindow, Notification, ipcMain, powerMonitor } from 'electron'
import { randomUUID } from 'crypto'
import { db } from '../database'
import { runChatTurnFromMain } from './chat'
import { TaskScheduler } from '../tasks/scheduler'
import { parseSchedule, type ScheduledTask } from '../../shared/schedule'
import { t } from '../i18n'

let scheduler: TaskScheduler | null = null

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('tasks:changed')
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
        const n = new Notification({
          title: task.lastStatus === 'ok' ? t('main.notify.taskDone') : t('main.notify.taskFailed'),
          body: task.lastStatus === 'ok' ? task.title : `${task.title} · ${task.lastNote ?? ''}`.slice(0, 200),
        })
        n.on('click', () => {
          const win = BrowserWindow.getAllWindows()[0]
          if (!win || win.isDestroyed()) return
          win.show(); win.focus()
          win.webContents.send('chat:openFromNotification', { chatId: task.chatId })
        })
        n.show()
      } catch { /* notifications unavailable */ }
    },
  })
  return scheduler
}

/** Create a task with its own chat on the given chat's model (and settings). */
export function createTaskFromChat(sourceChatId: string, input: { title: string; prompt: string; schedule: unknown }):
  { ok: true; task: ScheduledTask } | { ok: false; error: string } {
  const parsed = parseSchedule(input.schedule)
  if (!parsed.ok) return parsed
  if (!input.prompt?.trim()) return { ok: false, error: 'The task needs a prompt.' }
  const source = db.getChat(sourceChatId)
  if (!source) return { ok: false, error: 'Open a chat with the model the task should use first.' }
  const now = Date.now()
  const chat = { id: randomUUID(), title: (input.title || input.prompt).replace(/\s+/g, ' ').trim().slice(0, 60), createdAt: now, updatedAt: now, modelId: source.modelId, modelPath: source.modelPath }
  db.createChat(chat)
  // Same model and settings (tools, folder, permissions) as the chat it came from.
  const overrides = db.getChatOverrides(sourceChatId)
  if (overrides) {
    try { db.setChatOverrides({ ...overrides, chatId: chat.id }) } catch { /* keep defaults */ }
  }
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
  s.start()
  // After sleep: run what came due while the Mac slept (once, with a note).
  try { powerMonitor.on('resume', () => setTimeout(() => { void s.tick() }, 15_000)) } catch { /* not in tests */ }
}
