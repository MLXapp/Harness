import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MessageSquare, ArrowLeft, Terminal } from 'lucide-react'
import { TitleBar } from './components/layout/TitleBar'
import { ConsoleSubnavigation } from './components/layout/ConsoleSubnavigation'
import { DownloadTab } from './components/sessions/DownloadTab'
import { ConsoleSidebar } from './components/layout/ConsoleSidebar'
import { SingleModelPreference } from './components/layout/SingleModelPreference'
import { SessionDashboard } from './components/sessions/SessionDashboard'
import { CreateSession } from './components/sessions/CreateSession'
import { SessionView } from './components/sessions/SessionView'
import { SessionSsdPoolNotice, type SsdPoolSession } from './components/sessions/SsdPoolNotice'
import { SessionSettings } from './components/sessions/SessionSettings'
import { ChatInterface } from './components/chat/ChatInterface'
import { SetupScreen } from './components/setup/SetupScreen'
import { ToastProvider } from './components/Toast'
import { DownloadStatusBar } from './components/DownloadStatusBar'
import { UpdateBanner } from './components/UpdateBanner'
import { MtpComponentUpdatePrompt } from './components/MtpComponentUpdatePrompt'
import { MetalMemoryNotice } from './components/MetalMemoryNotice'
import { useAppState } from './contexts/AppStateContext'
import { useSessionsContext } from './contexts/SessionsContext'
import { ChatModeToolbar } from './components/layout/ChatModeToolbar'
import { AccountsPreference } from './components/accounts/AccountsPreference'
import { AccountSheetsHost } from './components/accounts/AccountSheetsHost'
import { ONBOARDING_EVENT } from './components/accounts/events'
import { Onboarding } from './components/setup/Onboarding'
import { ONBOARDING_DONE_KEY, shouldShowOnboarding, type StartChoice } from '../../shared/accountSetup'
import { ChatModelContext, type ChatModelContextValue } from './components/chat/ChatModelContext'
import { groupPickerEntries } from '../../shared/providers/pickerGroups'
import type { ChatModelBinding, ProviderReasoningLevel } from '../../shared/providers/types'
import { ToolsDashboard } from './components/tools/ToolsDashboard'
import { ModelInspector } from './components/tools/ModelInspector'
import { ModelDoctor } from './components/tools/ModelDoctor'
import { ModelConverter } from './components/tools/ModelConverter'
import { ApiDashboard } from './components/api/ApiDashboard'
import { ImageTab } from './components/image/ImageTab'
import { NetworkView } from './components/network/NetworkView'
import { MlxNodePreference } from './components/network/MlxNodePreference'
import { isImageSession, sessionMatchesModelPath } from '../../shared/sessionUtils'
import { resolveDownloadModelType, type DownloadModelType } from '../../shared/modelDiscoveryNavigation'
import { useTranslation, LOCALES, LOCALE_NAMES, LOCALE_FLAGS } from './i18n'
import { useTheme, type ThemePreference } from './providers/ThemeProvider'

function App() {
  const { t } = useTranslation()
  const [setupDone, setSetupDone] = useState(false)
  const [checkingSetup, setCheckingSetup] = useState(true)
  const [creatingChatSession, setCreatingChatSession] = useState(false)
  const [downloadModelType, setDownloadModelType] = useState<DownloadModelType>('text')
  const [chatCreationError, setChatCreationError] = useState<string | null>(null)
  // A downloaded model to preselect when the chat page asks to launch one (first-run setup).
  const [chatCreateModelPath, setChatCreateModelPath] = useState<string | null>(null)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const { state, restored, dispatch, setMode, openChat } = useAppState()
  const { sessions: allSessions, ready: sessionsReady } = useSessionsContext()

  // For chat mode, exclude image sessions — they belong in the Image tab
  const sessions = useMemo(() => allSessions.filter(s => !isImageSession(s)), [allSessions])

  // Check if engine is already installed (skip setup screen if so)
  useEffect(() => {
    window.api.engine.checkInstallation()
      .then((result: any) => {
        if (result.installed) setSetupDone(true)
      })
      .catch((err) => console.error('Installation check failed:', err))
      .finally(() => setCheckingSetup(false))
  }, [])

  // Clear stale chat locks on mount. Only locks that can no longer finish:
  // an agent turn that kept running while the window was closed (or across a
  // reload) must not be stopped by the window coming back.
  useEffect(() => {
    const clear = window.api.chat.clearStaleLocks ?? window.api.chat.clearAllLocks
    clear().catch((err) => console.error('Failed to clear chat locks:', err))
  }, [])

  // First-run setup: once, after the engine is installed, until finished or skipped.
  useEffect(() => {
    if (!setupDone) return
    let alive = true
    window.api.settings.get(ONBOARDING_DONE_KEY)
      .then(done => { if (alive && shouldShowOnboarding(true, done)) setOnboardingOpen(true) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [setupDone])

  useEffect(() => {
    const open = () => setOnboardingOpen(true)
    window.addEventListener(ONBOARDING_EVENT, open)
    return () => window.removeEventListener(ONBOARDING_EVENT, open)
  }, [])

  const finishOnboarding = useCallback(() => {
    setOnboardingOpen(false)
    window.api.settings.set(ONBOARDING_DONE_KEY, String(Date.now())).catch(() => undefined)
  }, [])

  // Listen for navigation events from child components (e.g. toolbar "Add a model")
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.mode === 'onboarding') {
        setOnboardingOpen(true)
        return
      }
      if (detail?.mode === 'models') {
        setDownloadModelType(resolveDownloadModelType(detail.downloadModelType))
      }
      if (detail?.mode === 'chat' && detail?.panel === 'create') {
        setMode('chat')
        setCreatingChatSession(true)
        return
      }
      if (detail?.mode) setMode(detail.mode)
      if (detail?.panel) {
        if (detail.mode === 'tools') {
          dispatch({ type: 'SET_TOOLS_PANEL', panel: detail.panel, modelPath: detail.modelPath })
        } else {
          dispatch({ type: 'SET_SERVER_PANEL', panel: detail.panel, sessionId: detail.sessionId, modelPath: detail.modelPath })
        }
      }
    }
    window.addEventListener('vmlx:navigate', handler)
    return () => window.removeEventListener('vmlx:navigate', handler)
  }, [setMode, dispatch])

  // If the active session was deleted, fall back to another session
  useEffect(() => {
    if (state.activeSessionId && sessions.length > 0 && !sessions.find(s => s.id === state.activeSessionId)) {
      // Active session no longer exists — switch to first available
      const fallback = sessions.find(s => s.status === 'running') || sessions[0]
      if (fallback && state.activeChatId) {
        openChat(state.activeChatId, fallback.id)
      }
    }
  }, [sessions, state.activeSessionId, state.activeChatId, openChat])

  // Resolve the endpoint for the active session. A chat can stay pinned to a
  // stopped DUPLICATE session of the same model (identity split across path
  // prefixes: ~/models symlink vs /Volumes real dir spawns twin session rows)
  // while the usable twin runs — prefer the usable same-identity session so
  // the composer/banner reflect reality instead of the stale pin.
  const pinnedSession = sessions.find(s => s.id === state.activeSessionId)
  const sessionUsable = (s: typeof sessions[number] | undefined) =>
    !!s && (s.status === 'running' || s.status === 'loading' || s.status === 'standby')
  const activeSession = (pinnedSession && !sessionUsable(pinnedSession))
    ? sessions.find(s => sessionMatchesModelPath(s.modelPath, pinnedSession.modelPath) && sessionUsable(s)) || pinnedSession
    : pinnedSession
  // Adopt the same-identity recovery, not only its endpoint. Otherwise Stop
  // removes the usable twin and the next render silently reverts to the old
  // stopped row, so Start/settings act on a different session again.
  useEffect(() => {
    if (state.activeChatId && activeSession?.id && activeSession.id !== state.activeSessionId) {
      openChat(state.activeChatId, activeSession.id)
    }
  }, [state.activeChatId, state.activeSessionId, activeSession?.id, openChat])

  // Standby sessions still have a live process on their port — JIT middleware
  // auto-wakes. Loading sessions expose their endpoint too: a message sent
  // mid-load queues exactly once in the main process (visible load progress,
  // Stop cancels) instead of being rejected at the input box.
  const sessionEndpoint = (activeSession?.status === 'running' || activeSession?.status === 'standby' || activeSession?.status === 'loading')
    ? { host: activeSession.host, port: activeSession.port }
    : undefined

  const handleChatSelect = useCallback((chatId: string, modelPath: string) => {
    setCreatingChatSession(false)
    // Empty chatId means deselect (e.g. after deleting the active chat)
    if (!chatId) {
      dispatch({ type: 'CLOSE_CHAT' })
      return
    }

    // Match the chat's model to a session by real model IDENTITY, not raw path
    // equality. The same model is stored under different path prefixes — a
    // ~/.mlxstudio/models/X symlink vs the real /Volumes/…/org/X, or an HF repo
    // id vs its resolved local dir — so `s.modelPath === modelPath` misses the
    // right session and reverts the chat to an arbitrary session of a DIFFERENT
    // model (disabling the composer). `sessionMatchesModelPath` mirrors the
    // backend send-path resolver in ipc/chat.ts.
    const sameModel = (s: typeof sessions[number]) => sessionMatchesModelPath(s.modelPath, modelPath)
    const usable = (s: typeof sessions[number]) =>
      s.status === 'running' || s.status === 'loading' || s.status === 'standby'
    // Prefer this model's ready session, then this model in any state, then any
    // ready session, then anything — never silently jump to a different model's
    // session when this model's own session exists.
    const session =
      sessions.find(s => sameModel(s) && usable(s)) ||
      sessions.find(s => sameModel(s)) ||
      sessions.find(s => usable(s)) ||
      sessions[0]

    if (session) {
      openChat(chatId, session.id)
    } else {
      // Truly no sessions at all — open chat without one, toolbar will handle
      dispatch({ type: 'OPEN_CHAT', chatId, sessionId: '' })
    }
  }, [sessions, openChat, dispatch])

  /** A new chat bound to one provider model; false when it could not be created. */
  const createChatOnProvider = useCallback(async (
    providerId: string,
    model: { id: string; name?: string },
    reasoningEffort?: ProviderReasoningLevel,
  ): Promise<boolean> => {
    const api = window.api.providers
    if (!api) return false
    try {
      const modelPath = `provider://${providerId}/${model.id}`
      const result = await window.api.chat.create(
        t('chat.quickStart.chatWithModel', { model: model.name || model.id }),
        model.id,
        undefined,
        modelPath,
      )
      if (!result?.id) return false
      const bound = await api.setChatModel({
        chatId: result.id, providerId, modelId: model.id,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })
      if (!bound.ok) return false
      setCreatingChatSession(false)
      setMode('chat')
      dispatch({ type: 'OPEN_CHAT', chatId: result.id, sessionId: '' })
      return true
    } catch {
      return false
    }
  }, [dispatch, setMode, t])

  /** A new chat on a provider model, local servers first; false when none is usable. */
  const createProviderChat = useCallback(async (): Promise<boolean> => {
    const api = window.api.providers
    if (!api) return false
    try {
      let listed = await api.list()
      if (listed.ok && listed.localServers.length === 0) {
        const probed = await api.probeLocal()
        if (probed.ok) listed = { ...listed, localServers: probed.localServers }
      }
      if (!listed.ok) return false
      const groups = groupPickerEntries([], listed.localServers, listed.providers)
      const pick = [...groups.localServers, ...groups.cloud][0]
      const model = pick?.models[0]
      if (!pick || !model) return false
      return await createChatOnProvider(pick.provider.id, model)
    } catch {
      return false
    }
  }, [createChatOnProvider])

  const handleNewChat = useCallback(async () => {
    setCreatingChatSession(false)
    // mlxstudio #60: when the user has explicitly switched to session A in
    // the sidebar, "+ New Chat" must create a chat against session A — not
    // whichever running session happens to be first in the array. Earlier
    // logic always picked `sessions.find(s => running)` which was a coin
    // flip after loading a second model. Now we honor `activeSessionId`
    // (set by `openChat` / `handleSessionChange` whenever the user
    // navigates to a chat) and only fall back to "first running" or
    // "first session" when nothing is active yet.
    const explicit = state.activeSessionId
      ? sessions.find(s => s.id === state.activeSessionId)
      : null
    const running = sessions.find(s => s.status === 'running')
    // A pinned session that is no longer running must not win over a session
    // that is: the new chat would open against a stopped server and sit with
    // a disabled composer while another model is up (seen live after
    // stopping one session and starting another from the Server tab).
    const explicitUsable = explicit && (explicit.status === 'running' || explicit.status === 'loading' || !running)
    const target = (explicitUsable ? explicit : null) || running || explicit || sessions[0]

    if (!target) {
      if (await createProviderChat()) return
      setMode('chat')
      setCreatingChatSession(true)
      return
    }

    const modelName = target.modelName || target.modelPath.split('/').pop() || t('chat.interface.newChat')
    const result = await window.api.chat.create(
      t('chat.quickStart.chatWithModel', { model: modelName }),
      target.modelPath,
      undefined,
      target.modelPath
    )
    if (result?.id) {
      openChat(result.id, target.id)
    }
  }, [sessions, state.activeSessionId, setMode, dispatch, openChat, t, createProviderChat])

  useEffect(() => {
    // Restoring saved navigation must finish before acknowledging native menu
    // actions; otherwise a recreated window can overwrite the requested page.
    if (!restored || !sessionsReady || checkingSetup) return
    return window.api.navigation.onAction((action) => {
    if (action === 'new-chat') {
      setMode('chat')
      void handleNewChat().catch(error => {
        setChatCreationError(String(error))
        setCreatingChatSession(true)
      })
    } else if (action === 'preferences' || action === 'servers') {
      setMode('server')
      dispatch({ type: 'SET_SERVER_PANEL', panel: action === 'preferences' ? 'about' : 'dashboard' })
    } else {
      setMode(action)
    }
    })
  }, [restored, sessionsReady, checkingSetup, handleNewChat, setMode, dispatch])

  /** First-run setup's "Start a chat": best cloud model, else a downloaded local one. */
  const startFromOnboarding = useCallback(async (choice: StartChoice) => {
    finishOnboarding()
    if (choice.kind === 'cloud') {
      if (await createChatOnProvider(choice.providerId, { id: choice.modelId, name: choice.name }, choice.effort)) return
    } else if (choice.kind === 'local') {
      // Launch it with the chat defaults (one click on the chat page).
      setChatCreateModelPath(choice.modelPath)
      setMode('chat')
      setCreatingChatSession(true)
      return
    }
    setMode('chat')
    await handleNewChat().catch(error => setChatCreationError(String(error)))
  }, [finishOnboarding, createChatOnProvider, setMode, handleNewChat])

  const handleChatSessionCreated = async (sessionId: string) => {
    setCreatingChatSession(false)
    setChatCreateModelPath(null)
    setChatCreationError(null)
    try {
      const session = await window.api.sessions.get(sessionId)
      if (!session) throw new Error(t('sessions.context.createFailed'))
      const result = await window.api.chat.create(
        t('chat.quickStart.chatWithModel', { model: session.modelName || session.modelPath.split('/').pop() }),
        session.modelPath, undefined, session.modelPath,
      )
      if (!result?.id) throw new Error(t('sessions.context.createFailed'))
      openChat(result.id, sessionId)
    } catch (error) {
      // The session already exists: do not re-launch it if chat creation fails.
      setChatCreationError(String(error))
    }
  }

  const handleSessionChange = useCallback(async (sessionId: string) => {
    if (!state.activeChatId) return
    // A just-created remote may not be in this render's session list yet.
    // Persist its identity before switching the endpoint; otherwise the send
    // path resolves the old local model with the remote session's placeholder port.
    const newSession = await window.api.sessions.get(sessionId)
    if (!newSession) throw new Error(t('sessions.context.createFailed'))
    await window.api.chat.update(state.activeChatId, {
      modelId: newSession.modelPath,
      modelPath: newSession.modelPath
    })
    dispatch({ type: 'OPEN_CHAT', chatId: state.activeChatId, sessionId })
  }, [dispatch, state.activeChatId, t])

  // Setup screen
  if (checkingSetup) return null
  if (!setupDone) {
    return (
      <ToastProvider>
        <div className="flex flex-col h-screen bg-background text-foreground">
          <SetupScreen onReady={() => setSetupDone(true)} />
        </div>
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <div className="flex flex-col h-screen bg-background text-foreground">
        <TitleBar />
        <UpdateBanner />
        <MtpComponentUpdatePrompt />
        <MetalMemoryNotice />
        <DownloadStatusBar />

        <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
          <ConsoleSidebar onChatSelect={handleChatSelect} onNewChat={handleNewChat} />

          {/* Main content area */}
          <main className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
            <ConsoleSubnavigation />
            {/* Keyed by view so every page change fades in instead of cutting. */}
            <div key={`${state.mode}:${state.mode === 'server' ? state.serverPanel : state.mode === 'tools' ? state.toolsPanel : ''}`}
              className="flex-1 min-h-0 overflow-hidden mlx-view-in">
            {state.mode === 'chat' && chatCreationError && (
              <div role="alert" className="p-3 text-sm text-destructive break-words">
                {chatCreationError}
                <button className="ml-3 underline" onClick={() => setChatCreationError(null)}>{t('common.dismiss')}</button>
              </div>
            )}
            {state.mode === 'code' && (
              <div className="flex flex-col items-center justify-center h-full text-center px-8">
                <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-4">
                  <Terminal className="h-8 w-8 text-emerald-500" />
                </div>
                <h2 className="text-lg font-semibold mb-2">{t('app.code.title')}</h2>
                <p className="text-sm text-muted-foreground max-w-sm">
                  {t('app.code.description')}
                </p>
                <span className="mt-4 px-3 py-1 text-xs font-medium bg-emerald-500/10 text-emerald-500 rounded-full">
                  {t('app.code.comingSoon')}
                </span>
              </div>
            )}

            {state.mode === 'chat' && creatingChatSession && (
              <CreateSession defaultsOnly filterType="text" initialModelPath={chatCreateModelPath}
                onBack={() => { setCreatingChatSession(false); setChatCreateModelPath(null) }} onCreated={handleChatSessionCreated} />
            )}
            {state.mode === 'chat' && !creatingChatSession && (
              <ChatModeContent
                activeChatId={state.activeChatId}
                sessionEndpoint={sessionEndpoint}
                sessionStatus={activeSession?.status}
                activeSessionId={activeSession?.id || state.activeSessionId}
                ssdSession={activeSession}
                onNewChat={handleNewChat}
                onSessionChange={handleSessionChange}
              />
            )}

            {state.mode === 'server' && (
              <ServerModeContent />
            )}

            {state.mode === 'tools' && (
              <ToolsModeContent />
            )}
            {state.mode === 'models' && (
              <div className="h-full overflow-auto p-4">
                <DownloadTab initialModelType={downloadModelType} onDownloadComplete={() => {
                  // Downloads remain main-process jobs. No automatic load or
                  // route switch when a background transfer finishes.
                  window.dispatchEvent(new CustomEvent('vmlx:models-changed'))
                }} />
              </div>
            )}
            {state.mode === 'image' && (
              <ImageTab />
            )}
            {state.mode === 'network' && (
              <NetworkView />
            )}
            {state.mode === 'api' && (
              <ApiDashboard />
            )}
            </div>
          </main>
        </div>
        <AccountSheetsHost />
        <Onboarding open={onboardingOpen} onFinish={finishOnboarding} onStart={(choice) => void startFromOnboarding(choice)} />
      </div>
    </ToastProvider>
  )
}

// ─── Chat Mode Content ──────────────────────────────────────────────────────

function ChatModeContent({ activeChatId, sessionEndpoint, sessionStatus, activeSessionId, ssdSession, onNewChat, onSessionChange }: {
  activeChatId: string | null
  sessionEndpoint?: { host: string; port: number }
  sessionStatus?: string
  activeSessionId: string | null
  ssdSession?: SsdPoolSession
  onNewChat: () => void
  onSessionChange: (sessionId: string) => void | Promise<void>
}) {
  const [overridesVersion, setOverridesVersion] = useState(0)
  // The chat's provider model (Preferences → Models), when it uses one. Sends
  // then go to that provider: no MLX session endpoint is involved.
  const [providerBinding, setProviderBinding] = useState<ChatModelBinding | null>(null)
  useEffect(() => {
    let alive = true
    setProviderBinding(null)
    if (activeChatId && window.api.providers) {
      window.api.providers.getChatModel(activeChatId)
        .then(binding => { if (alive) setProviderBinding(binding) })
        .catch(() => undefined)
    }
    return () => { alive = false }
  }, [activeChatId])
  const changeProviderBinding = useCallback(async (next: ChatModelBinding | null) => {
    if (!activeChatId) return
    const result = next
      ? await window.api.providers.setChatModel(next)
      : await window.api.providers.clearChatModel(activeChatId)
    if (!result.ok) throw new Error(result.error)
    setProviderBinding(next)
  }, [activeChatId])

  // The composer's model switcher reads and changes the chat's model here.
  const { sessions: chatSessions } = useSessionsContext()
  const hasSession = !!activeSessionId && chatSessions.some(s => s.id === activeSessionId)
  const chatModel = useMemo<ChatModelContextValue | null>(() => activeChatId ? {
    chatId: activeChatId,
    activeSessionId,
    binding: providerBinding,
    setBinding: changeProviderBinding,
    selectSession: async (sessionId: string) => { await onSessionChange(sessionId) },
    hasModel: !!providerBinding || hasSession,
  } : null, [activeChatId, activeSessionId, providerBinding, changeProviderBinding, onSessionChange, hasSession])

  if (!activeChatId) {
    return <ChatEmptyState onNewChat={onNewChat} />
  }

  return (
    <ChatModelContext.Provider value={chatModel}>
    <div className="flex flex-col h-full relative">
      <ChatModeToolbar
        activeChatId={activeChatId}
        activeSessionId={activeSessionId}
        onOverridesChanged={() => setOverridesVersion(v => v + 1)}
        providerBinding={providerBinding}
      />
      <SessionSsdPoolNotice session={ssdSession} />
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <ChatInterface
          chatId={activeChatId}
          onNewChat={onNewChat}
          sessionEndpoint={providerBinding ? undefined : sessionEndpoint}
          sessionId={providerBinding ? undefined : activeSessionId || undefined}
          sessionStatus={providerBinding ? 'running' : sessionStatus}
          overridesVersion={overridesVersion}
        />
      </div>
    </div>
    </ChatModelContext.Provider>
  )
}

function ChatEmptyState({ onNewChat }: { onNewChat: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center h-full min-h-0 text-center px-4 py-8 overflow-auto [&>*]:shrink-0" data-mlx-studio="jinhojang">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4 flex-shrink-0">
        <MessageSquare className="h-8 w-8 text-primary" />
      </div>
      <h2 className="text-lg font-semibold mb-2">{t('chat.interface.emptyStateTitle')}</h2>
      <p className="text-sm text-muted-foreground mb-4 max-w-md">
        {t('chat.quickStart.emptyBody')}
      </p>
      <button
        onClick={onNewChat}
        className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded-md hover:bg-primary/90 transition-colors mb-6"
      >
        {t('chat.interface.newChat')}
      </button>

      <div className="text-left max-w-lg space-y-3 text-xs text-muted-foreground border-t border-border pt-4">
        <p className="font-semibold text-foreground text-sm">{t('chat.quickStart.title')}</p>

        <div>
          <p className="font-medium text-foreground">{t('chat.quickStart.textModelsTitle')}</p>
          <p>{t('chat.quickStart.textModelsBody')}</p>
          <p className="text-muted-foreground/70 mt-0.5">
            {t('chat.quickStart.textModelsRecommended')}
          </p>
        </div>

        <div>
          <p className="font-medium text-foreground">{t('chat.quickStart.visionModelsTitle')}</p>
          <p>{t('chat.quickStart.visionModelsBody')}</p>
          <p className="text-muted-foreground/70 mt-0.5">
            {t('chat.quickStart.visionModelsRecommended')}
          </p>
        </div>

        <div>
          <p className="font-medium text-foreground">{t('chat.quickStart.tipsTitle')}</p>
          <ul className="list-disc list-inside space-y-0.5 text-muted-foreground/80">
            <li>{t('chat.quickStart.tipLooping')}</li>
            <li>{t('chat.quickStart.tipFirstResponse')}</li>
            <li>{t('chat.quickStart.tipJang')}</li>
            <li>{t('chat.quickStart.tipSettings')}</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

// ─── Server Mode Content ────────────────────────────────────────────────────

function ServerModeContent() {
  const { state, dispatch } = useAppState()
  const { serverPanel, serverSessionId, serverInitialModelPath } = state
  const { t, locale, setLocale } = useTranslation()

  return (
    <>
      {serverPanel === 'dashboard' && (
        <SessionDashboard
          onOpenSession={(sessionId) => dispatch({ type: 'SET_SERVER_PANEL', panel: 'session', sessionId })}
          onConfigureSession={(sessionId) => dispatch({ type: 'SET_SERVER_PANEL', panel: 'settings', sessionId })}
          onCreateSession={() => dispatch({ type: 'SET_SERVER_PANEL', panel: 'create' })}
        />
      )}

      {serverPanel === 'create' && (
        <CreateSession
          initialModelPath={serverInitialModelPath}
          onBack={() => dispatch({ type: 'SET_SERVER_PANEL', panel: 'dashboard' })}
          onCreated={(sessionId) => dispatch({ type: 'SET_SERVER_PANEL', panel: 'session', sessionId })}
        />
      )}

      {serverPanel === 'session' && serverSessionId && (
        <SessionView
          sessionId={serverSessionId}
          onBack={() => dispatch({ type: 'SET_SERVER_PANEL', panel: 'dashboard' })}
        />
      )}

      {serverPanel === 'settings' && serverSessionId && (
        <SessionSettings
          sessionId={serverSessionId}
          onBack={() => dispatch({ type: 'SET_SERVER_PANEL', panel: 'dashboard' })}
        />
      )}

      {serverPanel === 'about' && (
        <div data-vmlx-surface="general-preferences" className="p-4 sm:p-8 overflow-auto h-full min-h-0 min-w-0">
          <div className="max-w-3xl mx-auto space-y-6">
            <button
              onClick={() => dispatch({ type: 'SET_SERVER_PANEL', panel: 'dashboard' })}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <ArrowLeft className="h-3 w-3" />
              {t('common.back')}
            </button>
            <h2 className="text-2xl font-bold">{t('console.preferences')}</h2>
            <AppearancePreference />
            <SingleModelPreference />
            <AccountsPreference />
            <MlxNodePreference />
            <div className="border border-border rounded-lg p-5">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">{t('app.about.language')}</h3>
              <div className="flex flex-wrap gap-2">
                {LOCALES.map((l) => (
                  <button
                    key={l}
                    data-vmlx-control={`preferences-locale-${l}`}
                    aria-pressed={locale === l}
                    onClick={() => setLocale(l)}
                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                      locale === l
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border hover:bg-accent'
                    }`}
                  >
                    {LOCALE_FLAGS[l]} {LOCALE_NAMES[l]}
                  </button>
                ))}
              </div>
            </div>
            <ApiKeysSection />
            <section className="border-t border-border pt-5 space-y-3">
              <h3 className="text-sm font-semibold">{t('app.about.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('app.about.desc')}</p>
              <p className="text-xs text-muted-foreground/70">{t('app.about.creator')}</p>
              <AppVersion />
              <div className="flex flex-wrap gap-4 text-xs">
                <a href="https://harness.mlx.app" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">harness.mlx.app</a>
                <a href="https://github.com/MLXapp/studio" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">GitHub</a>
                <a href="https://github.com/jjang-ai/vmlx" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">vMLX</a>
                <a href="https://github.com/MLXapp/studio/blob/main/NOTICE" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">{t('app.about.license')}</a>
              </div>
              {/* Required in-product attribution (MTPLX NOTICE, Apache-2.0 §4(d)). */}
              <p className="text-xs text-muted-foreground">
                <a data-vmlx-control="about-mtplx" href="https://github.com/youssofal/mtplx" target="_blank" rel="noopener noreferrer" className="hover:underline">
                  {`${t('app.about.poweredByMtplx')} · github.com/youssofal/mtplx`}
                </a>
              </p>
            </section>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Tools Mode Content ─────────────────────────────────────────────────────

function ToolsModeContent() {
  const { state, dispatch } = useAppState()
  const { toolsPanel, toolsModelPath } = state
  const [scannedModels, setScannedModels] = useState<Array<{ name: string; path: string }>>([])

  // Single model scan shared by all sub-panels
  useEffect(() => {
    window.api.models.scan().then(setScannedModels).catch((err) => console.error('Failed to scan models:', err))
  }, [])

  const navigateTo = (panel: 'dashboard' | 'inspector' | 'doctor' | 'converter', modelPath?: string) => {
    dispatch({ type: 'SET_TOOLS_PANEL', panel, modelPath: modelPath !== undefined ? (modelPath || null) : undefined })
  }

  const handleServe = (modelPath?: string) => {
    window.dispatchEvent(new CustomEvent('vmlx:navigate', {
      detail: { mode: 'server', panel: 'create', modelPath }
    }))
  }

  return (
    <>
      {toolsPanel === 'dashboard' && (
        <ToolsDashboard
          onInspect={(path) => navigateTo('inspector', path)}
          onDiagnose={(path) => navigateTo('doctor', path)}
          onConvert={(path) => navigateTo('converter', path)}
          onServe={(path) => handleServe(path)}
        />
      )}

      {toolsPanel === 'inspector' && (
        <ModelInspector
          initialModelPath={toolsModelPath}
          onBack={() => navigateTo('dashboard')}
          models={scannedModels}
        />
      )}

      {toolsPanel === 'doctor' && (
        <ModelDoctor
          initialModelPath={toolsModelPath}
          onBack={() => navigateTo('dashboard')}
          models={scannedModels}
        />
      )}

      {toolsPanel === 'converter' && (
        <ModelConverter
          initialModelPath={toolsModelPath}
          onBack={() => navigateTo('dashboard')}
          onServe={(path) => handleServe(path)}
          models={scannedModels}
        />
      )}
    </>
  )
}

// ─── Shared Components ──────────────────────────────────────────────────────

/** System / Light / Dark. A segmented control whose selection slides. */
function AppearancePreference() {
  const { t } = useTranslation()
  const { preference, setPreference } = useTheme()
  const options: Array<[ThemePreference, string]> = [
    ['system', t('app.about.themeSystem')],
    ['light', t('app.about.themeLight')],
    ['dark', t('app.about.themeDark')],
  ]
  const index = Math.max(0, options.findIndex(([value]) => value === preference))
  return (
    <div className="border border-border rounded-lg p-5" data-vmlx-surface="appearance-preference">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">{t('app.about.appearance')}</h3>
      <div role="radiogroup" aria-label={t('app.about.appearance')}
        className="relative grid grid-cols-3 w-full max-w-sm rounded-[10px] bg-foreground/[0.05] p-[3px]">
        <div aria-hidden
          className="absolute top-[3px] bottom-[3px] left-[3px] rounded-[8px] bg-card ring-1 ring-border/50 shadow-[0_1px_2px_var(--lg-depth),0_4px_12px_-6px_var(--shadow)] transition-transform duration-300 ease-mlx"
          style={{ width: 'calc((100% - 6px) / 3)', transform: `translateX(${index * 100}%)` }} />
        {options.map(([value, label]) => (
          <button key={value} role="radio" aria-checked={preference === value}
            data-vmlx-control={`preferences-theme-${value}`}
            onClick={() => setPreference(value)}
            className={`relative h-8 text-sm font-medium rounded-[8px] transition-colors ${preference === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function AppVersion() {
  const { t } = useTranslation()
  const [version, setVersion] = useState('...')
  useEffect(() => {
    window.api.app.getVersion().then((v: string) => setVersion(v)).catch(() => setVersion('unknown'))
  }, [])
  return (
    <div className="text-xs text-muted-foreground space-y-1">
      <p>{t('app.about.version', { version })}</p>
      <p>{t('app.about.copyright', { year: new Date().getFullYear() })}</p>
    </div>
  )
}

function ApiKeysSection() {
  const { t } = useTranslation()
  const [braveKey, setBraveKey] = useState('')
  const [hfToken, setHfToken] = useState('')
  const [saved, setSaved] = useState(false)
  const [hfSaved, setHfSaved] = useState(false)
  const [hasSavedBraveKey, setHasSavedBraveKey] = useState(false)
  const [hasSavedHfToken, setHasSavedHfToken] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [showHfKey, setShowHfKey] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    window.api.settings.has('braveApiKey').then((exists) => {
      if (mountedRef.current) setHasSavedBraveKey(exists)
    })
    window.api.settings.has('hf_api_key').then((exists) => {
      if (mountedRef.current) setHasSavedHfToken(exists)
    })
    return () => { mountedRef.current = false }
  }, [])

  const handleSave = async () => {
    const trimmed = braveKey.trim()
    if (trimmed) {
      await window.api.settings.set('braveApiKey', trimmed)
    } else {
      await window.api.settings.delete('braveApiKey')
    }
    setHasSavedBraveKey(!!trimmed)
    setSaved(true)
    setTimeout(() => { if (mountedRef.current) setSaved(false) }, 2000)
  }

  const handleHfSave = async () => {
    const trimmed = hfToken.trim()
    if (trimmed) {
      await window.api.settings.set('hf_api_key', trimmed)
    } else {
      await window.api.settings.delete('hf_api_key')
    }
    setHasSavedHfToken(!!trimmed)
    setHfSaved(true)
    setTimeout(() => { if (mountedRef.current) setHfSaved(false) }, 2000)
  }

  return (
    <div className="border border-border rounded-lg p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">{t('app.about.apiKeysTitle')}</h3>
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t('app.about.braveKey')}</label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">
            {t('app.about.braveRequired')}{' '}
            <a
              href="https://brave.com/search/api/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {t('app.about.getFreeKey')}
            </a>
          </p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={braveKey}
                onChange={e => { setBraveKey(e.target.value); setSaved(false) }}
                placeholder={hasSavedBraveKey ? t('app.about.savedKeyPlaceholder') : 'BSA...'}
                className="w-full px-3 py-2 bg-background border border-input rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring pr-10"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                title={showKey ? t('app.about.hide') : t('app.about.show')}
              >
                {showKey ? t('app.about.hide') : t('app.about.show')}
              </button>
            </div>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              {saved ? t('app.about.saved') : t('common.save')}
            </button>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-border">
          <label className="text-sm font-medium">{t('app.about.hfToken')}</label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">
            {t('app.about.hfRequired')}{' '}
            <a
              href="https://huggingface.co/settings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {t('app.about.getToken')}
            </a>
          </p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showHfKey ? 'text' : 'password'}
                value={hfToken}
                onChange={e => { setHfToken(e.target.value); setHfSaved(false) }}
                placeholder={hasSavedHfToken ? t('app.about.savedTokenPlaceholder') : 'hf_...'}
                className="w-full px-3 py-2 bg-background border border-input rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring pr-10"
              />
              <button
                onClick={() => setShowHfKey(!showHfKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                title={showHfKey ? t('app.about.hide') : t('app.about.show')}
              >
                {showHfKey ? t('app.about.hide') : t('app.about.show')}
              </button>
            </div>
            <button
              onClick={handleHfSave}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              {hfSaved ? t('app.about.saved') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
