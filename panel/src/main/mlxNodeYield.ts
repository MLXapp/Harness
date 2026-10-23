/**
 * MLX Node steps aside while MLX Harness runs a model on this Mac.
 *
 * MLX Node 0.9.6+ understands `mlx://yield?by=harness&minutes=N` (pause its
 * network jobs and free its model for N minutes, at most 60, ending by
 * itself) and `mlx://resume?by=harness`. While a local model is loaded here,
 * Harness renews the yield every few minutes; when the last local model
 * stops, it sends resume. Only a running MLX Node of a version that knows
 * these links is asked (older ones would open their panel), and the link
 * goes to that copy in the background. Preferences → MLX Node turns it off.
 */

import { execFile } from 'child_process'
import { db } from './database'
import { mlxNodeStatus } from './mlx-node'

export const YIELD_MIN_VERSION = '0.9.6'
export const YIELD_MINUTES = 10
export const RENEW_MS = 4 * 60_000
export const YIELD_SETTING = 'mlx_node_yield'

/** a ≥ b for dotted versions ("0.10.0" ≥ "0.9.5"). */
export function versionAtLeast(a: string | undefined, b: string): boolean {
  if (!a) return false
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

export type YieldStep = { send: 'yield' | 'resume' | null; yielding: boolean }

/**
 * What to send now. `busy`: a local model is loaded or loading here.
 * `yielding`: we asked MLX Node to step aside and have not resumed it.
 */
export function yieldStep(state: { enabled: boolean; busy: boolean; yielding: boolean; lastSentAt: number; now: number }): YieldStep {
  const want = state.enabled && state.busy
  if (want) {
    if (!state.yielding || state.now - state.lastSentAt >= RENEW_MS) return { send: 'yield', yielding: true }
    return { send: null, yielding: true }
  }
  if (state.yielding) return { send: 'resume', yielding: false }
  return { send: null, yielding: false }
}

export function yieldEnabled(): boolean {
  try { return db.getSetting(YIELD_SETTING) !== '0' } catch { return false }
}

/** A local model is loaded or loading in MLX Harness. */
function localModelBusy(): boolean {
  try {
    return db.getSessions().some(s => s.type !== 'remote' && (s.status === 'running' || s.status === 'loading'))
  } catch {
    return false
  }
}

let yielding = false
let lastSentAt = 0
let timer: ReturnType<typeof setInterval> | null = null

async function send(kind: 'yield' | 'resume'): Promise<boolean> {
  const node = await mlxNodeStatus().catch(() => null)
  if (!node?.installed || !node.running || !node.path || !versionAtLeast(node.version, YIELD_MIN_VERSION)) return false
  const url = kind === 'yield' ? `mlx://yield?by=harness&minutes=${YIELD_MINUTES}` : 'mlx://resume?by=harness'
  return new Promise(resolve => {
    execFile('/usr/bin/open', ['-g', '-a', node.path!, url], { timeout: 5000 }, err => resolve(!err))
  })
}

/** Look again now (session started or stopped, setting changed). */
export async function evaluateYield(): Promise<void> {
  if (process.platform !== 'darwin') return
  const step = yieldStep({ enabled: yieldEnabled(), busy: localModelBusy(), yielding, lastSentAt, now: Date.now() })
  if (!step.send) return
  const ok = await send(step.send)
  // A resume that could not be delivered still ends our side: MLX Node's own
  // yield expires within minutes anyway.
  yielding = step.send === 'yield' ? ok || yielding : false
  if (step.send === 'yield' && ok) lastSentAt = Date.now()
}

export function startMlxNodeYield(onSessionChange: (cb: () => void) => void): void {
  if (timer || process.platform !== 'darwin') return
  onSessionChange(() => { void evaluateYield() })
  timer = setInterval(() => { void evaluateYield() }, 60_000)
  void evaluateYield()
}

/** On quit: let MLX Node carry on at once. */
export async function releaseMlxNodeYield(): Promise<void> {
  if (!yielding) return
  yielding = false
  await send('resume').catch(() => false)
}
