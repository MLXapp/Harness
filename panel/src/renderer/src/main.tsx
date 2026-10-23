import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './providers/ThemeProvider'
import { BrandDefs } from './components/brand/Logo'
import { I18nProvider } from './i18n'
import { AppStateProvider } from './contexts/AppStateContext'
import { SessionsProvider } from './contexts/SessionsContext'
import { DownloadsView } from './components/DownloadsView'
import './index.css'

declare const __VMLINUX_BUILD_SOURCE_COMMIT__: string

declare global {
  // Runtime provenance consumed by the attached CDP release gate.
  // The value is injected by electron.vite.config.ts from Git itself.
  var __VMLINUX_SOURCE_COMMIT__: string | undefined
}

globalThis.__VMLINUX_SOURCE_COMMIT__ = __VMLINUX_BUILD_SOURCE_COMMIT__
document.documentElement.dataset.sourceCommit = __VMLINUX_BUILD_SOURCE_COMMIT__

// Download window: skip all providers, render only the downloads view
const isDownloadWindow = new URLSearchParams(window.location.search).get('view') === 'downloads'

// macOS window glass: the main window is transparent behind the sidebar.
try {
  if (!isDownloadWindow && window.api?.chrome?.vibrancy?.()) document.documentElement.classList.add('vibrancy')
} catch { /* older preload: opaque window */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrandDefs />
      <I18nProvider>
        {isDownloadWindow ? (
          <DownloadsView />
        ) : (
          <SessionsProvider>
            <AppStateProvider>
              <App />
            </AppStateProvider>
          </SessionsProvider>
        )}
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
)
