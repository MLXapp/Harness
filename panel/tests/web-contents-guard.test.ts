import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { on: vi.fn() }, session: {}, shell: {} }))

import { permissionCheckAllowed, permissionRequestAllowed } from '../src/main/webContentsGuard'

const isApp = (url: string) => url.startsWith('file:///Applications/MLX%20Harness.app/Contents/Resources/app.asar/out/renderer/')
const appUrl = 'file:///Applications/MLX%20Harness.app/Contents/Resources/app.asar/out/renderer/index.html'

describe('default-session permissions', () => {
  it('grants the app page only what it uses', () => {
    expect(permissionRequestAllowed('media', appUrl, true, isApp)).toBe(true)
    expect(permissionRequestAllowed('clipboard-sanitized-write', appUrl, true, isApp)).toBe(true)
    expect(permissionRequestAllowed('geolocation', appUrl, true, isApp)).toBe(false)
    expect(permissionRequestAllowed('notifications', appUrl, true, isApp)).toBe(false)
  })
  it('refuses preview frames and any other page', () => {
    expect(permissionRequestAllowed('media', 'http://127.0.0.1:5123/m1/index.html', false, isApp)).toBe(false)
    expect(permissionRequestAllowed('media', appUrl, false, isApp)).toBe(false)
    expect(permissionRequestAllowed('media', 'https://example.com/', true, isApp)).toBe(false)
    expect(permissionRequestAllowed('media', undefined, true, isApp)).toBe(false)
    expect(permissionCheckAllowed('http://127.0.0.1:5123/', false, isApp)).toBe(false)
    expect(permissionCheckAllowed(appUrl, true, isApp)).toBe(true)
  })
})
