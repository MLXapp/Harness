/**
 * IPC for Apps (Composio):
 *   apps:status · apps:connect (browser sign-in) · apps:connectKey(key)
 *   apps:cancel · apps:disconnect · apps:connectApp(toolkit)
 *   apps:rules · apps:setRule(toolkit, rule)
 *   apps:chatEnabled(chatId) · apps:setChatEnabled(chatId, on)
 *   event apps:status
 * Credentials never cross to the renderer.
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import { db } from '../database'
import { decryptSecret, encryptValue } from '../secretStorage'
import { AppsService, type AppsStatus } from '../apps/appsService'
import { FEATURED_APPS, appName, type AppRule } from '../apps/composioPolicy'
import { discoverSkills } from '../agent/skills'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const OAUTH_KEY = 'composio_oauth_secret'
const CONSUMER_KEY = 'composio_consumer_api_key'
const RULES_KEY = 'apps_rules'
const chatKey = (chatId: string) => `apps_chat_${chatId}`

let service: AppsService | null = null

export function appsService(): AppsService {
  if (service) return service
  service = new AppsService({
    storage: {
      readOAuth: () => {
        const raw = db.getSetting(OAUTH_KEY)
        if (!raw) return null
        try { return JSON.parse(decryptSecret(raw) || 'null') } catch { return null }
      },
      writeOAuth: (value) => {
        if (!value || (!value.client && !value.tokens)) db.deleteSetting(OAUTH_KEY)
        else db.setSetting(OAUTH_KEY, encryptValue(JSON.stringify(value)))
      },
      readKey: () => db.getSetting(CONSUMER_KEY) || null,
      writeKey: (key) => { if (key) db.setSetting(CONSUMER_KEY, key); else db.deleteSetting(CONSUMER_KEY) },
      readRules: () => {
        try {
          const parsed = JSON.parse(db.getSetting(RULES_KEY) || '{}')
          const out: Record<string, AppRule> = {}
          for (const [k, v] of Object.entries(parsed)) if (v === 'always' || v === 'blocked') out[k] = v
          return out
        } catch { return {} }
      },
      writeRules: (rules) => db.setSetting(RULES_KEY, JSON.stringify(rules)),
      chatEnabled: (chatId) => db.getSetting(chatKey(chatId)) === '1',
      readConnected: () => { try { const v = JSON.parse(db.getSetting('apps_connected') || '[]'); return Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'string') : [] } catch { return [] } },
      writeConnected: (list) => db.setSetting('apps_connected', JSON.stringify(list.slice(0, 50))),
      readSchemaCache: () => { try { return JSON.parse(db.getSetting('apps_schema_cache') || '{}') } catch { return {} } },
      writeSchemaCache: (cache) => db.setSetting('apps_schema_cache', JSON.stringify(cache)),
      setChatEnabled: (chatId, on) => { if (on) db.setSetting(chatKey(chatId), '1'); else db.deleteSetting(chatKey(chatId)) },
    },
    openExternal: async (url) => {
      if (!/^https:\/\//.test(url)) return
      await shell.openExternal(url)
    },
    onStatus: (status) => broadcast(status),
  })
  return service
}

function broadcast(status: AppsStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('apps:status', status)
  }
}

export function registerAppsHandlers(): void {
  const apps = appsService()
  // Skills (Preferences → Skills): the user's own; project skills show in their sessions.
  ipcMain.handle('skills:list', () => discoverSkills(undefined).map(s => ({ name: s.name, description: s.description, scope: s.scope, dir: s.dir })))
  ipcMain.handle('skills:openFolder', async () => {
    const dir = join(homedir(), '.mlx-harness', 'skills')
    mkdirSync(dir, { recursive: true })
    return (await shell.openPath(dir)) === ''
  })
  ipcMain.handle('apps:status', () => {
    const connected = new Set(apps.connectedApps())
    return { ...apps.status(), featured: FEATURED_APPS.map(id => ({ id, name: appName(id), connected: connected.has(id) })) }
  })
  ipcMain.handle('apps:connect', () => apps.connectOAuth())
  ipcMain.handle('apps:connectKey', (_e, key: string) => apps.connectWithKey(typeof key === 'string' ? key : ''))
  ipcMain.handle('apps:cancel', () => { apps.cancelSignIn(); return apps.status() })
  ipcMain.handle('apps:disconnect', () => apps.disconnect())
  ipcMain.handle('apps:connectApp', async (_e, toolkit: string) => {
    if (typeof toolkit !== 'string' || !/^[a-z0-9_]{2,40}$/.test(toolkit)) return { ok: false, opened: 0, message: 'Unknown app.' }
    try { return await apps.connectApp(toolkit) } catch (err: any) { return { ok: false, opened: 0, message: String(err?.message ?? err) } }
  })
  ipcMain.handle('apps:rules', () => apps.rules())
  ipcMain.handle('apps:setRule', (_e, toolkit: string, rule: AppRule) => {
    if (typeof toolkit !== 'string' || !/^[a-z0-9_]{2,40}$/.test(toolkit)) return apps.rules()
    return apps.setRule(toolkit, rule === 'always' || rule === 'blocked' ? rule : 'ask')
  })
  ipcMain.handle('apps:chatEnabled', (_e, chatId: string) => (typeof chatId === 'string' ? apps.chatEnabled(chatId) : false))
  ipcMain.handle('apps:setChatEnabled', async (_e, chatId: string, on: boolean) => {
    if (typeof chatId !== 'string' || !chatId) return false
    const enabled = apps.setChatEnabled(chatId, !!on)
    if (enabled) void apps.listTools().catch(() => undefined) // warm the tool list for the next turn
    return enabled
  })
}
