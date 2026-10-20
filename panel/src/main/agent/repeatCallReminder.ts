/*
 * Portions adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License.
 * (packages/guard/repeat-tool-reminder)
 */

/**
 * Advisory repeat-call reminder. When the model makes the same tool call
 * (same name, same arguments regardless of key order) for the 3rd, 5th and
 * 8th time in a chat session, a note is appended to that call's result. The
 * call itself always runs: this never blocks, it only makes a loop visible to
 * the model while it can still change course. The note goes at the END of the
 * newest tool result, so the cached prompt prefix is untouched.
 */

export const REPEAT_THRESHOLDS: readonly number[] = [3, 5, 8]
const ARGUMENTS_PREVIEW_CHARS = 500

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/** Canonical arguments: deep key-sort, then stringify. */
export function canonicalArguments(args: unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(sortJsonValue(JSON.parse(args)))
    } catch {
      return args
    }
  }
  return JSON.stringify(sortJsonValue(args ?? {}))
}

function previewArguments(canonical: string): string {
  if (canonical.length <= ARGUMENTS_PREVIEW_CHARS) return canonical
  return `${canonical.slice(0, ARGUMENTS_PREVIEW_CHARS)}… (+${canonical.length - ARGUMENTS_PREVIEW_CHARS} more chars)`
}

/** The note for the Nth identical call, or null when N is not a threshold. */
export function repeatReminderText(toolName: string, count: number, canonical: string): string | null {
  if (!REPEAT_THRESHOLDS.includes(count)) return null
  if (count === REPEAT_THRESHOLDS[0]) {
    return (
      `[Note: this is call #${count} of ${toolName} with exactly these arguments in this session. ` +
      'Look carefully at the earlier results before calling it again. If something changed since ' +
      '(for example you edited files), repeating is fine; otherwise try a different approach or different arguments.]'
    )
  }
  return (
    '[Repeated tool call detected:\n' +
    `- tool: ${toolName}\n` +
    `- identical calls this session: ${count}\n` +
    `- arguments: ${previewArguments(canonical)}\n` +
    'These repeats do not seem to be making progress. Unless the situation has changed, do not call this tool ' +
    'with these exact arguments again: inspect the latest result and choose a different action or arguments, ' +
    'or finish the task if you already have enough evidence.]'
  )
}

export class RepeatCallTracker {
  private readonly sessions = new Map<string, Map<string, number>>()

  /** Count one executed call and return the advisory note to append, if any. */
  record(sessionId: string, toolName: string, args: unknown): string | null {
    const canonical = canonicalArguments(args)
    const key = `${toolName}\u0000${canonical}`
    let counts = this.sessions.get(sessionId)
    if (!counts) {
      counts = new Map()
      this.sessions.set(sessionId, counts)
    }
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return repeatReminderText(toolName, count, canonical)
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

export function appendReminder(resultText: string, reminder: string | null): string {
  if (!reminder) return resultText
  return resultText ? `${resultText}\n\n${reminder}` : reminder
}
