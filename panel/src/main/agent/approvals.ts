/**
 * One-shot, fail-closed approval requests between the agent loop (main
 * process) and the chat window.
 *
 * A request resolves exactly once, to the user's answer or to a closed
 * refusal: "unavailable" when it cannot be shown (no window), "timeout" when
 * nobody answers in time, "aborted" when the turn is stopped. A second answer,
 * an answer for an unknown id, or an answer from another sender is ignored,
 * and "allow-always" is accepted only when the card offered it. Pending
 * requests stay listed so a reloaded window can show the card again; when the
 * window itself is destroyed every pending request resolves "unavailable".
 *
 * Modelled on DeepSeek Harness's user-approval seam (packages/interaction/
 * user-approval and sandbox/escalation.ts: closed outcome vocabulary, nothing
 * runs before a grant), MIT License, Copyright (c) 2026 DeepSeek.
 */

import type { ApprovalKind, ApprovalOutcome } from './permissions'

export type ApprovalAnswer = 'allow-once' | 'allow-always' | 'deny'

export interface ApprovalCard {
  id: string
  chatId: string
  toolCallId?: string
  toolName: string
  kind: ApprovalKind
  /** The command, script or path, exactly as it will run. */
  subject: string
  /** The model's one-line justification (escalations) or its stated intent. */
  reason?: string
  /** Why approval is needed (read-only, no-sandbox, network, escalation …). */
  why: string
  allowAlways: boolean
  /** Epoch ms after which the request resolves "timeout". */
  expiresAt: number
}

export interface ApprovalRequestInput extends Omit<ApprovalCard, 'id' | 'expiresAt'> {
  signal?: AbortSignal
}

export interface ApprovalTransport {
  /** Show the card; false when there is no window to show it in (fails closed). */
  show(card: ApprovalCard): boolean
  /** Tell the window the card is settled (answered, timed out, aborted). */
  settled(card: ApprovalCard, outcome: ApprovalOutcome): void
}

interface Pending {
  card: ApprovalCard
  resolve: (outcome: ApprovalOutcome) => void
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>()
  private seq = 0

  constructor(
    private readonly transport: ApprovalTransport,
    private readonly options: {
      timeoutMs?: number
      now?: () => number
      setTimer?: (fn: () => void, ms: number) => unknown
      clearTimer?: (handle: unknown) => void
      newId?: () => string
    } = {},
  ) {}

  get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  }

  request(input: ApprovalRequestInput): Promise<ApprovalOutcome> {
    const { signal, ...rest } = input
    const now = this.options.now ?? Date.now
    const setTimer = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const clearTimer = this.options.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
    const id = this.options.newId?.() ?? `appr_${now().toString(36)}_${(++this.seq).toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const card: ApprovalCard = { ...rest, id, expiresAt: now() + this.timeoutMs }

    if (signal?.aborted) return Promise.resolve('aborted')

    return new Promise<ApprovalOutcome>(resolvePromise => {
      let done = false
      let timer: unknown
      const onAbort = () => finish('aborted')
      const finish = (outcome: ApprovalOutcome) => {
        if (done) return
        done = true
        this.pending.delete(id)
        if (timer !== undefined) clearTimer(timer)
        signal?.removeEventListener('abort', onAbort)
        try {
          this.transport.settled(card, outcome)
        } catch { /* the window may be gone */ }
        resolvePromise(outcome)
      }
      // Register before showing so an answer racing the send still lands.
      this.pending.set(id, { card, resolve: finish })
      let shown = false
      try {
        shown = this.transport.show(card)
      } catch {
        shown = false
      }
      if (!shown) {
        finish('unavailable')
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimer(() => finish('timeout'), this.timeoutMs)
    })
  }

  /** Apply the user's answer. Returns false when it was not accepted. */
  answer(id: string, answer: unknown): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    if (answer !== 'allow-once' && answer !== 'allow-always' && answer !== 'deny') return false
    if (answer === 'allow-always' && !entry.card.allowAlways) return false
    entry.resolve(answer)
    return true
  }

  /** Cards still waiting, optionally for one chat (a reloaded window re-shows them). */
  list(chatId?: string): ApprovalCard[] {
    return [...this.pending.values()].map(p => p.card).filter(c => !chatId || c.chatId === chatId)
  }

  /** Resolve every pending request with a refusal (window destroyed, app quitting). */
  cancelAll(outcome: Extract<ApprovalOutcome, 'unavailable' | 'aborted'> = 'unavailable'): number {
    const all = [...this.pending.values()]
    for (const p of all) p.resolve(outcome)
    return all.length
  }

  get size(): number {
    return this.pending.size
  }
}
