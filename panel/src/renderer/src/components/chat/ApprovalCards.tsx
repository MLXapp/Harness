import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from '../../i18n'

/**
 * Inline approval cards for the coding agent (permission presets).
 *
 * The agent loop in the main process pauses on a tool call that needs the
 * user's OK and sends a card here. Each card is answered once (Allow once,
 * Deny, or, for an exact shell command, Always allow it in this chat). The
 * main process fails closed: a card nobody answers is denied when its timer
 * runs out, and Stop denies it too; either way it disappears from here.
 *
 * Cards open and close with a height + opacity transition (no jump cuts).
 */

const TRANSITION_MS = 220

interface ShownCard {
  card: ChatApprovalCard
  open: boolean
  busy: boolean
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function ApprovalCards({ chatId }: { chatId: string }) {
  const { t } = useTranslation()
  const [shown, setShown] = useState<ShownCard[]>([])
  const [now, setNow] = useState(() => Date.now())
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  useEffect(() => {
    let alive = true
    setShown([])
    const later = (fn: () => void, ms: number) => {
      const h = setTimeout(() => { timers.current.delete(h); if (alive) fn() }, ms)
      timers.current.add(h)
    }
    const add = (card: ChatApprovalCard) => {
      if (card.chatId !== chatId) return
      setShown(prev => (prev.some(s => s.card.id === card.id) ? prev : [...prev, { card, open: false, busy: false }]))
      // Next frame: let the closed state paint first so the opening animates.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!alive) return
        setShown(prev => prev.map(s => (s.card.id === card.id ? { ...s, open: true } : s)))
      }))
    }
    const remove = (id: string) => {
      setShown(prev => prev.map(s => (s.card.id === id ? { ...s, open: false, busy: true } : s)))
      later(() => setShown(prev => prev.filter(s => s.card.id !== id)), TRANSITION_MS + 40)
    }
    // Cards already waiting (window reloaded, or the user switched chats).
    window.api.chat.getPendingApprovals?.(chatId)
      .then(list => { if (alive) (list || []).forEach(add) })
      .catch(() => {})
    const offRequest = window.api.chat.onApprovalRequest?.(add) ?? (() => {})
    const offSettled = window.api.chat.onApprovalSettled?.(data => {
      if (data.chatId === chatId) remove(data.id)
    }) ?? (() => {})
    return () => {
      alive = false
      offRequest()
      offSettled()
      for (const h of timers.current) clearTimeout(h)
      timers.current.clear()
    }
  }, [chatId])

  // The auto-deny countdown ticks only while a card is showing.
  useEffect(() => {
    if (shown.length === 0) return
    setNow(Date.now())
    const h = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(h)
  }, [shown.length])

  const respond = (id: string, answer: 'allow-once' | 'allow-always' | 'deny') => {
    setShown(prev => prev.map(s => (s.card.id === id ? { ...s, busy: true } : s)))
    window.api.chat.answerApproval(id, answer)
      .then(res => {
        // Not accepted: the card already settled (timeout/stop); the settled
        // event removes it. Re-enable only if it is somehow still listed.
        if (!res?.accepted) setShown(prev => prev.map(s => (s.card.id === id ? { ...s, busy: false } : s)))
      })
      .catch(() => setShown(prev => prev.map(s => (s.card.id === id ? { ...s, busy: false } : s))))
  }

  if (shown.length === 0) return null

  return (
    <div className="bg-card" data-vmlx-control="approval-cards">
      {shown.map(({ card, open, busy }) => {
        const kindLabel = t(`chat.approval.kind.${card.kind}`)
        const whyKey = `chat.approval.why.${card.why}`
        const why = t(whyKey)
        return (
          <div
            key={card.id}
            style={{
              display: 'grid',
              gridTemplateRows: open ? '1fr' : '0fr',
              opacity: open ? 1 : 0,
              transition: `grid-template-rows ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS - 40}ms ease`,
            }}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="border-t border-border px-4 py-3">
                <div
                  className="max-w-2xl mx-auto rounded-lg border border-warning/40 bg-warning/5 p-3"
                  role="alertdialog"
                  aria-label={t('chat.approval.title')}
                  data-approval-kind={card.kind}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <ShieldAlert className="h-4 w-4 text-warning flex-shrink-0" />
                    <span className="text-sm font-medium">{t('chat.approval.title')}</span>
                    <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                      {card.toolName}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    <span className="font-medium text-foreground">{kindLabel}</span>
                    {why !== whyKey && <span> · {why}</span>}
                  </div>
                  {card.subject && (
                    <pre className="text-xs font-mono bg-background border border-border rounded px-2 py-1.5 mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all select-text">
                      {card.subject}
                    </pre>
                  )}
                  {card.reason && (
                    <div className="text-xs mb-2">
                      <span className="text-muted-foreground">{t('chat.approval.reason')}: </span>
                      <span className="whitespace-pre-wrap">{card.reason}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => respond(card.id, 'allow-once')}
                      className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40"
                    >
                      {t('chat.approval.allowOnce')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => respond(card.id, 'deny')}
                      className="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent disabled:opacity-40"
                    >
                      {t('chat.approval.deny')}
                    </button>
                    {card.allowAlways && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => respond(card.id, 'allow-always')}
                        className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-40"
                      >
                        {t(card.kind === 'mcp' ? 'chat.approval.alwaysAllowTool' : 'chat.approval.alwaysAllow')}
                      </button>
                    )}
                    <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                      {t('chat.approval.autoDeny', { time: formatRemaining(card.expiresAt - now) })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
