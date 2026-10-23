import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useAppState } from '../../contexts/AppStateContext'

/** Fraction of the window at which the history is compacted (main/agent/compaction.ts). */
const COMPACT_AT = 0.8
const R = 7
const C = 2 * Math.PI * R

const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/**
 * How full the model's context window is, from the last request this chat
 * sent: a small ring in the composer. Amber past 60%, it compacts at 80%.
 * Clicking it compacts now (/compact).
 */
export function ContextGauge({ onCompact, disabled }: { onCompact: () => void; disabled?: boolean }) {
  const { t } = useTranslation()
  const { state } = useAppState()
  const chatId = state.activeChatId
  const [usage, setUsage] = useState<{ tokens: number; window: number } | null>(null)
  useEffect(() => {
    setUsage(null)
    const off = window.api?.chat?.onContext?.(data => {
      if (data.chatId === chatId) setUsage({ tokens: data.tokens, window: data.window })
    })
    return () => off?.()
  }, [chatId])
  if (!usage || usage.window <= 0) return null
  const frac = Math.min(1, usage.tokens / usage.window)
  const tone = frac >= 0.6 ? 'rgb(var(--warning))' : 'var(--acc)'
  const title = t('chat.context.title', { used: short(usage.tokens), window: short(usage.window), pct: Math.round(frac * 100), at: Math.round(COMPACT_AT * 100) })
  return (
    <button type="button" data-vmlx-control="chat-context" onClick={onCompact} disabled={disabled}
      title={title} aria-label={title}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] disabled:opacity-40">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
        <circle cx="9" cy="9" r={R} fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 9 9)"
          style={{ transition: 'stroke-dashoffset 500ms var(--ease, ease), stroke 300ms ease' }} />
      </svg>
    </button>
  )
}
