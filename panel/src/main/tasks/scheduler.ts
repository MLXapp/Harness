/**
 * Scheduled tasks: a prompt sent to its own chat on a schedule.
 *
 * Runs unattended, so anything that needs the user's OK is refused when the
 * approval card times out (the agent loop fails closed). A run missed while
 * the Mac slept or the app was closed runs once when it can, with a note.
 * One run at a time per task; at most two tasks run at once.
 */

import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { describeSchedule, dueAction, nextRun, type Schedule, type ScheduledTask } from '../../shared/schedule'

export function ensureTaskSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      next_run INTEGER,
      created_at INTEGER NOT NULL
    );
  `)
}

export class TaskStore {
  constructor(private readonly db: Database.Database) { ensureTaskSchema(db) }

  list(): ScheduledTask[] {
    return (this.db.prepare('SELECT json FROM scheduled_tasks ORDER BY created_at DESC').all() as Array<{ json: string }>)
      .map(r => { try { return JSON.parse(r.json) as ScheduledTask } catch { return null } })
      .filter((t): t is ScheduledTask => !!t)
  }

  get(id: string): ScheduledTask | null {
    const r = this.db.prepare('SELECT json FROM scheduled_tasks WHERE id = ?').get(id) as { json: string } | undefined
    if (!r) return null
    try { return JSON.parse(r.json) } catch { return null }
  }

  save(task: ScheduledTask): void {
    this.db.prepare('INSERT INTO scheduled_tasks (id, json, next_run, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, next_run = excluded.next_run')
      .run(task.id, JSON.stringify(task), task.nextRun, task.createdAt)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
  }
}

export interface SchedulerDeps {
  store: () => TaskStore
  /** Send the prompt as a new turn in the chat; resolves when the turn ends. */
  /** `retry`: not run at all (e.g. its model was not up): try again soon. */
  runTurn: (chatId: string, prompt: string) => Promise<{ ok: boolean; error?: string; retry?: boolean }>
  now?: () => number
  onChange?: () => void
  onFinished?: (task: ScheduledTask) => void
  maxConcurrent?: number
}

const fmtTime = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = new Set<string>()

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)() }

  create(input: { title: string; prompt: string; chatId: string; schedule: Schedule }): ScheduledTask {
    const now = this.now()
    const task: ScheduledTask = {
      id: `t${randomBytes(4).toString('hex')}`,
      title: input.title.trim().slice(0, 80) || 'Scheduled task',
      prompt: input.prompt.trim().slice(0, 8000),
      chatId: input.chatId,
      schedule: input.schedule,
      enabled: true,
      nextRun: nextRun(input.schedule, now),
      createdAt: now,
    }
    this.deps.store().save(task)
    this.deps.onChange?.()
    return task
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask | null {
    const t = this.deps.store().get(id)
    if (!t) return null
    t.enabled = enabled
    // Re-enabling starts from now: no catch-up for the paused time.
    if (enabled) t.nextRun = nextRun(t.schedule, this.now())
    this.deps.store().save(t)
    this.deps.onChange?.()
    return t
  }

  delete(id: string): boolean {
    const ok = this.deps.store().delete(id)
    this.deps.onChange?.()
    return ok
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    void this.tick()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  /** Run what is due. Call after wake from sleep too. */
  async tick(): Promise<void> {
    const now = this.now()
    const max = this.deps.maxConcurrent ?? 2
    for (const t of this.deps.store().list()) {
      if (!t.enabled || this.running.has(t.id)) continue
      if (this.running.size >= max) break
      const action = dueAction(t.nextRun, now)
      if (action === 'wait') continue
      void this.run(t.id, action === 'run-late' ? `Ran at ${fmtTime(now)} instead of ${fmtTime(t.nextRun!)}: the Mac was asleep or MLX Harness was closed.` : undefined)
    }
  }

  /** Run one task now (also "Run now"). */
  async run(id: string, lateNote?: string): Promise<ScheduledTask | null> {
    const store = this.deps.store()
    const t = store.get(id)
    if (!t || this.running.has(id)) return t
    this.running.add(id)
    const started = this.now()
    t.lastRun = started
    t.lastStatus = 'running'
    t.lastNote = lateNote
    // The next run is planned from now, so a late run never causes a burst.
    t.nextRun = nextRun(t.schedule, started)
    if (t.schedule.kind === 'once') t.enabled = false
    store.save(t)
    this.deps.onChange?.()
    let result: { ok: boolean; error?: string; retry?: boolean }
    try {
      result = await this.deps.runTurn(t.chatId, t.prompt)
    } catch (err: any) {
      result = { ok: false, error: String(err?.message ?? err) }
    }
    this.running.delete(id)
    const done = store.get(id)
    // Deleted while it ran: stays deleted.
    if (!done) { this.deps.onChange?.(); return null }
    done.lastStatus = result.ok ? 'ok' : 'error'
    done.lastNote = result.ok ? lateNote : `${result.error ?? 'Failed'}${lateNote ? ` · ${lateNote}` : ''}`
    // Not run at all (its model was not up yet): try again in 5 minutes, up
    // to an hour, instead of losing the run.
    if (result.retry) {
      const tries = (done.retries ?? 0) + 1
      if (tries <= 12) {
        done.retries = tries
        done.nextRun = this.now() + 5 * 60_000
        done.enabled = true
        done.lastNote = `${result.error ?? 'Not run'} Trying again in 5 min.`
      } else {
        done.retries = 0
      }
    } else {
      done.retries = 0
    }
    store.save(done)
    this.deps.onChange?.()
    this.deps.onFinished?.(done)
    return done
  }

  isRunning(id: string): boolean { return this.running.has(id) }

  /** After a crash or quit mid-run: stored "running" becomes an error. */
  recoverInterrupted(): void {
    const store = this.deps.store()
    for (const t of store.list()) {
      if (t.lastStatus !== 'running') continue
      t.lastStatus = 'error'
      t.lastNote = 'Interrupted: MLX Harness closed during the run.'
      store.save(t)
    }
  }
}

export { describeSchedule }
