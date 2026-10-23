/**
 * Schedules for scheduled tasks (pure, shared by main and the renderer).
 * Times are the Mac's local time. A run missed while the Mac slept or the
 * app was closed runs once when it can, and says so (never a burst).
 */

export type Schedule =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string } // 0 = Sunday … 6 = Saturday
  | { kind: 'interval'; minutes: number }

export const MIN_INTERVAL_MINUTES = 15
/** A run this late counts as caught up (the task note says so). */
export const LATE_MS = 2 * 60_000

function parseTime(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h <= 23 && min <= 59 ? { h, m: min } : null
}

/** A schedule from untrusted input (the agent's tool call, IPC), or an error. */
export function parseSchedule(input: unknown): { ok: true; schedule: Schedule } | { ok: false; error: string } {
  const s = (input ?? {}) as Record<string, unknown>
  switch (s.kind) {
    case 'once': {
      const at = typeof s.at === 'number' ? s.at : typeof s.at === 'string' ? Date.parse(s.at) : NaN
      if (!Number.isFinite(at)) return { ok: false, error: 'once needs "at" (an ISO date-time, e.g. 2026-10-24T09:00)' }
      return { ok: true, schedule: { kind: 'once', at } }
    }
    case 'daily': {
      if (!parseTime(String(s.time))) return { ok: false, error: 'daily needs "time" as HH:MM (24 h, local time)' }
      return { ok: true, schedule: { kind: 'daily', time: String(s.time).trim() } }
    }
    case 'weekly': {
      if (!parseTime(String(s.time))) return { ok: false, error: 'weekly needs "time" as HH:MM (24 h, local time)' }
      const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
      if (days.length === 0) return { ok: false, error: 'weekly needs "days": numbers 0 (Sunday) to 6 (Saturday)' }
      return { ok: true, schedule: { kind: 'weekly', days, time: String(s.time).trim() } }
    }
    case 'interval': {
      const minutes = Math.round(Number(s.minutes))
      if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) return { ok: false, error: `interval needs "minutes" of at least ${MIN_INTERVAL_MINUTES}` }
      return { ok: true, schedule: { kind: 'interval', minutes: Math.min(minutes, 60 * 24 * 30) } }
    }
    default:
      return { ok: false, error: 'schedule.kind must be once, daily, weekly or interval' }
  }
}

/** The first run strictly after `from` (ms), or null when there is none. */
export function nextRun(schedule: Schedule, from: number): number | null {
  if (schedule.kind === 'once') return schedule.at > from ? schedule.at : null
  if (schedule.kind === 'interval') return from + schedule.minutes * 60_000
  const t = parseTime(schedule.time)
  if (!t) return null
  const d = new Date(from)
  for (let i = 0; i <= 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, t.h, t.m, 0, 0)
    if (c.getTime() <= from) continue
    if (schedule.kind === 'daily' || schedule.days.includes(c.getDay())) return c.getTime()
  }
  return null
}

/** What to do at `now` for a task whose run was due at `due`. */
export function dueAction(due: number | null, now: number): 'wait' | 'run' | 'run-late' {
  if (due === null || due > now) return 'wait'
  return now - due > LATE_MS ? 'run-late' : 'run'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Short English description, for logs and the agent ("daily at 08:00"). */
export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case 'once': { const d = new Date(s.at); return `once on ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
    case 'daily': return `daily at ${s.time}`
    case 'weekly': return `weekly on ${s.days.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')} at ${s.time}`
    case 'interval': return s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`
  }
}

export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  chatId: string
  schedule: Schedule
  enabled: boolean
  nextRun: number | null
  lastRun?: number
  lastStatus?: 'ok' | 'error' | 'running'
  lastNote?: string
  createdAt: number
}
