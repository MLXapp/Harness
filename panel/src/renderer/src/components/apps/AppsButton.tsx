import { useEffect, useState } from 'react'
import { Blocks } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppState } from '../../contexts/AppStateContext'
import { useAppsStatus } from './AppsPreference'

/**
 * Apps in this chat, in the composer: a switch once Composio is connected
 * (the model then gets the app tools), else a shortcut to Preferences → Apps.
 */
export function AppsButton({ compact }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { state, dispatch } = useAppState()
  const status = useAppsStatus()
  const chatId = state.activeChatId
  const connected = status?.state === 'connected'
  const [on, setOn] = useState(false)
  useEffect(() => {
    let alive = true
    if (!chatId || !connected) { setOn(false); return }
    window.api.apps.chatEnabled(chatId).then(v => { if (alive) setOn(v) }).catch(() => undefined)
    return () => { alive = false }
  }, [chatId, connected])
  if (!status || !window.api?.apps) return null
  if (!connected) {
    return (
      <button type="button" data-vmlx-control="chat-apps-setup" onClick={() => dispatch({ type: 'OPEN_PREFERENCES', section: 'apps' })}
        title={t('apps.setupTitle')} aria-label={t('apps.setupTitle')}
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground">
        <Blocks className="h-[17px] w-[17px]" strokeWidth={1.8} />
      </button>
    )
  }
  const toggle = async () => {
    if (!chatId) return
    const next = !on
    setOn(next)
    setOn(await window.api.apps.setChatEnabled(chatId, next).catch(() => !next))
  }
  return (
    <button type="button" role="switch" aria-checked={on} data-vmlx-control="chat-apps" data-vmlx-state={on ? 'on' : 'off'}
      disabled={!chatId} onClick={() => void toggle()} title={on ? t('apps.onTitle') : t('apps.offTitle')}
      className={`mlx-chip ${on ? 'is-on' : ''}`}>
      <Blocks className="h-3.5 w-3.5" strokeWidth={1.9} />
      {!compact && t('apps.chip')}
    </button>
  )
}
