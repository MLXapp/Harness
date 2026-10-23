import { useState, useEffect, useMemo } from 'react'
import { Settings, Server, Play, Square, Loader2, X, RotateCw, Share } from 'lucide-react'
import { ChatSettings } from '../chat/ChatSettings'
import { ServerSettingsDrawer } from '../sessions/ServerSettingsDrawer'
import { useSessionsContext } from '../../contexts/SessionsContext'
import { isImageSession } from '../../../../shared/sessionUtils'
import {
  reasoningParserIsEnabled,
  resolveEffectiveReasoningParser,
} from '../../../../shared/reasoningParserAliases'
import { useTranslation } from '../../i18n'
import { useToast } from '../Toast'
import { useProviders } from '../settings/useProviders'
import { ChromeEnd } from './ChromeSlot'
import { findBoundModel } from '../../../../shared/providers/pickerGroups'
import type { ChatModelBinding } from '../../../../shared/providers/types'

/**
 * The thin bar above a chat: the MLX session's Start / Stop and the chat and
 * server settings drawers. The model itself is chosen in the composer
 * (components/chat/ModelSwitcher.tsx).
 */
interface ChatModeToolbarProps {
  activeChatId: string | null
  activeSessionId: string | null
  onOverridesChanged?: () => void
  /** The chat's provider model (Preferences → Models), when it uses one. */
  providerBinding?: ChatModelBinding | null
}

const BAR_BUTTON = 'flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors duration-150'

interface SessionDetail {
  id: string
  modelPath: string
  modelName?: string
  host: string
  port: number
  pid?: number
  status: 'running' | 'stopped' | 'error' | 'loading' | 'standby'
  config: string
  type?: 'local' | 'remote'
  remoteUrl?: string
  remoteModel?: string
}

export function ChatModeToolbar({ activeChatId, activeSessionId, onOverridesChanged, providerBinding }: ChatModeToolbarProps) {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const { sessions: allSessions, loadProgress } = useSessionsContext()
  const { providers, localServers } = useProviders()

  // Filter out image sessions — they belong in the Image tab, not chat
  const sessions = useMemo(() => allSessions.filter(s => !isImageSession(s)), [allSessions])
  const bound = useMemo(() => findBoundModel(providerBinding, localServers, providers), [providerBinding, localServers, providers])

  const [showChatSettings, setShowChatSettings] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [effectiveReasoningParser, setEffectiveReasoningParser] = useState<string | undefined>(undefined)

  // Load full session detail when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setSessionDetail(null)
      return
    }
    window.api.sessions.get(activeSessionId).then((s: SessionDetail | null) => {
      setSessionDetail(s)
      if (s) {
        try {
          const cfg = s.config ? JSON.parse(s.config) : {}
          if (!s.modelPath.startsWith('remote://')) {
            window.api.models.detectConfig(s.modelPath).then((detected: any) => {
              const effective = resolveEffectiveReasoningParser({
                configuredParser: cfg.reasoningParser,
                detectedParser: detected?.reasoningParser,
                supportsThinking: detected?.supportsThinking,
              })
              setEffectiveReasoningParser(
                reasoningParserIsEnabled(effective) ? effective : undefined,
              )
            }).catch((err) => console.error('Failed to load session info:', err))
          } else {
            const effective = resolveEffectiveReasoningParser({
              configuredParser: cfg.reasoningParser,
            })
            setEffectiveReasoningParser(
              reasoningParserIsEnabled(effective) ? effective : undefined,
            )
          }
        } catch { /* ignore */ }
      }
    }).catch((err) => console.error('Failed to load session info:', err))
  }, [activeSessionId])

  // Keep session status in sync via context
  const contextSession = sessions.find(s => s.id === activeSessionId)
  const displaySession = sessionDetail
    ? {
        ...sessionDetail,
        status: contextSession?.status ?? sessionDetail.status,
        modelPath: contextSession?.modelPath ?? sessionDetail.modelPath,
        modelName: contextSession?.modelName ?? sessionDetail.modelName,
        host: contextSession?.host ?? sessionDetail.host,
        port: contextSession?.port ?? sessionDetail.port,
        // When a context row exists its PID is authoritative even when it is
        // undefined: session:stopped deliberately clears the old process ID.
        pid: contextSession ? contextSession.pid : sessionDetail.pid,
        type: contextSession?.type ?? sessionDetail.type,
        remoteUrl: contextSession?.remoteUrl ?? sessionDetail.remoteUrl,
        config: contextSession?.config ?? sessionDetail.config,
      }
    : null

  const isRemote = displaySession?.type === 'remote'
  const isRunning = displaySession?.status === 'running'
  const isStandby = displaySession?.status === 'standby'
  const isPreflighting = !!activeSessionId && loadProgress.get(activeSessionId)?.preflightActive === true
  const isLoading = displaySession?.status === 'loading' || isPreflighting
  const isError = displaySession?.status === 'error'
  const isStopped = !isPreflighting && (displaySession?.status === 'stopped' || isError)

  const handleStart = async () => {
    if (!activeSessionId) return
    try {
      const result = await window.api.sessions.start(activeSessionId)
      if (!result?.success) {
        throw new Error(result?.error || t('chat.interface.toast.failedToStart'))
      }
    } catch (error) {
      showToast('error', t('chat.interface.toast.failedToStart'), (error as Error).message)
    }
  }

  const handleStop = async () => {
    if (!activeSessionId) return
    await window.api.sessions.stop(activeSessionId)
  }


  // No chat selected — don't render toolbar
  if (!activeChatId) return null

  // Chat settings for a provider chat describe the provider endpoint like a
  // remote connection (no local bundle to inspect).
  const chatSettingsSession = providerBinding
    ? {
        modelName: bound.model?.name || providerBinding.modelId,
        modelPath: `provider://${providerBinding.providerId}/${providerBinding.modelId}`,
        host: (() => { try { return new URL(bound.provider?.baseURL ?? '').hostname } catch { return '' } })(),
        port: 0,
        status: 'running' as const,
        type: 'remote' as const,
        remoteUrl: bound.provider?.baseURL,
        modelType: undefined,
        config: '{}',
      }
    : displaySession
      ? {
          modelName: displaySession.modelName,
          modelPath: displaySession.modelPath,
          host: displaySession.host,
          port: displaySession.port,
          status: displaySession.status,
          pid: displaySession.pid,
          type: displaySession.type,
          remoteUrl: displaySession.remoteUrl,
          modelType: (() => { try { return JSON.parse(displaySession.config || '{}').modelType } catch { return undefined } })(),
          config: displaySession.config,
        }
      : null

  // Nothing to control yet: the composer's "Choose a model" pill is the way in.
  if (!chatSettingsSession) return null

  const statusLabel = isRunning ? t('status.running') : isStandby ? t('status.sleeping') : isLoading ? null : t('status.stopped')

  return (
    <>
      <ChromeEnd>
      <div className="mlx-toolbar flex min-w-0 flex-shrink items-center gap-1 no-drag" data-vmlx-section="chat-toolbar">
        {/* The MLX session's Start / Stop (provider models have nothing to start). */}
        {displaySession && !providerBinding && (
          <div className="flex min-w-0 items-center gap-1 mlx-view-in">
            {statusLabel && (
              <span className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap px-1.5 text-[13px] text-muted-foreground"
                title={statusLabel} role="status" aria-label={statusLabel}>
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full transition-colors ${
                  isRunning ? 'bg-success' : isStandby ? 'bg-blue-400' : isError ? 'bg-destructive' : 'bg-muted-foreground'
                }`} />
                {/* Narrow windows keep just the dot (the label is its tooltip). */}
                <span className="mlx-tb-label mlx-tb-status">{statusLabel}</span>
              </span>
            )}
            {isError && (
              <button
                onClick={handleStart}
                className={`${BAR_BUTTON} text-destructive hover:bg-destructive/10`}
                title={isRemote ? t('common.reconnect') : t('sessions.toolbar.restartModel')}
              >
                <RotateCw className="h-4 w-4" />
                <span className="mlx-tb-label">{isRemote ? t('common.reconnect') : t('sessions.toolbar.restart')}</span>
              </button>
            )}
            {isStopped && !isError && (
              <button
                onClick={handleStart}
                className={`${BAR_BUTTON} text-foreground hover:bg-foreground/[0.06]`}
                title={isRemote ? t('common.connect') : t('sessions.toolbar.startModel')}
              >
                <Play className="h-4 w-4 text-success" />
                <span className="mlx-tb-label">{isRemote ? t('common.connect') : t('common.start')}</span>
              </button>
            )}
            {isLoading && (
              <>
                <span className="flex items-center gap-1.5 px-1.5 text-[13px] text-warning">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {isRemote ? t('common.connecting') : t('common.loading')}
                </span>
                <button
                  onClick={handleStop}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  title={t('common.cancel')}
                  aria-label={t('common.cancel')}
                >
                  <X className="h-4 w-4" />
                </button>
              </>
            )}
            {isRunning && (
              <button
                onClick={handleStop}
                className={`${BAR_BUTTON} text-muted-foreground hover:bg-destructive/10 hover:text-destructive`}
                title={isRemote ? t('common.disconnect') : t('sessions.toolbar.stopModel')}
              >
                <Square className="h-3.5 w-3.5" />
                <span className="mlx-tb-label">{isRemote ? t('common.disconnect') : t('common.stop')}</span>
              </button>
            )}
          </div>
        )}


        {/* Settings drawers */}
        <div className="flex flex-shrink-0 items-center gap-1">
          {activeChatId && (
            <button
              type="button"
              data-vmlx-control="chat-export"
              onClick={async () => {
                try {
                  const result = await window.api.chat.export(activeChatId, 'markdown')
                  if (result.success) showToast('success', t('chat.sessionExport.success'), result.path)
                } catch (error) {
                  showToast('error', t('chat.sessionExport.failed'), (error as Error).message)
                }
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              title={t('chat.sessionExport.button')}
              aria-label={t('chat.sessionExport.button')}
            >
              <Share className="h-4 w-4" />
            </button>
          )}
          <button
            data-vmlx-control="chat-settings"
            onClick={() => { setShowChatSettings(!showChatSettings); setShowServerSettings(false) }}
            className={`${BAR_BUTTON} ${
              showChatSettings ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
            }`}
            title={t('sessions.view.chatSettingsTitle')}
          >
            <Settings className="h-4 w-4" />
            <span className="mlx-tb-label">{t('sessions.view.chatLabel')}</span>
          </button>
          {!providerBinding && displaySession && <button
            data-vmlx-control="server-settings"
            aria-pressed={showServerSettings}
            onClick={() => { setShowServerSettings(!showServerSettings); setShowChatSettings(false) }}
            className={`${BAR_BUTTON} ${
              showServerSettings ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
            }`}
            title={isRemote ? t('sessions.view.connectionTitle') : t('sessions.view.serverSettingsTitle')}
          >
            <Server className="h-4 w-4" />
            <span className="mlx-tb-label">{isRemote ? t('sessions.view.connection') : t('sessions.view.server')}</span>
          </button>}
        </div>
      </div>
      </ChromeEnd>

      {/* Settings drawers */}
      {showChatSettings && activeChatId && chatSettingsSession && (
        <div className="absolute right-0 top-0 bottom-0 z-20 flex w-full max-w-80 justify-end">
          <ChatSettings
            chatId={activeChatId}
            session={chatSettingsSession}
            reasoningParser={providerBinding ? undefined : effectiveReasoningParser}
            onClose={() => setShowChatSettings(false)}
            onOverridesChanged={onOverridesChanged}
          />
        </div>
      )}
      {showServerSettings && displaySession && !providerBinding && (
        <div className="absolute right-0 top-0 bottom-0 z-20 flex w-full max-w-96 justify-end">
          <ServerSettingsDrawer
            session={displaySession}
            isRemote={isRemote}
            onClose={() => setShowServerSettings(false)}
            onSessionUpdate={async () => {
              const s = await window.api.sessions.get(activeSessionId!)
              if (s) setSessionDetail(s)
            }}
          />
        </div>
      )}
    </>
  )
}
