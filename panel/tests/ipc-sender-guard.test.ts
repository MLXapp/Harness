import { describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: any[]) => any>()
const listeners = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: any[]) => any) => { handlers.set(ch, fn) },
    on: (ch: string, fn: (...args: any[]) => any) => { listeners.set(ch, fn) },
  },
}))

import { ipcMain } from 'electron'
import { installIpcSenderGuard, isGuardedChannel, senderIsAppPage } from '../src/main/ipcSenderGuard'

const isApp = (url: string) => url.startsWith('file:///app/out/renderer/')
const appEvent = { senderFrame: { url: 'file:///app/out/renderer/index.html' } }
const otherEvent = { senderFrame: { url: 'https://example.com/' } }

describe('IPC sender guard', () => {
  it('names the channels that change settings, files or processes', () => {
    for (const ch of ['settings:set', 'workspace:save', 'sessions:create', 'sessions:update', 'chat:setOverrides', 'chat:answerUser',
      'models:addDirectory', 'models:deleteLocal', 'image:saveFile', 'tools:launchCodingTool', 'gateway:start']) {
      expect(isGuardedChannel(ch)).toBe(true)
    }
    for (const ch of ['settings:get', 'sessions:list', 'chat:sendMessage', 'models:scan']) expect(isGuardedChannel(ch)).toBe(false)
  })

  it('checks the sending frame, and a gone frame fails closed', () => {
    expect(senderIsAppPage(appEvent, isApp)).toBe(true)
    expect(senderIsAppPage(otherEvent, isApp)).toBe(false)
    expect(senderIsAppPage({ senderFrame: null }, isApp)).toBe(false)
    const gone = { get senderFrame(): any { throw new Error('disposed') } }
    expect(senderIsAppPage(gone, isApp)).toBe(false)
  })

  it('wraps guarded handlers registered after install and leaves the rest alone', async () => {
    installIpcSenderGuard(isApp)
    const set = vi.fn(() => 'ok')
    const get = vi.fn(() => 'value')
    const answer = vi.fn()
    ipcMain.handle('settings:set', set)
    ipcMain.handle('settings:get', get)
    ipcMain.on('chat:answerUser', answer)
    expect(handlers.get('settings:get')).toBe(get)
    expect(handlers.get('settings:set')!(appEvent, 'k', 'v')).toBe('ok')
    expect(() => handlers.get('settings:set')!(otherEvent, 'k', 'v')).toThrow(/Not allowed/)
    expect(set).toHaveBeenCalledTimes(1)
    listeners.get('chat:answerUser')!(otherEvent, 'x')
    expect(answer).not.toHaveBeenCalled()
    listeners.get('chat:answerUser')!(appEvent, 'x')
    expect(answer).toHaveBeenCalledWith(appEvent, 'x')
  })
})
