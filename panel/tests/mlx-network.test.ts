import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  formatMlx,
  miningUrl,
  MLX_NETWORK_TOTALS_URL,
  normalizeWalletName,
  parseNetworkTotals,
  parseWalletMining,
  unitsToMlx,
} from '../src/shared/mlxNetwork'
import { consolePageForMode, restoreAppMode } from '../src/renderer/src/lib/consoleNavigation'

describe('MLX Network tie-in', () => {
  it('reads the public endpoints on mlx.app', () => {
    expect(MLX_NETWORK_TOTALS_URL).toBe('https://mlx.app/api/world/network?totals=1')
    expect(miningUrl('luca.mlx')).toBe('https://mlx.app/api/account/luca.mlx/mining')
  })

  it('accepts the totals shape and keeps countries only when reported', () => {
    const snap = parseNetworkTotals({ chain: 'mlx-1', at: 1, totals: { macs: 3, online: 2, working: 1, tps: 300, tokensToday: 9000, countries: 2, cities: 2, placed: 2, freeNodes: 1, freeTflops: 3.4, freeMemGB: 16 } })
    expect(snap?.totals).toEqual({ macs: 3, online: 2, working: 1, tps: 300, tokensToday: 9000, countries: 2, freeNodes: 1 })
    const noCountries = parseNetworkTotals({ totals: { macs: 0, online: 0, working: 0, tps: 0, tokensToday: 0 } })
    expect(noCountries?.totals.countries).toBeUndefined()
  })

  it('treats malformed totals as an error, never as zeros', () => {
    expect(parseNetworkTotals(null)).toBeNull()
    expect(parseNetworkTotals({ error: 'boom' })).toBeNull()
    expect(parseNetworkTotals({ totals: { macs: 1, online: 1, working: 1, tps: 'fast', tokensToday: 1 } })).toBeNull()
    expect(parseNetworkTotals({ totals: { macs: -1, online: 1, working: 1, tps: 1, tokensToday: 1 } })).toBeNull()
  })

  it('parses live mining and rejects anything else', () => {
    const m = parseWalletMining({ at: 5, locked: '1500000', pending: '250', rate: 0.0005, active: true, macs: 2, state: 'mining' })
    expect(m).toEqual({ at: 5, locked: '1500000', pending: '250', rate: 0.0005, active: true, macs: 2, state: 'mining' })
    expect(parseWalletMining({ at: 5, locked: '1.5', pending: '0', rate: 0 })).toBeNull()
    expect(parseWalletMining({ at: 5, locked: '1', pending: '0', rate: -1 })).toBeNull()
    expect(parseWalletMining({ error: 'Account not found' })).toBeNull()
    expect(parseWalletMining({ at: 5, locked: '0', pending: '0', rate: 0, active: false, macs: 0, state: 'weird' })?.state).toBe('idle')
  })

  it('normalizes wallet names like mlx.app does', () => {
    expect(normalizeWalletName('Luca')).toBe('luca.mlx')
    expect(normalizeWalletName(' luca.mlx ')).toBe('luca.mlx')
    expect(normalizeWalletName('my-mac-2')).toBe('my-mac-2.mlx')
    expect(normalizeWalletName('a')).toBeNull()
    expect(normalizeWalletName('-luca')).toBeNull()
    expect(normalizeWalletName('luca/../x')).toBeNull()
    expect(normalizeWalletName('x'.repeat(33))).toBeNull()
  })

  it('shows MLX with 6 decimals from base units', () => {
    expect(unitsToMlx('1500000')).toBe(1.5)
    expect(unitsToMlx('7')).toBe(0.000007)
    expect(unitsToMlx('0')).toBe(0)
    expect(formatMlx(1.5, 'en-US')).toBe('1.500000')
    expect(formatMlx(1234.5, 'en-US')).toBe('1,234.500000')
    expect(formatMlx(NaN)).toBe('–')
  })

  it('is a primary page with a stable mode', () => {
    expect(consolePageForMode('network')).toBe('network')
    expect(restoreAppMode('network')).toBe('network')
    const sidebar = readFileSync('src/renderer/src/components/layout/ConsoleSidebar.tsx', 'utf8')
    expect(sidebar).toContain("['network', Globe, t('console.network')]")
  })

  it('makes its network calls from the main process and shows "–" until data arrives', () => {
    const view = readFileSync('src/renderer/src/components/network/NetworkView.tsx', 'utf8')
    expect(view).not.toContain('fetch(')
    expect(view).toContain("const DASH = '–'")
    const main = readFileSync('src/main/ipc/network.ts', 'utf8')
    expect(main).toContain("ipcMain.handle('network:totals'")
    expect(main).toContain("ipcMain.handle('network:mining'")
    expect(main).toContain("shell.openExternal('mlx://open')")
    expect(main).toContain("ipcMain.handle('network:installMlxNode'")
    const node = readFileSync('src/main/mlx-node.ts', 'utf8')
    expect(node).toContain('CFBundleIdentifier === MLX_NODE_BUNDLE_ID')
  })

  it('calls the menu bar app MLX Node everywhere', () => {
    for (const locale of ['en', 'es', 'ja', 'ko', 'zh']) {
      const text = readFileSync(`src/renderer/src/i18n/locales/${locale}.json`, 'utf8')
      expect(text, locale).not.toContain('MLX for macOS')
      const catalog = JSON.parse(text)
      expect(catalog.network.appTitle).toBe('MLX Node')
      expect(catalog.network.installApp).toContain('MLX Node')
      expect(catalog.main.dialog.mlxNodeOfferTitle).toContain('MLX Node')
    }
    const en = JSON.parse(readFileSync('src/renderer/src/i18n/locales/en.json', 'utf8'))
    expect(en.main.dialog.mlxNodeOfferTitle).toBe('Also install MLX Node?')
    expect(en.main.dialog.mlxNodeOfferDetail).toBe("MLX Node is the menu bar app that lends your Mac's idle time to MLX Network and earns MLX Tokens. It's separate from MLX Studio, updates itself, and you can quit or remove it any time.")
    expect([en.main.dialog.mlxNodeInstall, en.main.dialog.mlxNodeNotNow]).toEqual(['Install MLX Node', 'Not now'])
  })
})
