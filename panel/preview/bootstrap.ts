/**
 * Reads the preview's query parameters, seeds browser storage and fixture
 * settings the renderer restores from, installs the mock `window.api`, and
 * after mount opens the requested page. Everything is exposed on
 * `window.__PREVIEW__` for screenshot scripts and future preview screens.
 *
 *   ?scenario=default|fresh|connected   fixture set (preview/fixtures.ts)
 *   ?theme=light|dark|system            pinned appearance (default: system)
 *   ?mode=chat|models|server|tools|network|image|api|code
 *   &panel=about|dashboard|create|...   sub-page (server/tools panels)
 *   ?chat=<id>                          chat to open (chat mode; default: most recent)
 *   ?session=<id>                       session for panel=session|settings
 *   ?engine=missing                     engine not installed (SetupScreen)
 *   ?locale=en|zh|ko|ja|es              UI language
 *   ?setup=1                            show first-run setup (otherwise it counts as done)
 *   ?sidebar=collapsed                  start with the sidebar collapsed
 *
 * When the page has settled, <html data-preview-ready="1"> is set.
 */

import { buildFixtures, HARDWARE, SCENARIOS, type Fixtures, type ScenarioName } from './fixtures'
import { createMockApi, PreviewEvents, withFallback, type PreviewApi } from './mockApi'

export interface PreviewGlobal {
  /** Raw query parameters. */
  params: Record<string, string>
  scenario: ScenarioName
  theme: 'light' | 'dark' | 'system'
  /** `?setup=1`: first-run setup shows (the onboardingDone setting is left unset). */
  setup: boolean
  /** Hardware the preview pretends to be (no IPC exposes the chip yet). */
  hardware: typeof HARDWARE
  /** Live fixture state behind the mock; mutate and emit to drive the UI. */
  fixtures: Fixtures
  /** The unwrapped mock (window.api is this behind a fallback proxy). */
  api: PreviewApi
  /** Fire a main → renderer IPC event, e.g. emit('session:ready', { sessionId }). */
  emit: (channel: string, data?: unknown) => void
  /** Open a page the same way the app's own `vmlx:navigate` event does. */
  navigate: (detail: { mode: string; panel?: string; sessionId?: string; modelPath?: string }) => void
  /** True once the requested page is open and painted. */
  ready: boolean
}

declare global {
  interface Window {
    __PREVIEW__: PreviewGlobal
  }
}

const THEME_KEY = 'mlx-studio-theme' // src/renderer/src/providers/ThemeProvider.tsx
const LOCALE_KEY = 'vmlx-locale' // src/renderer/src/i18n/I18nProvider.tsx

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* storage blocked */ }
}

export function installPreview(): { afterMount: () => void } {
  const params = Object.fromEntries(new URLSearchParams(window.location.search))
  const scenario: ScenarioName = (SCENARIOS as readonly string[]).includes(params.scenario) ? params.scenario as ScenarioName : 'default'
  const theme = params.theme === 'light' || params.theme === 'dark' ? params.theme : 'system'
  const mode = params.mode || 'chat'
  const panel = params.panel

  // Each load starts from the URL alone, never from what a previous load stored.
  storageSet(THEME_KEY, theme)
  storageSet(LOCALE_KEY, params.locale || null)

  const fixtures = buildFixtures(scenario, { engineInstalled: params.engine !== 'missing' })

  // What AppStateContext restores on mount (settings.get on appMode etc.).
  const s = fixtures.settings
  s.appMode = mode
  // First-run setup shows only with ?setup=1 (otherwise it would cover every screenshot).
  if (params.setup !== '1') s.onboardingDone = '1'
  if (params.sidebar === 'collapsed') s.sidebarCollapsed = 'true'
  if (mode === 'chat') {
    const chat = params.chat
      ? fixtures.chats.find(c => c.id === params.chat)
      : [...fixtures.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (chat) {
      s.lastActiveChatId = chat.id
      const bound = fixtures.chatBindings.some(b => b.chatId === chat.id)
      const session = bound ? undefined : fixtures.sessions.find(x => x.modelPath === chat.modelPath && x.status === 'running')
      if (session) s.lastActiveSessionId = session.id
    }
  }

  const events = new PreviewEvents()
  const api = createMockApi(fixtures, events)
  ;(window as unknown as { api: PreviewApi }).api = withFallback(api)
  ;(window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { send() {}, invoke: async () => undefined, on() { return () => {} }, once() {}, removeListener() {}, removeAllListeners() {} },
    process: { platform: 'darwin', versions: {}, env: {} },
  }

  const navigate: PreviewGlobal['navigate'] = detail => {
    window.dispatchEvent(new CustomEvent('vmlx:navigate', { detail }))
  }

  const preview: PreviewGlobal = {
    params,
    scenario,
    theme,
    setup: params.setup === '1',
    hardware: HARDWARE,
    fixtures,
    api,
    emit: (channel, data) => events.emit(channel, data),
    navigate,
    ready: false,
  }
  window.__PREVIEW__ = preview
  document.documentElement.dataset.previewScenario = scenario

  const markReady = () => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      preview.ready = true
      document.documentElement.dataset.previewReady = '1'
    }))
  }

  return {
    afterMount() {
      // The setup screen has no <main>; neither does the downloads window.
      const appShown = () => document.querySelector('main') !== null
      const setupShown = () => fixtures.engineInstalled === false && document.getElementById('root')!.childElementCount > 0
      const started = performance.now()
      const tick = () => {
        if (appShown()) {
          // The app's own navigation listener is attached; persisted state is restored.
          // A short grace period lets the async state restore settle first.
          setTimeout(() => {
            if (panel || mode !== 'chat') {
              navigate({ mode, ...(panel ? { panel } : {}), ...(params.session ? { sessionId: params.session } : {}) })
            }
            markReady()
          }, 150)
          return
        }
        if (setupShown() || params.view === 'downloads' || performance.now() - started > 8000) {
          markReady()
          return
        }
        setTimeout(tick, 30)
      }
      tick()
    },
  }
}
