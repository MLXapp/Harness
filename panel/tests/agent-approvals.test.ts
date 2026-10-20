import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, type ApprovalCard } from '../src/main/agent/approvals'

function setup(opts: { show?: boolean; timeoutMs?: number } = {}) {
  const shown: ApprovalCard[] = []
  const settled: Array<[string, string]> = []
  let n = 0
  const broker = new ApprovalBroker(
    {
      show: card => { shown.push(card); return opts.show ?? true },
      settled: (card, outcome) => settled.push([card.id, outcome]),
    },
    { timeoutMs: opts.timeoutMs ?? 1000, newId: () => `id${++n}` },
  )
  const req = (extra: Partial<ApprovalCard> & { signal?: AbortSignal } = {}) =>
    broker.request({ chatId: 'c1', toolName: 'run_command', kind: 'shell', subject: 'npm ci', why: 'no-sandbox', allowAlways: true, ...extra })
  return { broker, shown, settled, req }
}

describe('approval state machine', () => {
  it('shows a card and resolves with the answer, exactly once', async () => {
    const { broker, shown, settled, req } = setup()
    const p = req()
    expect(shown).toHaveLength(1)
    expect(broker.list('c1').map(c => c.id)).toEqual(['id1'])
    expect(broker.answer('id1', 'allow-once')).toBe(true)
    expect(broker.answer('id1', 'deny')).toBe(false) // one-shot
    await expect(p).resolves.toBe('allow-once')
    expect(settled).toEqual([['id1', 'allow-once']])
    expect(broker.size).toBe(0)
  })

  it('fails closed when there is no window to show the card', async () => {
    const { broker, settled, req } = setup({ show: false })
    await expect(req()).resolves.toBe('unavailable')
    expect(settled).toEqual([['id1', 'unavailable']])
    expect(broker.size).toBe(0)
  })

  it('fails closed on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { broker, req } = setup({ timeoutMs: 5000 })
      const p = req()
      vi.advanceTimersByTime(4999)
      expect(broker.size).toBe(1)
      vi.advanceTimersByTime(1)
      await expect(p).resolves.toBe('timeout')
      expect(broker.answer('id1', 'allow-once')).toBe(false) // late answer ignored
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves aborted when the turn is stopped, before or during the wait', async () => {
    const { req, shown } = setup()
    const pre = new AbortController()
    pre.abort()
    await expect(req({ signal: pre.signal })).resolves.toBe('aborted')
    expect(shown).toHaveLength(0)
    const live = new AbortController()
    const p = req({ signal: live.signal })
    live.abort()
    await expect(p).resolves.toBe('aborted')
  })

  it('accepts allow-always only when offered, and rejects unknown answers and ids', async () => {
    const { broker, req } = setup()
    const p = req({ allowAlways: false })
    expect(broker.answer('id1', 'allow-always')).toBe(false)
    expect(broker.answer('id1', 'yes')).toBe(false)
    expect(broker.answer('nope', 'allow-once')).toBe(false)
    expect(broker.answer('id1', 'deny')).toBe(true)
    await expect(p).resolves.toBe('deny')
  })

  it('cancelAll refuses every pending card (window destroyed)', async () => {
    const { broker, req } = setup()
    const a = req()
    const b = req({ chatId: 'c2' })
    expect(broker.list('c2')).toHaveLength(1)
    expect(broker.cancelAll()).toBe(2)
    await expect(a).resolves.toBe('unavailable')
    await expect(b).resolves.toBe('unavailable')
  })

  it('carries an expiry so the card can show the deadline', () => {
    const { shown, req } = setup({ timeoutMs: 60_000 })
    const before = Date.now()
    void req()
    expect(shown[0].expiresAt).toBeGreaterThanOrEqual(before + 60_000)
  })
})
