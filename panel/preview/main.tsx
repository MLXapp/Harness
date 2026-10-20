/**
 * Browser preview entry. Installs the mock `window.api` first, then loads the
 * real renderer tree (same providers and CSS as src/renderer/src/main.tsx).
 * Query parameters are documented in preview/bootstrap.ts.
 */
import { installPreview } from './bootstrap'

const preview = installPreview()

// The renderer is imported only after window.api exists.
const { mountApp } = await import('./mount')
mountApp()
preview.afterMount()
