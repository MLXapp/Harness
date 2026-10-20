import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/src/App'
import { ThemeProvider } from '@/src/providers/ThemeProvider'
import { BrandDefs } from '@/src/components/brand/Logo'
import { I18nProvider } from '@/src/i18n'
import { AppStateProvider } from '@/src/contexts/AppStateContext'
import { SessionsProvider } from '@/src/contexts/SessionsContext'
import { DownloadsView } from '@/src/components/DownloadsView'
import '@/src/index.css'
import './preview.css'

/** Same tree as src/renderer/src/main.tsx. Keep the two in step. */
export function mountApp(): void {
  globalThis.__VMLINUX_SOURCE_COMMIT__ = __VMLINUX_BUILD_SOURCE_COMMIT__
  document.documentElement.dataset.sourceCommit = __VMLINUX_BUILD_SOURCE_COMMIT__

  const isDownloadWindow = new URLSearchParams(window.location.search).get('view') === 'downloads'

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
}
