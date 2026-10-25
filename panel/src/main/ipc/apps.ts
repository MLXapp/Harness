/**
 * IPC for Apps (Composio):
 *   apps:status · apps:connect (browser sign-in) · apps:connectKey(key)
 *   apps:cancel · apps:disconnect · apps:connectApp(toolkit)
 *   apps:rules · apps:setRule(toolkit, rule)
 *   apps:chatEnabled(chatId) · apps:setChatEnabled(chatId, on)
 *   event apps:status
 * Credentials never cross to the renderer.
 */

import { ipcMain, shell } from 'electron'
import { db } from '../database'
import { decryptSecret, encryptValue } from '../secretStorage'
import { AppsService, type AppsStatus } from '../apps/appsService'
import { FEATURED_APPS, appName, type AppRule } from '../apps/composioPolicy'
import { appWindows } from '../browser/electronDriver'
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
      readPending: () => {
        try {
          const v = JSON.parse(db.getSetting('apps_pending') || '{}')
          const out: Record<string, number> = {}
          if (v && typeof v === 'object') for (const [k, t] of Object.entries(v)) if (typeof t === 'number' && /^[a-z0-9_]{2,40}$/.test(k)) out[k] = t
          return out
        } catch { return {} }
      },
      writePending: (pending) => db.setSetting('apps_pending', JSON.stringify(pending)),
      readSchemaCache: () => { try { return JSON.parse(db.getSetting('apps_schema_cache') || '{}') } catch { return {} } },
      writeSchemaCache: (cache) => db.setSetting('apps_schema_cache', JSON.stringify(cache)),
      setChatEnabled: (chatId, on) => { if (on) db.setSetting(chatKey(chatId), '1'); else db.deleteSetting(chatKey(chatId)) },
    },
    openExternal: async (url) => {
      if (!/^https:\/\//.test(url)) return
      await shell.openExternal(url)
    },
    onStatus: (status) => broadcast(status),
    onAppsChanged: () => broadcast(service?.status() ?? { state: 'off', via: null }),
  })
  // Sign-ins still open when the app last quit are watched again.
  if (service.isConnected()) service.resumePending()
  return service
}

/** The status the renderer shows: with every featured app's connection. */
function statusView(status: AppsStatus) {
  const apps = appsService()
  const connected = new Set(apps.connectedApps())
  const pending = new Set(apps.pendingApps())
  return {
    ...status,
    featured: FEATURED_APPS.map(id => ({ id, name: appName(id), connected: connected.has(id), pending: !connected.has(id) && pending.has(id) })),
  }
}

function broadcast(status: AppsStatus): void {
  if (!service) return
  const view = statusView(status)
  for (const win of appWindows()) win.webContents.send('apps:status', view)
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
  ipcMain.handle('apps:status', () => statusView(apps.status()))
  ipcMain.handle('apps:connect', () => apps.connectOAuth())
  ipcMain.handle('apps:connectKey', (_e, key: string) => apps.connectWithKey(typeof key === 'string' ? key : ''))
  ipcMain.handle('apps:cancel', () => { apps.cancelSignIn(); return apps.status() })
  ipcMain.handle('apps:disconnect', () => apps.disconnect())
  ipcMain.handle('apps:connectApp', async (_e, toolkit: string) => {
    if (typeof toolkit !== 'string' || !/^[a-z0-9_]{2,40}$/.test(toolkit)) return { ok: false, opened: 0, message: 'Unknown app.' }
    try { return await apps.connectApp(toolkit) } catch (err: any) { return { ok: false, opened: 0, message: String(err?.message ?? err) } }
  })
  ipcMain.handle('apps:checkApp', async (_e, toolkit: string, quiet?: boolean) => {
    if (typeof toolkit !== 'string' || !/^[a-z0-9_]{2,40}$/.test(toolkit)) return { ok: false, connected: false }
    // A quiet check (window focus) only waits; it never asks Composio to start a sign-in.
    try { return await apps.checkApp(toolkit, { manage: quiet !== true }) } catch (err: any) { return { ok: false, connected: false, message: String(err?.message ?? err) } }
  })
  ipcMain.handle('apps:removeApp', (_e, toolkit: string) => {
    if (typeof toolkit === 'string' && /^[a-z0-9_]{2,40}$/.test(toolkit)) apps.removeApp(toolkit)
    return statusView(apps.status())
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
