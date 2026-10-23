import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { dueAction, nextRun, parseSchedule } from '../src/shared/schedule'
import { TaskScheduler, TaskStore } from '../src/main/tasks/scheduler'

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('schedules', () => {
  it('parses and refuses', () => {
    expect(parseSchedule({ kind: 'daily', time: '08:00' })).toEqual({ ok: true, schedule: { kind: 'daily', time: '08:00' } })
    expect(parseSchedule({ kind: 'daily', time: '25:00' }).ok).toBe(false)
    expect(parseSchedule({ kind: 'interval', minutes: 5 }).ok).toBe(false)
    expect(parseSchedule({ kind: 'weekly', days: [9], time: '08:00' }).ok).toBe(false)
    expect(parseSchedule({ kind: 'cron' }).ok).toBe(false)
  })
  it('finds the next run', () => {
    const fri = local(2026, 10, 23, 9, 0) // a Friday
    expect(nextRun({ kind: 'daily', time: '08:00' }, fri)).toBe(local(2026, 10, 24, 8, 0))
    expect(nextRun({ kind: 'daily', time: '10:00' }, fri)).toBe(local(2026, 10, 23, 10, 0))
    expect(nextRun({ kind: 'weekly', days: [1], time: '08:00' }, fri)).toBe(local(2026, 10, 26, 8, 0))
    expect(nextRun({ kind: 'interval', minutes: 60 }, fri)).toBe(fri + 3600000)
    expect(nextRun({ kind: 'once', at: fri - 1 }, fri)).toBeNull()
  })
  it('knows on time from late', () => {
    expect(dueAction(1000, 500)).toBe('wait')
    expect(dueAction(1000, 1000 + 60_000)).toBe('run')
    expect(dueAction(1000, 1000 + 10 * 60_000)).toBe('run-late')
  })
})

describe('scheduler', () => {
  it('runs due tasks once, plans from now (no burst after sleep) and notes a late run', async () => {
    let now = local(2026, 10, 23, 7, 0)
    const runs: string[] = []
    const store = new TaskStore(new Database(':memory:'))
    const s = new TaskScheduler({ store: () => store, now: () => now, runTurn: async (chatId, prompt) => { runs.push(`${chatId}:${prompt}`); return { ok: true } } })
    const t = s.create({ title: 'Brief', prompt: 'Summarize', chatId: 'c1', schedule: { kind: 'daily', time: '08:00' } })
    await s.tick(); expect(runs).toHaveLength(0)
    now = local(2026, 10, 25, 9, 30) // slept through two 08:00 runs
    await s.tick(); await new Promise(r => setTimeout(r, 0))
    expect(runs).toEqual(['c1:Summarize'])
    const after = store.get(t.id)!
    expect(after.lastStatus).toBe('ok')
    expect(after.lastNote).toMatch(/instead of 08:00/)
    expect(after.nextRun).toBe(local(2026, 10, 26, 8, 0))
    await s.tick(); await new Promise(r => setTimeout(r, 0))
    expect(runs).toHaveLength(1)
  })
  it('a once task turns itself off; errors are kept', async () => {
    let now = 1000
    const store = new TaskStore(new Database(':memory:'))
    const s = new TaskScheduler({ store: () => store, now: () => now, runTurn: async () => ({ ok: false, error: 'Its model was not running.' }) })
    const t = s.create({ title: 'x', prompt: 'y', chatId: 'c', schedule: { kind: 'once', at: 2000 } })
    now = 2500
    await s.run(t.id)
    const after = store.get(t.id)!
    expect(after.enabled).toBe(false)
    expect(after.lastStatus).toBe('error')
    expect(after.lastNote).toContain('not running')
  })
  it('is wired: the tool asks, runs in its own chat, and the app starts the scheduler', () => {
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    expect(chat).toContain('} else if (tc.function.name === "schedule_task") {')
    expect(chat).toContain('refusalOf(await gateToolCall(tc.function.name, toolArgs, tc.id, true, fullContent, scheduleSubject))')
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain('registerTaskHandlers()')
  })
})
